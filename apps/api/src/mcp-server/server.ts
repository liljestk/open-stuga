import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SYSTEM_VERSION } from "../version.js";
import { chatgptMcpServerInstructions, type McpProfile } from "./chatgpt-profile.js";

export function createMcpServer(profile: McpProfile): Server {
  return new Server(
    { name: profile === "chatgpt" ? "stugu-chatgpt" : "stugu-local", version: SYSTEM_VERSION },
    {
      capabilities: { tools: {} },
      instructions: profile === "chatgpt"
        ? chatgptMcpServerInstructions
        : [
            "This Stugu MCP is a read-only inspection surface over its configured local SQLite workspace.",
            "It cannot inspect a separately running API process's in-memory connections or event bus.",
            "Create, update, delete, import, migration, sharing, synchronization, control, raw credentials, SSE streams, and binary asset downloads are intentionally excluded.",
          ].join(" "),
    },
  );
}
