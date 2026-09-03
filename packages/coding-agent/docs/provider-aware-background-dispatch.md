# Provider-Aware Background Dispatch and Provider-Scoped Request Middleware

Status: Proposed

Scope: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`

## Summary

This document proposes implementing two changes together:

1. Require every foreground and background agent loop to receive an explicit, host-owned, provider-aware `StreamFn`.
2. Add provider-scoped request middleware to `ModelRuntime` so an extension can transform or observe requests for one exact provider without replacing a shared API implementation.

The changes solve related but different problems:

- Explicit stream-function injection ensures every Pi-owned agent call enters the canonical `ModelRuntime` path.
- Provider-scoped middleware gives extensions a narrow interception point inside that canonical path.

The combined target is:

```text
Agent or agentLoop
  -> explicit runtime-derived StreamFn
  -> ModelRuntime
  -> exact provider selected by model.provider
  -> provider-scoped request middleware
  -> composed Provider
  -> provider API adapter
  -> network
```

This proposal is generic infrastructure for legitimate provider integrations, gateways, tracing, policy enforcement, schema normalization, and compatibility handling. It does not define or endorse client-identity impersonation, entitlement circumvention, or billing-control bypasses.

## Problem Statement

Pi currently has two relevant dispatch paths.

The canonical path is used by `AgentSession`:

```text
AgentSession
  -> Agent.streamFunction
  -> ModelRuntime.streamSimple()
  -> provider-composer
  -> provider or provider override
  -> API adapter
```

A compatibility path also exists for older compiled consumers and callers that construct low-level agents incorrectly:

```text
Agent or agentLoop without an explicit runtime stream function
  -> process-global default StreamFn
  -> pi-ai compat.streamSimple
  -> API registry
  -> built-in API adapter
```

The compatibility path does not necessarily include provider registrations held by `ModelRuntime`. A main interactive request can therefore use a composed provider while an auxiliary or background request in the same process bypasses it.

The existing `before_provider_request` extension event has a similar ownership problem. `createAgentSession()` attaches it to the particular `Agent` it creates through `Agent.onPayload`. A separately constructed `Agent` or raw `agentLoop()` does not automatically carry that hook.

These behaviors create four classes of inconsistency:

1. Provider behavior differs between foreground and background requests.
2. Extension request hooks depend on which agent constructor was used.
3. API-scoped overrides can accidentally affect unrelated providers sharing the same wire protocol.
4. A missing stream function silently falls back instead of failing at the construction boundary.

## Current Implementation

### Agent loop boundary

The current low-level API already types `streamFn` as required:

```text
packages/agent/src/agent-loop.ts:32-50
packages/agent/src/agent-loop.ts:65-93
```

Every assistant response is obtained through the supplied function:

```text
packages/agent/src/agent-loop.ts:279-310
```

The stateful `Agent` stores the function at construction time and forwards it to every prompt or continuation:

```text
packages/agent/src/agent.ts:179-184
packages/agent/src/agent.ts:216-225
packages/agent/src/agent.ts:409-433
```

Runtime compatibility remains because both `Agent` and the low-level implementation still use `getDefaultStreamFn()` when an older JavaScript consumer omits the argument.

### Canonical coding-agent stream function

`createAgentSession()` currently builds a provider-aware function inline:

```text
packages/coding-agent/src/core/sdk.ts:304-341
```

That function:

- reads retry and timeout settings;
- applies provider attribution headers;
- dispatches `before_provider_headers` extension events;
- calls `modelRuntime.streamSimple()`;
- preserves the caller's per-request options.

The same `Agent` receives `onPayload` and `onResponse` callbacks for `before_provider_request` and `after_provider_response`:

```text
packages/coding-agent/src/core/sdk.ts:343-360
```

### ModelRuntime dispatch

`ModelRuntime.streamSimple()` performs auth preparation and dispatches to the exact composed provider:

```text
packages/coding-agent/src/core/model-runtime.ts:573-640
```

Provider composition selects an extension provider override before a built-in provider or API-registry fallback:

```text
packages/coding-agent/src/core/provider-composer.ts:454-472
```

### Existing payload callback

`ProviderRequestOptions` already includes:

```ts
onPayload?: (
  payload: unknown,
  model: Model<Api>,
) => unknown | undefined | Promise<unknown | undefined>;

