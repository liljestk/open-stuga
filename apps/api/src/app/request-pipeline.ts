import { routeAccessPolicy } from "./route-access.js";
import { roleCanAccessNonGuestConfiguration } from "@climate-twin/contracts";
import express from "express";
import {
  type LocalAuthSession,
} from "../local-auth.js";
import {
  cloudflareSetupCallbackPath,
} from "../cloudflare-setup.js";
import { registerStugubyProtocolRoutes } from "../stuguby/routes.js";
import {
  TrackingError,
} from "../tracking/store.js";
import { HttpError, LOCAL_SESSION_COOKIE, SAFE_HTTP_METHODS, appleNotesGrant, cookieValue, isTrackingObserverHeartbeatPath, keyMatches, localCloudflareUiRequestAllowed, trackingObserverAttemptKeys } from "./support/index.js";
import type { LocalRequestPrincipal } from "./support/index.js";
import type { RuntimeCoordination } from "./runtime-coordination.js";



/** Request middleware ahead of authentication: body parsers per route zone, Cloudflare setup callbacks, the Stuguby peer protocol and request guards. */
export function installRequestPipeline(context: RuntimeCoordination) {
  const config = context.config;
  context.app.get(cloudflareSetupCallbackPath, async (request, response) => {
      if (!localCloudflareUiRequestAllowed(request, config)) {
        throw new HttpError(403, "CLOUDFLARE_SETUP_LOCAL_ONLY", "Cloudflare approval must return to this Stugu's local address");
      }
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) {
        if (typeof value === "string") query.set(key, value);
      }
      const operation = await context.cloudflareSetup.completeOAuth(query);
      const successful = operation.phase !== "failed";
      response.status(successful ? 200 : 400);
      response.type("html");
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-frame-options", "DENY");
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.send(`<!doctype html>
  <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>${successful ? "Cloudflare approved" : "Cloudflare approval not completed"}</title>
  <body style="font:16px system-ui,sans-serif;max-width:38rem;margin:10vh auto;padding:1.5rem;color:#1b1d1a;background:#f1efe9">
  <h1>${successful ? "Cloudflare approved" : "Approval not completed"}</h1>
  <p>${successful
      ? "Stugu is finishing the secure connection. You can close this window and return to Stugu."
      : "Return to Stugu to review the problem and try again."}</p>
  </body></html>`);
    });
  context.app.get(`${context.prefix}/internal/cloudflare-setup/claims/:id`, (request, response) => {
      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const claim = context.cloudflareSetup.claim(request.params.id, bearer);
      response.setHeader("cache-control", "no-store");
      if (!claim) {
        response.status(404).json({ error: { code: "CLOUDFLARE_SETUP_CLAIM_NOT_FOUND", message: "Setup claim was not found" } });
        return;
      }
      response.json(claim);
    });
  registerStugubyProtocolRoutes(context.app, context.stuguby);
  const authJsonParser = express.json({ limit: "8kb" });
  context.app.use((request, response, next) => {
      if (request.path.startsWith(`${context.prefix}/auth/`)) {
        response.locals.accountBodyLimit = "8 KiB";
        authJsonParser(request, response, next);
        return;
      }
      next();
    });
  const routes = routeAccessPolicy(context.prefix, context.v2Prefix);
  context.app.use((request, response, next) => {
      const initialized = context.localAuth.isInitialized();
      const rawToken = cookieValue(request, LOCAL_SESSION_COOKIE);
      const session = initialized ? context.localAuth.sessionForToken(rawToken) : null;
      if (session) {
        response.locals.localPrincipal = { ...session, bootstrap: false } satisfies LocalRequestPrincipal;
      } else if (!initialized && config.localAuthTestBypass === true) {
        response.locals.localPrincipal = {
          userId: "bootstrap",
          email: "",
          role: "owner",
          joinedAt: "",
          grants: [],
          bootstrap: true,
        } satisfies LocalRequestPrincipal;
      }

      const tapoWorkerPath = request.path.startsWith(`${context.prefix}/internal/tapo-history/`);
      if (tapoWorkerPath) {
        response.setHeader("cache-control", "no-store");
        if (!config.tapoHistoryEnabled || !config.tapoHistoryWorkerToken) {
          next(new HttpError(404, "TAPO_HISTORY_WORKER_DISABLED", "Tapo history worker endpoint is disabled"));
          return;
        }
        const authorization = request.header("authorization");
        const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
        if (!bearer || !keyMatches(bearer, config.tapoHistoryWorkerToken)) {
          next(new HttpError(401, "UNAUTHORIZED", "A valid Tapo history worker token is required"));
          return;
        }
        next();
        return;
      }

      const trackingObserverPath = (
        request.method === "POST"
        && (
          request.path === `${context.prefix}/tracking/evidence:batch`
          || isTrackingObserverHeartbeatPath(request.path, context.prefix)
        )
      ) || (
        request.method === "GET"
        && new RegExp(
          `^${context.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`
          + "/tracking/observers/[^/]+/resolution-manifest$",
          "u",
        ).test(request.path)
      );
      const trackingAuthorization = request.header("authorization");
      const trackingBearer = trackingAuthorization?.startsWith("Bearer ")
        ? trackingAuthorization.slice(7)
        : null;
      if (trackingObserverPath && trackingBearer?.startsWith("stugu_observer.")) {
        if (!context.tracking.enabled) {
          next(new TrackingError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled"));
          return;
        }
        const release = context.trackingObserverAbuseLimiter.enter(
          trackingObserverAttemptKeys(request, config, trackingBearer),
          response,
        );
        let authenticated = false;
        try {
          const observer = context.tracking.authenticateObserverCredential(trackingBearer);
          if (!observer) {
            next(new TrackingError(401, "UNAUTHORIZED", "A valid observer credential is required"));
            return;
          }
          authenticated = true;
          response.locals.trackingObserver = observer;
          next();
        } finally {
          release(authenticated);
        }
        return;
      }

      const preSetupPath = request.path === `${context.prefix}/health`
        || request.path === `${context.prefix}/openapi.json`
        || request.path === `${context.v2Prefix}/openapi.json`
        || request.path === `${context.prefix}/session`
        || request.path === `${context.prefix}/auth/setup`;
      if (!initialized && config.localAuthTestBypass !== true) {
        if (preSetupPath) { next(); return; }
        next(new HttpError(401, "SETUP_REQUIRED", "Create the first local Owner before using the API"));
        return;
      }

      const publicPath = preSetupPath
        || request.path === `${context.prefix}/auth/login`
        || request.path === `${context.prefix}/auth/register`;
      if (publicPath) { next(); return; }

      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      const providedIngestKey = request.header("x-api-key") ?? bearer;
      const validIngestService = routes.ingestService(request) && Boolean(
        config.ingestApiKey && providedIngestKey && keyMatches(providedIngestKey, config.ingestApiKey),
      );
      const hostMetricsServicePath = request.method === "GET"
        && request.path === `${context.prefix}/system/metrics`;
      const validHostMetricsService = hostMetricsServicePath && Boolean(
        config.ingestApiKey && providedIngestKey && keyMatches(providedIngestKey, config.ingestApiKey),
      );
      const appleNotesService = (request.method === "POST"
        && request.path === `${context.prefix}/integrations/apple-notes/capture`)
        || (request.method === "GET" && request.path === `${context.prefix}/integrations/apple-notes/snapshot`);
      if (validIngestService) {
        response.locals.ingestServiceAuthorized = true;
        next();
        return;
      }
      if (validHostMetricsService) {
        response.locals.hostMetricsAuthorized = true;
        next();
        return;
      }
      if (appleNotesService) {
        // Validate the route-scoped machine credential before the large parser.
        response.setHeader("cache-control", "no-store");
        appleNotesGrant(request, config);
        next();
        return;
      }

      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      if (!principal) {
        next(new HttpError(401, "UNAUTHORIZED", "Sign in to access this endpoint"));
        return;
      }
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && !routes.sideEffectFreePost(request);
      if (unsafe && !roleCanAccessNonGuestConfiguration(principal.role) && !routes.guestSelfService(request)) {
        next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts are read-only"));
        return;
      }
      if (!roleCanAccessNonGuestConfiguration(principal.role) && routes.administration(request)) {
        next(new HttpError(403, "FORBIDDEN", "Guest accounts cannot access administrative configuration"));
        return;
      }
      if (unsafe && !principal.bootstrap) {
        const authenticatedSession = session as LocalAuthSession;
        if (!context.localAuth.csrfMatches(authenticatedSession, request.header("x-csrf-token"))) {
          next(new HttpError(403, "CSRF_TOKEN_INVALID", "A valid X-CSRF-Token header is required"));
          return;
        }
      }
      next();
    });
  const cloudflareSetupJsonParser = express.json({ limit: "16kb" });
  const memberJsonParser = express.json({ limit: "32kb" });
  const trackingObserverJsonParser = express.json({ limit: "256kb" });
  const apiJsonParser = express.json({ limit: "15mb" });
  const extended = Object.assign(context, { authJsonParser, cloudflareSetupJsonParser, memberJsonParser, trackingObserverJsonParser, apiJsonParser });
  return extended;
}

export type RequestPipeline = ReturnType<typeof installRequestPipeline>;
