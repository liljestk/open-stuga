import { createServer } from "node:http";
import type { RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpTools } from "./mcp-server/tool-catalog.js";
import { McpHost, type ConnectedMcpServer, type McpTransport } from "./mcp-server/host.js";
import type { McpProfile } from "./mcp-server/chatgpt-profile.js";
import { createMcpRuntime } from "./mcp-server/runtime.js";
import { SYSTEM_VERSION } from "./version.js";

const host = "127.0.0.1";
const configuredAccessTokenHash = process.env.STUGU_MCP_ACCESS_TOKEN_SHA256;
if (!configuredAccessTokenHash || !/^[a-f0-9]{64}$/u.test(configuredAccessTokenHash)) {
  throw new Error("The MCP access token digest is unavailable");
}
const accessTokenHash = Buffer.from(configuredAccessTokenHash, "hex");
delete process.env.STUGU_MCP_ACCESS_TOKEN_SHA256;

function authorized(authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  return timingSafeEqual(
    accessTokenHash,
    createHash("sha256").update(authorization.slice(7)).digest(),
  );
}

const mcpHost = new McpHost(createMcpRuntime());
const app = createMcpExpressApp({ host });
app.disable("x-powered-by");

// The API authenticates every client and forwards only this process's own bearer.
// /mcp serves the full local inspection profile; /assistant serves the focused
// conversation profile that OAuth-connected assistants use.
const profilePaths: ReadonlyArray<[path: string, profile: McpProfile]> = [["/mcp", "local"], ["/assistant", "chatgpt"]];

const requireUpstreamBearer: RequestHandler = (request, response, next) => {
  if (authorized(request.header("authorization"))) {
    next();
    return;
  }
  response.status(401).set("www-authenticate", 'Bearer realm="Stugu MCP"').json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "A valid Stugu MCP access token is required" },
    id: null,
  });
};

function serveProfile(profile: McpProfile): RequestHandler {
  return async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let server: ConnectedMcpServer | undefined;
    try {
      server = await mcpHost.connect(transport as unknown as McpTransport, profile);
      const connectedServer = server;
      response.once("close", () => {
        void mcpHost.disconnect(connectedServer);
      });
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (server) await mcpHost.disconnect(server).catch(() => undefined);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}

for (const [path, profile] of profilePaths) {
  app.post(path, requireUpstreamBearer, serveProfile(profile));
  app.all(path, (_request, response) => {
    response.status(405).set("allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });
}

const httpServer = createServer(app);
await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, host, () => {
    httpServer.off("error", reject);
    resolve();
  });
});

const address = httpServer.address() as AddressInfo;
process.send?.({
  type: "ready",
  port: address.port,
  toolCount: buildMcpTools("local").length,
  serverVersion: SYSTEM_VERSION,
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.all([
    mcpHost.close(),
    new Promise<void>((resolve) => httpServer.close(() => resolve())),
  ]).then(() => undefined);
  return shutdownPromise;
}

function requestShutdown(): void {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
    requestShutdown();
  }
});
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
process.once("disconnect", requestShutdown);
