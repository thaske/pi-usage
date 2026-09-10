import { describe, expect, test } from "bun:test";
import { normalizeOpencodeGoPayload, opencodeGoProvider } from "../src/providers/opencodeGo";

const opencodeGoModel = { provider: "opencode-go", id: "glm-5.2", name: "GLM-5.2" };

const ROLLING_RESET = "2026-08-13T16:27:38.287Z";
const WEEKLY_RESET = "2026-08-17T00:00:00.287Z";
const MONTHLY_RESET = "2026-09-13T06:06:01.287Z";

/** Mirrors the live /zen/go/v1/usage payload shape. */
function usagePayload(rollingPct = 4, weeklyPct = 3, monthlyPct = 1) {
	return {
		usage: {
			rolling: { status: "ok", percent: rollingPct, resetsAt: ROLLING_RESET },
			weekly: { status: "ok", percent: weeklyPct, resetsAt: WEEKLY_RESET },
			monthly: { status: "ok", percent: monthlyPct, resetsAt: MONTHLY_RESET },
		},
	};
}

describe("opencodeGoProvider", () => {
	test("matches only opencode-go models", () => {
		expect(opencodeGoProvider.matchesModel(opencodeGoModel)).toBe(true);
		expect(opencodeGoProvider.matchesModel({ provider: "opencode", id: "x" })).toBe(false);
		expect(opencodeGoProvider.matchesModel({ provider: "zai", id: "glm-4.7" })).toBe(false);
		expect(opencodeGoProvider.matchesModel(undefined)).toBe(false);
	});

	test("labels the provider and selects its snapshot", () => {
		expect(opencodeGoProvider.label()).toBe("opencode-go");
		const report = normalizeOpencodeGoPayload(usagePayload() as any, Date.now());
		expect(opencodeGoProvider.selectSnapshot(report, opencodeGoModel)?.limitId).toBe("opencode-go");
	});

	test("query reports unavailable errors for missing auth", async () => {
		await expect(
			opencodeGoProvider.query({ modelRegistry: {} } as any, opencodeGoModel, 1000),
		).rejects.toThrow("No OpenCode API key");
	});

	test("query attaches the bearer token and parses the response", async () => {
		const originalFetch = global.fetch;
		let authHeader: string | undefined;
		let url: any;
		global.fetch = (async (input: any, init: any) => {
			url = input;
			authHeader = init?.headers?.Authorization;
			return new Response(JSON.stringify(usagePayload(4, 3, 1)), { status: 200 });
		}) as any;
		try {
			const report = await opencodeGoProvider.query(
				{ modelRegistry: { getApiKeyForProvider: async () => "test-key" } } as any,
				opencodeGoModel,
				1000,
			);
			expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
			expect(authHeader).toBe("Bearer test-key");
			expect(report.snapshots[0]?.primary?.usedPercent).toBe(4);
		} finally {
			global.fetch = originalFetch;
		}
	});
});

describe("normalizeOpencodeGoPayload", () => {
	test("maps rolling/weekly/monthly into primary/secondary/tertiary", () => {
		const report = normalizeOpencodeGoPayload(usagePayload(4, 3, 1) as any, Date.now());
		expect(report.snapshots).toHaveLength(1);
		const snapshot = report.snapshots[0];
		expect(snapshot?.limitId).toBe("opencode-go");
		expect(snapshot?.primary).toEqual({
			usedPercent: 4,
			resetAt: Date.parse(ROLLING_RESET),
			windowDurationSeconds: 5 * 60 * 60,
			windowLabel: "5h",
		});
		expect(snapshot?.secondary).toEqual({
			usedPercent: 3,
			resetAt: Date.parse(WEEKLY_RESET),
			windowDurationSeconds: 7 * 24 * 60 * 60,
			windowLabel: "weekly",
		});
		expect(snapshot?.tertiary).toEqual({
			usedPercent: 1,
			resetAt: Date.parse(MONTHLY_RESET),
			windowLabel: "monthly",
		});
	});

	test("treats a rate-limited window without a percent as fully consumed", () => {
		const report = normalizeOpencodeGoPayload(
			{ usage: { rolling: { status: "rate-limited", resetsAt: ROLLING_RESET } } } as any,
			Date.now(),
		);
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(100);
	});

	test("drops windows with an unknown status and no percent", () => {
		const report = normalizeOpencodeGoPayload(
			{ usage: { rolling: { status: "ok" }, weekly: { status: "ok", percent: 12 } } } as any,
			Date.now(),
		);
		expect(report.snapshots[0]?.primary).toBeUndefined();
		expect(report.snapshots[0]?.secondary?.usedPercent).toBe(12);
	});

	test("clamps out-of-range percentages", () => {
		const report = normalizeOpencodeGoPayload(
			{ usage: { rolling: { status: "ok", percent: 140 }, weekly: { status: "ok", percent: -5 } } } as any,
			Date.now(),
		);
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(100);
		expect(report.snapshots[0]?.secondary?.usedPercent).toBe(0);
	});

	test("throws when no displayable windows are present", () => {
		expect(() => normalizeOpencodeGoPayload({ usage: {} } as any, Date.now())).toThrow("no displayable");
		expect(() => normalizeOpencodeGoPayload({ usage: { rolling: null } } as any, Date.now())).toThrow(
			"no displayable",
		);
		expect(() => normalizeOpencodeGoPayload({} as any, Date.now())).toThrow("was not an object");
	});
});
