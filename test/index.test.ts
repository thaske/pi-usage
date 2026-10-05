import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piUsage from "../src/index";
import { codexProvider } from "../src/providers/codex";
import {
	QUOTA_PROVIDERS_CHANNEL,
	QUOTA_PROVIDERS_REQUEST_CHANNEL,
	QUOTA_REQUEST_CHANNEL,
	QUOTA_RESPONSE_CHANNEL,
	type QuotaStatusResponse,
} from "../src/quota";
import type { ProviderModel, UsageReport } from "../src/types";

const legacyModel = { provider: "openai-codex", id: "gpt-5.2-codex" };
const nativeModel = { provider: "openai", id: "gpt-6-luna" };
const sparkModel = { provider: "openai", id: "gpt-5.3-codex-spark" };

function report(usedPercent: number, limitId = "codex"): UsageReport {
	return { capturedAt: Date.now(), snapshots: [{ limitId, primary: { usedPercent } }] };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

// Drain the async event handlers without waiting for periodic refresh timers.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type LifecycleHandler = (event: { model?: ProviderModel }, ctx: ExtensionContext) => void;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function createHarness(model: ProviderModel | undefined, oauth = true) {
	const events = new EventEmitter();
	const handlers = new Map<string, LifecycleHandler>();
	const commands = new Map<string, Command>();
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const context = {
		model,
		modelRegistry: { isUsingOAuth: () => oauth },
		ui: {
			theme: { fg: (_role: string, text: string) => text, bg: (_role: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
			notify: (text: string) => { notices.push(text); },
		},
	};
	// Model-registry/host boundaries are intentionally structural in this harness.
	const ctx = context as unknown as ExtensionContext;
	piUsage({
		events,
		on: (name: string, handler: LifecycleHandler) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
	} as unknown as ExtensionAPI);
	return {
		events, statuses, notices,
		start: () => { handlers.get("session_start")?.({}, ctx); },
		select: (next: ProviderModel) => {
			context.model = next;
			handlers.get("model_select")?.({ model: next }, ctx);
		},
		usage: () => commands.get("usage")!.handler("", ctx),
		shutdown: () => { handlers.get("session_shutdown")?.({}, ctx); },
		request: (provider: string, requestedModel?: ProviderModel) => {
			const requestId = crypto.randomUUID();
			return new Promise<QuotaStatusResponse>((resolve) => {
				const listener = (response: QuotaStatusResponse) => {
					if (response.requestId !== requestId) return;
					events.off(QUOTA_RESPONSE_CHANNEL, listener);
					resolve(response);
				};
				events.on(QUOTA_RESPONSE_CHANNEL, listener);
				events.emit(QUOTA_REQUEST_CHANNEL, { requestId, provider, model: requestedModel });
			});
		},
	};
}

let harness: ReturnType<typeof createHarness> | undefined;
afterEach(() => {
	harness?.shutdown();
	harness = undefined;
	mock.restore();
});

describe("quota query scopes", () => {
	test("does not reuse the legacy cache when switching to native OpenAI", async () => {
		const query = spyOn(codexProvider, "query").mockImplementation(async (_ctx, model) =>
			report(model?.provider === "openai" ? 20 : 90),
		);
		harness = createHarness(legacyModel);
		harness.start();
		await flush();
		expect(harness.statuses.at(-1)).toContain("10%");

		harness.select(nativeModel);
		await flush();
		expect(query).toHaveBeenCalledTimes(2);
		expect(harness.statuses.at(-1)).toContain("80%");

		harness.select(legacyModel);
		await flush();
		expect(query).toHaveBeenCalledTimes(3);
		expect(harness.statuses.at(-1)).toContain("10%");
	});

	test("shares the cache between native models using the same bucket", async () => {
		const query = spyOn(codexProvider, "query").mockResolvedValue(report(20));
		harness = createHarness(nativeModel);
		harness.start();
		await flush();
		harness.select({ provider: "openai", id: "another-native-model" });
		await flush();
		expect(query).toHaveBeenCalledTimes(1);
		expect(harness.statuses.at(-1)).toContain("80%");
	});

	test("isolates overlapping queries and ignores a late result from the old scope", async () => {
		const legacy = deferred<UsageReport>();
		const native = deferred<UsageReport>();
		const query = spyOn(codexProvider, "query").mockImplementation((_ctx, model) =>
			model?.provider === "openai" ? native.promise : legacy.promise,
		);
		harness = createHarness(legacyModel);
		harness.start();
		harness.select(nativeModel);
		const legacyBus = harness.request("openai-codex", legacyModel);
		const nativeBus = harness.request("openai", nativeModel);
		expect(query).toHaveBeenCalledTimes(2);

		native.resolve(report(20));
		expect((await nativeBus).ok).toBe(true);
		await flush();
		expect(harness.statuses.at(-1)).toContain("80%");
		const statusCount = harness.statuses.length;

		legacy.resolve(report(90));
		expect((await legacyBus).ok).toBe(true);
		await flush();
		expect(harness.statuses).toHaveLength(statusCount);
		expect(harness.statuses.at(-1)).toContain("80%");
	});

	test("does not share in-flight regular and Spark bucket queries", async () => {
		const regular = deferred<UsageReport>();
		const spark = deferred<UsageReport>();
		const query = spyOn(codexProvider, "query").mockImplementation((_ctx, model) =>
			model?.id === sparkModel.id ? spark.promise : regular.promise,
		);
		harness = createHarness(nativeModel);
		harness.start();
		harness.select(sparkModel);
		expect(query).toHaveBeenCalledTimes(2);
		spark.resolve(report(40, "spark"));
		regular.resolve(report(20));
		await flush();
		expect(harness.statuses.at(-1)).toContain("60%");
	});
});

describe("quota bus routing", () => {
	test("announces native OpenAI alongside legacy and existing providers", () => {
		harness = createHarness(undefined);
		const announcements: string[][] = [];
		harness.events.on(QUOTA_PROVIDERS_CHANNEL, (event: { providers: string[] }) => {
			announcements.push(event.providers);
		});
		harness.events.emit(QUOTA_PROVIDERS_REQUEST_CHANNEL, {});
		harness.start();
		expect(announcements).toEqual([
			["openai-codex", "openai", "opencode-go", "zai"],
			["openai-codex", "openai", "opencode-go", "zai"],
		]);
	});

	test("routes native OpenAI requests and shares the active query", async () => {
		const pending = deferred<UsageReport>();
		const query = spyOn(codexProvider, "query").mockReturnValue(pending.promise);
		harness = createHarness(nativeModel);
		harness.start();
		const reply = harness.request("openai");
		expect(query).toHaveBeenCalledTimes(1);
		pending.resolve(report(100));
		expect(await reply).toMatchObject({ ok: true, provider: "openai", label: "codex", exhausted: true });
		await flush();
	});

	test("rejects API-key auth without querying or borrowing a legacy in-flight report", async () => {
		const pending = deferred<UsageReport>();
		const query = spyOn(codexProvider, "query").mockReturnValue(pending.promise);
		harness = createHarness(legacyModel, false);
		harness.start();
		const reply = await harness.request("openai", nativeModel);
		expect(reply).toMatchObject({ ok: false, provider: "openai" });
		if (!reply.ok) expect(reply.error).toContain("authentication");
		expect(query).toHaveBeenCalledTimes(1);
		pending.resolve(report(20));
		await flush();
	});

	test("keeps legacy requests on the legacy scope when another provider is active", async () => {
		const query = spyOn(codexProvider, "query").mockResolvedValue(report(20));
		harness = createHarness({ provider: "unsupported", id: "other" });
		harness.start();
		const reply = await harness.request("openai-codex");
		expect(reply).toMatchObject({ ok: true, provider: "openai-codex", exhausted: false });
		expect(query.mock.calls[0]?.[1]?.provider).toBe("openai-codex");
	});

	test("rejects mismatched model/provider requests", async () => {
		const query = spyOn(codexProvider, "query").mockResolvedValue(report(20));
		harness = createHarness(undefined);
		harness.start();
		expect(await harness.request("openai", legacyModel)).toMatchObject({ ok: false, provider: "openai" });
		expect(query).not.toHaveBeenCalled();
	});

	test("returns errors for unsupported providers, missing context, and missing buckets", async () => {
		spyOn(codexProvider, "query").mockResolvedValue(report(20, "spark"));
		harness = createHarness(undefined);
		expect(await harness.request("openai", nativeModel)).toMatchObject({ ok: false });
		harness.start();
		expect(await harness.request("unsupported")).toMatchObject({ ok: false });
		const reply = await harness.request("openai", nativeModel);
		expect(reply).toMatchObject({ ok: false });
		if (!reply.ok) expect(reply.error).toContain("No matching quota windows");
		harness.shutdown();
		expect(await harness.request("openai", nativeModel)).toMatchObject({ ok: false });
	});
});

describe("usage attribution", () => {
	test("warns that native OpenAI reports the separately authenticated CLI account quota", async () => {
		spyOn(codexProvider, "query").mockResolvedValue(report(20));
		harness = createHarness(nativeModel);
		await harness.usage();
		expect(harness.notices.at(-1)).toContain("local Codex CLI account");
		expect(harness.notices.at(-1)).toContain("not a verified limit");
		expect(harness.notices.at(-1)).toContain("20% used");
	});
});
