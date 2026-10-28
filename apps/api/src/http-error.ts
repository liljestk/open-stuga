/**
 * A failure that already knows its HTTP answer. Domain errors extend it with
 * their own name, so routes let them propagate and the API error middleware
 * maps every one of them in one place.
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}
