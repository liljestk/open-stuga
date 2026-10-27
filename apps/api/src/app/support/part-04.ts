import { roleCanManageWorkspace } from "@climate-twin/contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import { type NextFunction, type Request, type Response } from "express";
import type {
  AppSession,
  HouseWeather,
} from "@climate-twin/contracts";
import { type AppConfig } from "../../config.js";
import {
  ClimateDatabase,
  outdoorLocationKey,
} from "../../db.js";
import {
  DataModeCoordinator,
} from "../../services.js";
import { SYSTEM_VERSION } from "../../version.js";
import {
  type LocalAuthIdentity,
} from "../../local-auth.js";
import {
  cloudflareSetupCallbackPath,
} from "../../cloudflare-setup.js";
import { HttpError } from "./http-error.js";
import { compareCodeUnits } from "../../text-order.js";

export function visibleCollectionPage<T>(
  load: (limit: number, offset: number) => T[],
  visible: (item: T) => boolean,
  page: { limit: number; offset: number },
): T[] {
  const result: T[] = [];
  let rawOffset = 0;
  let visibleOffset = 0;
  for (;;) {
    const batch = load(500, rawOffset);
    for (const item of batch) {
      if (!visible(item)) continue;
      if (visibleOffset < page.offset) {
        visibleOffset += 1;
        continue;
      }
      result.push(item);
      if (result.length >= page.limit) return result;
    }
    if (batch.length < 500) return result;
    rawOffset += batch.length;
  }
}

export function completeVisibleCollection<T>(
  load: (limit: number, offset: number) => T[],
  visible: (item: T) => boolean,
  maximum = 10_000,
): T[] {
  const result: T[] = [];
  let rawOffset = 0;
  for (;;) {
    const batch = load(500, rawOffset);
    for (const item of batch) {
      if (!visible(item)) continue;
      result.push(item);
      if (result.length > maximum) {
        throw new HttpError(
          413,
          "COLLECTION_TOO_LARGE",
          `This collection contains more than ${maximum} visible records`,
        );
      }
    }
    if (batch.length < 500) return result;
    rawOffset += batch.length;
  }
}

export function alertDurationSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 31_536_000) {
    throw new HttpError(400, "INVALID_FIELD", "durationSeconds must be an integer from 1 to 31536000");
  }
  return value;
}

