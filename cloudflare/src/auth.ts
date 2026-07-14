import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./http.js";

export type AuthPrincipal =
  | { kind: "access"; email: string; subject: string }
  | { kind: "api-token"; tenantId: string; label: string; scopes: string[] }
  | { kind: "development"; email: string; subject: string };

interface ApiTokenRow {
  tenant_id: string;
  label: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const accessJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function accessJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = accessJwksByIssuer.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  accessJwksByIssuer.set(issuer, created);
  return created;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
    throw new HttpError(403, "INVALID_IDENTITY", "Authenticated identity does not contain a valid email address");
  }
  return normalized;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableTenantId(email: string): Promise<string> {
  return `tenant_${(await sha256Hex(normalizeEmail(email))).slice(0, 24)}`;
}

async function authenticateApiToken(token: string, env: Env): Promise<AuthPrincipal | null> {
  if (!token.startsWith("stuga_")) return null;
  if (token.length < 32 || token.length > 200) {
    throw new HttpError(401, "INVALID_API_TOKEN", "API token is malformed");
  }
  const row = await env.DB.prepare(`SELECT tenant_id, label, scopes_json, expires_at, revoked_at
    FROM api_tokens WHERE token_hash = ?`).bind(await sha256Hex(token)).first<ApiTokenRow>();
  if (!row || row.revoked_at !== null) throw new HttpError(401, "INVALID_API_TOKEN", "API token is invalid or revoked");
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(401, "EXPIRED_API_TOKEN", "API token has expired");
  }
  const parsedScopes = JSON.parse(row.scopes_json) as unknown;
  const scopes = Array.isArray(parsedScopes) ? parsedScopes.filter((scope): scope is string => typeof scope === "string") : [];
  return { kind: "api-token", tenantId: row.tenant_id, label: row.label, scopes };
}

export async function authenticate(request: Request, env: Env): Promise<AuthPrincipal> {
  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (bearer) {
    const tokenPrincipal = await authenticateApiToken(bearer, env);
    if (tokenPrincipal) return tokenPrincipal;
  }

  const authMode: string = env.AUTH_MODE;
  if (authMode === "development") {
    const hostname = new URL(request.url).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
      throw new HttpError(403, "DEVELOPMENT_AUTH_REJECTED", "Development authentication is restricted to localhost");
    }
    const email = normalizeEmail(env.DEV_USER_EMAIL || "developer@open-stuga.local");
    return { kind: "development", email, subject: `development:${email}` };
  }

  if (authMode !== "access") {
    throw new HttpError(503, "AUTH_NOT_CONFIGURED", "Hosted authentication is not configured");
  }
  if (!env.TEAM_DOMAIN?.startsWith("https://") || env.TEAM_DOMAIN.includes("CHANGE-ME")
    || !env.POLICY_AUD || env.POLICY_AUD === "CHANGE-ME") {
    throw new HttpError(503, "ACCESS_NOT_CONFIGURED", "Cloudflare Access issuer and audience must be configured");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new HttpError(401, "ACCESS_REQUIRED", "A Cloudflare Access session is required");

  try {
    const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
    const jwks = accessJwks(issuer);
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.POLICY_AUD,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : null;
    if (!email || typeof payload.sub !== "string") throw new HttpError(403, "INVALID_IDENTITY", "Access token is missing identity claims");
    return { kind: "access", email, subject: payload.sub };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(JSON.stringify({ message: "Access JWT validation failed", error: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(401, "INVALID_ACCESS_TOKEN", "Cloudflare Access token could not be verified");
  }
}

export function randomApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `stuga_${encoded}`;
}

export function requireApiScope(principal: AuthPrincipal, scope: string): void {
  if (principal.kind === "api-token" && !principal.scopes.includes(scope) && !principal.scopes.includes("*")) {
    throw new HttpError(403, "API_TOKEN_SCOPE_REQUIRED", `API token does not grant the ${scope} scope`);
  }
}
