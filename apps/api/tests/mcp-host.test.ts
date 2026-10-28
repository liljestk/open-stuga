import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAppConfig } from "../src/config/api-defaults.js";
import { ClimateDatabase } from "../src/db.js";
import { McpHost } from "../src/mcp-server/host.js";
import { createMcpRuntime } from "../src/mcp-server/runtime.js";
import { config } from "./appTestSupport.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** A seeded workspace file the MCP runtime can open read-only. */
function fixtureDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "stugu-mcp-host-"));
  directories.push(directory);
  const path = join(directory, "climate.db");
  new ClimateDatabase(path, true).close();
  return path;
}

describe("in-process MCP host", () => {
  it("answers tools from a runtime built over a fixture workspace and closes it", async () => {
    const runtime = createMcpRuntime(normalizeAppConfig({ ...config, databasePath: fixtureDatabasePath() }));
    const host = new McpHost(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await host.connect(serverTransport);
    const client = new Client({ name: "stugu-in-process-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const houses = await client.callTool({ name: "list_houses", arguments: {} });
    expect(houses.structuredContent).toMatchObject({ result: expect.arrayContaining([expect.objectContaining({ id: "house-main" })]) });
    await expect(client.callTool({ name: "get_house", arguments: { houseId: "missing-house" } }))
      .rejects.toThrow(/Unknown house: missing-house/u);

    await host.close();
    expect(() => runtime.database.listHouses()).toThrow();
  });
});
