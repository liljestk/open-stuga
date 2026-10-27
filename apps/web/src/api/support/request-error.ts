/** A request the API answered with an error status and its error envelope. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** The server's message for a failed request when it sent one, otherwise the caller's fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** The HTTP status of a failed API request, or null for any other failure. */
export function apiErrorStatus(error: unknown): number | null {
  return error instanceof ApiRequestError && Number.isInteger(error.status)
    && error.status >= 100 && error.status <= 599 ? error.status : null;
}
