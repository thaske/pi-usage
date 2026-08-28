/**
 * pi-usage — unified statusline usage bars for pi coding providers.
 *
 * Renders the active model's provider usage as a Codex-style braille bar
 * with countdown annotations. Providers are pluggable adapters that
 * normalize their quota APIs into shared snapshots; adding a provider means
 * implementing {@link UsageProvider} and registering it in PROVIDERS.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatLoadingBar } from "./braille";
import { nextResetCountdownDelayForRemainingMs } from "./countdown";
import { codexProvider } from "./providers/codex";
import { zaiProvider } from "./providers/zai";
import {
	formatBar,
	formatLoadingStatusline,
	formatProblemStatusline,
	formatStatusline,
	isUsageUnavailable,
} from "./statusline";
import type {
	ProviderModel,
	UsageProvider,
	UsageQueryResult,
	UsageReport,
} from "./types";

const PROVIDERS: UsageProvider[] = [codexProvider, zaiProvider];

const STATUS_KEY = "pi-usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const REFRESH_INTERVAL_MS = 60 * SECOND_MS;
const PROVISIONAL_RETRY_MS = SECOND_MS;
const FULL_AVAILABILITY_CONFIRMATION_MS = 15 * SECOND_MS;
const LOADING_FRAME_MS = 30;
const REDRAW_BLINK_MS = 150;
const MAX_FAILED_REFRESHES = 5;

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

type CachedReport = {
	providerId: string;
	createdAt: number;
	report: UsageReport;
};

function activeProvider(model: ProviderModel | undefined): UsageProvider | undefined {
	return PROVIDERS.find((provider) => provider.matchesModel(model));
}

function isActiveModel(model: ProviderModel | undefined): boolean {
	return activeProvider(model) !== undefined;
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("ctx is stale");
}

function handleTimerError(error: unknown): void {
	if (isStaleExtensionContextError(error)) return;
	throw error;
}

function handleAsyncTimerError(error: unknown): void {
	handleTimerError(error);
}

/** Fully-unused reports can be provisional right after a reset; confirm before trusting. */
function isFullyAvailableReport(
	report: UsageReport,
	provider: UsageProvider,
	model: ProviderModel | undefined,
): boolean {
	const snapshot = provider.selectSnapshot(report, model);
	const windows = [snapshot?.primary, snapshot?.secondary].filter(
		(window): window is NonNullable<typeof window> => window !== undefined,
	);
	return (
		windows.length > 0 &&
		windows.every((window) => window.usedPercent === 0)
	);
}

function nextResetCountdownDelayMs(
	report: UsageReport,
	provider: UsageProvider,
	model: ProviderModel | undefined,
	now: number,
): number | undefined {
	const snapshot = provider.selectSnapshot(report, model);
	const resetTimes: (number | undefined)[] = [snapshot?.secondary?.resetAt ?? snapshot?.primary?.resetAt];
	if (snapshot?.secondary && (snapshot.primary?.usedPercent ?? 0) >= 100) {
		resetTimes.push(snapshot.primary?.resetAt);
	}
	const delays = resetTimes
		.filter((resetAt): resetAt is number => resetAt !== undefined)
		.map((resetAt) => nextResetCountdownDelayForRemainingMs(resetAt - now))
		.filter((delay): delay is number => delay !== undefined);
	return delays.length > 0 ? Math.min(...delays) : undefined;
}

