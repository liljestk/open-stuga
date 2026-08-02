import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./mcp-server/01-config-to-get-house-weather.js";
import "./mcp-server/09-mcp-tool-definitions-part04-to-tool-handler.js";
import { connectMcpTransport, requestShutdown } from "./mcp-server/10-all-tool-handlers.js";

await connectMcpTransport(new StdioServerTransport());

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
process.stdin.once("end", requestShutdown);
