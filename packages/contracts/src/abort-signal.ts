/**
 * Request options carrying `signal` only when the caller passed one, because
 * `exactOptionalPropertyTypes` rejects an explicit `signal: undefined`.
 */
export const withSignal = (signal: AbortSignal | undefined): { signal?: AbortSignal } => (signal ? { signal } : {});