export default function piUsage(pi: ExtensionAPI) {
	let cache: CachedReport | undefined;
	let failedRefreshes = 0;
	let inFlightUsageQuery: { providerId: string; promise: Promise<UsageQueryResult> } | undefined;
	let statuslineBlinkTimer: TimeoutHandle | undefined;
	let statuslineClearTimer: TimeoutHandle | undefined;
	let statuslineCountdownTimer: TimeoutHandle | undefined;
	let statuslineLoadingTimer: TimeoutHandle | undefined;
	let statuslineRefreshTimer: TimeoutHandle | undefined;
	let statuslineLoadingFrame = 0;
	let statuslineLoadingProviderId: string | undefined;
	let statuslineRequestId = 0;
	let provisionalFullReport: { providerId: string; firstSeenAt: number } | undefined;

	const clearStatuslineTimers = () => {
		if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
		if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineBlinkTimer = undefined;
		statuslineClearTimer = undefined;
		statuslineCountdownTimer = undefined;
		statuslineLoadingTimer = undefined;
		statuslineLoadingProviderId = undefined;
		statuslineRefreshTimer = undefined;
	};

	const stopStatuslineLoading = () => {
		if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
		statuslineLoadingTimer = undefined;
		statuslineLoadingProviderId = undefined;
	};

	const startStatuslineLoading = (
		ctx: ExtensionContext,
		provider: UsageProvider,
	) => {
		if (statuslineLoadingTimer && statuslineLoadingProviderId === provider.id) return;
		stopStatuslineLoading();
		statuslineLoadingFrame = Math.random() < 0.5 ? 0 : 19;
		statuslineLoadingProviderId = provider.id;
		const drawNextFrame = () => {
			try {
				ctx.ui.setStatus(STATUS_KEY, formatLoadingStatusline(ctx.ui.theme, provider, statuslineLoadingFrame));
				statuslineLoadingFrame += 1;
				statuslineLoadingTimer = setTimeout(drawNextFrame, LOADING_FRAME_MS) as TimeoutHandle;
				statuslineLoadingTimer.unref?.();
			} catch (error) {
				statuslineLoadingTimer = undefined;
				handleTimerError(error);
			}
		};
		drawNextFrame();
	};

	const clearUsageStatusline = (ctx: ExtensionContext) => {
		statuslineRequestId += 1;
		clearStatuslineTimers();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		statuslineClearTimer = setTimeout(() => {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				statuslineClearTimer = undefined;
			} catch (error) {
				handleTimerError(error);
			}
		}, REFRESH_INTERVAL_MS) as TimeoutHandle;
		statuslineClearTimer.unref?.();
	};

	const scheduleStatuslineRefresh = (ctx: ExtensionContext, delayMs = REFRESH_INTERVAL_MS) => {
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineRefreshTimer = setTimeout(() => {
			void refreshCurrentUsageStatusline(ctx, true).catch(handleAsyncTimerError);
		}, delayMs) as TimeoutHandle;
		statuslineRefreshTimer.unref?.();
	};

	const scheduleStatuslineCountdown = (
		ctx: ExtensionContext,
		provider: UsageProvider,
		report: UsageReport,
		model: ProviderModel | undefined,
	) => {
		if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
		const delayMs = nextResetCountdownDelayMs(report, provider, model, Date.now());
		if (delayMs === undefined) {
			statuslineCountdownTimer = undefined;
			return;
		}
		statuslineCountdownTimer = setTimeout(() => {
			try {
				if (provider.matchesModel(ctx.model as ProviderModel | undefined)) {
					const snapshot = provider.selectSnapshot(report, model);
					ctx.ui.setStatus(STATUS_KEY, formatStatusline(ctx.ui.theme, provider, snapshot));
					scheduleStatuslineCountdown(ctx, provider, report, model);
				}
			} catch (error) {
				handleTimerError(error);
			}
		}, delayMs) as TimeoutHandle;
		statuslineCountdownTimer.unref?.();
	};

	const setUsageStatusline = (
		ctx: ExtensionContext,
		provider: UsageProvider,
		report: UsageReport,
		options: { autoRefresh: boolean; blink: boolean; model: ProviderModel | undefined },
	) => {
		if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
		stopStatuslineLoading();
		statuslineBlinkTimer = undefined;
		statuslineClearTimer = undefined;
		statuslineCountdownTimer = undefined;
		const model = options.model;
		const snapshot = provider.selectSnapshot(report, model);
		const text = formatStatusline(ctx.ui.theme, provider, snapshot);
		if (options.blink) {
			ctx.ui.setStatus(STATUS_KEY, formatLoadingStatusline(ctx.ui.theme, provider, statuslineLoadingFrame));
			statuslineBlinkTimer = setTimeout(() => {
				try {
					ctx.ui.setStatus(STATUS_KEY, text);
					scheduleStatuslineCountdown(ctx, provider, report, model);
					statuslineBlinkTimer = undefined;
				} catch (error) {
					handleTimerError(error);
				}
			}, REDRAW_BLINK_MS) as TimeoutHandle;
			statuslineBlinkTimer.unref?.();
		} else {
			ctx.ui.setStatus(STATUS_KEY, text);
			scheduleStatuslineCountdown(ctx, provider, report, model);
		}
		if (options.autoRefresh) scheduleStatuslineRefresh(ctx);
		else scheduleTemporaryStatuslineClear(ctx);
	};

	const queryCurrentUsage = (
		ctx: ExtensionContext,
		provider: UsageProvider,
		model: ProviderModel | undefined,
	): Promise<UsageQueryResult> => {
		if (inFlightUsageQuery?.providerId === provider.id) return inFlightUsageQuery.promise;
		const promise = queryUsage(ctx, provider, model).finally(() => {
			if (inFlightUsageQuery?.promise === promise) inFlightUsageQuery = undefined;
		});
		inFlightUsageQuery = { providerId: provider.id, promise };
		return promise;
	};

	const refreshCurrentUsageStatusline = async (
		ctx: ExtensionContext,
		force: boolean,
		modelOverride?: ProviderModel,
	) => {
		try {
			const model = modelOverride ?? (ctx.model as ProviderModel | undefined);
			const provider = activeProvider(model);
			if (!provider) {
				clearUsageStatusline(ctx);
				return;
			}

			const usableCache =
				cache && cache.providerId === provider.id && provider.selectSnapshot(cache.report, model)
					? cache
					: undefined;
			if (usableCache) {
				setUsageStatusline(ctx, provider, usableCache.report, { autoRefresh: true, blink: false, model });
			} else {
				startStatuslineLoading(ctx, provider);
			}
			const requestId = statuslineRequestId + 1;
			statuslineRequestId = requestId;
			const freshCache =
				usableCache && Date.now() - usableCache.createdAt < REFRESH_INTERVAL_MS ? usableCache : undefined;
			if (freshCache && !force) {
				setUsageStatusline(ctx, provider, freshCache.report, { autoRefresh: true, blink: false, model });
				return;
			}

			const result = await queryCurrentUsage(ctx, provider, model);
			if (requestId !== statuslineRequestId) return;
			if (!provider.matchesModel(ctx.model as ProviderModel | undefined)) {
				clearUsageStatusline(ctx);
				return;
			}

			if (!result.ok) {
				failedRefreshes += 1;
				const activeCache =
					cache && cache.providerId === provider.id && provider.selectSnapshot(cache.report, model)
						? cache
						: undefined;
				if (!activeCache || failedRefreshes >= MAX_FAILED_REFRESHES) {
					stopStatuslineLoading();
					ctx.ui.setStatus(STATUS_KEY, formatProblemStatusline(ctx.ui.theme, provider, result.errors));
				}
				scheduleStatuslineRefresh(ctx);
				return;
			}

			const previousReport = cache?.providerId === provider.id ? cache.report : undefined;
			const previousWasFullyAvailable = previousReport
				? isFullyAvailableReport(previousReport, provider, model)
				: false;
			if (isFullyAvailableReport(result.report, provider, model) && !previousWasFullyAvailable) {
				const now = Date.now();
				if (provisionalFullReport?.providerId !== provider.id) {
					provisionalFullReport = { providerId: provider.id, firstSeenAt: now };
				}
				if (now - provisionalFullReport.firstSeenAt < FULL_AVAILABILITY_CONFIRMATION_MS) {
					scheduleStatuslineRefresh(ctx, PROVISIONAL_RETRY_MS);
					return;
				}
			} else {
				provisionalFullReport = undefined;
			}
			const previousSnapshot = previousReport ? provider.selectSnapshot(previousReport, model) : undefined;
			const blink = previousReport
				? formatBar(previousSnapshot) !== formatBar(provider.selectSnapshot(result.report, model))
				: false;
			failedRefreshes = 0;
			provisionalFullReport = undefined;
			cache = { providerId: provider.id, createdAt: Date.now(), report: result.report };
			setUsageStatusline(ctx, provider, result.report, { autoRefresh: true, blink, model });
		} catch (error) {
			if (isStaleExtensionContextError(error)) {
				clearStatuslineTimers();
				return;
			}
			throw error;
		}
	};

	async function queryUsage(
		ctx: ExtensionContext,
		provider: UsageProvider,
		model: ProviderModel | undefined,
	): Promise<UsageQueryResult> {
		try {
			const report = await provider.query(ctx, model, DEFAULT_TIMEOUT_MS);
			return { ok: true, report };
		} catch (cause) {
			return {
				ok: false,
				errors: [{ source: provider.id, message: cause instanceof Error ? cause.message : String(cause), cause }],
			};
		}
	}

	pi.registerCommand("usage", {
		description: "Show current coding-provider usage quota",
		handler: async (_args, ctx) => {
			const model = ctx.model as ProviderModel | undefined;
			const provider = activeProvider(model);
			if (!provider) {
				ctx.ui.notify("No usage provider matches the active model.", "info");
				return;
			}
			ctx.ui.notify(`Querying ${provider.label(model)} usage…`, "info");
			const result = await queryUsage(ctx, provider, model);
			if (!result.ok) {
				ctx.ui.notify(`usage: ${result.errors.map((error) => error.message).join("; ")}`, "warning");
				return;
			}
			const snapshot = provider.selectSnapshot(result.report, model);
			if (!snapshot) {
				ctx.ui.notify("usage: no matching quota windows in the response.", "warning");
				return;
			}
			const lines: string[] = [`${provider.label(model)}${snapshot.meta?.level ? ` (${snapshot.meta.level})` : ""}`];
			const describe = (name: string, window: { usedPercent: number; resetAt?: number } | undefined) => {
				if (!window) return;
				const used = `${Math.round(window.usedPercent)}% used`;
				const reset = window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleString()}` : "";
				lines.push(`  ${name}: ${used}${reset}`);
			};
			describe("5h", snapshot.primary);
			describe("weekly", snapshot.secondary);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (isActiveModel(ctx.model as ProviderModel | undefined)) {
			void refreshCurrentUsageStatusline(ctx, false).catch(handleAsyncTimerError);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		if (isActiveModel(ctx.model as ProviderModel | undefined)) {
			void refreshCurrentUsageStatusline(ctx, false).catch(handleAsyncTimerError);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (isActiveModel(event.model as ProviderModel | undefined)) {
			void refreshCurrentUsageStatusline(ctx, false, event.model as ProviderModel).catch(
				handleAsyncTimerError,
			);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearUsageStatusline(ctx);
	});
}
