import { routeAccessPolicy } from "./route-access.js";
import { type NextFunction, type Request, type Response } from "express";
import type {
  AppSession,
} from "@climate-twin/contracts";
import { openApiV1Document, openApiV2Document } from "../openapi.js";
import { SYSTEM_VERSION } from "../version.js";
import { registerStugubyLocalRoutes } from "../stuguby/routes.js";
import { HttpError, LOCAL_CSRF_COOKIE, LOCAL_SESSION_COOKIE, LOCAL_SESSION_MAX_AGE_MS, LocalVisibility, SAFE_HTTP_METHODS, cookieValue, isTrackingObserverHeartbeatPath, localAuthorizationFingerprint, requestPrincipal, requireWorkspaceAdmin, secureRequest, sessionDocument } from "./support/index.js";
import type { LocalRequestPrincipal } from "./support/index.js";
import type { RequestPipeline } from "./request-pipeline.js";



/** Authentication and visibility: session middleware, principal resolution, stream authorization, and the session, OpenAPI and health routes. */
export function installAccessControl(context: RequestPipeline) {
  const config = context.config;
  const routes = routeAccessPolicy(context.prefix, context.v2Prefix);
  context.app.use((request, response, next) => {
      // Authentication endpoints were parsed above because their credentials are
      // themselves needed for authentication and abuse limiting. Everything else
      // is authorized before the server allocates a potentially large JSON body.
      if (request.path.startsWith(`${context.prefix}/auth/`)) { next(); return; }
      if (request.path === `${context.prefix}/cloudflare/setup/start`) {
        response.locals.accountBodyLimit = "16 KiB";
        context.cloudflareSetupJsonParser(request, response, next);
        return;
      }
      if (request.path === `${context.prefix}/bug-reports`) {
        response.locals.accountBodyLimit = "32 KiB";
        context.memberJsonParser(request, response, next);
        return;
      }
      if (request.path.startsWith(`${context.prefix}/tenant/members`)
        || request.path.startsWith(`${context.prefix}/internal/tapo-history/`)) {
        response.locals.accountBodyLimit = "32 KiB";
        context.memberJsonParser(request, response, next);
        return;
      }
      if (request.method === "POST" && (
        request.path === `${context.prefix}/tracking/evidence:batch`
        || isTrackingObserverHeartbeatPath(request.path, context.prefix)
      )) {
        response.locals.accountBodyLimit = "256 KiB";
        context.trackingObserverJsonParser(request, response, next);
        return;
      }
      response.locals.accountBodyLimit = "15 MiB";
      context.apiJsonParser(request, response, next);
    });
  // Readings and source health already travel through the authenticated live
    // stream. Announce every other successful mutation there as well, allowing
    // all open browsers to refresh properties, tasks, notes, access grants, and
    // configuration without a manual reload.
    context.app.use((request, response, next) => {
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS" && !routes.sideEffectFreePost(request);
      if (!unsafe || routes.quietMutation(request)) { next(); return; }
      response.once("finish", () => {
        if (response.statusCode < 200 || response.statusCode >= 400) return;
        const resource = request.path.startsWith(context.v2Prefix)
          ? request.path.slice(context.v2Prefix.length) || "/"
          : request.path.startsWith(context.prefix)
            ? request.path.slice(context.prefix.length) || "/"
            : request.path;
        context.bus.publish({ type: "mutation", data: { method: request.method, resource, occurredAt: new Date().toISOString() } });
      });
      next();
    });
  registerStugubyLocalRoutes(context.app, context.stuguby, { requireAdmin: requireWorkspaceAdmin });
  // The request gate checks the ingest API key once and records the outcome.
  const requireIngestKey = (_request: Request, response: Response, next: NextFunction): void => {
      if (!config.ingestApiKey || response.locals.ingestServiceAuthorized === true) { next(); return; }
      next(new HttpError(401, "UNAUTHORIZED", "A valid ingestion API key is required"));
    };
  const visibility = (response: Response): LocalVisibility => new LocalVisibility(context.database, requestPrincipal(response));
  const currentStreamIdentity = (request: Request, response: Response): LocalRequestPrincipal | null => {
      const accepted = requestPrincipal(response);
      if (accepted.bootstrap) return accepted;
      const current = context.localAuth.sessionForToken(cookieValue(request, LOCAL_SESSION_COOKIE));
      return current ? { ...current, bootstrap: false } : null;
    };
  const currentStreamVisibility = (request: Request, response: Response): LocalVisibility | null => {
      const current = currentStreamIdentity(request, response);
      return current ? new LocalVisibility(context.database, current) : null;
    };
  const streamAuthorizationFingerprint = (request: Request, response: Response): string | null => {
      const current = currentStreamIdentity(request, response);
      return current ? localAuthorizationFingerprint(current) : null;
    };
  const authorizedStreamVisibility = (
      request: Request,
      response: Response,
      acceptedFingerprint: string,
    ): LocalVisibility | null => {
      const current = currentStreamIdentity(request, response);
      const currentFingerprint = current ? localAuthorizationFingerprint(current) : null;
      if (current && currentFingerprint === acceptedFingerprint) return new LocalVisibility(context.database, current);
      if (!response.destroyed && !response.writableEnded) {
        const status = current ? "changed" : "expired";
        response.end(`event: authorization\ndata: ${JSON.stringify({ status })}\n\n`);
      }
      return null;
    };
  context.app.get(`${context.prefix}/health`, async (_request, response) => {
      const eventLoopProbeStartedAt = performance.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const eventLoopLagMs = Number((performance.now() - eventLoopProbeStartedAt).toFixed(3));
      const archive = context.telemetryArchive?.status();
      const requiredArchiveUnavailable = config.timeseriesRequired === true && (
        !archive || archive.phase === "degraded" || archive.phase === "stopped" || !archive.timescaleAvailable
      );
      const measurementCache = context.measurementSnapshotCache.stats();
      const readingCache = context.readingSnapshotCache.stats();
      response.status(requiredArchiveUnavailable ? 503 : 200).json({
        status: requiredArchiveUnavailable ? "degraded" : "ok",
        systemVersion: SYSTEM_VERSION,
        apiVersion: "v1",
        database: "ready",
        telemetryArchive: archive ? {
          enabled: true,
          required: config.timeseriesRequired,
          phase: archive.phase,
          caughtUp: archive.caughtUp,
          timescaleAvailable: archive.timescaleAvailable,
          timescaleVersion: archive.timescaleVersion,
          hypertables: archive.hypertables,
          aggregateMode: archive.aggregateMode,
          coldStorageMode: archive.coldStorageMode,
          schemaWarningCount: archive.schemaWarningCount,
          queuedSamples: archive.queuedSamples,
          dirtyRows: context.database.telemetryArchiveDirtyCount(),
          lastSuccessAt: archive.lastSuccessAt,
          lastFailureAt: archive.lastFailureAt,
        } : { enabled: false, required: false, phase: "disabled", caughtUp: false },
        cache: {
          entries: measurementCache.entries + readingCache.entries,
          estimatedBytes: measurementCache.estimatedBytes + readingCache.estimatedBytes,
          hits: measurementCache.hits + readingCache.hits,
          misses: measurementCache.misses + readingCache.misses,
        },
        analytics: context.analyticsWorkLimiter.snapshot(),
        timeseriesPool: context.timeseries ? {
          total: context.timeseries.pool.totalCount,
          idle: context.timeseries.pool.idleCount,
          waiting: context.timeseries.pool.waitingCount,
        } : null,
        timeseriesQueries: context.timeseries?.diagnostics() ?? null,
        eventLoopLagMs,
        uptimeSeconds: Math.round(process.uptime()),
      });
    });
  context.app.get(`${context.prefix}/openapi.json`, (_request, response) => response.json(openApiV1Document));
  context.app.get(`${context.v2Prefix}/openapi.json`, (_request, response) => response.json(openApiV2Document));
  context.app.get(`${context.prefix}/session`, (request, response) => {
      if (!context.localAuth.isInitialized()) {
        const session: AppSession = {
          authenticated: false,
          principal: { type: "setup-required", email: null },
          tenant: { id: "local", name: "Local Stugu", role: "owner" },
          availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
          readOnly: true,
          grants: [],
          setupRequired: true,
        };
        response.json({ ...session, systemVersion: SYSTEM_VERSION });
        return;
      }
      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      if (!principal || principal.bootstrap || !principal.csrfToken) {
        throw new HttpError(401, "UNAUTHORIZED", "Sign in to access this workspace");
      }
      response.cookie(LOCAL_CSRF_COOKIE, principal.csrfToken, {
        httpOnly: false,
        sameSite: "strict",
        secure: secureRequest(request, config),
        path: "/api",
        maxAge: LOCAL_SESSION_MAX_AGE_MS,
      });
      response.json(sessionDocument(principal, principal.csrfToken));
    });
  const extended = Object.assign(context, { requireIngestKey, visibility, currentStreamIdentity, currentStreamVisibility, streamAuthorizationFingerprint, authorizedStreamVisibility });
  return extended;
}
