/**
 * OpenAI Codex provider adapter.
 *
 * Query strategy ported from @llblab/pi-codex-usage (MIT):
 * 1. pi-auth   — ChatGPT backend usage endpoint using pi's Codex auth
 * 2. codex-app-server — `codex app-server` RPC fallback
 *
 * Spark models prefer the app-server first because the backend payload
 * labels the spark bucket as an additional rate limit.
 */

import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { assertObject, asNumber, asResetTime, asString, errorMessage, fetchWithTimeout, hasHeader, normalizedUsageKey, parseJsonObject, redactErrorBody, truncateEnd } from "../util";
import type {
	ProviderModel,
	QueryContext,
	UsageProvider,
	UsageReport,
	UsageSnapshot,
	UsageWindow,
} from "../types";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_LIMIT_ID = "codex";
const SPARK_USAGE_LIMIT_ID = "spark";
const SPARK_MODEL_KEY = "gpt-5.3-codex-spark";
const MAX_ERROR_BODY_CHARS = 600;

type UsageSource = "pi-auth" | "codex-app-server";

type BackendRateLimitDetails = {
	primary_window?: unknown;
	secondary_window?: unknown;
};

type BackendWindowSnapshot = {
	used_percent?: unknown;
	reset_at?: unknown;
	resets_at?: unknown;
	reset_time?: unknown;
	end_time?: unknown;
	ends_at?: unknown;
	expires_at?: unknown;
	reset_after_seconds?: unknown;
};

type BackendAdditionalRateLimit = {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
};

type AppServerRateLimitSnapshot = {
	limitId?: unknown;
	primary?: unknown;
	secondary?: unknown;
};

type AppServerWindowSnapshot = {
	usedPercent?: unknown;
	resetAt?: unknown;
	resetsAt?: unknown;
	resetTime?: unknown;
	endTime?: unknown;
	endsAt?: unknown;
	expiresAt?: unknown;
	resetAfterSeconds?: unknown;
};

export function isSparkCodexModel(
	model: Pick<ProviderModel, "id" | "name" | "provider"> | undefined,
): boolean {
	if (model?.provider !== CODEX_PROVIDER_ID) return false;
	const key = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
	return key.includes(SPARK_MODEL_KEY);
}

export const codexProvider: UsageProvider = {
	id: CODEX_PROVIDER_ID,
	label: (model) => (isSparkCodexModel(model) ? SPARK_USAGE_LIMIT_ID : CODEX_USAGE_LIMIT_ID),
	matchesModel: (model) => model?.provider === CODEX_PROVIDER_ID,
	selectSnapshot: (report, model) =>
		report.snapshots.find(
			(snapshot) =>
				normalizedUsageKey(snapshot.limitId) ===
				normalizedUsageKey(isSparkCodexModel(model) ? SPARK_USAGE_LIMIT_ID : CODEX_USAGE_LIMIT_ID),
		),
	query: async (ctx, model, timeoutMs) => {
		const errors: { source: UsageSource; message: string; cause?: unknown }[] = [];
		const sources: UsageSource[] = isSparkCodexModel(model)
			? ["codex-app-server", "pi-auth"]
			: ["pi-auth", "codex-app-server"];

		for (const source of sources) {
			try {
				const report =
					source === "pi-auth"
						? await queryViaPiAuth(ctx, timeoutMs)
						: await queryViaCodexAppServer(timeoutMs);
				if (codexProvider.selectSnapshot(report, model)) return report;
				errors.push({
					source,
					message: `${source} returned no displayable ${codexProvider.label(model)} rate-limit windows`,
				});
			} catch (cause) {
				errors.push({ source, message: errorMessage(cause), cause });
			}
		}
		throw new AggregateError(
			errors.map((error) => new Error(error.message)),
			errors.map((error) => error.message).join("; ") || "codex usage query failed",
		);
	},
};