onResponse?: (
  response: ProviderResponse,
  model: Model<Api>,
) => void | Promise<void>;
```

See:

```text
packages/ai/src/types.ts:133-151
```

Built-in adapters invoke these callbacks after constructing a provider-specific payload and around the HTTP response. Custom `streamSimple` implementations are contractually required to do the same:

```text
packages/coding-agent/src/core/extensions/types.ts:1520-1532
```

The missing piece is a provider-scoped registry owned by `ModelRuntime` and applied independently of a particular `Agent` instance.

## Goals

The simultaneous implementation must satisfy these goals:

1. Every Pi-owned agent loop uses an explicit `StreamFn`.
2. Pi-owned background loops use the same `ModelRuntime` and provider composition as their host.
3. Request middleware is scoped by exact provider ID, not only by API protocol.
4. Existing per-agent `onPayload`, `onResponse`, and header transforms continue to work.
5. Multiple middleware registrations compose deterministically.
6. Unregistering or reloading an extension removes its middleware without affecting in-flight requests.
7. Authentication remains centralized in `ModelRuntime`; background agents do not receive raw stored credentials.
8. Two providers that share an API type remain isolated.
9. Request failures before network transmission remain observable and deterministic.
10. Existing custom providers can adopt the feature without changing their stream event contract.

## Non-Goals

This proposal does not:

- serialize a JavaScript `StreamFn` into a child process;
- automatically copy temporary parent extensions into subprocesses;
- globally monkey-patch `fetch`;
- modify requests that bypass `ModelRuntime` by directly calling an API adapter;
- make one API-registry slot provider-aware;
- expose raw OAuth tokens to request middleware by default;
- define provider-specific authentication or attribution behavior;
- authorize extensions to circumvent provider terms, billing, access controls, or client attestation.

## Target Architecture

```text
+---------------------------------------------------------------+
| Host runtime                                                  |
|                                                               |
|  ModelRuntime                                                 |
|    - credentials                                              |
|    - provider catalog                                         |
|    - exact-provider composition                               |
|    - provider request middleware registry                     |
|                                                               |
|  Runtime StreamFn                                             |
|    - timeout/retry defaults                                   |
|    - per-agent request hooks                                  |
|    - ModelRuntime dispatch                                    |
|                                                               |
|  +-----------------+  +-----------------+  +----------------+ |
|  | Main Agent      |  | Background A    |  | Background B   | |
|  | own transcript  |  | own transcript  |  | own transcript | |
|  | own session ID  |  | own session ID  |  | own session ID | |
|  +--------+--------+  +--------+--------+  +-------+--------+ |
|           |                    |                   |          |
|           +--------------------+-------------------+          |
|                                |                              |
|                                v                              |
|                    explicit Runtime StreamFn                  |
|                                |                              |
|                                v                              |
|                    exact ModelRuntime provider                |
|                                |                              |
|                                v                              |
|                    provider middleware chain                  |
|                                |                              |
|                                v                              |
|                         API adapter/network                    |
+---------------------------------------------------------------+
```

Separate processes require separate runtime construction or an explicit parent RPC broker:

```text
Child process                 Parent process
-------------                 --------------
Agent                         ModelRuntime
  -> RPC StreamFn proxy  ->     -> Provider -> Network
```

The in-process implementation must not claim to solve subprocess propagation.

# Part I: Explicit Provider-Aware Stream Functions

## Design Principle

A `StreamFn` is a capability. It gives an agent permission to issue model requests through a particular host runtime.

The host owns:

- provider selection;
- credentials and refresh;
- request defaults;
- provider middleware;
- retry policy;
- extension integration;
- observability.

The child owns:

- transcript;
- system prompt;
- tools;
- session ID;
- cancellation;
- steering and follow-up queues.

No background caller should independently rediscover transport behavior when a host runtime already exists.

## Proposed Public Types

Keep the existing `StreamFn` type in `@earendil-works/pi-agent-core` as the fundamental contract.

Add a coding-agent binding type that describes a runtime-derived capability without exposing `ExtensionRunner`:

```ts
export interface AgentTransportBinding {
  readonly streamFn: StreamFn;
  readonly runtimeId: string;
}
```

`runtimeId` is diagnostic metadata only. It must not be treated as authentication.

Optionally add a getter to `AgentSession`:

```ts
interface AgentSession {
  getTransportBinding(): AgentTransportBinding;
}
```

The binding should return the exact function already assigned to `session.agent.streamFunction`. It should not construct a second routing path.

## Internal Stream Function Factory

Extract the inline closure from `packages/coding-agent/src/core/sdk.ts` into an internal helper, for example:

```text
packages/coding-agent/src/core/runtime-stream-function.ts
```

Conceptual signature:

```ts
interface RuntimeStreamFunctionOptions {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  getExtensionRunner(): ExtensionRunner | undefined;
}

