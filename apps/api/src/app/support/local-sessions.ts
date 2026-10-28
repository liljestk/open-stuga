import { roleCanManageWorkspace, type AppSession, roleCanAccessNonGuestConfiguration } from "@climate-twin/contracts";
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../../config.js";
import { SYSTEM_VERSION } from "../../version.js";
import type { LocalAuthIdentity } from "../../local-auth.js";
import { HttpError } from "../../http-error.js";
import { compareCodeUnits } from "../../text-order.js";
import { trustedProxyRequest } from "./trusted-network.js";

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

export function requireNonGuest(_request: Request, response: Response, next: NextFunction): void {
  if (!roleCanAccessNonGuestConfiguration(requestPrincipal(response).role)) {
    next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot access administrative configuration"));
    return;
  }
  next();
}
