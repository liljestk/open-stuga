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

  it("answers every offline tool with a result or a domain error, never an internal failure", { timeout: 60_000 }, async () => {
    const runtime = createMcpRuntime(normalizeAppConfig({ ...config, databasePath: fixtureDatabasePath() }));
    const host = new McpHost(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await host.connect(serverTransport);
    const client = new Client({ name: "stugu-in-process-test", version: "1.0.0" });
    await client.connect(clientTransport);
    // These reach a network service, the LAN or a worker thread; the stdio suite covers their wiring.
    const online = new Set(["search_locations", "resolve_coordinate_defaults", "get_house_weather", "discover_integrations",
      "test_home_assistant_connection", "test_tp_link_connection", "list_tp_link_devices", "run_thermal_simulation"]);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const values: Record<string, unknown> = {
      propertyId: "property-main", houseId: "house-main", sensorId: "sensor-01", sensorIds: ["sensor-01"],
      metric: "temperature", measurementId: "temperature", from, to, unit: "day", anchor: to.slice(0, 10),
      stugubyId: "00000000-0000-4000-8000-000000000000", observationId: "missing-observation",
      maintenanceTaskId: "missing-task", assetId: "missing-asset",
    };
    const internalFailure = /TypeError|ReferenceError|Cannot read propert|is not a function|is not iterable/u;
    const failures: string[] = [];
    let answered = 0;
    try {
      const { tools } = await client.listTools();
      for (const tool of tools.filter((candidate) => !online.has(candidate.name))) {
        const required = (tool.inputSchema as { required?: string[] }).required ?? [];
        const missing = required.filter((key) => !(key in values));
        if (missing.length) {
          failures.push(`${tool.name}: no fixture value for ${missing.join(", ")}`);
          continue;
        }
        try {
          const response = await client.callTool({ name: tool.name, arguments: Object.fromEntries(required.map((key) => [key, values[key]])) });
          expect(response.structuredContent).toHaveProperty("result");
          answered += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (internalFailure.test(message)) failures.push(`${tool.name}: ${message}`);
        }
      }
    } finally {
      await client.close();
      await host.close();
    }
    expect(failures).toEqual([]);
    expect(answered).toBeGreaterThan(30);
  });
});
