import { randomUUID } from "node:crypto";
import {
  ASSISTANT_CONNECTOR_CONSENT_PATH,
  ASSISTANT_CONNECTOR_RESOURCE_PATH,
  ASSISTANT_CONNECTOR_SCOPE,
  roleCanManageWorkspace,
  type AssistantAuthorizationDecision,
  type AssistantAuthorizationPreview,
  type AssistantConnection,
} from "@climate-twin/contracts";
import { HttpError } from "../http-error.js";
import { TOKEN_ENDPOINT_AUTH_METHODS, validatedRegistration, type AssistantClientMetadata } from "./client-registration.js";
import {
  AssistantOAuthError,
  clientCredentials,
  digestMatches,
  formParameters,
  hasTokenShape,
  invalidClient,
  invalidGrant,
  invalidRequest,
  newSecret,
  pkceVerifierMatches,
  requestedScopeAllowed,
  secretDigest,
  singleParameters,
  validPkceChallenge,
  type ClientCredentials,
} from "./oauth-protocol.js";
import { redirectUriRegistered } from "./redirect-policy.js";
import type { AssistantConnectorStore, StoredAssistantClient, StoredAssistantToken } from "./store.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const ROTATED_REFRESH_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CODE_TTL_MS = 2 * 60 * 1_000;
const MAX_PENDING_CODES = 100;
const MAX_CLIENTS = 200;
const UNAPPROVED_CLIENT_TTL_MS = 24 * 60 * 60 * 1_000;
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1_000;
const MAX_QUERY_LENGTH = 8_192;

export interface AssistantTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type AssistantClientRegistration = AssistantClientMetadata & {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
};

interface AuthorizationTarget {
  client: StoredAssistantClient;
  redirectUri: string;
  parameters: Map<string, string>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  userId: string;
  expiresAt: number;
}

