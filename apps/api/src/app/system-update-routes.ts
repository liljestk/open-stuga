import type { Request, Response } from "express";
import { SystemUpdateError } from "../system-updates.js";
import {
  HttpError,
  bodyObject,
  boundedSseWriter,
  localAuthorizationFingerprint,
  requestPrincipal,
  requireWorkspaceAdmin,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type SystemUpdateRouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "prefix"
  | "systemUpdates"
  | "recordSecurityAudit"
  | "rejectEventStreamDuringShutdown"
  | "acquireEventStream"
  | "authorizedStreamVisibility"
  | "registerEventStream"
>;

function registerUpdateEventStream(
  context: SystemUpdateRouteContext,
  request: Request,
  response: Response,
): void {
  if (context.rejectEventStreamDuringShutdown(response)) return;
  const releaseStream = context.acquireEventStream(response);
  if (!releaseStream) {
    response.setHeader("retry-after", "5");
    throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
  }
  const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
  const writer = boundedSseWriter(response);
  let previousStatus = "";
  const publishStatus = (): void => {
    if (response.destroyed || response.writableEnded) return;
    if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
    const status = context.systemUpdates.status();
    const serialized = JSON.stringify({
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      updateAvailable: status.updateAvailable,
      capability: status.capability,
      operation: status.operation,
    });
    if (serialized === previousStatus) return;
    previousStatus = serialized;
    writer.send(`event: system-update\ndata: ${serialized}\n\n`);
  };
  writer.send("retry: 1000\n\n");
  publishStatus();
  const poll = setInterval(publishStatus, 1_000);
  poll.unref();
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
      writer.send(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    }
  }, 10_000);
  heartbeat.unref();
  context.registerEventStream(
    request,
    response,
    () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      writer.dispose();
    },
    releaseStream,
  );
}

export function registerSystemUpdateRoutes(context: SystemUpdateRouteContext): void {
  context.app.get(`${context.prefix}/system/updates`, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(context.systemUpdates.status());
  });
  context.app.get(
    `${context.prefix}/system/updates/events`,
    requireWorkspaceAdmin,
    (request, response) => registerUpdateEventStream(context, request, response),
  );
  context.app.post(`${context.prefix}/system/updates/check`, requireWorkspaceAdmin, async (_request, response, next) => {
    try {
      response.setHeader("cache-control", "no-store");
      response.json(await context.systemUpdates.check());
    } catch (error) {
      next(error);
    }
  });
  context.app.patch(`${context.prefix}/system/updates/settings`, requireWorkspaceAdmin, (request, response, next) => {
    try {
      const status = context.systemUpdates.updateSettings(bodyObject(request.body));
      const principal = requestPrincipal(response);
      context.recordSecurityAudit(principal, {
        eventType: "system.update.settings.changed",
        subjectType: "system-update-settings",
        subjectId: "local",
        details: { mode: status.settings.mode, timezone: status.settings.timezone },
      });
      response.setHeader("cache-control", "no-store");
      response.json(status);
    } catch (error) {
      next(error instanceof TypeError ? new HttpError(400, "INVALID_UPDATE_SETTINGS", error.message) : error);
    }
  });
  context.app.post(`${context.prefix}/system/updates/install`, requireWorkspaceAdmin, async (_request, response, next) => {
    try {
      const status = await context.systemUpdates.queueLatest();
      const principal = requestPrincipal(response);
      context.recordSecurityAudit(principal, {
        eventType: "system.update.requested",
        subjectType: "system-update",
        subjectId: status.operation?.id ?? "unknown",
        details: { version: status.operation?.version ?? status.latestVersion ?? "unknown" },
      });
      response.setHeader("cache-control", "no-store");
      response.status(202).json(status);
    } catch (error) {
      next(error instanceof SystemUpdateError
        ? new HttpError(error.status, error.code, error.message)
        : error);
    }
  });
}
