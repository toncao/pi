import type { Api, Model, ProviderHeaders, ProviderResponse, RequestPurpose } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "../utils/abort.ts";

/**
 * Provider-scoped request middleware.
 *
 * Middleware intercepts provider requests at one exact provider identity inside
 * `ModelRuntime`, so foreground and background agents dispatched through the
 * same runtime observe identical request behavior. This is deliberately
 * provider-scoped rather than API-scoped: two providers sharing one wire
 * protocol (for example `anthropic` and an `anthropic-messages` gateway) may
 * need different routing, auth, or schema handling and must remain isolated.
 *
 * Composition order inside `ModelRuntime`:
 *
 *   provider/auth headers -> per-request headers -> existing caller
 *   transformHeaders -> provider middleware (priority, then registration
 *   order) -> adapter transport defaults
 *
 *   adapter payload -> existing caller onPayload -> provider middleware ->
 *   network
 *
 *   HTTP response -> existing caller onResponse -> provider middleware
 *   afterResponse -> body consumption
 *
 * Middleware is highly privileged: it can inspect prompts, tool schemas, and
 * headers. Extensions that register it run with the user's full local
 * permissions, exactly like other extension code.
 */

/** Logical purpose of a provider request. Untrusted caller-supplied metadata. */
export type ProviderRequestPurpose = RequestPurpose;

/** Per-request context passed to every middleware callback. */
export interface ProviderRequestMiddlewareContext {
	/** Unique ID for the logical dispatch (one per stream()/streamSimple() call). */
	readonly requestId: string;
	/** Owning ModelRuntime instance ID. Diagnostic metadata only. */
	readonly runtimeId: string;
	/** Exact provider ID the request is dispatched to. */
	readonly providerId: string;
	/** Model used for this request. */
	readonly model: Model<Api>;
	/** Wire API of the request; identical to `model.api`. */
	readonly api: Api;
	/** Logical request purpose. Untrusted metadata; never authorization. */
	readonly purpose: ProviderRequestPurpose;
	/**
	 * 0-based invocation index for this callback kind within the logical request.
	 * Adapter callbacks are not guaranteed to run once per network retry; this is
	 * diagnostic ordering metadata, not an authoritative transport attempt count.
	 */
	readonly attempt: number;
	/** Caller-supplied abort signal for the logical request, if any. */
	readonly signal?: AbortSignal;
}

/** Middleware that transforms or observes requests for one exact provider. */
export interface ProviderRequestMiddleware {
	/** Unique ID within the owning registration surface. */
	readonly id: string;
	/** Exact provider ID, or several provider IDs this middleware applies to. */
	readonly provider: string | readonly string[];
	/** Optional model-ID allowlist. */
	readonly models?: readonly string[];
	/** Optional API allowlist applied after provider matching. */
	readonly apis?: readonly Api[];
	/** Lower runs earlier. Default 0. Ties resolve by registration order. */
	readonly priority?: number;
	/** Transform merged request headers before provider dispatch. Return undefined to keep. */
	transformHeaders?(
		headers: ProviderHeaders,
		context: ProviderRequestMiddlewareContext,
		// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
	): ProviderHeaders | void | Promise<ProviderHeaders | void>;
	/** Transform the adapter-built native payload before sending. Return undefined to keep. */
	transformPayload?(
		payload: unknown,
		context: ProviderRequestMiddlewareContext,
		// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
	): unknown | void | Promise<unknown | void>;
	/** Observe the HTTP response before its body is consumed. */
	afterResponse?(response: ProviderResponse, context: ProviderRequestMiddlewareContext): void | Promise<void>;
}

/** Handle for a registered middleware. Disposing removes it from future requests. */
export interface ProviderRequestMiddlewareRegistration {
	readonly id: string;
	dispose(): void;
}

/** Match inputs used to select and order middleware for one logical request. */
export interface ProviderRequestMiddlewareMatch {
	readonly requestId: string;
	readonly runtimeId: string;
	readonly providerId: string;
	readonly model: Model<Api>;
	readonly purpose: ProviderRequestPurpose;
	readonly signal?: AbortSignal;
}

