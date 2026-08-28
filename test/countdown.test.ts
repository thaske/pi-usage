import { describe, expect, test } from "bun:test";
import {
	HOUR_MS,
	HOUR_TENTH_MS,
	MINUTE_MS,
	formatResetCountdown,
	nextResetCountdownDelayForRemainingMs,
} from "../src/countdown";

describe("formatResetCountdown", () => {
	test("renders tenths of days above one day", () => {
		expect(formatResetCountdown(Date.now() + 36 * HOUR_MS)).toBe("1.5d");
		// 24h + 1m is 10.007 day-tenths -> ceil to 1.1d
		expect(formatResetCountdown(Date.now() + 24 * HOUR_MS + MINUTE_MS)).toBe("1.1d");
	});

	test("renders tenths of hours above one hour", () => {
		expect(formatResetCountdown(Date.now() + 90 * MINUTE_MS)).toBe("1.5h");
		expect(formatResetCountdown(Date.now() + 60 * MINUTE_MS)).toBe("1h");
	});

	test("renders minutes and seconds below one hour", () => {
		expect(formatResetCountdown(Date.now() + 42 * MINUTE_MS)).toBe("42m");
		expect(formatResetCountdown(Date.now() + 30_000)).toBe("30s");
	});

	test("clamps elapsed resets to zero", () => {
		expect(formatResetCountdown(Date.now() - 1000)).toBe("0s");
	});
});

describe("nextResetCountdownDelayForRemainingMs", () => {
	test("aligns to the next tenth-of-hour boundary", () => {
		const remaining = 90 * MINUTE_MS;
		const delay = nextResetCountdownDelayForRemainingMs(remaining);
		// 9.0h remaining -> next displayed value is 8.9h, 6 minutes from now
		expect(delay).toBe(remaining - 14 * HOUR_TENTH_MS);
	});

	test("returns undefined once the reset has passed", () => {
		expect(nextResetCountdownDelayForRemainingMs(0)).toBeUndefined();
		expect(nextResetCountdownDelayForRemainingMs(-5)).toBeUndefined();
	});

	test("sub-second delays stay positive", () => {
		expect(nextResetCountdownDelayForRemainingMs(500)).toBeGreaterThan(0);
	});
});
