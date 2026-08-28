/**
 * Statusline composition: turns a normalized snapshot into the themed
 * "label ▉▊ annotation" string, following the Codex usage conventions:
 * - accent-colored label ("codex", "spark", "zai", "zai(lite)")
 * - braille bar on a selected background, or tool-error background when a
 *   displayed window is exhausted
 * - dim countdown annotation for the long window; when the short window is
 *   exhausted, "shortCountdown/longCountdown"
 * - single-window snapshots degrade to "42% 3.2h" text without a background
 */

import {
	formatAdaptiveBar,
	formatLoadingBar,
	remainingPercent,
} from "./braille";
import { formatResetCountdown } from "./countdown";
import type { UsageProvider, UsageQueryError, UsageSnapshot } from "./types";

export type ThemeApi = {
	fg(role: string, text: string): string;
	bg(role: string, text: string): string;
};

export function isWindowExhausted(usedPercent: number | undefined): boolean {
	return usedPercent !== undefined && remainingPercent(usedPercent) <= 0;
}

export function snapshotExhausted(snapshot: UsageSnapshot | undefined): boolean {
	return isWindowExhausted(snapshot?.primary?.usedPercent) || isWindowExhausted(snapshot?.secondary?.usedPercent);
}

/** Statusline label for a snapshot, including provider meta ("zai(lite)"). */
export function statusLabel(
	provider: UsageProvider,
	snapshot: UsageSnapshot | undefined,
): string {
	const base = provider.label();
	const level = snapshot?.meta?.level;
	return level ? `${base}(${level})` : base;
}

/** The bare bar (no label/annotation), used for blink-on-change detection. */
export function formatBar(snapshot: UsageSnapshot | undefined): string | undefined {
	if (!snapshot || (!snapshot.primary && !snapshot.secondary)) return undefined;
	return formatAdaptiveBar(snapshot.primary?.usedPercent, snapshot.secondary?.usedPercent);
}

/** "▛▚ 5.5d", "42% 3.2h", "▟▄ 18m/1.2d" — bar plus annotations. */
export function formatStatusValue(
	snapshot: UsageSnapshot | undefined,
	now = Date.now(),
): string | undefined {
	if (!snapshot || (!snapshot.primary && !snapshot.secondary)) return undefined;

	if (!snapshot.primary || !snapshot.secondary) {
		const window = snapshot.primary ?? snapshot.secondary;
		if (!window) return undefined;
		const percentage = `${Math.round(remainingPercent(window.usedPercent))}%`;
		const countdown = window.resetAt ? formatResetCountdown(window.resetAt, now) : undefined;
		return countdown ? `${percentage} ${countdown}` : percentage;
	}

	const bar = formatAdaptiveBar(snapshot.primary.usedPercent, snapshot.secondary.usedPercent);
	if (isWindowExhausted(snapshot.primary.usedPercent) && snapshot.primary.resetAt) {
		const primaryCountdown = formatResetCountdown(snapshot.primary.resetAt, now);
		const secondaryCountdown = snapshot.secondary.resetAt
			? formatResetCountdown(snapshot.secondary.resetAt, now)
			: undefined;
		return secondaryCountdown
			? `${bar} ${primaryCountdown}/${secondaryCountdown}`
			: `${bar} ${primaryCountdown}`;
	}
	const countdown = snapshot.secondary.resetAt
		? formatResetCountdown(snapshot.secondary.resetAt, now)
		: undefined;
	return countdown ? `${bar} ${countdown}` : bar;
}

export function formatStatusline(
	theme: ThemeApi,
	provider: UsageProvider,
	snapshot: UsageSnapshot | undefined,
	now = Date.now(),
): string {
	const label = theme.fg("accent", statusLabel(provider, snapshot));
	const value = formatStatusValue(snapshot, now) ?? "n/a";
	if (!snapshot?.primary || !snapshot.secondary) {
		return `${label} ${theme.fg("dim", value)}`;
	}
	const [bar = "", countdown] = value.split(" ", 2);
	const background = snapshotExhausted(snapshot) ? "toolErrorBg" : "selectedBg";
	const barText = `${label} ${theme.bg(background, theme.fg("dim", bar))}`;
	return countdown ? `${barText} ${theme.fg("dim", countdown)}` : barText;
}

export function formatLoadingStatusline(
	theme: ThemeApi,
	provider: UsageProvider,
	frame: number,
): string {
	const label = theme.fg("accent", provider.label());
	const bar = theme.bg("selectedBg", theme.fg("dim", formatLoadingBar(frame)));
	return `${label} ${bar}`;
}

export function formatProblemStatusline(
	theme: ThemeApi,
	provider: UsageProvider,
	errors: UsageQueryError[],
): string {
	const label = theme.fg("accent", provider.label());
	const value = isUsageUnavailable(errors)
		? theme.fg("muted", "n/a")
		: theme.fg("error", "error");
	return `${label} ${value}`;
}

/** All errors look like "no data for this account" rather than transient faults. */
export function isUsageUnavailable(errors: UsageQueryError[]): boolean {
	return errors.length > 0 && errors.every(isUnavailableError);
}

function isUnavailableError(error: UsageQueryError): boolean {
	const message = error.message.toLowerCase();
	return (
		message.includes("no pi openai codex subscription auth") ||
		message.includes("no z.ai api key was available") ||
		message.includes("no displayable") ||
		message.includes("returned no displayable") ||
		message.includes("returned 401") ||
		message.includes("returned 403") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("token expired") ||
		message.includes("subscription") ||
		message.includes("no active plan") ||
		message.includes("plan unavailable") ||
		message.includes("quota unavailable") ||
		message.includes("rate limits unavailable")
	);
}