interface MiddlewareEntry {
	readonly seq: number;
	readonly owner: string;
	readonly middleware: ProviderRequestMiddleware;
	disposed: boolean;
}

export function validateProviderRequestMiddleware(middleware: ProviderRequestMiddleware, owner: string): void {
	if (!middleware || typeof middleware !== "object") {
		throw new Error(`Provider request middleware for ${owner}: registration must be an object.`);
	}
	if (typeof middleware.id !== "string" || middleware.id.trim() === "") {
		throw new Error(`Provider request middleware for ${owner}: id must be a non-empty string.`);
	}
	const providers = Array.isArray(middleware.provider) ? middleware.provider : [middleware.provider];
	if (providers.length === 0 || providers.some((id) => typeof id !== "string" || id.trim() === "")) {
		throw new Error(
			`Provider request middleware "${middleware.id}" for ${owner}: provider must be a non-empty provider ID or a non-empty array of provider IDs.`,
		);
	}
	if (middleware.models !== undefined) {
		if (!Array.isArray(middleware.models) || middleware.models.length === 0) {
			throw new Error(
				`Provider request middleware "${middleware.id}" for ${owner}: models must be a non-empty array when provided.`,
			);
		}
		for (const modelId of middleware.models) {
			if (typeof modelId !== "string" || modelId.trim() === "") {
				throw new Error(
					`Provider request middleware "${middleware.id}" for ${owner}: models entries must be non-empty strings.`,
				);
			}
		}
	}
	if (middleware.apis !== undefined && (!Array.isArray(middleware.apis) || middleware.apis.length === 0)) {
		throw new Error(
			`Provider request middleware "${middleware.id}" for ${owner}: apis must be a non-empty array when provided.`,
		);
	}
	if (
		middleware.priority !== undefined &&
		(typeof middleware.priority !== "number" || !Number.isFinite(middleware.priority))
	) {
		throw new Error(
			`Provider request middleware "${middleware.id}" for ${owner}: priority must be a finite number when provided.`,
		);
	}
	if (
		typeof middleware.transformHeaders !== "function" &&
		typeof middleware.transformPayload !== "function" &&
		typeof middleware.afterResponse !== "function"
	) {
		throw new Error(
			`Provider request middleware "${middleware.id}" for ${owner}: at least one of transformHeaders, transformPayload, or afterResponse is required.`,
		);
	}
}

function matchesProvider(entry: MiddlewareEntry, match: ProviderRequestMiddlewareMatch): boolean {
	const providers = Array.isArray(entry.middleware.provider) ? entry.middleware.provider : [entry.middleware.provider];
	if (!providers.includes(match.providerId)) return false;
	if (entry.middleware.models && !entry.middleware.models.includes(match.model.id)) return false;
	if (entry.middleware.apis && !entry.middleware.apis.includes(match.model.api)) return false;
	return true;
}

/**
 * Ordered snapshot of the middleware matching one logical request.
 *
 * The snapshot is immutable: disposing a registration after the snapshot was
 * taken does not affect an in-flight request. Chain callbacks are strict — a
 * throwing transform or observer fails the request, matching the existing
 * awaited-callback behavior of `onPayload`/`onResponse`.
 */
export class ProviderRequestMiddlewareChain {
	readonly ids: readonly string[];
	private readonly entries: readonly MiddlewareEntry[];
	private readonly match: ProviderRequestMiddlewareMatch;

	constructor(entries: readonly MiddlewareEntry[], match: ProviderRequestMiddlewareMatch) {
		this.entries = entries;
		this.match = match;
		this.ids = entries.map((entry) => entry.middleware.id);
	}

	get empty(): boolean {
		return this.entries.length === 0;
	}

