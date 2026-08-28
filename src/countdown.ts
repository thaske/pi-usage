/**
 * Reset countdown formatting, ported from the Codex usage convention:
 * >1 day renders in tenths of days ("1.5d"), >1 hour in tenths of hours
 * ("3.2h"), then minutes, then seconds. The companion delay helper powers
 * countdown timers that fire exactly when the displayed value changes.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const HOUR_TENTH_MS = 6 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const DAY_TENTH_MS = 144 * MINUTE_MS;

export function formatTenths(value: number): string {
	return value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1);
}

export function formatResetCountdown(resetAt: number, now = Date.now()): string {
	const remainingMs = Math.max(0, resetAt - now);
	if (remainingMs > DAY_MS) {
		const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
		return `${formatTenths(dayTenths)}d`;
	}
	if (remainingMs >= HOUR_MS) {
		const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
		return `${formatTenths(hourTenths)}h`;
	}
	if (remainingMs >= MINUTE_MS) return `${Math.floor(remainingMs / MINUTE_MS)}m`;
	return `${Math.floor(remainingMs / SECOND_MS)}s`;
}

/** Delay until the countdown display would change, or undefined if elapsed. */
export function nextResetCountdownDelayForRemainingMs(
	remainingMs: number,
): number | undefined {
	if (remainingMs <= 0) return undefined;
	if (remainingMs > DAY_MS) {
		const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
		return Math.max(1, remainingMs - (dayTenths - 1) * DAY_TENTH_MS);
	}
	if (remainingMs >= HOUR_MS) {
		const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
		if (hourTenths === 10) return Math.max(1, remainingMs - HOUR_MS + 1);
		return Math.max(1, remainingMs - (hourTenths - 1) * HOUR_TENTH_MS);
	}
	if (remainingMs >= MINUTE_MS) {
		return Math.max(
			1,
			remainingMs - Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS + 1,
		);
	}
	return Math.max(
		1,
		remainingMs - Math.floor(remainingMs / SECOND_MS) * SECOND_MS + 1,
	);
}
