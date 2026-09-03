import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createBackgroundAgent } from "../src/core/runtime-stream-function.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedRequest {
	payload: unknown;
	sessionId: string | undefined;
	purpose: unknown;
}

let captured: CapturedRequest[] = [];

function capturingAnthropicProvider(): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")! };
	return {
		id: "anthropic",
		name: "Capturing Anthropic",
		baseUrl: "https://example.test",
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		// Contract-matching fake adapter: onPayload before send, onResponse after headers.
		streamSimple: (requestModel: Model<Api>, _context: Context, streamOptions: SimpleStreamOptions | undefined) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				let payload: Record<string, unknown> = { model: requestModel.id };
				try {
					const replaced = streamOptions?.onPayload
						? await streamOptions.onPayload(payload, requestModel)
						: payload;
					if (replaced !== undefined) payload = replaced as Record<string, unknown>;
					captured.push({
						payload,
						sessionId: streamOptions?.sessionId,
						purpose: streamOptions?.requestPurpose,
					});
					if (streamOptions?.onResponse) {
						await streamOptions.onResponse({ status: 200, headers: {} }, requestModel);
					}
					const message: AssistantMessage = {
						...fauxAssistantMessage("done"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				} catch (error) {
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...fauxAssistantMessage("failed", { stopReason: "error" }),
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
							errorMessage: error instanceof Error ? error.message : String(error),
						},
					});
				}
			})();
			return stream;
		},
	};
}

describe("extension provider request middleware lifecycle", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-middleware-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		captured = [];
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(capturingAnthropicProvider());
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});
		return { session, modelRuntime };
	}

	it("applies extension middleware to session prompts and background agents sharing the binding", async () => {
		const { session } = await createSession([
			(pi) => {
				pi.registerProviderRequestMiddleware({
					id: "tag-requests",
					provider: "anthropic",
					transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), tagged: true }),
				});
			},
		]);

		// Foreground request through the session agent.
		await session.prompt("hello");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.payload).toMatchObject({ tagged: true });
		expect(captured[0]?.purpose).toBe("interactive");

		// Same-process background agent built from the session transport binding.
		const binding = session.getTransportBinding();
		expect(binding.streamFn).toBe(session.agent.streamFunction);
		const background = createBackgroundAgent({
			transport: binding,
			initialState: {
				systemPrompt: "",
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				thinkingLevel: "off",
				tools: [],
			},
			requestPurpose: "subagent",
		});
		await background.prompt("background hello");

		expect(captured).toHaveLength(2);
		expect(captured[1]?.payload).toMatchObject({ tagged: true });
		expect(captured[1]?.purpose).toBe("subagent");
		expect(captured[1]?.sessionId).not.toBe(session.sessionManager.getSessionId());

		session.dispose();
	});

	it("a raw Agent without the binding fails clearly instead of using a hidden default", () => {
		const constructWithoutStreamFn = () =>
			Reflect.construct(Agent, [
				{
					initialState: {
						systemPrompt: "",
						model: getModel("anthropic", "claude-sonnet-4-5")!,
						thinkingLevel: "off",
						tools: [],
					},
				},
			]) as Agent;
		expect(constructWithoutStreamFn).toThrow(/no provider-aware stream function/i);
	});

	it("reload disposes the old middleware set and re-registers exactly once", async () => {
		const { session, modelRuntime } = await createSession([
			(pi) => {
				pi.registerProviderRequestMiddleware({
					id: "tag-requests",
					provider: "anthropic",
					transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), tagged: true }),
				});
			},
		]);

		await session.prompt("first");
		expect(captured).toHaveLength(1);

		await session.reload();
		expect(modelRuntime.getRequestMiddlewareIds()).toEqual(["tag-requests"]);

		await session.prompt("second");
		expect(captured).toHaveLength(2);
		const secondPayload = captured[1]?.payload as Record<string, unknown>;
		// Exactly one middleware instance ran: no double registration.
		expect(secondPayload).toMatchObject({ tagged: true });

		session.dispose();
		expect(modelRuntime.getRequestMiddlewareIds()).toEqual([]);
	});

	it("rejects invalid extension middleware registrations", async () => {
		const { session, modelRuntime } = await createSession([
			(pi) => {
				pi.registerProviderRequestMiddleware({ id: "", provider: "anthropic", afterResponse: () => {} });
			},
		]);

		expect(modelRuntime.getRequestMiddlewareIds()).toEqual([]);
		session.dispose();
	});
});
