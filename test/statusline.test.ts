import { describe, expect, test } from "bun:test";
import { HOUR_MS, MINUTE_MS } from "../src/countdown";
import {
	formatBar,
	formatLoadingStatusline,
	formatProblemStatusline,
	formatStatusValue,
	formatStatusline,
	isUsageUnavailable,
	snapshotExhausted,
	statusLabel,
} from "../src/statusline";
import { zaiProvider } from "../src/providers/zai";
import { codexProvider } from "../src/providers/codex";
import type { UsageProvider, UsageQueryError, UsageSnapshot } from "../src/types";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
};

const dualSnapshot: UsageSnapshot = {
	limitId: "zai",
	primary: { usedPercent: 36, resetAt: 1000 },
	secondary: { usedPercent: 7, resetAt: 1000 },
	meta: { level: "lite" },
};

const fakeProvider: UsageProvider = {
	id: "zai",
	label: () => "zai",
	matchesModel: (model) => model?.provider === "zai",
	selectSnapshot: (report) => report.snapshots[0],
	query: async () => {
		throw new Error("not implemented");
	},
};

describe("formatStatusValue", () => {
	test("dual windows render bar plus both countdowns when primary is exhausted", () => {
		const now = 1000;
		const value = formatStatusValue(
			{
				limitId: "zai",
				primary: { usedPercent: 100, resetAt: now + 5 * MINUTE_MS },
				secondary: { usedPercent: 50, resetAt: now + 90 * MINUTE_MS },
			},
			now,
		);
		// primary remaining 0 -> left halves empty; secondary remaining 50% -> bottom halves of cells 0-4
		expect(value).toBe("▄▄▄▄▄⠀⠀⠀⠀⠀ 5m/1.5h");
	});

	test("dual windows with a healthy primary show only the long countdown", () => {
		const now = 1000;
		const value = formatStatusValue(
			{
				limitId: "zai",
				primary: { usedPercent: 36 },
				secondary: { usedPercent: 7, resetAt: now + 90 * MINUTE_MS },
			},
			now,
		);
		expect(value?.endsWith("1.5h")).toBe(true);
	});

	test("single window degrades to percentage plus countdown", () => {
		const now = 1000;
		const value = formatStatusValue(
			{ limitId: "x", primary: { usedPercent: 42, resetAt: now + 90 * MINUTE_MS } },
			now,
		);
		expect(value).toBe("58% 1.5h");
	});

	test("returns undefined without windows", () => {
		expect(formatStatusValue(undefined)).toBeUndefined();
		expect(formatStatusValue({ limitId: "x" })).toBeUndefined();
	});
});

describe("formatStatusline", () => {
	test("labels carry provider meta and bar gets a background", () => {
		const line = formatStatusline(theme, zaiProvider, dualSnapshot, 1000);
		expect(line.startsWith("zai(lite) ")).toBe(true);
	});

	test("codex label has no suffix", () => {
		expect(statusLabel(codexProvider, undefined)).toBe("codex");
	});

	test("falls back to n/a without a snapshot", () => {
		const line = formatStatusline(theme, fakeProvider, undefined, 1000);
		expect(line).toBe("zai n/a");
	});
});

describe("snapshotExhausted", () => {
	test("true when any displayed window is exhausted", () => {
		expect(
			snapshotExhausted({
				limitId: "zai",
				primary: { usedPercent: 100 },
				secondary: { usedPercent: 10 },
			}),
		).toBe(true);
		expect(
			snapshotExhausted({
				limitId: "zai",
				primary: { usedPercent: 99 },
				secondary: { usedPercent: 100 },
			}),
		).toBe(true);
		expect(
			snapshotExhausted({
				limitId: "zai",
				primary: { usedPercent: 10 },
				secondary: { usedPercent: 20 },
			}),
		).toBe(false);
	});
});

describe("formatLoadingStatusline / formatProblemStatusline", () => {
	test("loading renders label plus animated bar", () => {
		const line = formatLoadingStatusline(theme, fakeProvider, 0);
		expect(line).toBe(`zai ▘${"⠀".repeat(8)}▗`);
	});

	test("problem renders n/a when all errors are unavailability", () => {
		const errors: UsageQueryError[] = [{ source: "zai", message: "returned 401" }];
		expect(formatProblemStatusline(theme, fakeProvider, errors)).toBe("zai n/a");
		const fatal: UsageQueryError[] = [{ source: "zai", message: "socket hang up" }];
		expect(formatProblemStatusline(theme, fakeProvider, fatal)).toBe("zai error");
		expect(isUsageUnavailable(errors)).toBe(true);
		expect(isUsageUnavailable(fatal)).toBe(false);
	});
});

describe("formatBar", () => {
	test(" adapts to window count", () => {
		expect(formatBar(dualSnapshot)).toBe(formatBar(dualSnapshot));
		expect(formatBar({ limitId: "x", primary: { usedPercent: 50 } })).toHaveLength(10);
	});
});

describe("countdown annotations use reset-aligned units", () => {
	test("day-scale countdown", () => {
		const now = 1000;
		const value = formatStatusValue(
			{
				limitId: "codex",
				primary: { usedPercent: 10 },
				secondary: { usedPercent: 20, resetAt: now + 36 * HOUR_MS },
			},
			now,
		);
		expect(value?.endsWith("1.5d")).toBe(true);
	});
});
