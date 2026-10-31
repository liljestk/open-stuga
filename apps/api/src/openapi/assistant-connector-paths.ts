import { jsonRequestBody, jsonResponse } from "./support/part-01.js";

const oauthError = (description: string) => jsonResponse(description, { $ref: "#/components/schemas/AssistantOAuthError" });

const formBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { "application/x-www-form-urlencoded": { schema } },
});

const clientAuthenticationFields = {
  client_id: { type: "string", description: "Required unless the client authenticates with HTTP Basic." },
  client_secret: { type: "string", description: "client_secret_post clients only." },
} as const;

const authorizationQueryParameters = [
  { name: "response_type", in: "query", required: true, schema: { const: "code" } },
  { name: "client_id", in: "query", required: true, schema: { type: "string", maxLength: 128 } },
  { name: "redirect_uri", in: "query", schema: { type: "string", format: "uri" } },
  { name: "code_challenge", in: "query", required: true, schema: { type: "string", minLength: 43, maxLength: 128 } },
  { name: "code_challenge_method", in: "query", required: true, schema: { const: "S256" } },
  { name: "state", in: "query", schema: { type: "string" } },
  { name: "scope", in: "query", schema: { type: "string" } },
  { name: "resource", in: "query", schema: { type: "string", format: "uri" } },
] as const;

/**
 * OAuth 2.1 for Claude, ChatGPT and local MCP apps. Discovery metadata is
 * served at the origin's /.well-known/oauth-authorization-server and
 * /.well-known/oauth-protected-resource/api/v1/mcp, outside this API's base path.
 */