	private context(attempt: number): ProviderRequestMiddlewareContext {
		return {
			requestId: this.match.requestId,
			runtimeId: this.match.runtimeId,
			providerId: this.match.providerId,
			model: this.match.model,
			api: this.match.model.api,
			purpose: this.match.purpose,
			attempt,
			signal: this.match.signal,
		};
	}

	private async abortable<T>(operation: () => T | Promise<T>): Promise<T> {
		this.match.signal?.throwIfAborted();
		return raceWithAbortSignal(Promise.resolve().then(operation), this.match.signal);
	}

	async transformHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		let value = headers;
		for (const entry of this.entries) {
			if (!entry.middleware.transformHeaders) continue;
			const next = await this.abortable(() => entry.middleware.transformHeaders!(value, this.context(0)));
			if (next !== undefined) value = next;
		}
		return value;
	}

	async transformPayload(payload: unknown, attempt: number): Promise<unknown> {
		let value = payload;
		for (const entry of this.entries) {
			if (!entry.middleware.transformPayload) continue;
			const next = await this.abortable(() => entry.middleware.transformPayload!(value, this.context(attempt)));
			if (next !== undefined) value = next;
		}
		return value;
	}

	async afterResponse(response: ProviderResponse, attempt: number): Promise<void> {
		for (const entry of this.entries) {
			if (!entry.middleware.afterResponse) continue;
			await this.abortable(() => entry.middleware.afterResponse!(response, this.context(attempt)));
		}
	}
}

const EMPTY_CHAIN = new ProviderRequestMiddlewareChain([], {
	requestId: "",
	runtimeId: "",
	providerId: "",
	model: undefined as unknown as Model<Api>,
	purpose: "other",
});

/**
 * Instance-local registry owned by a `ModelRuntime`. Never process-global:
 * multiple SDK runtimes in one process may have different providers,
 * credentials, and policies.
 */
export class ProviderRequestMiddlewareRegistry {
	private nextSeq = 0;
	private readonly entries: MiddlewareEntry[] = [];

	/** Number of active registrations. Used for the no-middleware fast path. */
	get size(): number {
		return this.entries.length;
	}

	/** Diagnostic list of active middleware IDs (unordered). */
	ids(): readonly string[] {
		return this.entries.filter((entry) => !entry.disposed).map((entry) => entry.middleware.id);
	}

	register(middleware: ProviderRequestMiddleware, owner: string): ProviderRequestMiddlewareRegistration {
		validateProviderRequestMiddleware(middleware, owner);
		if (this.entries.some((entry) => entry.owner === owner && entry.middleware.id === middleware.id)) {
			throw new Error(
				`Provider request middleware "${middleware.id}" is already registered by ${owner}. Use a unique ID or dispose the previous registration first.`,
			);
		}
		const entry: MiddlewareEntry = { seq: this.nextSeq++, owner, middleware, disposed: false };
		this.entries.push(entry);
		return {
			id: middleware.id,
			dispose: () => {
				entry.disposed = true;
				const index = this.entries.indexOf(entry);
				if (index !== -1) this.entries.splice(index, 1);
			},
		};
	}

	/** Remove every registration owned by `owner` (extension reload/dispose). */
	disposeOwner(owner: string): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			if (this.entries[i].owner === owner) {
				this.entries[i].disposed = true;
				this.entries.splice(i, 1);
			}
		}
	}

	/**
	 * Snapshot the middleware matching one logical request, ordered by
	 * ascending priority (default 0) then ascending registration sequence.
	 */
	snapshot(match: ProviderRequestMiddlewareMatch): ProviderRequestMiddlewareChain {
		if (this.entries.length === 0) return EMPTY_CHAIN;
		const matching = this.entries.filter((entry) => !entry.disposed && matchesProvider(entry, match));
		if (matching.length === 0) return EMPTY_CHAIN;
		matching.sort((a, b) => {
			const pa = a.middleware.priority ?? 0;
			const pb = b.middleware.priority ?? 0;
			return pa !== pb ? pa - pb : a.seq - b.seq;
		});
		return new ProviderRequestMiddlewareChain(matching, match);
	}
}