export function optionalQueryNumber(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a finite number`);
  }
  return Number(value);
}

export function persistWeatherObservation(database: ClimateDatabase, weather: HouseWeather, dataMode?: DataModeCoordinator): void {
  if (weather.stale || !weather.current || !Number.isFinite(weather.current.temperatureC)) return;
  database.upsertCurrentOutdoorTemperatureSample({
    houseId: weather.houseId,
    locationKey: outdoorLocationKey(weather.location),
    timestamp: weather.current.timestamp,
    temperatureC: weather.current.temperatureC as number,
    source: weather.provider === "fmi" ? "fmi-observation" : "open-meteo-current",
    fetchedAt: weather.fetchedAt,
    stationId: weather.observationStation?.id ?? null,
    stationName: weather.observationStation?.name ?? null,
    conditions: weather.current,
  });
  // The repository performs the irreversible latch only after verifying the
  // location key. Synchronize runtime listeners after that guarded write.
  dataMode?.synchronize();
}

export function keyMatches(provided: string, expected: string): boolean {
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

export const LOCAL_SESSION_COOKIE = "stuga_session";

export const LOCAL_CSRF_COOKIE = "stuga_csrf";

export const LOCAL_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface LocalRequestPrincipal extends LocalAuthIdentity {
  bootstrap: boolean;
  csrfToken?: string;
}

export function cookieValue(request: Request, name: string): string | null {
  const header = request.header("cookie");
  if (!header || header.length > 16_384) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function secureRequest(request: Request, config: AppConfig): boolean {
  return request.secure || (trustedProxyRequest(request, config)
    && request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase() === "https");
}

export function setLocalSessionCookies(response: Response, request: Request, config: AppConfig, token: string, csrfToken: string): void {
  const common = {
    sameSite: "strict" as const,
    secure: secureRequest(request, config),
    path: "/api",
    maxAge: LOCAL_SESSION_MAX_AGE_MS,
  };
  response.cookie(LOCAL_SESSION_COOKIE, token, { ...common, httpOnly: true });
  response.cookie(LOCAL_CSRF_COOKIE, csrfToken, { ...common, httpOnly: false });
}

export function clearLocalSessionCookies(response: Response, request: Request, config: AppConfig): void {
  const common = { sameSite: "strict" as const, secure: secureRequest(request, config), path: "/api" };
  response.clearCookie(LOCAL_SESSION_COOKIE, { ...common, httpOnly: true });
  response.clearCookie(LOCAL_CSRF_COOKIE, { ...common, httpOnly: false });
}

export function isLoopbackSocket(request: Request): boolean {
  const address = request.socket.remoteAddress?.toLowerCase();
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses.
  const peer = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return peer === "127.0.0.1" || peer === "::1";
}

export function isPrivateProxySocket(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return normalized.startsWith("fc") || normalized.startsWith("fd");
}

export function trustedProxyRequest(request: Request, config: AppConfig): boolean {
  const expected = config.localAuthProxySecret;
  const provided = request.header("x-stugu-local-proxy");
  return Boolean(expected
    && provided
    && isPrivateProxySocket(request.socket.remoteAddress)
    && keyMatches(provided, expected));
}

export function localSetupRequestAllowed(request: Request, config: AppConfig): boolean {
  if (isLoopbackSocket(request)) return true;
  const configuredBind = config.localAuthProxyBindAddress?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackBind = configuredBind === "127.0.0.1" || configuredBind === "::1" || configuredBind === "localhost";
  return loopbackBind
    && trustedProxyRequest(request, config);
}

export function localCloudflareUiRequestAllowed(request: Request, config: AppConfig): boolean {
  if (isLoopbackSocket(request)) return true;
  if (!localSetupRequestAllowed(request, config)) return false;
  const forwardedProtocol = request.header("x-forwarded-proto")?.trim().toLowerCase();
  if (forwardedProtocol !== "http") return false;
  try {
    const hostname = new URL(`http://${request.header("host") ?? ""}`).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

export function cloudflareUiRedirectUri(request: Request, config: AppConfig): string {
  if (!localCloudflareUiRequestAllowed(request, config)) {
    throw new HttpError(
      403,
      "CLOUDFLARE_SETUP_LOCAL_ONLY",
      "Open Stugu on this computer through its local address to change the secure connection",
    );
  }
  let port: number;
  try {
    const visible = new URL(`http://${request.header("host") ?? ""}`);
    port = Number(visible.port || 80);
  } catch {
    throw new HttpError(400, "INVALID_LOCAL_ADDRESS", "Stugu could not determine its local browser address");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new HttpError(400, "INVALID_LOCAL_ADDRESS", "Stugu must use an explicit unprivileged local port for Cloudflare approval");
  }
  return `http://127.0.0.1:${port}${cloudflareSetupCallbackPath}`;
}

export function requireJsonContentType(request: Request): void {
  if (!request.is("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED", "This endpoint requires an application/json request body");
  }
}

export function sessionDocument(identity: LocalAuthIdentity, csrfToken?: string): AppSession & { systemVersion: string } {
  return {
    systemVersion: SYSTEM_VERSION,
    authenticated: true,
    principal: { type: "local", email: identity.email },
    tenant: { id: "local", name: "Local Stugu", role: identity.role },
    availableTenants: [{ id: "local", name: "Local Stugu", role: identity.role }],
    readOnly: identity.role === "guest",
    grants: identity.role === "guest" ? identity.grants : [],
    ...(csrfToken ? { csrfToken } : {}),
  };
}

export function localAuthorizationFingerprint(identity: LocalAuthIdentity): string {
  const grants = identity.grants
    .map((grant) => `${grant.scopeType}:${grant.scopeId}`)
    .sort(compareCodeUnits);
  return createHash("sha256")
    .update(JSON.stringify([identity.userId, identity.role, grants]))
    .digest("base64url");
}

export function requestPrincipal(response: Response): LocalRequestPrincipal {
  const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
  if (!principal) throw new HttpError(401, "UNAUTHORIZED", "Sign in to access this endpoint");
  return principal;
}

export function auditAccountSubject(value: unknown): string {
  if (typeof value !== "string") return "invalid-account";
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && /^[^@\s]+@[^@\s]+$/u.test(email)
    ? email
    : "invalid-account";
}

export function requireWorkspaceAdmin(_request: Request, response: Response, next: NextFunction): void {
  const principal = requestPrincipal(response);
  if (!roleCanManageWorkspace(principal.role)) {
    next(new HttpError(403, "FORBIDDEN", "Workspace administration requires an Owner or Admin account"));
    return;
  }
  next();
}
