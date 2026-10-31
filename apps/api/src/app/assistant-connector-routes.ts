import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from "express";
import { ASSISTANT_CONNECTOR_RESOURCE_PATH, type AssistantAuthorizationDecision } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import { HttpError } from "../http-error.js";
import type { AssistantAuthorizationServer } from "../assistant-connector/authorization-server.js";
import { AssistantOAuthError } from "../assistant-connector/oauth-protocol.js";
import { AuthAbuseLimiter, assistantOAuthAttemptKeys } from "./support/auth-abuse-limits.js";
import { requestPrincipal, requireWorkspaceAdmin } from "./support/local-sessions.js";
import { requestOrigin } from "./support/origins.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type AssistantConnectorProtocolContext = { app: Express; prefix: string; config: AppConfig };
export type AssistantConnectorRouteContext = Pick<ApiRouteRegistrationContext, "app" | "prefix" | "config" | "recordSecurityAudit">;

/** The origin the client reached Stugu through; grants, metadata and the protected resource are bound to it. */
export function assistantRequestOrigin(request: Request, config: AppConfig): string {
  const origin = requestOrigin(request, config);
  if (!origin) throw new HttpError(400, "ASSISTANT_ORIGIN_UNKNOWN", "Stugu could not determine the address this request reached");
  return origin;
}

function rawQuery(request: Request): string {
  const separator = request.originalUrl.indexOf("?");
  return separator < 0 ? "" : request.originalUrl.slice(separator + 1);
}

function decisionInput(body: unknown): { query: string; decision: AssistantAuthorizationDecision } {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof record.query !== "string" || record.query.length > 8_192) {
    throw new HttpError(400, "INVALID_FIELD", "query must be the connection request's query string");
  }
  if (record.decision !== "approve" && record.decision !== "deny") {
    throw new HttpError(400, "INVALID_FIELD", "decision must be approve or deny");
  }
  return { query: record.query, decision: record.decision };
}

/** OAuth endpoints answer in OAuth's own error format and are never cached. */
const oauthErrors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  response.setHeader("cache-control", "no-store");
  if (error instanceof AssistantOAuthError) {
    response.status(error.status).json(error.body());
    return;
  }
  if (error instanceof HttpError && error.status === 429) {
    response.status(429).json({ error: "temporarily_unavailable", error_description: error.message });
    return;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    response.status(400).json({ error: "invalid_request", error_description: "The request body could not be read" });
    return;
  }
  response.status(500).json({ error: "server_error", error_description: "Stugu could not complete the request" });
};

/**
 * Machine-facing OAuth discovery, registration, token and revocation endpoints.
 * Register before browser-session middleware: these authenticate clients themselves.
 */
export function registerAssistantConnectorProtocolRoutes(
  context: AssistantConnectorProtocolContext,
  server: AssistantAuthorizationServer,
  limiter: AuthAbuseLimiter = new AuthAbuseLimiter(),
): void {
  const { app, prefix, config } = context;
  const discovery = express.Router();
  discovery.get("/.well-known/oauth-authorization-server", (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(server.metadata(assistantRequestOrigin(request, config)));
  });
  discovery.get(
    ["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${ASSISTANT_CONNECTOR_RESOURCE_PATH}`],
    (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(server.protectedResourceMetadata(assistantRequestOrigin(request, config)));
    },
  );
  app.use(discovery);

  const throttle = (endpoint: string): RequestHandler => (request, response, next) => {
    response.setHeader("cache-control", "no-store");
    const release = limiter.enter(assistantOAuthAttemptKeys(request, config, endpoint), response);
    response.once("close", () => release(response.statusCode < 400));
    next();
  };
  const form = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 32 });
  const json = express.json({ limit: "16kb" });

  const register: RequestHandler = (request, response) => {
    response.status(201).json(server.register(request.body));
  };
  const token: RequestHandler = (request, response) => {
    response.setHeader("pragma", "no-cache");
    response.json(server.token(request.body, request.header("authorization")));
  };
  const revoke: RequestHandler = (request, response) => {
    server.revoke(request.body, request.header("authorization"));
    response.json({});
  };
  app.post(`${prefix}/oauth/register`, throttle("register"), json, register, oauthErrors);
  app.post(`${prefix}/oauth/token`, throttle("token"), form, token, oauthErrors);
  app.post(`${prefix}/oauth/revoke`, throttle("revoke"), form, revoke, oauthErrors);
}

/** The Owner/Admin consent page's API and the list of connected assistants. */
export function registerAssistantConnectorRoutes(
  context: AssistantConnectorRouteContext,
  server: AssistantAuthorizationServer,
): void {
  const { app, prefix, config } = context;

  app.get(`${prefix}/assistant-connector/authorization`, requireWorkspaceAdmin, (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(server.preview(rawQuery(request), assistantRequestOrigin(request, config)));
  });

  app.post(`${prefix}/assistant-connector/authorization`, requireWorkspaceAdmin, (request, response) => {
    response.setHeader("cache-control", "no-store");
    const input = decisionInput(request.body);
    const principal = requestPrincipal(response);
    const result = server.decide({ ...input, userId: principal.userId, origin: assistantRequestOrigin(request, config) });
    if (result.approved) {
      context.recordSecurityAudit(principal, {
        eventType: "integration.grant.issued",
        subjectType: "integration-grant",
        subjectId: `assistant:${result.client.clientId}`,
        details: { integration: "assistant", assistant: result.client.assistant },
      });
    }
    response.json({ redirectUrl: result.redirectUrl });
  });

  app.get(`${prefix}/assistant-connector/connections`, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({ connections: server.connections() });
  });

  app.delete(`${prefix}/assistant-connector/connections/:id`, requireWorkspaceAdmin, (request, response) => {
    response.setHeader("cache-control", "no-store");
    const id = String(request.params.id);
    const connection = server.connection(id);
    if (!connection || !server.revokeConnection(id)) {
      throw new HttpError(404, "ASSISTANT_CONNECTION_NOT_FOUND", "The assistant connection was not found");
    }
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.grant.revoked",
      subjectType: "integration-grant",
      subjectId: `assistant-connection:${id}`,
      details: { integration: "assistant", assistant: connection.assistant },
    });
    response.json({ connections: server.connections() });
  });
}
