/**
 * Core usage-monitoring types shared by every provider adapter.
 *
 * A provider adapter converts a coding provider's proprietary usage/quota API
 * into normalized {@link UsageReport}s. The statusline renderer only knows
 * about the normalized shape, so adding a provider never touches rendering.
 *
 * Window semantics (matching the Codex usage convention):
 * - `primary`   short rolling window (Codex 5h, Z.ai 5h)
 * - `secondary` long window          (Codex weekly, Z.ai weekly)
 * - `usedPercent` is how much of the quota is consumed (0–100). Bars render
 *   the REMAINING share, exactly like the Codex usage extension.
 */

export type ProviderModel = {
	provider: string;
	id: string;
	name?: string;
};

export type UsageWindow = {
	usedPercent: number;
	/** Epoch ms when the window resets, when the provider reports it. */
	resetAt?: number;
};

export type UsageSnapshot = {
	/** Provider-specific bucket id ("codex", "spark", "zai", ...). */
	limitId: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	/** Free-form provider annotations surfaced in the statusline label. */
	meta?: Record<string, string | undefined>;
};

export type UsageReport = {
	capturedAt: number;
	snapshots: UsageSnapshot[];
};

export type UsageQueryError = {
	source: string;
	message: string;
	cause?: unknown;
};

export type UsageQueryResult =
	| { ok: true; report: UsageReport }
	| { ok: false; errors: UsageQueryError[] };

export type ApiKeyHeadersResult = {
	ok: boolean;
	error?: string;
	apiKey?: string;
	headers?: Record<string, string | null> | null;
};

/**
 * Structural subset of pi's ModelRegistry the adapters rely on. Declared
 * loosely so ExtensionContext satisfies it structurally in both the TUI and
 * test harnesses.
 */
export type QueryModelRegistry = {
	getApiKeyForProvider?(provider: string): Promise<string | null | undefined>;
	getApiKeyAndHeaders?(model: any): Promise<ApiKeyHeadersResult>;
	getAvailable?(): any[];
	getAll?(): any[];
};

export type QueryContext = {
	model?: ProviderModel | undefined;
	modelRegistry: QueryModelRegistry;
};

/**
 * A provider adapter. Implementations must be side-effect free apart from
 * their outbound usage query.
 */
export interface UsageProvider {
	id: string;
	/** Statusline label for the active model bucket ("codex", "spark", "zai"). */
	label(model?: ProviderModel): string;
	matchesModel(model: ProviderModel | undefined): boolean;
	/** Pick the bucket that applies to the active model, if any. */
	selectSnapshot(
		report: UsageReport,
		model: ProviderModel | undefined,
	): UsageSnapshot | undefined;
	query(
		ctx: QueryContext,
		model: ProviderModel | undefined,
		timeoutMs: number,
	): Promise<UsageReport>;
}
