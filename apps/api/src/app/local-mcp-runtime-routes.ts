import express, { type Express, type RequestHandler } from "express";
import {
  LocalMcpRuntimeError,
  type LocalMcpRuntimeService,
} from "../local-mcp-runtime.js";
import { HttpError, requireWorkspaceAdmin } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type LocalMcpRuntimeRouteContext = Pick<ApiRouteRegistrationContext, "app" | "prefix">;
export type LocalMcpTransportRouteContext = { app: Express; prefix: string };
export type LocalMcpRuntimeController = Pick<
  LocalMcpRuntimeService,
  "status" | "start" | "stop" | "authorize" | "proxy"
>;

function routeError(error: unknown): unknown {
  return error instanceof LocalMcpRuntimeError
    ? new HttpError(error.status, error.code, error.message)
    : error;
}

function mcpError(response: express.Response, status: number, code: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

/** Register before browser-session middleware; this machine route owns bearer authentication. */
export function registerLocalMcpTransportRoute(
  context: LocalMcpTransportRouteContext,
  runtime: LocalMcpRuntimeController,
): void {
  const path = `${context.prefix}/mcp`;
  const jsonParser = express.json({ limit: "1mb", type: ["application/json", "application/*+json"] });
  const authorizeRequest: RequestHandler = (request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.header("origin")) {
      mcpError(response, 403, -32001, "Browser-origin requests are not allowed");
      return;
    }
    if (!runtime.authorize(request.header("authorization"))) {
      response.setHeader("www-authenticate", 'Bearer realm="Stugu MCP"');
      mcpError(response, 401, -32001, "A valid Stugu MCP access token is required");
      return;
    }
    next();
  };
  const proxyRequest: RequestHandler = async (request, response) => {
    try {
      await runtime.proxy(request, response);
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

  context.app.post(`${context.prefix}/system/mcp-runtime/start`, requireWorkspaceAdmin, async (_request, response, next) => {
    try {
      response.setHeader("cache-control", "no-store");
      response.json(await runtime.start());
    } catch (error) {
      next(routeError(error));
    }
  });

  context.app.post(`${context.prefix}/system/mcp-runtime/stop`, requireWorkspaceAdmin, async (_request, response, next) => {
    try {
      response.setHeader("cache-control", "no-store");
      response.json(await runtime.stop());
    } catch (error) {
      next(routeError(error));
    }
  });
}
