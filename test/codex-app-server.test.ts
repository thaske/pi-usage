import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { codexProvider } from "../src/providers/codex";

const nativeModel = { provider: "openai", id: "gpt-6-luna" };

type FakeRpcReply = { result?: unknown; error?: { message: string; code: number } };

// Exercise the real stdio RPC client against a local fake executable. No real
// Codex login, credentials, or network requests are involved.
async function withFakeCodex(reply: FakeRpcReply, run: () => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-codex-test-"));
	const originalPath = process.env.PATH;
	const originalFetch = global.fetch;
	writeFileSync(join(dir, "codex"), `#!${process.execPath}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== "number") return;
  const reply = request.method === "initialize" ? { result: {} }
    : request.method === "account/rateLimits/read" ? ${JSON.stringify(reply)}
    : { error: { code: -32601, message: "Unexpected test RPC method" } };
  process.stdout.write(JSON.stringify({ id: request.id, ...reply }) + "\\n");
});
`, { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
	const fetch = mock(async () => { throw new Error("Unexpected network request in app-server test"); });
	global.fetch = fetch as unknown as typeof global.fetch;
	try {
		await run();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		global.fetch = originalFetch;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(dir, { recursive: true, force: true });
	}
}

function nativeContext() {
	const piAuth = mock(async () => ({ ok: true, apiKey: "unused-test-auth" }));
	return {
		piAuth,
		ctx: {
			model: nativeModel,
			modelRegistry: {
				isUsingOAuth: () => true,
				getAll: () => [{ provider: "openai-codex", id: "legacy" }],
				getApiKeyAndHeaders: piAuth,
			},
		},
	};
}

describe("native OpenAI app-server queries", () => {
	test("reads CLI quota through stdio without touching Pi auth", async () => {
		await withFakeCodex({ result: {
			rateLimitsByLimitId: { codex: { primary: { usedPercent: 42, windowDurationMins: 300 } } },
		} }, async () => {
			const { ctx, piAuth } = nativeContext();
			const report = await codexProvider.query(ctx, undefined, 2000);
			expect(codexProvider.selectSnapshot(report, nativeModel)?.primary?.usedPercent).toBe(42);
			expect(piAuth).not.toHaveBeenCalled();
		});
	});

	test("does not fall back to Pi auth when the CLI quota request fails", async () => {
		await withFakeCodex({ error: { code: -32000, message: "CLI login unavailable" } }, async () => {
			const { ctx, piAuth } = nativeContext();
			let failure: unknown;
			try {
				await codexProvider.query(ctx, nativeModel, 2000);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(AggregateError);
			if (failure instanceof AggregateError) {
				expect(failure.errors).toHaveLength(1);
				expect(failure.message).toContain("CLI login unavailable");
			}
			expect(piAuth).not.toHaveBeenCalled();
		});
	});
});
