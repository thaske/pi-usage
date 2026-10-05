import { describe, expect, test } from "bun:test";
import {
	codexProvider,
	isSparkCodexModel,
	normalizeAppServerResponse,
	normalizeBackendPayload,
} from "../src/providers/codex";

const regularCodex = { provider: "openai-codex", id: "gpt-5.2-codex", name: "GPT-5.2-Codex" };
const nativeModel = { provider: "openai", id: "gpt-6-luna", name: "GPT-6-Luna" };
const nativeCodex = { provider: "openai", id: "gpt-5.3-codex", name: "GPT-5.3-Codex" };
const sparkCodex = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" };
const nativeSpark = { provider: "openai", id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" };
const nativeOAuthContext = { modelRegistry: { isUsingOAuth: (model: { provider: string }) => model.provider === "openai" } };
const nativeApiKeyContext = { modelRegistry: { isUsingOAuth: () => false } };

describe("codexProvider", () => {
	test("matches every native openai model only with ChatGPT OAuth", () => {
		expect(codexProvider.matchesModel(regularCodex)).toBe(true);
		expect(codexProvider.matchesModel(nativeCodex, nativeOAuthContext)).toBe(true);
		expect(codexProvider.matchesModel(nativeModel, nativeOAuthContext)).toBe(true);
		expect(codexProvider.matchesModel(nativeModel, nativeApiKeyContext)).toBe(false);
		expect(codexProvider.matchesModel({ provider: "zai", id: "glm-4.7" })).toBe(false);
		expect(codexProvider.matchesModel(undefined)).toBe(false);
	});

	test("query scopes separate auth paths and buckets but share ordinary native models", () => {
		const scope = (model: typeof nativeModel) => codexProvider.queryScope!(model, nativeOAuthContext);
		expect(scope(nativeModel)).toBe(scope(nativeCodex));
		expect(scope(nativeModel)).not.toBe(scope(regularCodex));
		expect(scope(nativeModel)).not.toBe(scope(nativeSpark));
		expect(scope(nativeSpark)).not.toBe(scope(sparkCodex));
	});

	test("does not query ChatGPT usage for native OpenAI API-key auth", async () => {
		await expect(codexProvider.query({ model: nativeModel, ...nativeApiKeyContext }, nativeModel, 1000))
			.rejects.toThrow("ChatGPT OAuth");
	});

	test("labels spark models distinctly and selects their bucket", () => {
		expect(isSparkCodexModel(sparkCodex)).toBe(true);
		expect(isSparkCodexModel(nativeSpark)).toBe(true);
		expect(codexProvider.label(sparkCodex)).toBe("spark");
		expect(codexProvider.label(nativeSpark)).toBe("spark");
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
		expect(codexProvider.selectSnapshot(report, nativeSpark)?.primary?.usedPercent).toBe(100);
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
					primary_window: { used_percent: 42, reset_after_seconds: 3600, limit_window_seconds: 18_000 },
					secondary_window: { used_percent: 7, resets_at: capturedAt + 60_000, limit_window_seconds: 604_800 },
				},
			},
			capturedAt,
		);
		expect(report.snapshots).toHaveLength(1);
		expect(report.snapshots[0]?.limitId).toBe("codex");
		expect(report.snapshots[0]?.primary).toEqual({
			usedPercent: 42,
			resetAt: capturedAt + 3_600_000,
			windowDurationSeconds: 18_000,
			windowLabel: "5h",
		});
		expect(report.snapshots[0]?.secondary).toEqual({
			usedPercent: 7,
			resetAt: capturedAt + 60_000,
			windowDurationSeconds: 604_800,
			windowLabel: "weekly",
		});
	});

	test("labels a weekly-only primary window correctly", () => {
		const report = normalizeBackendPayload(
			{ rate_limit: { primary_window: { used_percent: 22, limit_window_seconds: 604_800 } } },
			Date.now(),
		);
		expect(report.snapshots[0]?.primary?.windowLabel).toBe("weekly");
		expect(report.snapshots[0]?.secondary).toBeUndefined();
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
						primary: { usedPercent: 88, resetAt: capturedAt + 1000, windowDurationMins: 300 },
						secondary: { usedPercent: 12, windowDurationMins: 10080 },
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

	test("normalizes app-server rateLimitsByLimitId buckets", () => {
		const report = normalizeAppServerResponse(
			{
				rateLimits: { limitId: "codex", primary: { usedPercent: 5 } },
				rateLimitsByLimitId: {
					codex: { limitId: "codex", primary: { usedPercent: 45 } },
					spark: { limitId: "spark", primary: { usedPercent: 80 } },
				},
			},
			Date.now(),
		);
		expect(report.snapshots).toHaveLength(2);
		expect(codexProvider.selectSnapshot(report, nativeCodex)?.primary?.usedPercent).toBe(45);
		expect(codexProvider.selectSnapshot(report, nativeSpark)?.primary?.usedPercent).toBe(80);
	});

	test("preserves fallback Codex when the map contains only Spark", () => {
		const report = normalizeAppServerResponse({
			rateLimits: { primary: { usedPercent: 40 } },
			rateLimitsByLimitId: { spark: { primary: { usedPercent: 80 } } },
		}, Date.now());
		expect(codexProvider.selectSnapshot(report, nativeModel)?.primary?.usedPercent).toBe(40);
		expect(codexProvider.selectSnapshot(report, nativeSpark)?.primary?.usedPercent).toBe(80);
	});

	test("merges partial map windows over fallback windows for the same bucket", () => {
		const report = normalizeAppServerResponse({
			rateLimits: { limitId: "codex", primary: { usedPercent: 5 }, secondary: { usedPercent: 20 } },
			rateLimitsByLimitId: { codex: { primary: { usedPercent: 45 } } },
		}, Date.now());
		expect(report.snapshots).toHaveLength(1);
		expect(report.snapshots[0]?.primary?.usedPercent).toBe(45);
		expect(report.snapshots[0]?.secondary?.usedPercent).toBe(20);
	});

	test("uses fallback windows when the map is empty or unusable", () => {
		for (const rateLimitsByLimitId of [{}, null, { codex: { primary: {} } }]) {
			const report = normalizeAppServerResponse({
				rateLimits: { primary: { usedPercent: 40 } }, rateLimitsByLimitId,
			}, Date.now());
			expect(report.snapshots[0]?.primary?.usedPercent).toBe(40);
		}
	});

	test("throws when the response has no windows", () => {
		expect(() => normalizeAppServerResponse({ rateLimits: [] }, Date.now())).toThrow("no displayable");
	});
});
