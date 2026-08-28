/**
 * Z.ai (GLM coding plan) provider adapter.
 *
 * Queries the Z.ai monitor usage endpoint with the provider API key and
 * normalizes the quota windows:
 *
 *   type         | unit | meaning                        | normalized as
 *   -------------|------|--------------------------------|---------------
 *   TOKENS_LIMIT | 3    | 5-hour rolling quota (legacy)  | primary
 *   TOKENS_LIMIT | 6    | weekly quota (legacy)          | secondary
 *   CREDIT_LIMIT | 3    | 5-hour rolling credit quota    | primary
 *   CREDIT_LIMIT | 6    | weekly credit quota            | secondary
 *   TIME_LIMIT   | 5    | monthly web tools              | (ignored)
 *
 * Z.ai migrated coding-plan quotas from tokens (TOKENS_LIMIT) to credits
 * (CREDIT_LIMIT) with identical unit semantics, so both types are accepted.
 * The plan tier (data.level, e.g. "lite") is attached as snapshot meta and
 * rendered as a label suffix: "zai(lite)".
 */

import { clampPercent } from "../braille";
import { assertObject, asNumber, asResetTime, fetchWithTimeout, parseJsonObject, redactErrorBody } from "../util";
import type { QueryContext, UsageProvider, UsageReport, UsageSnapshot } from "../types";

const ZAI_PROVIDER_ID = "zai";
const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_USAGE_LIMIT_ID = "zai";
const MAX_ERROR_BODY_CHARS = 600;

const ZAI_QUOTA_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);
const ZAI_UNIT_FIVE_HOUR = 3;
const ZAI_UNIT_WEEKLY = 6;

export const zaiProvider: UsageProvider = {
	id: ZAI_PROVIDER_ID,
	label: () => ZAI_PROVIDER_ID,
	matchesModel: (model) => model?.provider === ZAI_PROVIDER_ID,
	selectSnapshot: (report) =>
		report.snapshots.find((snapshot) => snapshot.limitId === ZAI_USAGE_LIMIT_ID),
	query: async (ctx: QueryContext, _model, timeoutMs) => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider?.(ZAI_PROVIDER_ID);
		if (!apiKey) {
			throw new Error(
				"No Z.ai API key was available. Configure the zai provider auth in pi first.",
			);
		}

		const capturedAt = Date.now();
		const response = await fetchWithTimeout(
			ZAI_USAGE_URL,
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
				`Z.ai usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text, MAX_ERROR_BODY_CHARS)}`,
			);
		}

		return normalizeZaiPayload(parseJsonObject(text, "Z.ai usage endpoint response"), capturedAt);
	},
};

export function normalizeZaiPayload(payload: Record<string, unknown>, capturedAt: number): UsageReport {
	// Z.ai returns HTTP 200 with an error body on auth failures, e.g.
	// {"code":401,"msg":"token expired or incorrect","success":false}
	if (payload.success === false) {
		const msg = typeof payload.msg === "string" ? payload.msg : "unknown error";
		throw new Error(`Z.ai usage API error: ${msg}`);
	}

	const data = assertObject(payload.data, "Z.ai usage payload data");
	const limits = data.limits;
	if (!Array.isArray(limits) || limits.length === 0) {
		throw new Error("Z.ai usage endpoint returned no displayable quota windows.");
	}

	let primary: UsageSnapshot["primary"];
	let secondary: UsageSnapshot["secondary"];
	for (const entry of limits) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const limit = entry as Record<string, unknown>;
		const type = typeof limit.type === "string" ? limit.type : "";
		if (!ZAI_QUOTA_TYPES.has(type)) continue;
		const unit = asNumber(limit.unit);
		const usedPercent = asNumber(limit.percentage);
		if (usedPercent === undefined) continue;
		const resetAt = asResetTime([limit.nextResetTime], undefined, capturedAt);
		const window = resetAt === undefined
			? { usedPercent: clampPercent(usedPercent) }
			: { usedPercent: clampPercent(usedPercent), resetAt };
		if (unit === ZAI_UNIT_FIVE_HOUR && !primary) primary = window;
		else if (unit === ZAI_UNIT_WEEKLY && !secondary) secondary = window;
	}

	if (!primary && !secondary) {
		throw new Error("Z.ai usage endpoint returned no displayable quota windows.");
	}

	const level = typeof data.level === "string" && data.level.length > 0 ? data.level : undefined;
	const snapshot: UsageSnapshot = {
		limitId: ZAI_USAGE_LIMIT_ID,
		primary,
		secondary,
		meta: level ? { level } : undefined,
	};
	return { capturedAt, snapshots: [snapshot] };
}
