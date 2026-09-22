import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryModelsStore,
	type Model,
	normalizeContext,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createBackgroundAgent,
	createRuntimeStreamFunction,
	createTransportBinding,
} from "../src/core/runtime-stream-function.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface DispatchedRequest {
	model: Model<Api>;
	options: SimpleStreamOptions | undefined;
}

function modelFor(providerId: string): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

function recordingProvider(providerId: string, capture: (request: DispatchedRequest) => void): Provider {
	return {
		id: providerId,
		name: providerId,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: `${providerId}-key` }, source: "test" }),
			},
		},
		getModels: () => [modelFor(providerId)],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: (requestModel, _context, streamOptions) => {
			capture({ model: requestModel, options: streamOptions });
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				...fauxAssistantMessage("ok"),
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			};
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	};
}

async function createTestRuntime(providers: Provider[]): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const provider of providers) runtime.registerNativeProvider(provider);
	return runtime;
}

function emptyContext(): TranscriptContext {
	return normalizeContext({ systemPrompt: "", messages: [] });
}

describe("runtime stream function factory", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-runtime-stream-fn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("dispatches through ModelRuntime and applies settings at request time", async () => {
		const dispatched: DispatchedRequest[] = [];
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const runtime = await createTestRuntime([recordingProvider("alpha", (r) => dispatched.push(r))]);
		const streamFn = createRuntimeStreamFunction({ modelRuntime: runtime, settingsManager });

		const message = await (
			await streamFn(modelFor("alpha"), emptyContext(), {
				sessionId: "session-1",
				requestPurpose: "interactive",
			})
		).result();

		expect(message.stopReason).toBe("stop");
		expect(dispatched).toHaveLength(1);
		// Runtime defaults are applied and per-request values are preserved.
		expect(dispatched[0]?.options?.sessionId).toBe("session-1");
		expect(dispatched[0]?.options?.requestPurpose).toBe("interactive");
	});

	it("reads settings per request so mid-session changes stay effective", async () => {
		const dispatched: DispatchedRequest[] = [];
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const runtime = await createTestRuntime([recordingProvider("alpha", (r) => dispatched.push(r))]);
		const streamFn = createRuntimeStreamFunction({ modelRuntime: runtime, settingsManager });

		await (await streamFn(modelFor("alpha"), emptyContext(), { timeoutMs: 1234 })).result();
		expect(dispatched[0]?.options?.timeoutMs).toBe(1234);
		// Explicit per-request values win over defaults on every call.
		await (await streamFn(modelFor("alpha"), emptyContext(), { timeoutMs: 5678 })).result();
		expect(dispatched[1]?.options?.timeoutMs).toBe(5678);
	});

	it("transport binding returns the runtime id and a working stream function", async () => {
		const dispatched: DispatchedRequest[] = [];
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const runtime = await createTestRuntime([recordingProvider("alpha", (r) => dispatched.push(r))]);
		const binding = createTransportBinding({ modelRuntime: runtime, settingsManager });

		expect(binding.runtimeId).toBe(runtime.runtimeId);
		await (await binding.streamFn(modelFor("alpha"), emptyContext(), {})).result();
		expect(dispatched).toHaveLength(1);
	});

	it("background agents default to a unique session id and background purpose", async () => {
		const dispatched: DispatchedRequest[] = [];
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const runtime = await createTestRuntime([recordingProvider("alpha", (r) => dispatched.push(r))]);
		const binding = createTransportBinding({ modelRuntime: runtime, settingsManager });

		const first = createBackgroundAgent({
			transport: binding,
			initialState: {
				systemPrompt: "",
				model: modelFor("alpha"),
				thinkingLevel: "off",
				tools: [],
			},
		});
		const second = createBackgroundAgent({
			transport: binding,
			initialState: {
				systemPrompt: "",
				model: modelFor("alpha"),
				thinkingLevel: "off",
				tools: [],
			},
		});

		await first.prompt("one");
		await second.prompt("two");

		expect(dispatched).toHaveLength(2);
		expect(dispatched[0]?.options?.requestPurpose).toBe("background");
		expect(dispatched[1]?.options?.requestPurpose).toBe("background");
		expect(dispatched[0]?.options?.sessionId).toBeTruthy();
		expect(dispatched[1]?.options?.sessionId).toBeTruthy();
		expect(dispatched[0]?.options?.sessionId).not.toBe(dispatched[1]?.options?.sessionId);
	});

	it("converting options preserves explicit caller values over runtime defaults", async () => {
		const dispatched: DispatchedRequest[] = [];
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const runtime = await createTestRuntime([recordingProvider("alpha", (r) => dispatched.push(r))]);
		const streamFn = createRuntimeStreamFunction({ modelRuntime: runtime, settingsManager });

		await (await streamFn(modelFor("alpha"), emptyContext(), { maxRetries: 0, maxRetryDelayMs: 42 })).result();
		expect(dispatched[0]?.options?.maxRetries).toBe(0);
		expect(dispatched[0]?.options?.maxRetryDelayMs).toBe(42);
	});
});
