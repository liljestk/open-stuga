import { sqliteFailure } from "../db/sqlite-failure.js";
import type { NextFunction, Request, Response } from "express";
import { TelegramServiceError } from "../telegram.js";
import { IncompleteTelemetryHistoryError } from "../timeseries/read-facade.js";
import { RollupsMaterializingError } from "../timeseries/read-support.js";
import { AnalyticsCapacityError } from "../analytics/work-limiter.js";
import { LocalTelemetryTimeoutError } from "../timeseries/local-telemetry-worker.js";
import { HttpError, isRequestCancellation } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** One error response: the shared `{ error: { code, message, details? } }` envelope plus headers. */
interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  retryAfter?: string;
}

/**
 * Maps the API's own error types; null for anything else. Domain errors extend
 * HttpError and carry their own status and code.
 */
function knownErrorResponse(error: unknown): ErrorResponse | null {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
  }
  if (error instanceof LocalTelemetryTimeoutError) {
    return { status: 503, code: error.code, message: error.message, retryAfter: "1" };
  }
  if (error instanceof AnalyticsCapacityError || error instanceof RollupsMaterializingError) {
    return { status: 503, code: error.code, message: error.message, retryAfter: String(error.retryAfterSeconds) };
  }
  if (error instanceof IncompleteTelemetryHistoryError) {
    return { status: 503, code: error.code, message: error.message, details: { archiveState: error.archiveState } };
  }
  if (error instanceof TelegramServiceError) return { status: error.status, code: `TELEGRAM_${error.code}`, message: error.message };
  return null;
}

/** Maps body-parser and SQLite constraint failures; null for anything else. */
function infrastructureErrorResponse(error: unknown, response: Response): ErrorResponse | null {
  const parserError = error as { status?: unknown; type?: unknown };
  if (parserError.status === 413 || parserError.type === "entity.too.large") {
    const limit = typeof response.locals.accountBodyLimit === "string" ? response.locals.accountBodyLimit : "15 MiB";
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${limit} limit` };
  }
  // Only the request body parser reports client JSON. Any other SyntaxError
  // (stored or upstream data) is a server fault and must reach the error log.
  if (parserError.type === "entity.parse.failed") {
    return { status: 400, code: "INVALID_JSON", message: "Request body is not valid JSON" };
  }
  const failure = sqliteFailure(error);
  if (failure?.kind === "foreign-key") {
    return { status: 409, code: "INVALID_REFERENCE", message: "A referenced resource does not exist" };
  }
  if (failure?.kind === "unique") {
    return { status: 409, code: "CONFLICT", message: "A resource with this identifier already exists" };
  }
  if (failure?.kind === "trigger" && failure.detail === "DEMO_DATA_DISABLED") {
    return { status: 409, code: "DEMO_DATA_DISABLED", message: "Demo telemetry is permanently disabled for this real-data database" };
  }
  return null;
}

function sendError(response: Response, { status, code, message, details, retryAfter }: ErrorResponse): void {
  if (retryAfter !== undefined) response.setHeader("retry-after", retryAfter);
  response.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

/**
 * Answers unknown API paths with 404 and maps every error to the one error
 * envelope. Register after every route: Express runs these in order.
 */
export function registerApiErrorHandling(context: ApiRouteRegistrationContext): void {
  context.app.use(`${context.prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use(`${context.v2Prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use(apiErrorMiddleware((error) => context.systemErrorLog.record({
    source: "api",
    code: error instanceof Error ? error.name : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "Unexpected error",
  })));
}

/**
 * The one error envelope for every route. `recordUnexpected` sees only faults
 * that are neither a known error type nor a cancelled request.
 */
export function apiErrorMiddleware(recordUnexpected: (error: unknown) => void) {
  return (error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    const mapped = knownErrorResponse(error) ?? infrastructureErrorResponse(error, response);
    if (mapped) {
      if (!response.headersSent && !response.writableEnded && !response.destroyed) sendError(response, mapped);
      return;
    }
    if (isRequestCancellation(error)) {
      // Nothing failed: the caller left, or the work was cancelled on its behalf.
      // Reporting these as errors buried the real ones in the system error log.
      if (!response.headersSent && !response.writableEnded && !response.destroyed) {
        sendError(response, { status: 503, code: "REQUEST_CANCELLED", message: "The request was cancelled before it completed", retryAfter: "1" });
      }
      return;
    }
    recordUnexpected(error);
    if (response.headersSent || response.writableEnded || response.destroyed) return;
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  };
}
