import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "./mcp-server/01-config-to-get-house-weather.js";
import { mcpTools } from "./mcp-server/09-mcp-tool-definitions-part04-to-tool-handler.js";
import {
  close,
  connectMcpTransport,
  disconnectMcpServer,
} from "./mcp-server/10-all-tool-handlers.js";
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

const app = createMcpExpressApp({ host });
app.disable("x-powered-by");
app.post("/mcp", (request, response, next) => {
  if (authorized(request.header("authorization"))) {
    next();
    return;
  }
  response.status(401).set("www-authenticate", 'Bearer realm="Stugu MCP"').json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "A valid Stugu MCP access token is required" },
    id: null,
  });
}, async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  let server: Awaited<ReturnType<typeof connectMcpTransport>> | undefined;
  try {
    server = await connectMcpTransport(transport as unknown as Parameters<typeof connectMcpTransport>[0]);
    const connectedServer = server;
    response.once("close", () => {
      void disconnectMcpServer(connectedServer);
    });
    await transport.handleRequest(request, response, request.body);
  } catch {
    if (server) await disconnectMcpServer(server).catch(() => undefined);
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.all("/mcp", (_request, response) => {
  response.status(405).set("allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
});

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
  toolCount: mcpTools.length,
  serverVersion: SYSTEM_VERSION,
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.all([
    close(),
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
