import type { Request } from "express";
import { isIOSNotificationRegistrationPath, isTrackingObserverHeartbeatPath } from "./support/request-classification.js";

/**
 * The routes that are exceptions to the general access rules, in one place for
 * the authentication gate and the mutation feed: which requests a machine
 * credential authorizes, which writes are side-effect free or allowed to a
 * Guest, and which successful writes are not announced as workspace mutations.
 */
export interface RouteAccessPolicy {
  /** POSTs that only read, such as analytics queries: no CSRF token, no Guest refusal, no mutation event. */
  sideEffectFreePost(request: Request): boolean;
  /** Telemetry ingestion that a valid ingest API key authorizes instead of a session. */
  ingestService(request: Request): boolean;
  /** Writes a Guest may make about themselves: signing out, their iOS registration, a bug report. */
  guestSelfService(request: Request): boolean;
  /** Administrative configuration a Guest cannot reach. */
  administration(request: Request): boolean;
  /** Successful writes that do not announce a workspace mutation. */
  quietMutation(request: Request): boolean;
}

export function routeAccessPolicy(prefix: string, v2Prefix: string): RouteAccessPolicy {
  const sideEffectFreePosts = new Set([`${v2Prefix}/analytics/query`, `${v2Prefix}/analytics/coverage`]);
  const ingestPaths = new Set([`${prefix}/readings`, `${v2Prefix}/measurements`, `${v2Prefix}/measurements/import`]);
  // Read-only analytics that still require a member session and CSRF token.
  const analyticsReads = new Set([`${v2Prefix}/analytics/opening-activity`, `${v2Prefix}/analytics/calendar-comparison`]);
  const demoEngine = (path: string) => path.startsWith(`${prefix}/mock/`) || path === `${prefix}/replay`;
  return {
    sideEffectFreePost: (request) => request.method === "POST" && sideEffectFreePosts.has(request.path),
    ingestService: (request) => request.method === "POST" && ingestPaths.has(request.path),
    guestSelfService: (request) => request.path === `${prefix}/auth/logout`
      || (["PUT", "DELETE"].includes(request.method) && isIOSNotificationRegistrationPath(request.path, prefix))
      || (request.method === "POST" && request.path === `${prefix}/bug-reports`),
    administration: (request) => request.path.startsWith(`${prefix}/integrations/`) || demoEngine(request.path),
    // Authentication, machine ingestion and observer evidence carry their own
    // signals; bug reports, analytics reads and the demo engines change no
    // workspace state.
    quietMutation: (request) => request.path.startsWith(`${prefix}/auth/`)
      || ingestPaths.has(request.path)
      || analyticsReads.has(request.path)
      || request.path === `${prefix}/tracking/evidence:batch`
      || isTrackingObserverHeartbeatPath(request.path, prefix)
      || request.path === `${prefix}/bug-reports`
      || demoEngine(request.path),
  };
}
