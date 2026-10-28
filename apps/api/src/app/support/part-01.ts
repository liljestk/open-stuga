import { optionalBoolean, optionalString, requiredNumber, requiredString } from "../../request-fields.js";
import { type Request, type Response } from "express";
import type {
  HouseLocation,
  HouseMapPlacement,
} from "@climate-twin/contracts";
import { type AppConfig } from "../../config.js";
import { trustedProxyRequest } from "./part-04.js";
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

export function credentialString(body: Record<string, unknown>, key: string, maximumLength: number, trim = false): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return trim ? value.trim() : value;
}

export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD"]);

export const MAX_SSE_QUEUE_MESSAGES = 128;

export const MAX_SSE_QUEUE_BYTES = 256 * 1024;

export const MAX_EVENT_STREAMS_GLOBAL = 64;

export const MAX_EVENT_STREAMS_PER_USER = 8;

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

export interface BoundedSseWriter {
  send: (payload: string) => boolean;
  dispose: () => void;
}

export function boundedSseWriter(response: Response): BoundedSseWriter {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let disposed = false;
  const flush = (): void => {
    if (disposed || response.destroyed || response.writableEnded) return;
    blocked = false;
    while (queue.length > 0 && !blocked) {
      const payload = queue.shift()!;
      queuedBytes -= Buffer.byteLength(payload);
      blocked = !response.write(payload);
    }
  };
  response.on("drain", flush);
  return {
    send(payload): boolean {
      if (disposed || response.destroyed || response.writableEnded) return false;
      if (!blocked && queue.length === 0) {
        blocked = !response.write(payload);
        return true;
      }
      const bytes = Buffer.byteLength(payload);
      if (queue.length >= MAX_SSE_QUEUE_MESSAGES || queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
        disposed = true;
        response.off("drain", flush);
        response.end();
        return false;
      }
      queue.push(payload);
      queuedBytes += bytes;
      return true;
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      response.off("drain", flush);
    },
  };
}

export function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function requestOrigin(request: Request, config: AppConfig): string | null {
  const host = request.header("host");
  if (!host) return null;
  const forwardedProtocol = trustedProxyRequest(request, config)
    ? request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    : null;
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : request.protocol;
  return normalizedOrigin(`${protocol}://${host}`);
}

export function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function trustedSelfHostname(hostname: string, apiHost: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") return true;
  const configured = normalizedHostname(apiHost);
  return !["0.0.0.0", "::", ""].includes(configured) && normalized === configured;
}

export function browserOriginAllowed(request: Request, origin: string, config: AppConfig): boolean {
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  if (normalized === normalizedOrigin(config.corsOrigin)) return true;
  if (normalized !== requestOrigin(request, config)) return false;
  if (trustedProxyRequest(request, config)) return true;
  return trustedSelfHostname(new URL(normalized).hostname, config.apiHost);
}

export function homeAssistantUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(400, "INVALID_FIELD", "url must be a valid HTTP or HTTPS Home Assistant address");
  }
}

export function networkHost(value: string): string {
  const host = value.trim();
  const hostnameOrIpv4 = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
  const ipv6 = host.includes(":") && /^[0-9A-Fa-f:]+$/.test(host);
  if (host.length > 253 || (!hostnameOrIpv4 && !ipv6)) {
    throw new HttpError(400, "INVALID_FIELD", "host must be an IP address or local network name without a URL scheme");
  }
  return host;
}

export function houseLocationValue(value: unknown): HouseLocation;

export function houseLocationValue(value: unknown, allowNull: true): HouseLocation | null;

export function houseLocationValue(value: unknown, allowNull = false): HouseLocation | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_FIELD", "location must be an object with latitude and longitude");
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const label = optionalString(body, "label")?.trim();
  const countryCode = optionalString(body, "countryCode")?.trim().toUpperCase();
  const source = optionalString(body, "source")?.trim() as HouseLocation["source"];
  const confidence = optionalString(body, "confidence")?.trim() as HouseLocation["confidence"];
  const discoveredAt = optionalString(body, "discoveredAt")?.trim();
  const userOverridden = optionalBoolean(body, "userOverridden");
  return {
    latitude,
    longitude,
    ...(label ? { label } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(source ? { source } : {}),
    ...(confidence ? { confidence } : {}),
    ...(discoveredAt ? { discoveredAt } : {}),
    ...(userOverridden !== undefined ? { userOverridden } : {}),
  };
}

export function houseMapPlacementValue(value: unknown): HouseMapPlacement;

export function houseMapPlacementValue(value: unknown, allowNull: true): HouseMapPlacement | null;

export function houseMapPlacementValue(value: unknown, allowNull = false): HouseMapPlacement | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      "mapPlacement must be an object with latitude, longitude, and metersPerPlanUnit",
    );
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const metersPerPlanUnit = requiredNumber(body, "metersPerPlanUnit");
  const footprintFloorId = body.footprintFloorId === undefined
    ? undefined
    : requiredString(body, "footprintFloorId");
  return { latitude, longitude, metersPerPlanUnit, ...(footprintFloorId ? { footprintFloorId } : {}) };
}

export const PROPERTY_AREA_KINDS = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
] as const;

export const AREA_EQUIPMENT_STATUSES = ["active", "out-of-service", "retired"] as const;

export const PROPERTY_NOTE_KINDS = ["note", "inspection", "maintenance"] as const;
