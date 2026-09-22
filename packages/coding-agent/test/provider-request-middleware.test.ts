import type { Api, Model, ProviderHeaders, ProviderResponse } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ProviderRequestMiddleware,
	type ProviderRequestMiddlewareMatch,
	ProviderRequestMiddlewareRegistry,
	validateProviderRequestMiddleware,
} from "../src/core/provider-request-middleware.ts";

function createModel(provider = "alpha", api: Api = "anthropic-messages"): Model<Api> {
	return {
		id: "model-1",
		name: "Model 1",
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

function createMatch(overrides: Partial<ProviderRequestMiddlewareMatch> = {}): ProviderRequestMiddlewareMatch {
	return {
		requestId: "req-1",
		runtimeId: "runtime-1",
		providerId: "alpha",
		model: createModel(),
		purpose: "interactive",
		...overrides,
	};
}

function observerMiddleware(id: string, overrides: Partial<ProviderRequestMiddleware> = {}): ProviderRequestMiddleware {
	return {
		id,
		provider: "alpha",
		afterResponse: () => {},
		...overrides,
	};
}

describe("validateProviderRequestMiddleware", () => {
	it("rejects empty ids", () => {
		expect(() => validateProviderRequestMiddleware(observerMiddleware(""), "sdk")).toThrow(/non-empty/);
		expect(() => validateProviderRequestMiddleware(observerMiddleware("  "), "sdk")).toThrow(/non-empty/);
	});

	it("rejects empty provider identifiers", () => {
		expect(() => validateProviderRequestMiddleware(observerMiddleware("m1", { provider: "" }), "sdk")).toThrow(
			/non-empty provider ID/,
		);
		expect(() =>
			validateProviderRequestMiddleware(observerMiddleware("m1", { provider: ["alpha", ""] }), "sdk"),
		).toThrow(/non-empty provider ID/);
		expect(() => validateProviderRequestMiddleware(observerMiddleware("m1", { provider: [] }), "sdk")).toThrow(
			/non-empty provider ID/,
		);
	});

	it("rejects non-finite priority", () => {
		expect(() =>
			validateProviderRequestMiddleware(observerMiddleware("m1", { priority: Number.NaN }), "sdk"),
		).toThrow(/finite number/);
		expect(() =>
			validateProviderRequestMiddleware(observerMiddleware("m1", { priority: Number.POSITIVE_INFINITY }), "sdk"),
		).toThrow(/finite number/);
	});

	it("rejects middleware without any callback", () => {
		const invalid = { id: "m1", provider: "alpha" } as unknown as ProviderRequestMiddleware;
		expect(() => validateProviderRequestMiddleware(invalid, "sdk")).toThrow(
			/at least one of transformHeaders, transformPayload, or afterResponse/,
		);
	});

	it("accepts well-formed middleware", () => {
		expect(() => validateProviderRequestMiddleware(observerMiddleware("m1"), "sdk")).not.toThrow();
		expect(() =>
			validateProviderRequestMiddleware(
				observerMiddleware("m1", {
					provider: ["alpha", "beta"],
					models: ["model-1"],
					apis: ["anthropic-messages"],
				}),
				"extension",
			),
		).not.toThrow();
	});
});

describe("ProviderRequestMiddlewareRegistry", () => {
	it("matches exact providers and skips others", () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const seen: string[] = [];
		registry.register(
			observerMiddleware("m1", {
				transformPayload: (_payload, ctx) => {
					seen.push(ctx.providerId);
				},
			}),
			"sdk",
		);

		expect(registry.snapshot(createMatch()).ids).toEqual(["m1"]);
		expect(registry.snapshot(createMatch({ providerId: "beta", model: createModel("beta") })).ids).toEqual([]);
		expect(seen).toEqual([]);
	});

	it("supports optional model and API predicates", () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const modelScoped = observerMiddleware("by-model", { models: ["model-1"] });
		const apiScoped = observerMiddleware("by-api", { provider: "gamma", apis: ["openai-responses"] });
		registry.register(modelScoped, "sdk");
		registry.register(apiScoped, "sdk");

		const anthropicMatch = createMatch();
		expect(registry.snapshot(anthropicMatch).ids).toEqual(["by-model"]);

		const openaiMatch = createMatch({
			providerId: "gamma",
			model: createModel("gamma", "openai-responses"),
		});
		expect(registry.snapshot(openaiMatch).ids).toEqual(["by-api"]);

		expect(registry.snapshot(createMatch({ model: { ...createModel(), id: "model-2" } })).ids).toEqual([]);
	});

	it("orders by ascending priority then registration sequence", () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		registry.register(observerMiddleware("late-low"), "sdk"); // seq 0, priority 0
		registry.register(observerMiddleware("early", { priority: -5 }), "sdk"); // seq 1
		registry.register(observerMiddleware("late-high", { priority: 10 }), "sdk"); // seq 2
		registry.register(observerMiddleware("late-low-2"), "sdk"); // seq 3, priority 0

		expect(registry.snapshot(createMatch()).ids).toEqual(["early", "late-low", "late-low-2", "late-high"]);
	});

	it("rejects duplicate IDs per owner but allows the same ID across owners", () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		registry.register(observerMiddleware("m1"), "owner-a");
		expect(() => registry.register(observerMiddleware("m1"), "owner-a")).toThrow(/already registered/);
		expect(() => registry.register(observerMiddleware("m1"), "owner-b")).not.toThrow();
	});

	it("disposal removes future matches but not in-flight snapshots", async () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const registration = registry.register(
			observerMiddleware("m1", {
				transformPayload: (payload) => ({ ...(payload as Record<string, unknown>), tagged: true }),
			}),
			"sdk",
		);

		const inFlight = registry.snapshot(createMatch());
		registration.dispose();

		expect(registry.snapshot(createMatch()).ids).toEqual([]);
		expect(inFlight.ids).toEqual(["m1"]);
		const payload = await inFlight.transformPayload({ hello: "world" }, 0);
		expect(payload).toEqual({ hello: "world", tagged: true });
	});

	it("disposeOwner removes all registrations of one owner only", () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		registry.register(observerMiddleware("a1"), "owner-a");
		registry.register(observerMiddleware("a2"), "owner-a");
		registry.register(observerMiddleware("b1"), "owner-b");
		registry.disposeOwner("owner-a");
		expect(registry.snapshot(createMatch()).ids).toEqual(["b1"]);
	});

	it("undefined transform results keep the current value", async () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		registry.register(
			observerMiddleware("noop", {
				transformHeaders: () => {},
				transformPayload: () => undefined,
			}),
			"sdk",
		);
		const chain = registry.snapshot(createMatch());

		const headers: ProviderHeaders = { "x-keep": "yes" };
		expect(await chain.transformHeaders(headers)).toBe(headers);
		const payload = { hello: "world" };
		expect(await chain.transformPayload(payload, 0)).toBe(payload);
	});

	it("chains replacements through every matching middleware in order", async () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const order: string[] = [];
		registry.register(
			observerMiddleware("first", {
				priority: 1,
				transformPayload: (payload) => {
					order.push("first");
					return { ...(payload as Record<string, unknown>), step: 1 };
				},
			}),
			"sdk",
		);
		registry.register(
			observerMiddleware("second", {
				priority: 2,
				transformPayload: (payload, ctx) => {
					order.push(`second:${ctx.attempt}`);
					return { ...(payload as Record<string, unknown>), step: 2 };
				},
			}),
			"sdk",
		);
		const chain = registry.snapshot(createMatch());

		const result = (await chain.transformPayload({ base: true }, 3)) as Record<string, unknown>;
		expect(result).toEqual({ base: true, step: 2 });
		expect(order).toEqual(["first", "second:3"]);
	});

	it("exposes request identity and purpose in the context", async () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const contexts: unknown[] = [];
		registry.register(
			observerMiddleware("m1", {
				transformPayload: (_payload, ctx) => {
					contexts.push({ ...ctx });
				},
			}),
			"sdk",
		);
		const match = createMatch({ requestId: "req-42", purpose: "compaction", model: createModel() });
		await registry.snapshot(match).transformPayload({}, 0);

		expect(contexts).toHaveLength(1);
		const context = contexts[0] as Record<string, unknown>;
		expect(context.requestId).toBe("req-42");
		expect(context.providerId).toBe("alpha");
		expect(context.purpose).toBe("compaction");
		expect(context.attempt).toBe(0);
		expect((context.model as Model<Api>).id).toBe("model-1");
	});

	it.each(["headers", "payload", "response"] as const)(
		"aborts a paused %s callback without running later middleware",
		async (kind) => {
			const registry = new ProviderRequestMiddlewareRegistry();
			const controller = new AbortController();
			let release!: () => void;
			let entered!: () => void;
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const paused = new Promise<void>((resolve) => {
				release = resolve;
			});
			let laterRan = false;
			registry.register(
				observerMiddleware("paused", {
					...(kind === "headers"
						? {
								transformHeaders: async () => {
									entered();
									await paused;
								},
							}
						: {}),
					...(kind === "payload"
						? {
								transformPayload: async () => {
									entered();
									await paused;
								},
							}
						: {}),
					...(kind === "response"
						? {
								afterResponse: async () => {
									entered();
									await paused;
								},
							}
						: {}),
				}),
				"sdk",
			);
			registry.register(
				observerMiddleware("later", {
					...(kind === "headers"
						? {
								transformHeaders: () => {
									laterRan = true;
								},
							}
						: {}),
					...(kind === "payload"
						? {
								transformPayload: () => {
									laterRan = true;
								},
							}
						: {}),
					...(kind === "response"
						? {
								afterResponse: () => {
									laterRan = true;
								},
							}
						: {}),
				}),
				"sdk",
			);
			const chain = registry.snapshot(createMatch({ signal: controller.signal }));
			const pending =
				kind === "headers"
					? chain.transformHeaders({})
					: kind === "payload"
						? chain.transformPayload({}, 0)
						: chain.afterResponse({ status: 200, headers: {} }, 0);
			await enteredPromise;
			controller.abort(new Error("cancel middleware"));
			await expect(pending).rejects.toThrow("cancel middleware");
			release();
			await Promise.resolve();
			expect(laterRan).toBe(false);
		},
	);

	it("afterResponse runs observers in order and propagates failures", async () => {
		const registry = new ProviderRequestMiddlewareRegistry();
		const order: string[] = [];
		registry.register(
			observerMiddleware("first", {
				priority: 1,
				afterResponse: () => {
					order.push("first");
				},
			}),
			"sdk",
		);
		registry.register(
			observerMiddleware("boom", {
				priority: 2,
				afterResponse: () => {
					throw new Error("observer failed");
				},
			}),
			"sdk",
		);
		registry.register(
			observerMiddleware("third", {
				priority: 3,
				afterResponse: () => {
					order.push("third");
				},
			}),
			"sdk",
		);

		const chain = registry.snapshot(createMatch());
		const response: ProviderResponse = { status: 200, headers: {} };
		await expect(chain.afterResponse(response, 0)).rejects.toThrow("observer failed");
		expect(order).toEqual(["first"]);
	});
});
