import { describe, expect, test } from "bun:test";
import { codexProvider } from "../src/providers/codex";
import { opencodeGoProvider } from "../src/providers/opencodeGo";
import { zaiProvider } from "../src/providers/zai";
import { isQuotaExhausted, parseQuotaStatusRequest } from "../src/quota";
import type { UsageReport } from "../src/types";

const codexModel = { provider: "openai-codex", id: "gpt-5.2-codex", name: "GPT-5.2-Codex" };
const sparkModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" };
const zaiModel = { provider: "zai", id: "glm-4.7", name: "GLM-4.7" };
const opencodeModel = { provider: "opencode-go", id: "qwen3-coder", name: "Qwen3 Coder" };

function report(limitId: string, primary: number, secondary: number): UsageReport {
	return {
		capturedAt: 0,
		snapshots: [
			{
				limitId,
				primary: { usedPercent: primary },
				secondary: { usedPercent: secondary },
			},
		],
	};
}

describe("isQuotaExhausted", () => {
	test("is false when every window still has room", () => {
		expect(isQuotaExhausted(codexProvider, report("codex", 42, 80), codexModel)).toBe(false);
	});

	test("is true when any window is fully consumed", () => {
		expect(isQuotaExhausted(codexProvider, report("codex", 100, 12), codexModel)).toBe(true);
		expect(isQuotaExhausted(codexProvider, report("codex", 12, 100), codexModel)).toBe(true);
	});

	test("selects the bucket that matches the active model", () => {
		const mixed: UsageReport = {
			capturedAt: 0,
			snapshots: [
				{ limitId: "codex", primary: { usedPercent: 100 } },
				{ limitId: "spark", primary: { usedPercent: 5 } },
			],
		};
		expect(isQuotaExhausted(codexProvider, mixed, codexModel)).toBe(true);
		expect(isQuotaExhausted(codexProvider, mixed, sparkModel)).toBe(false);
	});

	test("covers Z.ai and OpenCode Go windows", () => {
		expect(isQuotaExhausted(zaiProvider, report("zai", 10, 100), zaiModel)).toBe(true);
		expect(isQuotaExhausted(opencodeGoProvider, report("opencode-go", 100, 10), opencodeModel)).toBe(true);
	});

	test("counts the OpenCode Go monthly window when present", () => {
		const withMonthly: UsageReport = {
			capturedAt: 0,
			snapshots: [
				{
					limitId: "opencode-go",
					primary: { usedPercent: 10 },
					secondary: { usedPercent: 10 },
					tertiary: { usedPercent: 100 },
				},
			],
		};
		expect(isQuotaExhausted(opencodeGoProvider, withMonthly, opencodeModel)).toBe(true);
	});

	test("is false when no snapshot matches the model", () => {
		expect(isQuotaExhausted(zaiProvider, report("codex", 100, 100), zaiModel)).toBe(false);
	});
});

describe("parseQuotaStatusRequest", () => {
	test("accepts a well-formed request and preserves the model", () => {
		expect(
			parseQuotaStatusRequest({
				requestId: "r1",
				provider: "opencode-go",
				model: { provider: "opencode-go", id: "qwen3-coder", name: "Qwen3 Coder" },
			}),
		).toEqual({
			requestId: "r1",
			provider: "opencode-go",
			model: { provider: "opencode-go", id: "qwen3-coder", name: "Qwen3 Coder" },
		});
	});

	test("drops a malformed model instead of rejecting the request", () => {
		expect(parseQuotaStatusRequest({ requestId: "r1", provider: "zai", model: { id: 3 } })).toEqual({
			requestId: "r1",
			provider: "zai",
		});
	});

	test("rejects payloads missing a trusted request id or provider", () => {
		expect(parseQuotaStatusRequest(undefined)).toBeUndefined();
		expect(parseQuotaStatusRequest({ provider: "zai" })).toBeUndefined();
		expect(parseQuotaStatusRequest({ requestId: "", provider: "zai" })).toBeUndefined();
		expect(parseQuotaStatusRequest({ requestId: "r1", provider: "" })).toBeUndefined();
		expect(parseQuotaStatusRequest([{ requestId: "r1", provider: "zai" }])).toBeUndefined();
	});
});
