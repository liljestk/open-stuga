import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpProfile } from "./chatgpt-profile.js";
import { McpHost } from "./host.js";
import { createMcpRuntime } from "./runtime.js";

/** Serves the MCP tools for `profile` over stdio until the client disconnects or the process is signalled. */
export async function startStdioMcpServer(profile: McpProfile): Promise<void> {
  const host = new McpHost(createMcpRuntime());
  await host.connect(new StdioServerTransport(), profile);
  const requestShutdown = () => host.requestShutdown();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdin.once("end", requestShutdown);
}
