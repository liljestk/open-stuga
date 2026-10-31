import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ASSISTANT_CONNECTOR_SCOPE } from "@climate-twin/contracts";

/** An OAuth 2.1 error response: `{ error, error_description }` with the status the RFCs assign it. */
export class AssistantOAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AssistantOAuthError";
  }

  body(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.message };
  }
}

export const invalidRequest = (message: string) => new AssistantOAuthError(400, "invalid_request", message);
export const invalidClient = (message: string) => new AssistantOAuthError(401, "invalid_client", message);
export const invalidGrant = (message: string) => new AssistantOAuthError(400, "invalid_grant", message);

export type AssistantTokenPrefix = "stugu_at_" | "stugu_rt_" | "stugu_cs_";

/** 256 random bits, URL-safe; prefixed tokens are recognisable in logs and secret scanners. */
export function newSecret(prefix: AssistantTokenPrefix | "" = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function secretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function digestMatches(secret: string, expectedHex: string): boolean {
  const actual = Buffer.from(secretDigest(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hasTokenShape(value: string, prefix: AssistantTokenPrefix): boolean {
  return value.length === prefix.length + 43 && value.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/u.test(value.slice(prefix.length));
}

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/u;

export function validPkceChallenge(challenge: string): boolean {
  return PKCE_VALUE.test(challenge);
}

/** RFC 7636 S256: BASE64URL(SHA256(code_verifier)) equals the challenge sent with the authorization request. */
export function pkceVerifierMatches(verifier: string, challenge: string): boolean {
  if (!PKCE_VALUE.test(verifier)) return false;
  const actual = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Stugu grants exactly one read-only scope. Clients may also ask for
 * offline_access (refresh tokens are always issued); anything else is refused.
 */
export function requestedScopeAllowed(scope: string | null): boolean {
  if (scope === null || scope.trim() === "") return true;
  return scope.split(" ").filter(Boolean).every((item) => item === ASSISTANT_CONNECTOR_SCOPE || item === "offline_access");
}

/** One value per name: OAuth parameters must not repeat (RFC 6749 §3.1). */
export function singleParameters(parameters: URLSearchParams): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (values.has(name)) throw invalidRequest(`The ${name} parameter must not repeat`);
    values.set(name, value);
  }
  return values;
}

export function formParameters(body: unknown): Map<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest("Send the request as application/x-www-form-urlencoded");
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== "string") throw invalidRequest(`The ${name} parameter must appear once`);
    values.set(name, value);
  }
  return values;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
  basic: boolean;
}

function basicCredentials(authorization: string): ClientCredentials {
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
  } catch {
    throw invalidClient("The client credentials are malformed");
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) throw invalidClient("The client credentials are malformed");
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      basic: true,
    };
  } catch {
    throw invalidClient("The client credentials are malformed");
  }
}

/** client_secret_basic, client_secret_post, or a public client's bare client_id; never two methods at once. */
export function clientCredentials(form: Map<string, string>, authorization: string | undefined): ClientCredentials {
  const postedId = form.get("client_id");
  const postedSecret = form.get("client_secret");
  if (authorization?.startsWith("Basic ")) {
    if (postedSecret !== undefined) throw invalidRequest("Use one client authentication method");
    const credentials = basicCredentials(authorization);
    if (postedId !== undefined && postedId !== credentials.clientId) throw invalidRequest("client_id does not match the client credentials");
    return credentials;
  }
  if (!postedId) throw invalidClient("client_id is required");
  return { clientId: postedId, clientSecret: postedSecret === undefined || postedSecret === "" ? null : postedSecret, basic: false };
}
