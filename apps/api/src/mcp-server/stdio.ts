import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./01-config-to-get-house-weather.js";
import "./09-mcp-tool-definitions-part04-to-tool-handler.js";
import type { McpProfile } from "./chatgpt-profile.js";
import { connectMcpTransport, requestShutdown } from "./10-all-tool-handlers.js";

/** Serves the MCP tools for `profile` over stdio until the client disconnects or the process is signalled. */
export async function startStdioMcpServer(profile: McpProfile): Promise<void> {
  await connectMcpTransport(new StdioServerTransport(), profile);
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdin.once("end", requestShutdown);
}
