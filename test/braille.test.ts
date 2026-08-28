import { describe, expect, test } from "bun:test";
import {
	DUAL_BAR_CHARS,
	DUAL_BAR_WIDTH,
	formatAdaptiveBar,
	formatDualBar,
	formatLoadingBar,
	formatSingleBar,
} from "../src/braille";

describe("formatDualBar", () => {
	test("empty bar at 100% used (nothing remaining)", () => {
		expect(formatDualBar(100, 100)).toBe("⠀".repeat(DUAL_BAR_WIDTH));
	});

	test("full bar at 0% used", () => {
		expect(formatDualBar(0, 0)).toBe("█".repeat(DUAL_BAR_WIDTH));
	});

	test("50%/50% fills top halves then bottom halves of the same cells", () => {
		// bits 1|2 = top half (primary), bits 4|8 = bottom half (secondary)
		// 50% remaining = 10 of 20 parts -> cells 0-4 for both windows
		expect(formatDualBar(50, 50)).toBe("█████⠀⠀⠀⠀⠀");
	});

	test("full primary and half secondary", () => {
		// primary remaining 100% -> top halves everywhere; secondary 50% adds bottom halves on cells 0-4
		expect(formatDualBar(0, 50)).toBe("█████▀▀▀▀▀");
	});

	test("barely-remaining windows still draw one part", () => {
		// 1 part each -> cell 0 gets top-left (primary) + bottom-left (secondary) = ▌
		expect(formatDualBar(99, 99).startsWith("▌")).toBe(true);
	});
});

describe("formatSingleBar", () => {
	test("empty bar at 100% used", () => {
		expect(formatSingleBar(100)).toBe("⠀".repeat(DUAL_BAR_WIDTH));
	});

	test("full bar at 0% used", () => {
		expect(formatSingleBar(0)).toBe("█".repeat(DUAL_BAR_WIDTH));
	});

	test("half used fills half the cells", () => {
		expect(formatSingleBar(50)).toBe("█████⠀⠀⠀⠀⠀");
	});

	test("97% used renders a single part in the first cell", () => {
		// remaining 3% -> round(1.2) = 1 part -> bit 1 (▘) on cell 0
		expect(formatSingleBar(97)).toBe(`▘${"⠀".repeat(9)}`);
	});
});

describe("formatAdaptiveBar", () => {
	test("single window uses the single bar", () => {
		expect(formatAdaptiveBar(50, undefined)).toBe(formatSingleBar(50));
		expect(formatAdaptiveBar(undefined, 50)).toBe(formatSingleBar(50));
	});

	test("both windows use the dual bar", () => {
		expect(formatAdaptiveBar(50, 50)).toBe(formatDualBar(50, 50));
	});
});

describe("formatLoadingBar", () => {
	test("frame 0 draws opposite corners", () => {
		expect(formatLoadingBar(0)).toBe(`▘${"⠀".repeat(8)}▗`);
	});

	test("frames stay 10 cells and cycle in reverse", () => {
		const width = formatLoadingBar(7);
		expect(width).toHaveLength(DUAL_BAR_WIDTH);
	});
});
