/**
 * OpenCode Go (opencode.ai subscription plan) provider adapter.
 *
 * OpenCode Go meters three nested dollar budgets, published by the
 * subscription quota endpoint:
 *
 *   window  | budget          | normalized as
 *   --------|-----------------|---------------
 *   rolling | 5-hour rolling  | primary
 *   weekly  | calendar week   | secondary
 *   monthly | billing month   | tertiary (statusline ignores it; /usage shows it)
 *
 * Only the percentages are on the wire — the dollar limits are not — so each
 * window is normalized as a 0–100 tank. `status` is "ok" or "rate-limited";
 * a rate-limited window without a percent is treated as fully consumed.
 *
 * Auth is the plain OpenCode API key (`opencode-go` provider in pi,
 * OPENCODE_API_KEY / auth.json), sent as a Bearer token.
 */

import { clampPercent } from "../braille";
import { assertObject, asNumber, asString, asTimestampMs, fetchWithTimeout, parseJsonObject, redactErrorBody } from "../util";
import type { QueryContext, UsageProvider, UsageReport, UsageSnapshot, UsageWindow } from "../types";

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_LIMIT_ID = "opencode-go";
const MAX_ERROR_BODY_CHARS = 600;

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Payload window id -> normalized slot and label. */
const OPENCODE_GO_WINDOWS = {
	rolling: { label: "5h", windowDurationSeconds: FIVE_HOURS_SECONDS },
	weekly: { label: "weekly", windowDurationSeconds: WEEK_SECONDS },
	monthly: { label: "monthly", windowDurationSeconds: undefined },
} as const;

type OpencodeGoWindowId = keyof typeof OPENCODE_GO_WINDOWS;

export const opencodeGoProvider: UsageProvider = {
	id: OPENCODE_GO_PROVIDER_ID,
	label: () => OPENCODE_GO_PROVIDER_ID,
	matchesModel: (model) => model?.provider === OPENCODE_GO_PROVIDER_ID,
	selectSnapshot: (report) =>
		report.snapshots.find((snapshot) => snapshot.limitId === OPENCODE_GO_USAGE_LIMIT_ID),
	query: async (ctx: QueryContext, _model, timeoutMs) => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider?.(OPENCODE_GO_PROVIDER_ID);
		if (!apiKey) {
			throw new Error(
				"No OpenCode API key was available. Configure the opencode-go provider auth in pi first.",
			);
		}

		const capturedAt = Date.now();
		const response = await fetchWithTimeout(
			OPENCODE_GO_USAGE_URL,
			{
				headers: {
					// Accept-Encoding identity works around gzip decompression issues
					// in pi's undici proxy stack.
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${apiKey}`,
					"User-Agent": "pi-usage",
				},
			},
			timeoutMs,
		);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`OpenCode Go usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text, MAX_ERROR_BODY_CHARS)}`,
			);
		}

		return normalizeOpencodeGoPayload(parseJsonObject(text, "OpenCode Go usage endpoint response"), capturedAt);
	},
};

export function normalizeOpencodeGoPayload(payload: Record<string, unknown>, capturedAt: number): UsageReport {
	const usage = assertObject(payload.usage, "OpenCode Go usage payload");
	const windows = {
		rolling: normalizeWindow(usage.rolling, "rolling"),
		weekly: normalizeWindow(usage.weekly, "weekly"),
		monthly: normalizeWindow(usage.monthly, "monthly"),
	};
	if (!windows.rolling && !windows.weekly && !windows.monthly) {
		throw new Error("OpenCode Go usage endpoint returned no displayable quota windows.");
	}

	const snapshot: UsageSnapshot = {
		limitId: OPENCODE_GO_USAGE_LIMIT_ID,
		primary: windows.rolling,
		secondary: windows.weekly,
		tertiary: windows.monthly,
	};
	return { capturedAt, snapshots: [snapshot] };
}

function normalizeWindow(value: unknown, id: OpencodeGoWindowId): UsageWindow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const status = asString(raw.status);
	let usedPercent = asNumber(raw.percent);
	if (usedPercent === undefined) {
		// A rate-limited window that omits percent is fully consumed.
		if (status !== "rate-limited") return undefined;
		usedPercent = 100;
	}

	const { label, windowDurationSeconds } = OPENCODE_GO_WINDOWS[id];
	const resetAt = asTimestampMs(raw.resetsAt);
	return {
		usedPercent: clampPercent(usedPercent),
		...(resetAt === undefined ? {} : { resetAt }),
		...(windowDurationSeconds === undefined ? {} : { windowDurationSeconds }),
		windowLabel: label,
	};
}