export const assistantConnectorPaths = {
  "/oauth/register": {
    post: {
      tags: ["Security"], operationId: "registerAssistantClient", security: [],
      description: "RFC 7591 dynamic client registration. Only Claude's and ChatGPT's own callback addresses and loopback addresses are accepted; registrations nobody approves are removed after a day.",
      requestBody: jsonRequestBody({ $ref: "#/components/schemas/AssistantClientMetadata" }),
      responses: {
        "201": jsonResponse("Registered client. client_secret is returned only for confidential clients, once.", { $ref: "#/components/schemas/AssistantClientRegistration" }),
        "400": oauthError("invalid_redirect_uri or invalid_client_metadata"),
        "429": oauthError("Too many registrations from this address"),
        "503": oauthError("Too many registrations are waiting for approval"),
      },
    },
  },
  "/oauth/token": {
    post: {
      tags: ["Security"], operationId: "exchangeAssistantToken", security: [],
      description: "Exchanges an approved authorization code (with its PKCE verifier) or a refresh token. Refresh tokens rotate on every use; reusing a spent one disconnects the assistant.",
      requestBody: formBody({
        type: "object",
        required: ["grant_type"],
        properties: {
          grant_type: { enum: ["authorization_code", "refresh_token"] },
          code: { type: "string" },
          code_verifier: { type: "string", minLength: 43, maxLength: 128 },
          redirect_uri: { type: "string", format: "uri" },
          refresh_token: { type: "string" },
          scope: { type: "string" },
          resource: { type: "string", format: "uri" },
          ...clientAuthenticationFields,
        },
      }),
      responses: {
        "200": jsonResponse("Issued access and refresh tokens.", { $ref: "#/components/schemas/AssistantTokenResponse" }),
        "400": oauthError("invalid_request, invalid_grant, invalid_scope, invalid_target or unsupported_grant_type"),
        "401": oauthError("invalid_client"),
        "429": oauthError("Too many token requests from this address"),
      },
    },
  },
  "/oauth/revoke": {
    post: {
      tags: ["Security"], operationId: "revokeAssistantToken", security: [],
      description: "RFC 7009 revocation. A refresh token disconnects its whole connection; an access token revokes only itself. Unknown tokens are not an error.",
      requestBody: formBody({
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" }, token_type_hint: { enum: ["access_token", "refresh_token"] }, ...clientAuthenticationFields },
      }),
      responses: {
        "200": jsonResponse("Revoked, or already unknown.", { type: "object", additionalProperties: false, properties: {} }),
        "400": oauthError("invalid_request"),
        "401": oauthError("invalid_client"),
      },
    },
  },
  "/assistant-connector/authorization": {
    get: {
      tags: ["Security"], operationId: "previewAssistantAuthorization",
      description: "Owner/Admin-only. Validates the OAuth authorization request the consent page was opened with and describes the assistant asking to connect.",
      security: [{ localSession: [] }],
      parameters: authorizationQueryParameters,
      responses: {
        "200": jsonResponse("The assistant asking to connect.", { $ref: "#/components/schemas/AssistantAuthorizationPreview" }),
        "400": { description: "ASSISTANT_CLIENT_UNKNOWN when Stugu cannot answer the client; ASSISTANT_AUTHORIZATION_INVALID when the request must be returned to it" },
        "403": { description: "Owner or Admin role required" },
      },
    },
    post: {
      tags: ["Security"], operationId: "decideAssistantAuthorization",
      description: "Owner/Admin-only. Approves or declines the connection request and returns the assistant callback the browser continues to.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: jsonRequestBody({ $ref: "#/components/schemas/AssistantAuthorizationInput" }),
      responses: {
        "200": jsonResponse("The assistant callback carrying a code, or an OAuth error such as access_denied.", { $ref: "#/components/schemas/AssistantAuthorizationRedirect" }),
        "400": { description: "The request names no registered client or redirect address" },
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/assistant-connector/connections": {
    get: {
      tags: ["Security"], operationId: "listAssistantConnections",
      description: "Owner/Admin-only list of approved assistant connections.",
      security: [{ localSession: [] }],
      responses: {
        "200": jsonResponse("Approved connections, newest first.", { $ref: "#/components/schemas/AssistantConnectionsResponse" }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/assistant-connector/connections/{id}": {
    delete: {
      tags: ["Security"], operationId: "revokeAssistantConnection",
      description: "Owner/Admin-only. Disconnects the assistant and invalidates every token it holds.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [{ $ref: "#/components/parameters/Id" }],
      responses: {
        "200": jsonResponse("The connections that remain.", { $ref: "#/components/schemas/AssistantConnectionsResponse" }),
        "403": { description: "Owner or Admin role required" },
        "404": { description: "Connection not found" },
      },
    },
  },
} as const;

const assistantKind = { enum: ["claude", "chatgpt", "local"] } as const;

export const assistantConnectorSchemas = {
  AssistantOAuthError: {
    type: "object",
    required: ["error", "error_description"],
    properties: { error: { type: "string" }, error_description: { type: "string" } },
  },
  AssistantClientMetadata: {
    type: "object",
    required: ["redirect_uris"],
    properties: {
      redirect_uris: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", format: "uri" } },
      token_endpoint_auth_method: { enum: ["none", "client_secret_post", "client_secret_basic"], default: "client_secret_basic" },
      grant_types: { type: "array", items: { enum: ["authorization_code", "refresh_token"] } },
      response_types: { type: "array", items: { const: "code" } },
      client_name: { type: "string", maxLength: 200 },
      client_uri: { type: "string", maxLength: 2048 },
      scope: { type: "string", maxLength: 200 },
      software_id: { type: "string", maxLength: 200 },
      software_version: { type: "string", maxLength: 200 },
    },
  },
  AssistantClientRegistration: {
    allOf: [
      { $ref: "#/components/schemas/AssistantClientMetadata" },
      {
        type: "object",
        required: ["client_id", "client_id_issued_at", "token_endpoint_auth_method", "grant_types", "response_types"],
        properties: {
          client_id: { type: "string" },
          client_id_issued_at: { type: "integer" },
          client_secret: { type: "string", readOnly: true },
          client_secret_expires_at: { const: 0 },
        },
      },
    ],
  },
  AssistantTokenResponse: {
    type: "object",
    additionalProperties: false,
    required: ["access_token", "token_type", "expires_in", "refresh_token", "scope"],
    properties: {
      access_token: { type: "string", pattern: "^stugu_at_" },
      token_type: { const: "Bearer" },
      expires_in: { type: "integer", minimum: 1 },
      refresh_token: { type: "string", pattern: "^stugu_rt_" },
      scope: { const: "stugu.read" },
    },
  },
  AssistantAuthorizationPreview: {
    type: "object",
    additionalProperties: false,
    required: ["assistant", "clientName", "redirectOrigin", "scope"],
    properties: {
      assistant: assistantKind,
      clientName: { type: ["string", "null"] },
      redirectOrigin: { type: "string", format: "uri" },
      scope: { const: "stugu.read" },
    },
  },
  AssistantAuthorizationInput: {
    type: "object",
    additionalProperties: false,
    required: ["query", "decision"],
    properties: { query: { type: "string", maxLength: 8192 }, decision: { enum: ["approve", "deny"] } },
  },
  AssistantAuthorizationRedirect: {
    type: "object",
    additionalProperties: false,
    required: ["redirectUrl"],
    properties: { redirectUrl: { type: "string", format: "uri" } },
  },
  AssistantConnection: {
    type: "object",
    additionalProperties: false,
    required: ["id", "assistant", "clientName", "approvedBy", "createdAt", "lastUsedAt"],
    properties: {
      id: { type: "string" },
      assistant: assistantKind,
      clientName: { type: ["string", "null"] },
      approvedBy: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  AssistantConnectionsResponse: {
    type: "object",
    additionalProperties: false,
    required: ["connections"],
    properties: { connections: { type: "array", items: { $ref: "#/components/schemas/AssistantConnection" } } },
  },
} as const;
