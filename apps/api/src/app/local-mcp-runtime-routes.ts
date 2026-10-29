import express, { type Express, type Request, type RequestHandler } from "express";
import { ASSISTANT_CONNECTOR_SCOPE } from "@climate-twin/contracts";
import {
  LocalMcpRuntimeError,
  type LocalMcpRuntimeService,
  type LocalMcpUpstreamProfile,
} from "../local-mcp-runtime.js";
import { protectedResourceMetadataUrl } from "../assistant-connector/authorization-server.js";
import { ASSISTANT_WEB_ORIGINS } from "../assistant-connector/redirect-policy.js";
import { requestPrincipal, requireWorkspaceAdmin } from "./support/local-sessions.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type LocalMcpRuntimeRouteContext = Pick<ApiRouteRegistrationContext, "app" | "prefix" | "recordSecurityAudit">;
export type LocalMcpTransportRouteContext = { app: Express; prefix: string };
export type LocalMcpRuntimeController = Pick<
  LocalMcpRuntimeService,
  "status" | "start" | "stop" | "authorize" | "proxy" | "ensureRunning"
>;

/** Accepts assistant connections' OAuth bearer tokens beside the manual token. */
export interface AssistantBearerVerifier {
  /** The origin the request reached Stugu through, which assistant grants are bound to. */
  origin(request: Request): string | null;
  verifyAccessToken(token: string, origin: string): { grantId: string } | null;
}

function mcpError(response: express.Response, status: number, code: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function bearerToken(authorization: string | undefined): string | null {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

/** RFC 9728 §5.1: point an unauthenticated client at the OAuth metadata it needs to connect. */
function challenge(origin: string | null, presentedToken: boolean): string {
  const parameters = ['realm="Stugu MCP"'];
  if (origin) {
    parameters.push(`resource_metadata="${protectedResourceMetadataUrl(origin)}"`, `scope="${ASSISTANT_CONNECTOR_SCOPE}"`);
    if (presentedToken) parameters.push('error="invalid_token"');
  }
  return `Bearer ${parameters.join(", ")}`;
}

/** Register before browser-session middleware; this machine route owns bearer authentication. */
export function registerLocalMcpTransportRoute(
  context: LocalMcpTransportRouteContext,
  runtime: LocalMcpRuntimeController,
  assistants: AssistantBearerVerifier | null = null,
): void {
  const path = `${context.prefix}/mcp`;
  const jsonParser = express.json({ limit: "1mb", type: ["application/json", "application/*+json"] });
  const authorizeRequest: RequestHandler = (request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const origin = request.header("origin");
    // Assistants' own servers may name their web origin; any other browser page is refused.
    if (origin && !ASSISTANT_WEB_ORIGINS.has(origin)) {
      mcpError(response, 403, -32001, "Browser-origin requests are not allowed");
      return;
    }
    const authorization = request.header("authorization");
    if (runtime.authorize(authorization)) {
      response.locals.mcpProfile = "local" satisfies LocalMcpUpstreamProfile;
      next();
      return;
    }
    const token = bearerToken(authorization);
    const resourceOrigin = assistants?.origin(request) ?? null;
    if (token && resourceOrigin && assistants?.verifyAccessToken(token, resourceOrigin)) {
      response.locals.mcpProfile = "assistant" satisfies LocalMcpUpstreamProfile;
      next();
      return;
    }
    response.setHeader("www-authenticate", challenge(resourceOrigin, token !== null));
    mcpError(response, 401, -32001, "A valid Stugu MCP access token is required");
  };
  const proxyRequest: RequestHandler = async (request, response) => {
    const profile = response.locals.mcpProfile as LocalMcpUpstreamProfile;
    try {
      if (profile === "assistant") await runtime.ensureRunning();
      await runtime.proxy(request, response, profile);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      mcpError(
        response,
        error instanceof LocalMcpRuntimeError ? error.status : 502,
        -32603,
        error instanceof LocalMcpRuntimeError ? error.message : "The Stugu MCP service is unavailable",
      );
    }
  };

  context.app.post(path, authorizeRequest, jsonParser, proxyRequest);
  context.app.use((request, response, next) => {
    if (request.path !== path) {
      next();
      return;
    }
    response.setHeader("allow", "POST");
    mcpError(response, 405, -32000, "Method not allowed");
  });
}

export function registerLocalMcpRuntimeRoutes(
  context: LocalMcpRuntimeRouteContext,
  runtime: LocalMcpRuntimeController,
): void {
  context.app.get(`${context.prefix}/system/mcp-runtime`, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(runtime.status());
  });

  // The MCP bearer bypasses browser sessions and Guest grants, so issuing and
  // revoking it is audited like every other integration credential.
  context.app.post(`${context.prefix}/system/mcp-runtime/start`, requireWorkspaceAdmin, async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    const started = await runtime.start();
    if (started.accessToken !== null) {
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.grant.issued",
        subjectType: "integration-grant",
        subjectId: "mcp-http",
        details: { integration: "mcp" },
      });
    }
    response.json(started);
  });

  context.app.post(`${context.prefix}/system/mcp-runtime/stop`, requireWorkspaceAdmin, async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    const stopped = await runtime.stop();
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.grant.revoked",
      subjectType: "integration-grant",
      subjectId: "mcp-http",
      details: { integration: "mcp" },
    });
    response.json(stopped);
  });
}
