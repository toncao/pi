/**
 * Error message and guard for callers that omit the required `streamFn`.
 *
 * Every agent loop must receive an explicit stream function at construction or
 * call time. A process-global default is no longer consulted: it silently
 * bypassed host-owned provider composition (credentials, provider overrides,
 * and request middleware) for auxiliary/background agents in the same process.
 */
export const MISSING_STREAM_FN_MESSAGE =
	"No provider-aware stream function was supplied. Construct this agent through createAgentSession(), pass a ModelRuntime-derived StreamFn, or provide a custom provider StreamFn explicitly.";

/** @throws Always; use in place of a missing stream function. */
export function missingStreamFn(): never {
	throw new Error(MISSING_STREAM_FN_MESSAGE);
}