async function queryViaPiAuth(ctx: QueryContext, timeoutMs: number): Promise<UsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}

	const capturedAt = Date.now();
	const response = await fetchWithTimeout(
		CODEX_USAGE_URL,
		{ headers: auth.headers },
		timeoutMs,
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text, MAX_ERROR_BODY_CHARS)}`,
		);
	}

	return normalizeBackendPayload(parseJsonObject(text, "Codex usage endpoint response"), capturedAt);
}

async function resolvePiCodexAuth(
	ctx: QueryContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const models: any[] = [];
	const seen = new Set<string>();
	const add = (model: any) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		models.push(model);
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable?.() ?? []) add(model);
	for (const model of ctx.modelRegistry.getAll?.() ?? []) add(model);

	for (const model of models) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders?.(model);
		if (!auth?.ok) continue;

		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (value !== null) headers[name] = value;
		}
		if (!hasHeader(headers, "Authorization") && auth.apiKey) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage";
		if (hasHeader(headers, "Authorization")) return { headers };
	}

	return undefined;
}

async function queryViaCodexAppServer(timeoutMs: number): Promise<UsageReport> {
	const client = new CodexAppServerClient(timeoutMs);
	try {
		await client.start();
		await client.request("initialize", {
			clientInfo: { name: "pi_usage", title: "Pi Usage", version: "0.1.0" },
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: [],
			},
		});
		client.notify("initialized");
		const result = await client.request("account/rateLimits/read", undefined);
		return normalizeAppServerResponse(assertObject(result, "account/rateLimits/read result"), Date.now());
	} finally {
		client.dispose();
	}
}

export function normalizeBackendPayload(payload: Record<string, unknown>, capturedAt: number): UsageReport {
	const snapshots: UsageSnapshot[] = [];
	const primarySnapshot = normalizeBackendSnapshot(CODEX_USAGE_LIMIT_ID, payload.rate_limit, capturedAt);
	if (primarySnapshot) snapshots.push(primarySnapshot);

	if (Array.isArray(payload.additional_rate_limits)) {
		for (const item of payload.additional_rate_limits) {
			const additional = assertObject(item, "additional rate limit") as BackendAdditionalRateLimit;
			const snapshot = normalizeBackendSnapshot(backendAdditionalLimitId(additional), additional.rate_limit, capturedAt);
			if (snapshot) snapshots.push(snapshot);
		}
	}

	if (snapshots.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
	}
	return { capturedAt, snapshots };
}

function backendAdditionalLimitId(limit: BackendAdditionalRateLimit): string {
	const raw = `${asString(limit.limit_name) ?? ""} ${asString(limit.metered_feature) ?? ""}`;
	return raw.toLowerCase().includes("spark")
		? SPARK_USAGE_LIMIT_ID
		: (normalizedUsageKey(raw) ?? CODEX_USAGE_LIMIT_ID);
}

function normalizeBackendSnapshot(
	limitId: string,
	rateLimit: unknown,
	capturedAt: number,
): UsageSnapshot | undefined {
	if (rateLimit === null || rateLimit === undefined) return undefined;
	const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
	const primary = normalizeBackendWindow(details.primary_window, capturedAt);
	const secondary = normalizeBackendWindow(details.secondary_window, capturedAt);
	if (!primary && !secondary) return undefined;
	return { limitId, primary, secondary };
}

function normalizeBackendWindow(value: unknown, capturedAt: number): UsageWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const resetAt = asResetTime(
		[
			window.reset_at,
			window.resets_at,
			window.reset_time,
			window.end_time,
			window.ends_at,
			window.expires_at,
		],
		window.reset_after_seconds,
		capturedAt,
	);
	return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

export function normalizeAppServerResponse(payload: Record<string, unknown>, capturedAt: number): UsageReport {
	const snapshots: UsageSnapshot[] = [];
	const addSnapshot = (raw: unknown, fallbackId: string) => {
		const snapshot = normalizeAppServerSnapshot(raw, fallbackId, capturedAt);
		if (!snapshot) return;
		const existingIndex = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
		if (existingIndex >= 0) {
			const existing = snapshots[existingIndex] as UsageSnapshot;
			snapshots[existingIndex] = {
				limitId: snapshot.limitId || existing.limitId,
				primary: snapshot.primary ?? existing.primary,
				secondary: snapshot.secondary ?? existing.secondary,
			};
		} else {
			snapshots.push(snapshot);
		}
	};

	if (Array.isArray(payload.rateLimits)) {
		for (const item of payload.rateLimits) addSnapshot(item, CODEX_USAGE_LIMIT_ID);
	} else {
		addSnapshot(payload.rateLimits, CODEX_USAGE_LIMIT_ID);
	}
	if (snapshots.length === 0) {
		throw new Error("codex app-server returned no displayable rate-limit windows.");
	}

	return { capturedAt, snapshots };
}

function normalizeAppServerSnapshot(
	raw: unknown,
	fallbackId: string,
	capturedAt: number,
): UsageSnapshot | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
	const limitId = asString(snapshot.limitId) ?? fallbackId;
	const primary = normalizeAppServerWindow(snapshot.primary, capturedAt);
	const secondary = normalizeAppServerWindow(snapshot.secondary, capturedAt);
	if (!primary && !secondary) return undefined;
	return { limitId, primary, secondary };
}

function normalizeAppServerWindow(value: unknown, capturedAt: number): UsageWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(value, "app-server rate-limit window") as AppServerWindowSnapshot;
	const usedPercent = asNumber(window.usedPercent);
	if (usedPercent === undefined) return undefined;
	const resetAt = asResetTime(
		[
			window.resetAt,
			window.resetsAt,
			window.resetTime,
			window.endTime,
			window.endsAt,
			window.expiresAt,
		],
		window.resetAfterSeconds,
		capturedAt,
	);
	return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

type RpcResponse = {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private stderr = "";
	private readonly pending = new Map<number, PendingRpc>();
	private startPromise?: Promise<void>;
	private exitError?: Error;
	private readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;

		this.startPromise = new Promise((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			const startupTimeout = setTimeout(() => {
				reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`));
			}, this.timeoutMs);

			child.once("spawn", () => {
				clearTimeout(startupTimeout);
				resolve();
			});

			child.once("error", (error) => {
				clearTimeout(startupTimeout);
				reject(new Error(`Failed to start codex app-server: ${error.message}`));
				this.rejectAll(error);
			});

			child.once("exit", (code, signal) => {
				const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr, MAX_ERROR_BODY_CHARS)}` : "";
				this.exitError = new Error(
					`codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
				);
				this.rejectAll(this.exitError);
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
			});

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => this.handleLine(line));
		});

		return this.startPromise;
	}

	request(method: string, params: unknown): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin.writable) {
			throw new Error("codex app-server is not running.");
		}
		if (this.exitError) throw this.exitError;

		const id = this.nextId++;
		const payload = params === undefined ? { method, id } : { method, id, params };
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`));
			}, this.timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		});

		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return response;
	}

	notify(method: string): void {
		const child = this.child;
		if (!child?.stdin.writable) return;
		child.stdin.write(`${JSON.stringify({ method })}\n`);
	}

	dispose(): void {
		for (const [, pending] of this.pending) {
			pending.reject(new Error("codex app-server request cancelled."));
		}
		this.pending.clear();

		const child = this.child;
		if (!child) return;
		child.stdin.end();
		if (!child.killed) child.kill();
		this.child = undefined;
	}

	private handleLine(line: string): void {
		let parsed: RpcResponse;
		try {
			parsed = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}

		if (typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);

		if (parsed.error) {
			const message = asString(parsed.error.message) ?? "unknown error";
			pending.reject(new Error(`codex app-server request failed: ${message}`));
			return;
		}

		pending.resolve(parsed.result);
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) pending.reject(error);
		this.pending.clear();
	}
}
