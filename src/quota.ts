/**
 * Cross-extension quota protocol.
 *
 * pi-usage owns ALL provider-specific quota knowledge (endpoints, auth,
 * payload quirks). Other extensions ask it whether the active provider's
 * quota is exhausted over pi's shared event bus instead of reimplementing
 * provider adapters. Provider ids, window semantics, and exhaustion rules
 * therefore live in exactly one package.
 *
 * Channels (payloads are plain JSON so consumers can be separately versioned):
 * - `pi-usage:quota:providers`          pi-usage -> *  : { providers: string[] }
 * - `pi-usage:quota:providers:request`  consumer -> pi-usage : {}
 * - `pi-usage:quota:request`            consumer -> pi-usage :
 *       { requestId, provider, model?: { provider, id, name? } }
 * - `pi-usage:quota:response`           pi-usage -> consumer :
 *       { requestId, ok: true,  provider, label, exhausted } |
 *       { requestId, ok: false, provider, error }
 *
 * Ordering: extension factories all finish before `session_start`, and
 * extension loading is sequential, so a consumer that both listens for
 * `providers` and emits `providers:request` is guaranteed to learn the list
 * regardless of load order. The same guarantee makes the `session_start`
 * announcement safe.
 */

import type { ProviderModel, UsageProvider, UsageReport } from "./types";

export const QUOTA_PROVIDERS_CHANNEL = "pi-usage:quota:providers";
export const QUOTA_PROVIDERS_REQUEST_CHANNEL = "pi-usage:quota:providers:request";
export const QUOTA_REQUEST_CHANNEL = "pi-usage:quota:request";
export const QUOTA_RESPONSE_CHANNEL = "pi-usage:quota:response";

export type QuotaRequesterModel = {
	provider: string;
	id: string;
	name?: string;
};

export type QuotaStatusRequest = {
	requestId: string;
	provider: string;
	model?: QuotaRequesterModel;
};

export type QuotaStatusResponse =
	| {
			requestId: string;
			ok: true;
			provider: string;
			/** Active provider bucket label, for human-facing notices. */
			label: string;
			exhausted: boolean;
	  }
	| {
			requestId: string;
			ok: false;
			provider: string;
			error: string;
	  };

export type QuotaProvidersEvent = {
	providers: string[];
};

/**
 * A provider reports quota as the consumed share (`usedPercent`), so any
 * window at 100% blocks new requests until it resets. OpenCode Go windows
 * that arrive as `status: "rate-limited"` are normalized to 100% by its
 * adapter, so they are covered here too.
 */
export function isQuotaExhausted(
	provider: UsageProvider,
	report: UsageReport,
	model: ProviderModel | undefined,
): boolean {
	const snapshot = provider.selectSnapshot(report, model);
	if (!snapshot) return false;
	return [snapshot.primary, snapshot.secondary, snapshot.tertiary].some(
		(window) => window !== undefined && window.usedPercent >= 100,
	);
}

/** Validate an untrusted bus payload before acting on it. */
export function parseQuotaStatusRequest(raw: unknown): QuotaStatusRequest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.requestId !== "string" || value.requestId.length === 0) return undefined;
	if (typeof value.provider !== "string" || value.provider.length === 0) return undefined;
	const model = parseRequesterModel(value.model);
	return { requestId: value.requestId, provider: value.provider, ...(model ? { model } : {}) };
}

function parseRequesterModel(raw: unknown): QuotaRequesterModel | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
	return {
		provider: value.provider,
		id: value.id,
		...(typeof value.name === "string" ? { name: value.name } : {}),
	};
}
