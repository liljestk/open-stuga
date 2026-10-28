import type { Request } from "express";
import { HttpError } from "../../http-error.js";

/**
 * True when work was explicitly aborted for the caller. Server-owned deadlines
 * use TimeoutError and remain real, logged failures.
 */
export function isRequestCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD"]);

export function isTrackingObserverHeartbeatPath(path: string, prefix: string): boolean {
  const routePrefix = `${prefix}/tracking/observers/`;
  if (!path.startsWith(routePrefix)) return false;
  const segments = path.slice(routePrefix.length).split("/");
  return Boolean(segments[0])
    && segments[1] === "heartbeat"
    && (segments.length === 2 || (segments.length === 3 && segments[2] === ""));
}

export function isIOSNotificationRegistrationPath(path: string, prefix: string): boolean {
  const routePrefix = `${prefix}/ios-notification-registrations/`;
  const id = path.startsWith(routePrefix) ? path.slice(routePrefix.length) : "";
  return Boolean(id) && !id.includes("/");
}

export function requireJsonContentType(request: Request): void {
  if (!request.is("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED", "This endpoint requires an application/json request body");
  }
}
