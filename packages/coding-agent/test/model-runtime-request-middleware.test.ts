import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryModelsStore,
	type Model,
	type Provider,
	type ProviderHeaders,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderRequestMiddlewareContext } from "../src/core/provider-request-middleware.ts";

function modelFor(providerId: string, id = "test-model"): Model<Api> {
	return {
		id,
		name: id,
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

interface CapturedRequest {
	payload: unknown;
	headers: ProviderHeaders | undefined;
	onPayloadCalls: number;
}

interface FakeProviderOptions {
	capture: (request: CapturedRequest) => void;
	/** Invoked when an attempt starts, before send and response callbacks. */
	onAttempt?: (attempt: number) => void;
	/** Simulate one retry by invoking onPayload/onResponse twice. */
	simulateRetry?: boolean;
}

/**
 * Fake native provider honoring the built-in adapter callback contract:
 * onPayload before send, onResponse after headers and before the body.
 */
function fakeProvider(providerId: string, options: FakeProviderOptions): Provider {
	const model = modelFor(providerId);

	const dispatch = (
		requestModel: Model<Api>,
		streamOptions:
			| {
					onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
					onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
					headers?: ProviderHeaders;
			  }
			| undefined,
	): ReturnType<Provider["streamSimple"]> => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const attempts = options.simulateRetry === true ? 2 : 1;
			let payload: Record<string, unknown> = { provider: providerId, model: requestModel.id };
			try {
				for (let attempt = 0; attempt < attempts; attempt++) {
					options.onAttempt?.(attempt);
					const replaced = streamOptions?.onPayload
						? await streamOptions.onPayload(payload, requestModel)
						: payload;
					if (replaced !== undefined) payload = replaced as Record<string, unknown>;
					if (streamOptions?.onResponse) {
						await streamOptions.onResponse({ status: 200, headers: { "x-provider": providerId } }, requestModel);
					}
				}
				options.capture({
					payload,
					headers: streamOptions?.headers,
					onPayloadCalls: attempts,
				});
				const message: AssistantMessage = {
					...fauxAssistantMessage("ok"),
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
	};

	return {
		id: providerId,
		name: providerId,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: `${providerId}-key` }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: (requestModel, _context, streamOptions) => dispatch(requestModel, streamOptions),
		streamSimple: (requestModel, _context, streamOptions) => dispatch(requestModel, streamOptions),
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

function emptyContext(): Context {
	return { systemPrompt: "", messages: [] };
}

describe("ModelRuntime provider request middleware", () => {
	it("transforms payloads for the exact provider only", async () => {
		const captured: Record<string, CapturedRequest> = {};
		const runtime = await createTestRuntime([
			fakeProvider("alpha", {
				capture: (request) => {
					captured.alpha = request;
				},
			}),
			fakeProvider("beta", {
				capture: (request) => {
					captured.beta = request;
				},
			}),
		]);
		runtime.registerRequestMiddleware({
			id: "alpha-tag",
			provider: "alpha",
			transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), tagged: true }),
		});

		await runtime.completeSimple(modelFor("alpha"), emptyContext());
		await runtime.completeSimple(modelFor("beta"), emptyContext());

		expect(captured.alpha?.payload).toMatchObject({ provider: "alpha", tagged: true });
		expect(captured.beta?.payload).toMatchObject({ provider: "beta" });
		expect(captured.beta?.payload).not.toHaveProperty("tagged");
	});

	it("runs existing caller onPayload before middleware transforms", async () => {
		const captured: CapturedRequest[] = [];
		const order: string[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware({
			id: "last",
			provider: "alpha",
			transformPayload: (payload) => {
				order.push("middleware");
				return { ...(payload as Record<string, unknown>), middleware: true };
			},
		});

		await runtime.completeSimple(modelFor("alpha"), emptyContext(), {
			onPayload: (payload) => {
				order.push("caller");
				return { ...(payload as Record<string, unknown>), caller: true };
			},
		});

		expect(order).toEqual(["caller", "middleware"]);
		expect(captured[0]?.payload).toMatchObject({ caller: true, middleware: true });
	});

	it("runs middleware header transforms after the existing caller transformHeaders", async () => {
		const captured: CapturedRequest[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware({
			id: "header-policy",
			provider: "alpha",
			transformHeaders: (headers) => ({ ...headers, "x-final": "middleware" }),
		});

		await runtime.completeSimple(modelFor("alpha"), emptyContext(), {
			headers: { "x-base": "yes" },
			transformHeaders: (headers) => ({ ...headers, "x-caller": "yes" }),
		});

		expect(captured[0]?.headers).toMatchObject({
			"x-base": "yes",
			"x-caller": "yes",
			"x-final": "middleware",
		});
	});

	it("exposes requestId, runtimeId, purpose, and attempts in the context", async () => {
		const captured: CapturedRequest[] = [];
		const contexts: ProviderRequestMiddlewareContext[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request), simulateRetry: true }),
		]);
		runtime.registerRequestMiddleware({
			id: "observer",
			provider: "alpha",
			transformPayload: (payload, context) => {
				contexts.push({ ...context });
				return payload;
			},
		});

		const message = await runtime.completeSimple(modelFor("alpha"), emptyContext(), {
			requestPurpose: "background",
		});
		expect(message.stopReason).toBe("stop");

		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.attempt).toBe(0);
		expect(contexts[1]?.attempt).toBe(1);
		expect(contexts[0]?.requestId).toBe(contexts[1]?.requestId);
		expect(contexts[0]?.runtimeId).toBe(runtime.runtimeId);
		expect(contexts[0]?.purpose).toBe("background");
		expect(contexts[0]?.providerId).toBe("alpha");
		expect(captured[0]?.onPayloadCalls).toBe(2);
	});

	it("defaults the purpose to other when unlabeled", async () => {
		const contexts: ProviderRequestMiddlewareContext[] = [];
		const runtime = await createTestRuntime([fakeProvider("alpha", { capture: () => {} })]);
		runtime.registerRequestMiddleware({
			id: "observer",
			provider: "alpha",
			transformPayload: (_payload, context) => {
				contexts.push({ ...context });
			},
		});
		await runtime.completeSimple(modelFor("alpha"), emptyContext());
		expect(contexts[0]?.purpose).toBe("other");
	});

	it("observes responses through afterResponse with per-attempt attempt metadata", async () => {
		const observed: Array<{ status: number; attempt: number }> = [];
		const runtime = await createTestRuntime([fakeProvider("alpha", { capture: () => {}, simulateRetry: true })]);
		runtime.registerRequestMiddleware({
			id: "observer",
			provider: "alpha",
			afterResponse: (response, context) => {
				observed.push({ status: response.status, attempt: context.attempt });
			},
		});

		await runtime.completeSimple(modelFor("alpha"), emptyContext());
		expect(observed).toEqual([
			{ status: 200, attempt: 0 },
			{ status: 200, attempt: 1 },
		]);
	});

	it("fails the request before send when a payload transform throws", async () => {
		const captured: CapturedRequest[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware({
			id: "boom",
			provider: "alpha",
			transformPayload: () => {
				throw new Error("transform failed");
			},
		});

		const message = await runtime.completeSimple(modelFor("alpha"), emptyContext());
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/transform failed/);
		expect(captured).toHaveLength(0);
	});

	it("disposal removes future matches but started requests keep their snapshot", async () => {
		const captured: CapturedRequest[] = [];
		let resolveAttemptStarted: () => void = () => {};
		const attemptStartedPromise = new Promise<void>((resolve) => {
			resolveAttemptStarted = resolve;
		});
		const runtime = await createTestRuntime([
			fakeProvider("alpha", {
				capture: (request) => captured.push(request),
				onAttempt: () => resolveAttemptStarted(),
			}),
		]);
		const registration = runtime.registerRequestMiddleware({
			id: "temp",
			provider: "alpha",
			transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), temp: true }),
		});

		const resultPromise = runtime.streamSimple(modelFor("alpha"), emptyContext()).result();
		// Lazy streams start work on first consumption; wait until the request
		// has actually begun before disposing the registration.
		await attemptStartedPromise;
		registration.dispose();
		const message = await resultPromise;

		expect(message.stopReason).toBe("stop");
		expect(captured[0]?.payload).toMatchObject({ temp: true });

		await runtime.completeSimple(modelFor("alpha"), emptyContext());
		expect(captured[1]?.payload).not.toHaveProperty("temp");
	});

	it("disposeOwner removes every registration of one owner", async () => {
		const captured: CapturedRequest[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware(
			{
				id: "a",
				provider: "alpha",
				transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), a: true }),
			},
			"owner-1",
		);
		runtime.registerRequestMiddleware(
			{
				id: "b",
				provider: "alpha",
				transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), b: true }),
			},
			"owner-2",
		);

		runtime.disposeRequestMiddlewareOwner("owner-1");
		expect(runtime.getRequestMiddlewareIds()).toEqual(["b"]);

		await runtime.completeSimple(modelFor("alpha"), emptyContext());
		expect(captured[0]?.payload).not.toHaveProperty("a");
		expect(captured[0]?.payload).toHaveProperty("b");
	});

	it("applies middleware to stream() as well as streamSimple()", async () => {
		const captured: CapturedRequest[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware({
			id: "stream-hook",
			provider: "alpha",
			transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), viaStream: true }),
		});

		await runtime.complete(modelFor("alpha"), emptyContext());
		expect(captured[0]?.payload).toMatchObject({ viaStream: true });
	});

	it("isolates concurrent requests from each other's context", async () => {
		const captured: CapturedRequest[] = [];
		const runtime = await createTestRuntime([
			fakeProvider("alpha", { capture: (request) => captured.push(request) }),
		]);
		runtime.registerRequestMiddleware({
			id: "concurrent",
			provider: "alpha",
			transformPayload: (payload, context) => ({
				...(payload as Record<string, unknown>),
				requestId: context.requestId,
			}),
		});

		const [first, second] = await Promise.all([
			runtime.streamSimple(modelFor("alpha"), emptyContext()).result(),
			runtime.streamSimple(modelFor("alpha"), emptyContext()).result(),
		]);

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		const firstPayload = captured[0]?.payload as Record<string, unknown>;
		const secondPayload = captured[1]?.payload as Record<string, unknown>;
		expect(firstPayload.requestId).not.toBe(secondPayload.requestId);
	});
});