function createRuntimeStreamFunction(
  options: RuntimeStreamFunctionOptions,
): StreamFn;
```

The helper must preserve the current order:

1. Read retry and timeout settings at request time.
2. Preserve explicit per-request values over defaults.
3. Merge provider attribution headers.
4. Run `before_provider_headers` handlers.
5. Call `ModelRuntime.streamSimple()`.
6. Let `ModelRuntime` apply provider middleware.
7. Let the selected provider and API adapter send the request.

Settings must be read at call time rather than captured as fixed values so changes made during a session remain effective.

## Background Agent Construction

Every same-process background agent must be created through one of these supported patterns:

1. A host helper that creates a child `Agent` with the host binding.
2. A direct `new Agent({ streamFn: binding.streamFn, ... })` call.
3. A raw `agentLoop(..., binding.streamFn)` call.

The implementation should prefer a host helper for Pi-owned background workers because it can also assign:

- a unique session ID;
- a child telemetry context;
- cancellation ownership;
- request purpose metadata;
- bounded retry policy;
- lifecycle cleanup.

Suggested internal helper:

```ts
interface CreateBackgroundAgentOptions {
  transport: AgentTransportBinding;
  initialState: AgentState;
  convertToLlm: AgentOptions["convertToLlm"];
  sessionId: string;
  requestPurpose: "background" | "subagent" | "summarization";
}
```

`requestPurpose` is routing and observability metadata. It must not grant access or alter provider entitlements.

## Eliminate Silent Fallbacks

Current TypeScript declarations require `streamFn`, but runtime compatibility still allows omission:

```text
Agent constructor -> runtimeOptions.streamFn ?? getDefaultStreamFn()
runAgentLoop       -> streamFn ?? getDefaultStreamFn()
```

Implement a staged migration.

### Stage A: diagnostics

- Keep the fallback temporarily.
- Emit a one-time process warning identifying the callsite category when possible.
- Add a counter to diagnostics showing how many agents used the default.
- Document that the global default bypasses `ModelRuntime` provider composition.

### Stage B: Pi-owned migration

- Update every Pi-owned `new Agent()` call to pass an explicit stream function.
- Update every Pi-owned `agentLoop()` and `agentLoopContinue()` call similarly.
- Add a source check that rejects new callsites without the required argument.
- Add tests proving no coding-agent path reaches `getDefaultStreamFn()`.

### Stage C: runtime enforcement

At the next appropriate breaking release:

- remove the nullish fallback from low-level loop functions;
- make the `Agent` constructor throw a targeted error when `streamFn` is absent;
- remove `setDefaultStreamFn(streamSimple)` from coding-agent startup;
- retain `setDefaultStreamFn` only if another package has a documented standalone host use case, otherwise deprecate it.

Recommended error:

```text
No provider-aware stream function was supplied. Construct this agent through
createAgentSession(), pass a ModelRuntime-derived StreamFn, or provide a custom
provider StreamFn explicitly.
```

## Lifecycle Rules

A runtime-derived binding must obey these rules:

1. It remains valid while its owning `ModelRuntime` remains active.
2. Extension reload affects subsequent requests, not in-flight requests.
3. Session replacement must either preserve the same runtime intentionally or issue a new binding.
4. A disposed host must reject new calls through stale bindings.
5. Cancellation is supplied per request and must not be stored on the binding.
6. A child supplies its own session ID through request options.
7. Credentials are resolved for every request so OAuth refresh remains current.

## Concurrency Rules

The shared stream function must be safe for concurrent calls.

- `ModelRuntime` must not store mutable request-local state on the runtime object.
- Middleware chains must be snapshotted per request.
- Extension handlers that maintain state remain responsible for their own synchronization.
- Request IDs must distinguish concurrent children.
- One child's abort signal must not cancel sibling requests.
- Retry state must remain request-local.

## Subprocess Behavior

A `StreamFn` cannot cross a process boundary. A spawned Pi process must either:

1. Create its own `ModelRuntime`, resource loader, provider registrations, and request middleware; or
2. Use a documented RPC transport whose parent owns the actual `ModelRuntime` call.

For a local child runtime:

- pass declarative provider and extension sources, not function objects;
- reload credentials through the normal credential store;
- do not serialize access tokens into command-line arguments;
- report which provider extensions the child actually loaded;
- distinguish launch intent from child-runtime acknowledgement.

For a parent RPC broker:

- stream all assistant events in order;
- propagate aborts;
- authenticate the local child connection;
- enforce child model/tool/usage policy in the parent;
- report usage to the child and parent exactly once;
- handle parent death and child death explicitly;
- avoid placing complete prompts or credentials in process listings.

RPC brokering is out of scope for the first implementation.

# Part II: Provider-Scoped Request Middleware

## Design Principle

Request middleware must be scoped to a provider identity, not merely a wire protocol.

For example, these can share one API adapter while requiring different routing behavior:

```text
provider = anthropic
api      = anthropic-messages

