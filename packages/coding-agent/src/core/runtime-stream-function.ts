import { Agent, type AgentMessage, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, RequestPurpose } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Runtime-derived stream functions and transport bindings.
 *
 * A `StreamFn` is a capability: permission to issue model requests through one
 * host runtime. `createAgentSession()` builds the canonical provider-aware
 * stream function here; same-process background agents must reuse that binding
 * (`AgentSession.getTransportBinding()`) instead of rediscovering transport
 * behavior, so foreground and background requests resolve the same exact
 * provider, credentials, retry policy, and provider request middleware.
 */

/** Capability handle describing a runtime-derived stream function. */
export interface AgentTransportBinding {
	/** The exact function assigned to the host session agent. */
	readonly streamFn: StreamFn;
	/** Owning ModelRuntime instance ID. Diagnostic metadata only, never authentication. */
	readonly runtimeId: string;
}

export interface RuntimeStreamFunctionOptions {
	/** Canonical provider/auth runtime that owns dispatch. */
	modelRuntime: ModelRuntime;
	/** Retry and timeout settings, read at request time so mid-session changes apply. */
	settingsManager: SettingsManager;
	/**
	 * Extension runner accessor. Indirection keeps reload effective: the runner
	 * is looked up per request rather than captured, so extension reload
	 * replaces handlers without replacing the stream function.
	 */
	getExtensionRunner?: () => ExtensionRunner | undefined;
}

/**
 * Build the canonical provider-aware `StreamFn` used by `createAgentSession()`.
 *
 * Request path:
 * 1. Read retry and timeout settings at call time.
 * 2. Preserve explicit per-request values over defaults.
 * 3. Merge provider attribution headers.
 * 4. Run `before_provider_headers` extension handlers.
 * 5. Call `ModelRuntime.streamSimple()`, which resolves the exact provider,
 *    auth, and provider-scoped request middleware.
 */
export function createRuntimeStreamFunction(options: RuntimeStreamFunctionOptions): StreamFn {
	const { modelRuntime, settingsManager, getExtensionRunner } = options;
	return async (model, context, streamOptions) => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
		// Use max int32 to effectively disable the timeout.
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const timeoutMs = streamOptions?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
		const websocketConnectTimeoutMs =
			streamOptions?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
		const headerRunner = getExtensionRunner?.();
		return modelRuntime.streamSimple(model, context, {
			...streamOptions,
			timeoutMs,
			websocketConnectTimeoutMs,
			maxRetries: streamOptions?.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) => {
				const headers = mergeProviderAttributionHeaders(
					model,
					settingsManager,
					streamOptions?.sessionId,
					requestHeaders,
				);
				return headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers ?? {})
					: (headers ?? {});
			},
		});
	};
}

/**
 * Create a transport binding from a runtime. The returned function is the
 * canonical runtime stream function; child agents constructed with it share
 * the host's provider composition and request middleware.
 */
export function createTransportBinding(options: RuntimeStreamFunctionOptions): AgentTransportBinding {
	return {
		streamFn: createRuntimeStreamFunction(options),
		runtimeId: options.modelRuntime.runtimeId,
	};
}

/** Options for constructing a same-process background agent from a host binding. */
export interface CreateBackgroundAgentOptions {
	/** Host transport binding obtained from the owning session or runtime. */
	transport: AgentTransportBinding;
	/** Initial agent state (system prompt, model, thinking level, tools). */
	initialState: AgentOptions["initialState"];
	/** Message converter for the child agent. */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Unique session ID for the child. Generated when omitted. */
	sessionId?: string;
	/** Logical request purpose used for tracing and host-side policy. */
	requestPurpose?: Extract<RequestPurpose, "background" | "subagent" | "compaction" | "branch-summary">;
	/** Optional per-request API key resolver (short-lived OAuth tokens). */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Dynamic context transform applied before each model request. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
}

/**
 * Construct a same-process background `Agent` that dispatches through the host
 * runtime binding. The child owns its transcript, session ID, and cancellation;
 * the host owns provider selection, credentials, and request middleware.
 *
 * A `StreamFn` cannot cross a process boundary. Subprocesses must either build
 * their own `ModelRuntime` from declarative provider/extension sources or use
 * a parent-owned RPC transport.
 */
export function createBackgroundAgent(options: CreateBackgroundAgentOptions): Agent {
	const { transport, initialState, convertToLlm, sessionId, requestPurpose, getApiKey, transformContext } = options;
	return new Agent({
		initialState,
		convertToLlm,
		transformContext,
		streamFn: transport.streamFn,
		requestPurpose: requestPurpose ?? "background",
		sessionId: sessionId ?? uuidv7(),
		getApiKey,
	});
}
