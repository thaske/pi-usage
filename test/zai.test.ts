import { describe, expect, test } from "bun:test";
import { normalizeZaiPayload, zaiProvider } from "../src/providers/zai";

const zaiModel = { provider: "zai", id: "glm-4.7", name: "GLM-4.7" };

/** Mirrors the live coding-plan payload after the credits migration. */
function creditPayload(fiveHourPct: number, weeklyPct: number, level = "lite") {
	return {
		code: 200,
		msg: "Operation successful",
		success: true,
		data: {
			level,
			limits: [
				{
					type: "CREDIT_LIMIT",
					unit: 3,
					number: 5,
					usage: 2000,
					currentValue: 723,
					remaining: 1276,
					percentage: fiveHourPct,
					nextResetTime: 1787957567164,
				},
				{
					type: "CREDIT_LIMIT",
					unit: 6,
					number: 1,
					usage: 10000,
					currentValue: 723,
					remaining: 9276,
					percentage: weeklyPct,
					nextResetTime: 1788544065998,
				},
			],
		},
	};
}

describe("zaiProvider", () => {
	test("matches only zai models", () => {
		expect(zaiProvider.matchesModel(zaiModel)).toBe(true);
		expect(zaiProvider.matchesModel({ provider: "openai-codex", id: "x" })).toBe(false);
		expect(zaiProvider.matchesModel(undefined)).toBe(false);
	});

	test("selects the single zai snapshot", () => {
		const report = normalizeZaiPayload(creditPayload(36, 7) as any, Date.now());
		expect(zaiProvider.selectSnapshot(report, zaiModel)?.meta?.level).toBe("lite");
	});
});

describe("normalizeZaiPayload", () => {
	test("normalizes the live credit payload into primary/secondary windows", () => {
		const report = normalizeZaiPayload(creditPayload(36, 7) as any, Date.now());
		expect(report.snapshots).toHaveLength(1);
		const snapshot = report.snapshots[0];
		expect(snapshot?.limitId).toBe("zai");
		expect(snapshot?.primary?.usedPercent).toBe(36);
		expect(snapshot?.primary?.resetAt).toBe(1787957567164);
		expect(snapshot?.secondary?.usedPercent).toBe(7);
		expect(snapshot?.secondary?.resetAt).toBe(1788544065998);
		expect(snapshot?.meta?.level).toBe("lite");
	});

	test("accepts legacy TOKENS_LIMIT payloads and a mix of both types", () => {
		const legacy = normalizeZaiPayload({
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, percentage: 20, nextResetTime: 1000 },
					{ type: "TOKENS_LIMIT", unit: 6, percentage: 30 },
				],
			},
		} as any, Date.now());
		expect(legacy.snapshots[0]?.primary?.usedPercent).toBe(20);
		expect(legacy.snapshots[0]?.secondary?.usedPercent).toBe(30);

		const mixed = normalizeZaiPayload({
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, percentage: 10 },
					{ type: "CREDIT_LIMIT", unit: 6, percentage: 55 },
				],
			},
		} as any, Date.now());
		expect(mixed.snapshots[0]?.primary?.usedPercent).toBe(10);
		expect(mixed.snapshots[0]?.secondary?.usedPercent).toBe(55);
	});

	test("ignores the monthly TIME_LIMIT tools budget", () => {
		const report = normalizeZaiPayload({
			data: {
				limits: [
					{ type: "TIME_LIMIT", unit: 5, percentage: 100 },
					{ type: "CREDIT_LIMIT", unit: 3, percentage: 12 },
				],
			},
		} as any, Date.now());
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(12);
		expect(report.snapshots[0]?.secondary).toBeUndefined();
	});

	test("omits meta when level is absent", () => {
		const report = normalizeZaiPayload({
			data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 1 }] },
		} as any, Date.now());
		expect(report.snapshots[0]?.meta).toBeUndefined();
	});

	test("throws on the 200-wrapped auth error body", () => {
		expect(() =>
			normalizeZaiPayload({ code: 401, msg: "token expired or incorrect", success: false } as any, Date.now()),
		).toThrow("token expired or incorrect");
	});

	test("throws when no quota windows are present", () => {
		expect(() => normalizeZaiPayload({ data: { limits: [] } } as any, Date.now())).toThrow("no displayable");
		expect(() => normalizeZaiPayload({ data: {} } as any, Date.now())).toThrow("no displayable");
	});

	test("query reports unavailable errors for missing auth", async () => {
		const emptyRegistry = { modelRegistry: {} };
		await expect(zaiProvider.query(emptyRegistry as any, zaiModel, 1000)).rejects.toThrow("No Z.ai API key");
	});

	test("query attaches the bearer token and parses the response", async () => {
		const originalFetch = global.fetch;
		let authHeader: string | undefined;
		global.fetch = (async (_url: any, init: any) => {
			authHeader = init?.headers?.Authorization;
			return new Response(JSON.stringify(creditPayload(36, 7)), { status: 200 });
		}) as any;
		try {
			const report = await zaiProvider.query(
				{ modelRegistry: { getApiKeyForProvider: async () => "test-key" } } as any,
				zaiModel,
				1000,
			);
			expect(authHeader).toBe("Bearer test-key");
			expect(report.snapshots[0]?.primary?.usedPercent).toBe(36);
		} finally {
			global.fetch = originalFetch;
		}
	});
});
