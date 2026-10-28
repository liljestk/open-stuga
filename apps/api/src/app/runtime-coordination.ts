import { reportBackgroundFailure } from "../system-error-log.js";
import express, { type Request, type Response } from "express";
import type {
  IntegrationStatus,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "../version.js";
import { HttpError, MAX_EVENT_STREAMS_GLOBAL, MAX_EVENT_STREAMS_PER_USER, SAFE_HTTP_METHODS, browserOriginAllowed, normalizedOrigin, requestPrincipal } from "./support/index.js";
import type { ExternalFeedServices } from "./external-feed-services.js";
import { compareCodeUnits } from "../text-order.js";

/** The Express app, internal event wakes, the live event-stream registry and integration status helpers. */
export function createRuntimeCoordination(context: ExternalFeedServices) {
  const app = express();
  app.disable("x-powered-by");
  // Security middleware classifies route prefixes before Express dispatches.
  // Keep dispatch case-sensitive so mixed-case paths cannot cross auth zones.
  app.set("case sensitive routing", true);
  // Authentication decisions use the real socket address. Proxy headers must
  // never turn a remote first-owner setup request into a loopback request.
  app.disable("trust proxy");
  const config = context.config;
  const removeSnapshotMutationWake = context.bus.subscribe((event) => {
      if (event.type === "mutation") context.invalidateSnapshotCaches();
    });
  const removeSpatialLayerWake = context.bus.subscribeMeasurements((sample) => {
      context.notifySpatial((runtime) => runtime.wakeMeasurement(sample));
    });
  const removeNotificationWake = context.bus.subscribe((event) => {
      if (event.type === "alert" && event.data.resolvedAt === null) context.notificationOutbox.wake();
    });
  context.notificationOutbox.start();
  // Keep the production build independent of the contracts package's TypeScript source export.
    const prefix = "/api/v1" as const;
  const v2Prefix = "/api/v2" as const;
  const activeEventStreams = new Set<(notifyClient?: boolean) => void>();
  const activeEventStreamsByUser = new Map<string, number>();
  const homeAssistantConfigurationGenerations = new Map<string, number>();
  const tpLinkConfigurationGenerations = new Map<string, number>();
  const synchronizeCloudflareAccess = async (): Promise<{
      status: "disabled" | "pending" | "synced";
      lastSyncedAt: string | null;
    }> => {
      if (!context.cloudflareAccess) return { status: "disabled", lastSyncedAt: null };
      try {
        const result = await context.cloudflareAccess.synchronize();
        return { status: result.status, lastSyncedAt: result.lastSyncedAt };
      } catch {
        reportBackgroundFailure(context.systemErrorLog, {
          level: "warning", source: "cloudflare-access", code: "SYNC_PENDING", message: "Member allowlist synchronization is pending",
        });
        return { status: "pending", lastSyncedAt: context.cloudflareAccess.status().lastSyncedAt };
      }
    };
  const integrationStatusForHouse = (houseId?: string): IntegrationStatus => {
      const value = structuredClone(context.status.value);
      if (!houseId) return value;
      const homeAssistantConnections = (value.homeAssistant.connections ?? [])
        .filter((connection) => connection.houseId === houseId);
      value.homeAssistant.connections = homeAssistantConnections;
      value.homeAssistant.configured = homeAssistantConnections.some((connection) => connection.configured);
      value.homeAssistant.connected = homeAssistantConnections.some((connection) => connection.connected);
      value.homeAssistant.lastEventAt = homeAssistantConnections.map((connection) => connection.lastEventAt)
        .filter((timestamp): timestamp is string => Boolean(timestamp)).sort(compareCodeUnits).at(-1) ?? null;
      value.homeAssistant.mappedEntities = homeAssistantConnections
        .reduce((total, connection) => total + connection.mappedEntities, 0);
      value.homeAssistant.error = homeAssistantConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      const tpLinkConnections = (value.tpLink.connections ?? []).filter((connection) => connection.houseId === houseId);
      value.tpLink.connections = tpLinkConnections;
      value.tpLink.configured = tpLinkConnections.some((connection) => connection.configured);
      value.tpLink.connected = tpLinkConnections.some((connection) => connection.connected);
      value.tpLink.lastPollAt = tpLinkConnections.map((connection) => connection.lastPollAt)
        .filter((timestamp): timestamp is string => Boolean(timestamp)).sort(compareCodeUnits).at(-1) ?? null;
      value.tpLink.mappedDevices = tpLinkConnections.reduce((total, connection) => total + connection.mappedDevices, 0);
      value.tpLink.discoveredDevices = tpLinkConnections.reduce((total, connection) => total + connection.discoveredDevices, 0);
      value.tpLink.hubModel = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.hubModel : null;
      value.tpLink.host = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.host ?? null : null;
      value.tpLink.sourceType = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.sourceType ?? null : null;
      value.tpLink.sourceModel = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.sourceModel ?? null : null;
      value.tpLink.sourceAlias = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.sourceAlias ?? null : null;
      value.tpLink.error = tpLinkConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      if (value.gree) {
        const greeConnections = value.gree.connections.filter((connection) => connection.houseId === houseId);
        value.gree.connections = greeConnections;
        value.gree.configured = greeConnections.some((connection) => connection.configured);
        value.gree.connected = greeConnections.some((connection) => connection.connected);
        value.gree.lastPollAt = greeConnections.map((connection) => connection.lastPollAt)
          .filter((timestamp): timestamp is string => Boolean(timestamp)).sort(compareCodeUnits).at(-1) ?? null;
        value.gree.error = greeConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      }
      if (value.tuya) {
        const tuyaConnections = value.tuya.connections.filter((connection) => connection.houseId === houseId);
        value.tuya.connections = tuyaConnections;
        value.tuya.configured = tuyaConnections.some((connection) => connection.configured);
        value.tuya.connected = tuyaConnections.some((connection) => connection.connected);
        value.tuya.lastPollAt = tuyaConnections.map((connection) => connection.lastPollAt)
          .filter((timestamp): timestamp is string => Boolean(timestamp)).sort(compareCodeUnits).at(-1) ?? null;
        value.tuya.error = tuyaConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      }
      const weatherConnections = (value.weather.connections ?? []).filter((connection) => connection.houseId === houseId);
      value.weather.connections = weatherConnections;
      value.weather.configuredHouses = weatherConnections.filter((connection) => connection.configured).length;
      value.weather.provider = weatherConnections[0]?.provider ?? value.weather.provider;
      value.weather.lastSuccessAt = weatherConnections[0]?.lastSuccessAt ?? null;
      value.weather.error = weatherConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      return value;
    };
  const assertTpLinkConnectionScope = (sensor: {
      houseId: string;
      tpLinkDeviceId?: string | null;
      tpLinkConnectionId?: string | null;
    }): void => {
      if (!sensor.tpLinkDeviceId) {
        if (sensor.tpLinkConnectionId) throw new HttpError(400, "INVALID_TP_LINK_BINDING", "tpLinkConnectionId requires tpLinkDeviceId");
        return;
      }
      const discoveredDevice = context.tpLink.listDiscoveredDevices(sensor.houseId)
        .find((device) => device.deviceId === sensor.tpLinkDeviceId
          && (!sensor.tpLinkConnectionId || device.connectionId === sensor.tpLinkConnectionId));
      if (discoveredDevice?.deviceType === "contact") {
        throw new HttpError(
          422,
          "TP_LINK_CONTACT_REQUIRES_OPENING",
          "Door and window contact sensors must be attached to an opening in the Home floor plan",
        );
      }
      if (!sensor.tpLinkConnectionId) return;
      const connection = (config.tpLinkConnections ?? []).find((candidate) => candidate.id === sensor.tpLinkConnectionId);
      if (!connection) throw new HttpError(422, "TP_LINK_CONNECTION_NOT_FOUND", "The selected TP-Link connection no longer exists");
      if (connection.houseId !== sensor.houseId) {
        throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "The selected TP-Link connection belongs to another house");
      }
    };
  const acquireEventStream = (response: Response): (() => void) | null => {
      if (context.runtimeState.shutdownStarted || context.runtimeState.activeEventStreamCount >= MAX_EVENT_STREAMS_GLOBAL) return null;
      const userId = requestPrincipal(response).userId;
      const userCount = activeEventStreamsByUser.get(userId) ?? 0;
      if (userCount >= MAX_EVENT_STREAMS_PER_USER) return null;
      context.runtimeState.activeEventStreamCount += 1;
      activeEventStreamsByUser.set(userId, userCount + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        context.runtimeState.activeEventStreamCount = Math.max(0, context.runtimeState.activeEventStreamCount - 1);
        const remaining = Math.max(0, (activeEventStreamsByUser.get(userId) ?? 1) - 1);
        if (remaining === 0) activeEventStreamsByUser.delete(userId);
        else activeEventStreamsByUser.set(userId, remaining);
      };
    };
  const rejectEventStreamDuringShutdown = (response: Response): boolean => {
      if (!context.runtimeState.shutdownStarted) return false;
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "close");
      response.flushHeaders();
      response.end(": server shutting down\n\n");
      return true;
    };
  const registerEventStream = (
      request: Request,
      response: Response,
      dispose: () => void,
      releaseLease: () => void,
    ): void => {
      let active = true;
      const closeStream = (notifyClient = false): void => {
        if (!active) return;
        active = false;
        dispose();
        releaseLease();
        activeEventStreams.delete(closeStream);
        if (notifyClient && !response.destroyed && !response.writableEnded) {
          response.write(": server shutting down\n\n");
          response.end();
        }
      };
      activeEventStreams.add(closeStream);
      request.once("aborted", () => closeStream());
      response.once("close", () => closeStream());
      // A request accepted just before server.close() can reach this handler
      // after shutdown has begun; do not let that late SSE stream block drain.
      if (context.runtimeState.shutdownStarted) closeStream(true);
    };
  app.use((request, response, next) => {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-api-version", request.path.startsWith(v2Prefix) ? "v2" : "v1");
      response.setHeader("x-stugu-system-version", SYSTEM_VERSION);
      if (request.path.startsWith(prefix) || request.path.startsWith(v2Prefix)) {
        // Account and Guest scope are carried by an HttpOnly cookie. Never let a
        // browser or shared intermediary reuse one account's API representation
        // after logout, account switching, or an access-grant change.
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("pragma", "no-cache");
      }
      const origin = request.header("origin");
      const originAllowed = origin ? browserOriginAllowed(request, origin, config) : false;
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS";
      const crossSite = request.header("sec-fetch-site")?.toLowerCase() === "cross-site";
      if (((unsafe || request.method === "OPTIONS") && origin !== undefined && !originAllowed)
        || (unsafe && crossSite && !originAllowed)) {
        next(new HttpError(403, "CROSS_SITE_REQUEST_REJECTED", "Cross-site browser requests are not allowed"));
        return;
      }
      if (config.corsOrigin && originAllowed && normalizedOrigin(origin) === normalizedOrigin(config.corsOrigin)) {
        response.setHeader("access-control-allow-origin", normalizedOrigin(config.corsOrigin)!);
        response.setHeader("access-control-allow-credentials", "true");
        response.setHeader("access-control-expose-headers", "x-api-version, x-stugu-system-version");
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        response.setHeader("access-control-allow-headers", "Content-Type,Authorization,X-API-Key,X-CSRF-Token,X-Stugu-Bootstrap-Secret,Last-Event-ID");
      }
      if (request.method === "OPTIONS") { response.status(204).end(); return; }
      next();
    });
  const extended = Object.assign(context, { app, removeSnapshotMutationWake, removeSpatialLayerWake, removeNotificationWake, prefix, v2Prefix, activeEventStreams, activeEventStreamsByUser, homeAssistantConfigurationGenerations, tpLinkConfigurationGenerations, synchronizeCloudflareAccess, integrationStatusForHouse, assertTpLinkConnectionScope, acquireEventStream, rejectEventStreamDuringShutdown, registerEventStream });
  return extended;
}

export type RuntimeCoordination = ReturnType<typeof createRuntimeCoordination>;