/** The protected resource: the MCP endpoint below the origin the client reached Stugu through. */
export function assistantResourceUrl(origin: string): string {
  return `${origin}${ASSISTANT_CONNECTOR_RESOURCE_PATH}`;
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${ASSISTANT_CONNECTOR_RESOURCE_PATH}`;
}

function canonicalResource(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

function redirectWith(redirectUri: string, values: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url.toString();
}

function unknownClient(message: string): HttpError {
  return new HttpError(400, "ASSISTANT_CLIENT_UNKNOWN", message);
}

/**
 * Stugu's OAuth 2.1 authorization server for assistant connections. Owners
 * and Admins approve each connection in the Stugu web app; the issued tokens
 * open only the read-only assistant MCP profile.
 */
export class AssistantAuthorizationServer {
  readonly #codes = new Map<string, PendingCode>();

  constructor(
    private readonly store: AssistantConnectorStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** RFC 8414 authorization server metadata. */
  metadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${ASSISTANT_CONNECTOR_CONSENT_PATH}`,
      token_endpoint: `${origin}/api/v1/oauth/token`,
      registration_endpoint: `${origin}/api/v1/oauth/register`,
      revocation_endpoint: `${origin}/api/v1/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS,
      scopes_supported: [ASSISTANT_CONNECTOR_SCOPE],
    };
  }

  /** RFC 9728 protected resource metadata for the MCP endpoint. */
  protectedResourceMetadata(origin: string) {
    return {
      resource: assistantResourceUrl(origin),
      authorization_servers: [origin],
      scopes_supported: [ASSISTANT_CONNECTOR_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Stugu",
    };
  }

  /** RFC 7591 dynamic client registration, limited to the assistants' own callback addresses. */
  register(body: unknown): AssistantClientRegistration {
    const { metadata, assistant } = validatedRegistration(body);
    const now = this.now();
    this.store.pruneUnapprovedClients(new Date(now.getTime() - UNAPPROVED_CLIENT_TTL_MS).toISOString());
    if (this.store.clientCount() >= MAX_CLIENTS) {
      throw new AssistantOAuthError(503, "temporarily_unavailable", "Too many assistant registrations are waiting for approval");
    }
    const clientId = randomUUID();
    const secret = metadata.token_endpoint_auth_method === "none" ? null : newSecret("stugu_cs_");
    const issuedAt = Math.floor(now.getTime() / 1_000);
    this.store.insertClient({
      clientId,
      secretHash: secret ? secretDigest(secret) : null,
      assistant,
      metadata: { ...metadata },
      registeredAt: now.toISOString(),
    });
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    };
  }

  /** What the consent page shows. Throws when the request cannot be approved. */
  preview(query: string, origin: string): AssistantAuthorizationPreview {
    const target = this.#trustedTarget(query);
    const problem = this.#requestProblem(target.parameters, origin);
    if (problem) throw new HttpError(400, "ASSISTANT_AUTHORIZATION_INVALID", problem.message);
    const clientName = target.client.metadata.client_name;
    return {
      assistant: target.client.assistant,
      clientName: typeof clientName === "string" ? clientName : null,
      redirectOrigin: new URL(target.redirectUri).origin,
      scope: ASSISTANT_CONNECTOR_SCOPE,
    };
  }

  /** Records the person's decision and returns where the browser goes next. */
  decide(input: { query: string; decision: AssistantAuthorizationDecision; userId: string; origin: string }): {
    redirectUrl: string;
    approved: boolean;
    client: StoredAssistantClient;
  } {
    const target = this.#trustedTarget(input.query);
    const state = target.parameters.get("state") ?? null;
    const problem = this.#requestProblem(target.parameters, input.origin)
      ?? (input.decision === "deny" ? new AssistantOAuthError(400, "access_denied", "The connection was declined in Stugu") : null);
    if (problem) {
      const redirectUrl = redirectWith(target.redirectUri, { error: problem.code, error_description: problem.message, state });
      return { redirectUrl, approved: false, client: target.client };
    }
    const code = newSecret();
    this.#rememberCode(code, {
      clientId: target.client.clientId,
      redirectUri: target.redirectUri,
      codeChallenge: target.parameters.get("code_challenge")!,
      resource: canonicalResource(target.parameters.get("resource") ?? assistantResourceUrl(input.origin))!,
      userId: input.userId,
      expiresAt: this.now().getTime() + CODE_TTL_MS,
    });
    return { redirectUrl: redirectWith(target.redirectUri, { code, state }), approved: true, client: target.client };
  }

  /** The token endpoint: authorization_code and refresh_token grants. */
  token(body: unknown, authorization: string | undefined): AssistantTokenResponse {
    const form = formParameters(body);
    const client = this.#authenticate(clientCredentials(form, authorization));
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.#exchangeCode(client, form);
    if (grantType === "refresh_token") return this.#refresh(client, form);
    throw new AssistantOAuthError(400, "unsupported_grant_type", "Stugu supports the authorization_code and refresh_token grants");
  }

  /** RFC 7009: a refresh token revokes its whole grant; an access token only itself. Unknown tokens are not an error. */
  revoke(body: unknown, authorization: string | undefined): void {
    const form = formParameters(body);
    const client = this.#authenticate(clientCredentials(form, authorization));
    const token = form.get("token");
    if (!token) throw invalidRequest("token is required");
    const tokenHash = secretDigest(token);
    const refresh = this.store.token(tokenHash, "refresh");
    if (refresh?.clientId === client.clientId) {
      this.store.deleteGrant(refresh.grantId);
      return;
    }
    if (this.store.token(tokenHash, "access")?.clientId === client.clientId) this.store.deleteToken(tokenHash);
  }

  /** The grant an MCP request's bearer token belongs to, or null when it does not open this resource. */
  verifyAccessToken(token: string, origin: string): { grantId: string } | null {
    if (!hasTokenShape(token, "stugu_at_")) return null;
    const stored = this.store.token(secretDigest(token), "access");
    if (!stored || !this.#tokenUsable(stored) || stored.resource !== assistantResourceUrl(origin)) return null;
    const now = this.now();
    const lastUsed = stored.lastUsedAt ? Date.parse(stored.lastUsedAt) : 0;
    if (now.getTime() - lastUsed >= LAST_USED_RESOLUTION_MS) this.store.touchGrant(stored.grantId, now.toISOString());
    return { grantId: stored.grantId };
  }

  connections(): AssistantConnection[] {
    return this.store.connections();
  }

  connection(grantId: string): AssistantConnection | null {
    return this.store.connection(grantId);
  }

  revokeConnection(grantId: string): boolean {
    return this.store.deleteGrant(grantId);
  }

  #trustedTarget(query: string): AuthorizationTarget {
    if (query.length > MAX_QUERY_LENGTH) throw unknownClient("The connection request is too long");
    let parameters: Map<string, string>;
    try {
      parameters = singleParameters(new URLSearchParams(query.startsWith("?") ? query.slice(1) : query));
    } catch (error) {
      throw unknownClient(error instanceof Error ? error.message : "The connection request is malformed");
    }
    const clientId = parameters.get("client_id");
    const client = clientId ? this.store.client(clientId) : null;
    if (!client) throw unknownClient("This assistant is not registered with Stugu. Start the connection again from the assistant.");
    const registered = client.metadata.redirect_uris as string[];
    const requested = parameters.get("redirect_uri");
    if (requested !== undefined && !redirectUriRegistered(requested, registered)) {
      throw unknownClient("The assistant asked Stugu to answer at an address it did not register");
    }
    const redirectUri = requested ?? (registered.length === 1 ? registered[0] : undefined);
    if (!redirectUri) throw unknownClient("The connection request must say where Stugu should answer");
    return { client, redirectUri, parameters };
  }

  #requestProblem(parameters: Map<string, string>, origin: string): AssistantOAuthError | null {
    if (parameters.get("response_type") !== "code") {
      return new AssistantOAuthError(400, "unsupported_response_type", "Stugu supports the authorization code flow only");
    }
    const challenge = parameters.get("code_challenge");
    if (!challenge || !validPkceChallenge(challenge) || parameters.get("code_challenge_method") !== "S256") {
      return invalidRequest("A PKCE code_challenge with code_challenge_method S256 is required");
    }
    if (!requestedScopeAllowed(parameters.get("scope") ?? null)) {
      return new AssistantOAuthError(400, "invalid_scope", "Stugu offers the stugu.read scope only");
    }
    const resource = parameters.get("resource");
    if (resource !== undefined && canonicalResource(resource) !== assistantResourceUrl(origin)) {
      return new AssistantOAuthError(400, "invalid_target", "The requested resource is not this Stugu's MCP endpoint");
    }
    return null;
  }

  #rememberCode(code: string, pending: PendingCode): void {
    const now = this.now().getTime();
    for (const [key, value] of this.#codes) {
      if (value.expiresAt <= now) this.#codes.delete(key);
    }
    while (this.#codes.size >= MAX_PENDING_CODES) this.#codes.delete(this.#codes.keys().next().value!);
    this.#codes.set(secretDigest(code), pending);
  }

  #authenticate(credentials: ClientCredentials): StoredAssistantClient {
    const client = this.store.client(credentials.clientId);
    if (!client) throw invalidClient("The client is not registered");
    if (client.secretHash === null) {
      if (credentials.clientSecret !== null) throw invalidClient("This client was registered without a secret");
      return client;
    }
    if (credentials.clientSecret === null || !digestMatches(credentials.clientSecret, client.secretHash)) {
      throw invalidClient("The client credentials are not valid");
    }
    return client;
  }

  #exchangeCode(client: StoredAssistantClient, form: Map<string, string>): AssistantTokenResponse {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) throw invalidRequest("code and code_verifier are required");
    const codeHash = secretDigest(code);
    const pending = this.#codes.get(codeHash);
    // A code is single-use even when the exchange fails.
    this.#codes.delete(codeHash);
    const now = this.now();
    if (!pending || pending.expiresAt <= now.getTime() || pending.clientId !== client.clientId) {
      throw invalidGrant("The authorization code is invalid or has expired");
    }
    this.#checkCodeBinding(pending, form, verifier);
    const role = this.store.memberRole(pending.userId);
    if (!role || !roleCanManageWorkspace(role)) throw invalidGrant("The approving account can no longer connect assistants");
    return this.store.transaction(() => {
      const grantId = randomUUID();
      this.store.insertGrant({
        id: grantId,
        clientId: client.clientId,
        userId: pending.userId,
        resource: pending.resource,
        scope: ASSISTANT_CONNECTOR_SCOPE,
        createdAt: now.toISOString(),
      });
      return this.#issueTokens(grantId, now);
    });
  }

  #checkCodeBinding(pending: PendingCode, form: Map<string, string>, verifier: string): void {
    const redirectUri = form.get("redirect_uri");
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) throw invalidGrant("redirect_uri does not match the authorization request");
    const resource = form.get("resource");
    if (resource !== undefined && canonicalResource(resource) !== pending.resource) {
      throw new AssistantOAuthError(400, "invalid_target", "The requested resource does not match the authorization");
    }
    if (!pkceVerifierMatches(verifier, pending.codeChallenge)) throw invalidGrant("code_verifier does not match the code challenge");
  }

  #refresh(client: StoredAssistantClient, form: Map<string, string>): AssistantTokenResponse {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) throw invalidRequest("refresh_token is required");
    if (!requestedScopeAllowed(form.get("scope") ?? null)) {
      throw new AssistantOAuthError(400, "invalid_scope", "Stugu offers the stugu.read scope only");
    }
    const tokenHash = secretDigest(refreshToken);
    const stored = this.store.token(tokenHash, "refresh");
    if (!stored || stored.clientId !== client.clientId) throw invalidGrant("The refresh token is invalid");
    if (stored.rotatedAt !== null) {
      this.store.deleteGrant(stored.grantId);
      throw invalidGrant("The refresh token was already used, so Stugu disconnected this assistant. Connect it again.");
    }
    if (!this.#tokenUsable(stored)) {
      this.store.deleteToken(tokenHash);
      throw invalidGrant("The refresh token has expired or its approver can no longer connect assistants");
    }
    const resource = form.get("resource");
    if (resource !== undefined && canonicalResource(resource) !== stored.resource) {
      throw new AssistantOAuthError(400, "invalid_target", "The requested resource does not match the authorization");
    }
    const now = this.now();
    return this.store.transaction(() => {
      this.store.markRotated(tokenHash, now.toISOString(), new Date(now.getTime() + ROTATED_REFRESH_RETENTION_MS).toISOString());
      return this.#issueTokens(stored.grantId, now);
    });
  }

  #tokenUsable(stored: StoredAssistantToken): boolean {
    return Date.parse(stored.expiresAt) > this.now().getTime()
      && stored.approverRole !== null
      && roleCanManageWorkspace(stored.approverRole);
  }

  #issueTokens(grantId: string, now: Date): AssistantTokenResponse {
    this.store.pruneExpiredTokens(now.toISOString());
    const accessToken = newSecret("stugu_at_");
    const refreshToken = newSecret("stugu_rt_");
    this.store.insertToken({
      tokenHash: secretDigest(accessToken),
      grantId,
      kind: "access",
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
    });
    this.store.insertToken({
      tokenHash: secretDigest(refreshToken),
      grantId,
      kind: "refresh",
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1_000,
      refresh_token: refreshToken,
      scope: ASSISTANT_CONNECTOR_SCOPE,
    };
  }
}
