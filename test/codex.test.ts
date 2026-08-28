import { describe, expect, test } from "bun:test";
import {
	codexProvider,
	isSparkCodexModel,
	normalizeAppServerResponse,
	normalizeBackendPayload,
} from "../src/providers/codex";

const regularCodex = { provider: "openai-codex", id: "gpt-5.2-codex", name: "GPT-5.2-Codex" };
const sparkCodex = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" };

describe("codexProvider", () => {
	test("matches only openai-codex models", () => {
		expect(codexProvider.matchesModel(regularCodex)).toBe(true);
		expect(codexProvider.matchesModel({ provider: "zai", id: "glm-4.7" })).toBe(false);
		expect(codexProvider.matchesModel(undefined)).toBe(false);
	});

	test("labels spark models distinctly and selects their bucket", () => {
		expect(isSparkCodexModel(sparkCodex)).toBe(true);
		expect(codexProvider.label(sparkCodex)).toBe("spark");
		expect(codexProvider.label(regularCodex)).toBe("codex");

		const report = normalizeBackendPayload(
			{
				rate_limit: { primary_window: { used_percent: 10 } },
				additional_rate_limits: [
					{
						limit_name: "codex_bengalfox",
						metered_feature: "GPT-5.3-Codex-Spark",
						rate_limit: { primary_window: { used_percent: 100 } },
					},
				],
			},
			Date.now(),
		);
		expect(codexProvider.selectSnapshot(report, regularCodex)?.primary?.usedPercent).toBe(10);
		expect(codexProvider.selectSnapshot(report, sparkCodex)?.primary?.usedPercent).toBe(100);
	});

	test("query uses pi-auth when the backend responds", async () => {
		const originalFetch = global.fetch;
		let authHeader: string | undefined;
		global.fetch = (async (_url: any, init: any) => {
			authHeader = init?.headers?.Authorization;
			return new Response(
				JSON.stringify({ rate_limit: { primary_window: { used_percent: 42 } } }),
				{ status: 200 },
			);
		}) as any;
		try {
			const report = await codexProvider.query(
				{
					model: regularCodex,
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer test" } }),
					},
				} as any,
				regularCodex,
				1000,
			);
			expect(authHeader).toBe("Bearer test");
			expect(codexProvider.selectSnapshot(report, regularCodex)?.primary?.usedPercent).toBe(42);
		} finally {
			global.fetch = originalFetch;
		}
	});
});

describe("normalizeBackendPayload", () => {
	test("normalizes primary and secondary windows with reset times", () => {
		const capturedAt = 1_700_000_000_000;
		const report = normalizeBackendPayload(
			{
				rate_limit: {
					primary_window: { used_percent: 42, reset_after_seconds: 3600 },
					secondary_window: { used_percent: 7, resets_at: capturedAt + 60_000 },
				},
			},
			capturedAt,
		);
		expect(report.snapshots).toHaveLength(1);
		expect(report.snapshots[0]?.limitId).toBe("codex");
		expect(report.snapshots[0]?.primary).toEqual({ usedPercent: 42, resetAt: capturedAt + 3_600_000 });
		expect(report.snapshots[0]?.secondary).toEqual({ usedPercent: 7, resetAt: capturedAt + 60_000 });
	});

	test("throws when no displayable windows exist", () => {
		expect(() => normalizeBackendPayload({ rate_limit: {} }, Date.now())).toThrow("no displayable");
	});
});

describe("normalizeAppServerResponse", () => {
	test("normalizes app-server rateLimits with camelCase fields", () => {
		const capturedAt = 1_700_000_000_000;
		const report = normalizeAppServerResponse(
			{
				rateLimits: [
					{
						limitId: "codex",
						primary: { usedPercent: 88, resetAt: capturedAt + 1000 },
						secondary: { usedPercent: 12 },
					},
				],
			},
			capturedAt,
		);
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(88);
		expect(report.snapshots[0]?.primary?.resetAt).toBe(capturedAt + 1000);
		expect(report.snapshots[0]?.secondary?.usedPercent).toBe(12);
	});

	test("merges duplicate limit ids", () => {
		const capturedAt = Date.now();
		const report = normalizeAppServerResponse(
			{
				rateLimits: [
					{ limitId: "codex", primary: { usedPercent: 10 } },
					{ limitId: "codex", secondary: { usedPercent: 20 } },
				],
			},
			capturedAt,
		);
		expect(report.snapshots).toHaveLength(1);
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(10);
		expect(report.snapshots[0]?.secondary?.usedPercent).toBe(20);
	});

	test("throws when the response has no windows", () => {
		expect(() => normalizeAppServerResponse({ rateLimits: [] }, Date.now())).toThrow("no displayable");
	});
});
