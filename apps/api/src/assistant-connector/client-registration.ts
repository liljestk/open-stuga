import type { AssistantKind } from "@climate-twin/contracts";
import { AssistantOAuthError, requestedScopeAllowed } from "./oauth-protocol.js";
import { assistantForRedirectUris } from "./redirect-policy.js";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export const TOKEN_ENDPOINT_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

/** The RFC 7591 metadata Stugu keeps for a client: the fields it uses or echoes, nothing a client could smuggle in. */
export interface AssistantClientMetadata {
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  client_uri?: string;
  scope?: string;
  software_id?: string;
  software_version?: string;
}

const invalidMetadata = (message: string) => new AssistantOAuthError(400, "invalid_client_metadata", message);

function optionalText(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const value = record[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw invalidMetadata(`${name} must be text of at most ${maxLength} characters`);
  return value.trim() || undefined;
}

function textList(record: Record<string, unknown>, name: string, fallback: string[]): string[] {
  const value = record[name];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 10 || value.some((item) => typeof item !== "string" || item.length > 2048)) {
    throw invalidMetadata(`${name} must be a list of at most 10 strings`);
  }
  return [...new Set(value as string[])];
}

function authMethod(record: Record<string, unknown>): TokenEndpointAuthMethod {
  const value = record.token_endpoint_auth_method ?? "client_secret_basic";
  if (!TOKEN_ENDPOINT_AUTH_METHODS.includes(value as TokenEndpointAuthMethod)) {
    throw invalidMetadata("token_endpoint_auth_method must be none, client_secret_post, or client_secret_basic");
  }
  return value as TokenEndpointAuthMethod;
}

/** Validates a registration request and decides which assistant it belongs to from its redirect addresses. */
export function validatedRegistration(body: unknown): { metadata: AssistantClientMetadata; assistant: AssistantKind } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidMetadata("Send the client metadata as a JSON object");
  const record = body as Record<string, unknown>;
  const redirectUris = textList(record, "redirect_uris", []);
  if (redirectUris.length === 0) throw new AssistantOAuthError(400, "invalid_redirect_uri", "redirect_uris is required");
  const assistant = assistantForRedirectUris(redirectUris);
  if (!assistant) {
    throw new AssistantOAuthError(
      400,
      "invalid_redirect_uri",
      "Stugu accepts Claude's and ChatGPT's own callback addresses and loopback addresses on this computer only",
    );
  }
  const grantTypes = textList(record, "grant_types", ["authorization_code", "refresh_token"]);
  if (!grantTypes.includes("authorization_code") || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
    throw invalidMetadata("grant_types may contain authorization_code and refresh_token only");
  }
  const responseTypes = textList(record, "response_types", ["code"]);
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") throw invalidMetadata("response_types must be [\"code\"]");
  const scope = optionalText(record, "scope", 200);
  if (!requestedScopeAllowed(scope ?? null)) throw invalidMetadata("Stugu offers the stugu.read scope only");
  const metadata: AssistantClientMetadata = {
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod(record),
    grant_types: grantTypes,
    response_types: responseTypes,
  };
  const optional = {
    client_name: optionalText(record, "client_name", 200),
    client_uri: optionalText(record, "client_uri", 2048),
    scope,
    software_id: optionalText(record, "software_id", 200),
    software_version: optionalText(record, "software_version", 200),
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(metadata, { [name]: value });
  }
  return { metadata, assistant };
}
