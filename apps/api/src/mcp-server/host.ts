import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runMcpToolRequest } from "../mcp-lifecycle.js";
import { validateMcpToolRegistry } from "../mcp-validation.js";
import { objectArguments } from "./arguments.js";
import { createMcpServer } from "./server.js";
import { activeMcpToolNames } from "./tool-catalog.js";
import { buildMcpTools, type ToolHandler } from "./tool-catalog.js";
import type { McpProfile } from "./chatgpt-profile.js";
import type { McpRuntime } from "./runtime.js";
import { createToolHandlers } from "./tool-handlers.js";

export type ConnectedMcpServer = ReturnType<typeof createMcpServer>;
export type McpTransport = Parameters<ConnectedMcpServer["connect"]>[0];

interface McpProfileRegistration {
  tools: ReturnType<typeof buildMcpTools>;
  handlers: Record<string, ToolHandler>;
}

/** Each profile's listed tools and the handlers that answer them, checked against each other. */
function profileRegistrations(runtime: McpRuntime): Map<McpProfile, McpProfileRegistration> {
  const allHandlers = createToolHandlers(runtime);
  return new Map((["local", "chatgpt"] as const).map((profile) => {
    const active = activeMcpToolNames(profile);
    const tools = buildMcpTools(profile);
    const handlers = Object.fromEntries(Object.entries(allHandlers).filter(([name]) => active.has(name)));
    validateMcpToolRegistry(tools.map((tool) => tool.name), Object.keys(handlers));
    return [profile, { tools, handlers }];
  }));
}

/** Serves the MCP profiles over one runtime: connects transports and owns the drain and shutdown. */
export class McpHost {
  private readonly profiles: Map<McpProfile, McpProfileRegistration>;
  private readonly connectedServers = new Set<ConnectedMcpServer>();
  private resourcesClosed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly runtime: McpRuntime) {
    this.profiles = profileRegistrations(runtime);
  }

  async connect(transport: McpTransport, profile: McpProfile = "local"): Promise<ConnectedMcpServer> {
    const server = createMcpServer(profile);
    this.registerRequestHandlers(server, profile);
    server.onclose = () => this.connectedServers.delete(server);
    this.connectedServers.add(server);
    try {
      await server.connect(transport);
      return server;
    } catch (error) {
      this.connectedServers.delete(server);
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(server: ConnectedMcpServer): Promise<void> {
    if (!this.connectedServers.delete(server)) return;
    await server.close();
  }

  /** Stops accepting calls, drains in-flight ones, closes every connection, then the runtime. */
  close(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const { operations, mock, replay, timeseries } = this.runtime;
    operations.stopAccepting();
    mock.stop();
    replay.stop();
    this.shutdownPromise = (async () => {
      let drainError: unknown;
      try {
        try {
          await operations.waitForIdle(10_000);
        } catch (error) {
          drainError = error;
        }
        // Let the protocol flush the response produced by the final handler.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.all([...this.connectedServers].map((server) => server.close()));
        if (drainError) throw drainError;
      } finally {
        try {
          await timeseries?.close();
        } finally {
          this.closeResources();
        }
      }
    })();
    return this.shutdownPromise;
  }

  requestShutdown(): void {
    void this.close().catch(() => {
      // Keep credentials and request contents out of protocol logs.
      console.error("Stugu MCP shutdown failed");
      process.exitCode = 1;
    });
  }

  private closeResources(): void {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    const { mock, replay, homeAssistant, tpLink, database } = this.runtime;
    mock.stop();
    replay.stop();
    homeAssistant.stop();
    tpLink.stop();
    database.close();
  }

  private registerRequestHandlers(server: ConnectedMcpServer, profile: McpProfile): void {
    const { tools, handlers } = this.profiles.get(profile)!;
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const result = await runMcpToolRequest(
        this.runtime.operations,
        handlers,
        request.params.name,
        objectArguments(request.params.arguments),
        extra.signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { result },
      };
    });
  }
}