provider = cloudflare-ai-gateway
api      = anthropic-messages
```

An API-registry override keyed only by `anthropic-messages` cannot safely distinguish them before provider-level base URL and auth composition.

`ModelRuntime` already knows the exact provider. It is therefore the correct owner for provider-scoped middleware.

## Proposed Types

Add public types in coding-agent, with shared payload and response primitives imported from pi-ai:

```ts
export type ProviderRequestPurpose =
  | "interactive"
  | "background"
  | "subagent"
  | "compaction"
  | "branch-summary"
  | "title-generation"
  | "other";

export interface ProviderRequestMiddlewareContext {
  readonly requestId: string;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly model: Model<Api>;
  readonly api: Api;
  readonly purpose: ProviderRequestPurpose;
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface ProviderRequestMiddleware {
  readonly id: string;
  readonly provider: string | readonly string[];
  readonly models?: readonly string[];
  readonly apis?: readonly Api[];
  readonly priority?: number;

  transformHeaders?(
    headers: ProviderHeaders,
    context: ProviderRequestMiddlewareContext,
  ): ProviderHeaders | void | Promise<ProviderHeaders | void>;

  transformPayload?(
    payload: unknown,
    context: ProviderRequestMiddlewareContext,
  ): unknown | void | Promise<unknown | void>;

  afterResponse?(
    response: ProviderResponse,
    context: ProviderRequestMiddlewareContext,
  ): void | Promise<void>;
}

export interface ProviderRequestMiddlewareRegistration {
  readonly id: string;
  dispose(): void;
}
```

The exact names may change during implementation. The required properties are exact-provider scope, deterministic ordering, disposal, request identity, and cancellation context.

## Registration Surfaces

Provide two surfaces.

### Direct SDK registration

```ts
const registration = modelRuntime.registerRequestMiddleware(middleware);
registration.dispose();
```

This is useful for SDK hosts that do not use Pi extensions.

### Extension registration

```ts
pi.registerProviderRequestMiddleware(middleware);
```

The extension loader owns disposal automatically when the extension unloads or reloads. Extensions should not need access to `ModelRuntime` internals.

The extension-facing API must reject registration when:

- `id` is empty;
- `provider` contains an empty identifier;
- the same extension registers a duplicate ID;
- priority is non-finite;
- no transform or observer callback is present.

## Registry Ownership

Add an instance-local registry to `ModelRuntime`:

```ts
private readonly requestMiddleware = new ProviderRequestMiddlewareRegistry();
```

Do not use a process-global singleton. Multiple SDK runtimes in the same process may intentionally have different providers, credentials, and policies.

The registry should store:

- registration sequence number;
- owner identity;
- middleware ID;
- provider/model/API predicates;
- priority;
- callbacks;
- disposed state.

Sort matching middleware by:

1. ascending `priority`, default `0`;
2. ascending registration sequence.

Snapshot the ordered list once when `prepareRequest()` begins. Disposing a registration does not mutate an in-flight request's snapshot.

## Request Pipeline

The target request path is:

```text
1. Agent transforms context
2. Agent converts messages to provider-neutral Context
3. Runtime StreamFn receives model/context/options
4. ModelRuntime resolves exact provider and credentials
5. ModelRuntime merges configured and per-request headers
6. Existing per-call header transform runs
7. Matching provider header middleware runs
8. Provider/API adapter constructs native payload
9. Existing per-call onPayload callback runs
10. Matching provider payload middleware runs
11. Adapter sends request
12. Adapter receives HTTP response
13. Existing per-call onResponse callback runs
14. Matching provider response middleware runs
15. Adapter consumes and normalizes the stream
```

Provider-scoped middleware runs after existing per-call transforms so runtime policy has a deterministic final request view. If compatibility with current provider wrappers requires a different order, expose explicit phases instead of relying on registration accidents.

## Composition in ModelRuntime

`ModelRuntime.prepareRequest()` currently resolves auth and applies `transformHeaders`. Extend it conceptually as follows:

```ts
const chain = this.requestMiddleware.snapshot({
  providerId: model.provider,
  model,
  purpose: options?.requestPurpose ?? "other",
});

let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
headers = await applyCallerHeaderTransform(headers, transformHeaders);
headers = await chain.transformHeaders(headers, requestContext);

const callerOnPayload = providerOptions.onPayload;
const callerOnResponse = providerOptions.onResponse;

providerOptions.onPayload = async (payload, payloadModel) => {
  const callerResult = await callerOnPayload?.(payload, payloadModel);
  const next = callerResult === undefined ? payload : callerResult;
  return chain.transformPayload(next, requestContext);
};

providerOptions.onResponse = async (response, responseModel) => {
  await callerOnResponse?.(response, responseModel);
  await chain.afterResponse(response, requestContext);
};
```

This is pseudocode. Production code must preserve generic option types and avoid installing callbacks when neither caller hooks nor middleware are present.

## Payload Semantics

Payload middleware runs after provider-specific serialization. The payload can therefore differ by API:

- Anthropic Messages request parameters;
- OpenAI Responses request body;
- OpenAI Chat Completions parameters;
- Google generation parameters;
- Bedrock command input;
- custom provider payloads.

Rules:

1. `undefined` or no return means no replacement.
2. Any other value becomes input to the next transform.
3. Middleware must not mutate the original object in place unless the API explicitly permits it.
4. A transform that throws prevents network transmission.
5. Middleware should be idempotent.
6. Middleware must not assume a particular schema unless it scopes itself to the corresponding API.
7. Middleware must not consume or clone streaming response bodies.

## Header Semantics

Header matching must be case-insensitive while preserving the last supplied casing for output.

Rules:

1. Start with provider/auth headers merged with per-call headers.
2. Run the existing per-call `transformHeaders` callback.
3. Run provider middleware in deterministic order.
4. A `null` value removes a header where the underlying provider contract permits removal.
5. Reserved signed headers for Bedrock remain protected.
6. Middleware must not log secrets by default.
7. Provider adapters may still add transport-required defaults after this stage; adapters must document headers that cannot be replaced.

If an exact final-wire header hook is required later, add it inside each adapter rather than globally wrapping `fetch`.

## Response Semantics

`afterResponse` runs after headers are available and before the response body is consumed, matching the current provider contract.

Rules:

1. Observers receive normalized status and headers, not the raw body.
2. Observers run once per actual HTTP response exposed by the adapter.
3. Retry attempts should carry an incremented `attempt` when the adapter can expose it.
4. Observer failures must follow one documented policy.

Recommended policy:

- request transforms are strict: failure aborts before send;
- response observers are strict by default to match current awaited callbacks;
- a future `bestEffort: true` option may log observer errors without masking provider responses.

## Request Purpose

Add an optional request-purpose field to the provider request options or telemetry context.

Suggested values:

```text
interactive
background
subagent
compaction
branch-summary
title-generation
other
```

The purpose is useful for:

- tracing;
- rate-policy decisions;
- audit logs;
- debugging inconsistent auxiliary requests;
- selecting cache behavior;
- distinguishing user-facing and maintenance traffic.

It must not be treated as trusted authorization. A caller can supply an incorrect label.

## Extension Lifecycle

Extension middleware registration must be tied to the extension instance.

On load:

1. Validate registration.
2. Assign owner and sequence metadata.
3. Add it to the runtime registry.

On reload or shutdown:

1. Mark registrations disposed.
2. Remove them from future registry snapshots.
3. Let in-flight snapshots finish.
4. Prevent stale extension callbacks from receiving new requests.

If an extension reload fails, the runtime should follow the same rollback policy used for other extension registrations. It must not leave half of a middleware set active.

## Security and Trust

Provider request middleware can inspect prompts, tool schemas, and headers. It is therefore highly privileged.

Requirements:

- only trusted global, CLI, or trusted-project extensions may register it;
- startup diagnostics must identify the owning extension;
- logs must redact authorization and cookie headers;
- middleware must not receive credential-store objects;
- project trust must be resolved before project middleware activates;
- capability ceilings that deny extensions must also deny their middleware;
- child-runtime status should distinguish requested middleware sources from acknowledged runtime registration.

Extensions already execute with full local user permissions, but explicit provenance remains important for diagnosis and policy.

## API Adapter Compliance

Every built-in adapter used by `ModelRuntime` must honor `onPayload` and `onResponse` consistently.

Current callsites exist in adapters including:

- `anthropic-messages.ts`;
- `openai-completions.ts`;
- `openai-responses.ts`;
- `openai-codex-responses.ts`;
- `azure-openai-responses.ts`;
- `google-generative-ai.ts`;
- `google-vertex.ts`;
- `mistral-conversations.ts`;
- `bedrock-converse-stream.ts`;
- `pi-messages.ts`;
- `openrouter-images.ts`.

Add a provider-adapter conformance suite that verifies:

1. `onPayload` receives the final native request before send.
2. A replacement payload is actually sent.
3. `onResponse` runs before body consumption.
4. callback failures become deterministic stream errors.
5. callback invocation count is documented under retries.
6. abort signals stop asynchronous transforms.

Custom providers continue to carry the documented obligation to invoke these callbacks.

# Simultaneous Implementation Plan

Implement the two designs in one coordinated sequence so no new middleware API is introduced while background agents still bypass the runtime that owns it.

## Phase 0: Characterization Tests

Before changing production code, add tests that pin current behavior.

1. A normal `AgentSession` reaches a provider override registered in `ModelRuntime`.
2. A raw agent using the compatibility default bypasses that override.
3. `before_provider_request` runs for a normal session request.
4. A separately constructed raw agent lacks that event unless explicitly configured.
5. Two providers sharing one API type can dispatch differently through `ModelRuntime`.
6. Direct API-adapter calls bypass coding-agent runtime behavior by design.

These tests should use fake providers and fetch spies. They must not require live provider credentials.

## Phase 1: Middleware Registry

Add the internal registry and unit tests without exposing it to extensions yet.

Suggested files:

```text
packages/coding-agent/src/core/provider-request-middleware.ts
packages/coding-agent/test/provider-request-middleware.test.ts
```

Implement:

- validation;
- exact-provider matching;
- optional model/API matching;
- deterministic ordering;
- snapshot semantics;
- disposal;
- concurrent request isolation.

## Phase 2: ModelRuntime Integration

Modify:

```text
packages/coding-agent/src/core/model-runtime.ts
```

Changes:

1. Own a middleware registry.
2. Expose direct SDK registration.
3. Generate a request ID for each logical dispatch.
4. Compose header transforms in `prepareRequest()`.
5. Compose payload and response callbacks into provider options.
6. Apply the same logic to `stream()` and `streamSimple()`.
7. Decide and document deferred fetch/cancel behavior.

Recommended v1 scope: `stream()` and `streamSimple()` only. Deferred operations can be added after their payload semantics are standardized.

## Phase 3: Extract Runtime Stream Function

Modify:

```text
packages/coding-agent/src/core/sdk.ts
```

Add:

```text
packages/coding-agent/src/core/runtime-stream-function.ts
```

Move the existing inline provider-aware stream function into the helper without changing behavior. Keep extension runner access behind a callback so reload replaces the active runner without replacing the function.

Expose the resulting binding through `AgentSession` or a narrow exported helper.

## Phase 4: Migrate Background Callers

Search for:

```text
new Agent(
agentLoop(
agentLoopContinue(
runAgentLoop(
runAgentLoopContinue(
```

For every Pi-owned callsite:

1. Identify the owning host runtime.
2. Obtain its runtime-derived stream binding.
3. Assign a unique session ID.
4. Set request-purpose metadata.
5. Pass the function explicitly.
6. Add a test proving the selected provider ID and middleware chain.

Do not use `setDefaultStreamFn()` as the migration mechanism.

## Phase 5: Extension API

Modify:

```text
packages/coding-agent/src/core/extensions/types.ts
packages/coding-agent/src/core/extensions/loader.ts
packages/coding-agent/src/core/extensions/runner.ts
```

Add `pi.registerProviderRequestMiddleware()` and bind each registration to its extension owner. Ensure reload and session replacement dispose registrations correctly.

The existing events remain supported:

```text
before_provider_headers
before_provider_request
after_provider_response
```

Their per-agent behavior should be implemented as per-call callbacks composed with runtime middleware. They should not be silently redefined as process-global hooks.

## Phase 6: Remove Pi-Owned Default Dispatch

Modify:

```text
packages/coding-agent/src/core/sdk.ts
packages/agent/src/agent.ts
packages/agent/src/agent-loop.ts
packages/agent/src/stream-fn.ts
```

After all Pi-owned callsites are explicit:

- remove `setDefaultStreamFn(streamSimple)` from coding-agent initialization;
- replace compatibility fallback use with a diagnostic error according to release policy;
- retain or deprecate the standalone global API based on documented external use.

## Phase 7: Documentation and Examples

Update:

```text
packages/coding-agent/docs/extensions.md
packages/coding-agent/docs/sdk.md
packages/coding-agent/docs/custom-provider.md
packages/agent/README.md
```

Add examples using neutral behavior:

- provider-scoped trace header;
- schema normalization for a custom provider;
- background summarizer using a host transport binding;
- two providers sharing an API type without cross-contamination;
- extension reload and middleware disposal.

# Detailed File Impact

## `packages/agent/src/agent-loop.ts`

- Keep `streamFn` required in TypeScript.
- Remove internal nullish fallback after migration.
- Ensure every continuation path uses the same supplied function.
- Add a targeted missing-function error for JavaScript callers during transition.

## `packages/agent/src/agent.ts`

- Keep `streamFunction` as an instance capability.
- Require it at runtime after the compatibility period.
- Preserve `onPayload`, `onResponse`, session ID, and cancellation in loop config.
- Consider making the property read-only after construction to prevent mid-run transport swaps.

## `packages/agent/src/stream-fn.ts`

- Add deprecation documentation to process-global defaults.
- Add diagnostics for fallback use during migration.
- Remove or isolate the global default in a later breaking release.

## `packages/coding-agent/src/core/sdk.ts`

- Extract runtime stream-function construction.
- Stop installing raw `compat.streamSimple` as coding-agent's global default.
- Return or expose the transport binding with the session.
- Keep per-agent extension hooks separate from provider middleware.

## `packages/coding-agent/src/core/model-runtime.ts`

- Own provider middleware registrations.
- Snapshot matching middleware per request.
- Compose header, payload, and response callbacks.
- Expose safe registration and disposal methods.
- Add runtime/request IDs and purpose metadata.

## `packages/coding-agent/src/core/provider-composer.ts`

No API-scoped registry override is needed. Existing exact-provider composition remains authoritative.

Review whether native provider replacements and legacy provider-config overrides should inherit runtime middleware automatically. Recommended answer: yes, because middleware scopes by provider ID and belongs above whichever provider implementation is currently composed.

## `packages/ai/src/types.ts`

Minimize changes. Existing `onPayload` and `onResponse` are sufficient for payload and response middleware composition.

Potential additions:

- request-purpose metadata in `ProviderRequestOptions`;
- an internal request-attempt identifier if adapters can expose retry attempts consistently.

Avoid moving the coding-agent extension registry into pi-ai unless non-coding-agent hosts demonstrate a need for the exact same registration abstraction.

## Extension loader and runner

- associate middleware registration with source provenance;
- reject registrations from untrusted project extensions;
- dispose registrations atomically on unload;
- expose bounded diagnostics without dumping prompts or secrets.

# Ordering and Precedence

Use one documented order across all providers.

## Request headers

```text
provider/auth headers
  -> per-request headers
  -> existing caller transformHeaders
  -> provider middleware by priority and registration order
  -> adapter-required transport headers
```

## Payload

```text
adapter-built payload
  -> existing caller onPayload
  -> provider middleware by priority and registration order
  -> network serialization
```

## Response

```text
HTTP response headers available
  -> existing caller onResponse
  -> provider middleware afterResponse by priority and registration order
  -> body/stream consumption
```

If a security-sensitive host needs an immutable final stage, add an explicit host-policy phase instead of relying on an extreme numeric priority.

# Failure Semantics

## Missing StreamFn

Fail before the first model request with a configuration error. Do not silently select `compat.streamSimple`.

## Header Transform Failure

Fail the request before provider dispatch. Include middleware ID and provider ID in the diagnostic, but do not include headers.

## Payload Transform Failure

Fail before network send. Include middleware ID, provider ID, model ID, and request ID. Do not serialize the payload into the error.

## Response Observer Failure

Follow the documented strict or best-effort policy. V1 should preserve current awaited-callback behavior unless compatibility testing shows that extensions depend on errors being swallowed.

## Stale Binding

Reject with a runtime-disposed error rather than falling back to another provider path.

## Unsupported Custom Provider

If a custom provider ignores `onPayload` or `onResponse`, startup cannot prove compliance. Provide a development conformance helper and document that middleware guarantees require a compliant provider implementation.

# Testing Strategy

## Unit Tests

### Stream function

- explicit function is called exactly once per model turn;
- prompt and continuation use the same function;
- child abort does not affect siblings;
- child session ID reaches provider options;
- missing function produces the intended diagnostic;
- no Pi-owned test relies on the global default.

### Middleware matching

- exact provider match;
- non-matching provider skipped;
- optional model match;
- optional API match;
- duplicate IDs rejected per owner;
- ordering by priority then sequence;
- disposal removes future matches;
- in-flight snapshot survives disposal;
- concurrent snapshots do not leak state.

### Middleware transforms

- no-return keeps the current value;
- replacement reaches the next transform;
- caller callback runs in documented order;
- thrown transform prevents fetch;
- response observer runs before stream consumption;
- abort signal cancels asynchronous middleware;
- secret headers are absent from diagnostics.

## Integration Tests

1. Register fake providers `alpha` and `beta` using the same API type.
2. Register middleware for `alpha` only.
3. Start a foreground agent and background agent with the same runtime binding.
4. Verify both `alpha` requests are transformed.
5. Verify no `beta` request is transformed.
6. Reload the extension.
7. Verify old registration is gone and new registration runs once.
8. Start two background agents concurrently and verify request IDs and cancellation isolation.

## Provider Conformance Tests

For each built-in adapter:

- capture the final outbound request with a fetch or SDK transport spy;
- replace one harmless payload field through `onPayload`;
- verify the replacement is sent;
- verify `onResponse` timing;
- verify abort and callback errors;
- record retry invocation behavior.

## Subprocess Tests

Subprocess behavior must be explicit:

- a child that reconstructs the same declarative provider setup loads its own middleware;
- a child without that setup does not inherit parent runtime middleware;
- launch metadata reports intended extension sources;
- child runtime acknowledgement is separate from parent launch intent;
- credentials never appear in process arguments.

# Observability

Add bounded diagnostics:

```text
runtime ID
request ID
request purpose
provider/model/API
middleware IDs that matched
middleware execution duration
request/response status
whether a runtime-derived or custom StreamFn was used
whether a compatibility default was used
```

Never log by default:

- request payloads;
- user or system prompts;
- tool arguments;
- authorization headers;
- cookies;
- OAuth tokens;
- full response bodies.

Debug payload logging must remain an explicit opt-in with clear redaction warnings.

# Performance Considerations

The common path with no middleware should allocate minimally.

- Store registrations in a provider-indexed map.
- Return early when no middleware matches.
- Avoid creating wrapper callbacks when no caller hook or runtime middleware exists.
- Snapshot arrays rather than locking the registry during async transforms.
- Measure middleware duration separately from provider latency.
- Do not deep-clone payloads in the runtime; transforms own any copy they require.

# Compatibility and Rollout

## Backward Compatibility

The middleware API is additive.

Removing silent stream-function fallback is behaviorally breaking for JavaScript and older compiled consumers. Use a warning period and release note.

Existing extension events remain available and retain per-agent semantics. Existing provider registrations continue to compose as before.

## Migration Guidance

### Existing SDK hosts

Prefer `createAgentSession()` and use its transport binding for same-process child agents.

### Existing raw `Agent` users

Pass an explicit custom or runtime-derived `streamFn`.

### Existing low-level `agentLoop` users

Pass the function explicitly and do not rely on a global default.

### Existing provider extensions

Keep `registerProvider()` for full provider replacement. Use provider request middleware only when payload/header/response interception is sufficient.

### Existing `before_provider_request` extensions

No migration is required. Move to provider middleware only when the transform must apply to every request through a provider rather than one AgentSession.

# Alternatives Considered

## Restore API-registry bridging

Rejected because the registry is keyed by API protocol, not exact provider. One override can affect unrelated providers sharing that API implementation.

## Globally wrap `fetch`

Rejected because it:

- misses SDKs or WebSockets that do not use global fetch;
- cannot reliably identify provider/model intent;
- risks intercepting unrelated network traffic;
- complicates streaming and abort semantics;
- creates global ordering conflicts.

## Set a process-global default StreamFn to one runtime

Rejected as the primary design because:

- multiple runtimes can coexist;
- last writer wins;
- lifecycle ownership is unclear;
- stale defaults can outlive sessions;
- tests interfere through global state.

A global fallback may remain temporarily for compatibility only.

## Register middleware by API type

Rejected as the default because providers sharing an API type can have different base URLs, authentication, signing, and routing behavior.

Optional API predicates are useful only after exact-provider matching.

## Give every extension direct access to ModelRuntime internals

Rejected because it increases coupling and makes lifecycle cleanup, provenance, and validation difficult. Expose a narrow registration API instead.

# Acceptance Criteria

The combined implementation is complete when all of the following are true:

1. Every Pi-owned `Agent` and low-level agent loop receives an explicit stream function.
2. Main and same-process background agents resolve the same exact provider through the same `ModelRuntime`.
3. No Pi-owned coding-agent path depends on raw `compat.streamSimple` as a hidden default.
4. Provider middleware can target one provider without affecting another provider sharing the same API type.
5. Existing caller payload/header/response hooks compose in documented order.
6. Middleware registration and disposal are safe across reload and concurrent requests.
7. Adapter conformance tests cover every built-in streaming API.
8. Missing stream functions fail clearly before a network request.
9. Subprocess limitations are documented and tested without claiming function inheritance.
10. No credential or prompt content is exposed in default diagnostics.
11. Extension-denying capability policies also prevent middleware registration or execution.
12. Documentation includes neutral, provider-agnostic examples.

# Recommended Delivery Sequence

A reviewable commit sequence is:

1. Add current-behavior characterization tests.
2. Add middleware registry types, matching, ordering, and disposal tests.
3. Integrate middleware composition into `ModelRuntime`.
4. Extract the canonical runtime stream-function factory from `sdk.ts`.
5. Expose a session transport binding.
6. Migrate Pi-owned background and auxiliary agents to explicit bindings.
7. Add extension registration and lifecycle plumbing.
8. Add built-in adapter conformance tests.
9. Add diagnostics and migration warnings for compatibility defaults.
10. Update documentation and neutral examples.
11. Remove coding-agent's raw global default in the chosen breaking release.

Implementing in this order keeps each commit testable while ensuring the public middleware API is not declared complete until background dispatch converges on the runtime that owns it.
