import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STUGBY_PROTOCOL_VERSION } from "@climate-twin/stuguby-protocol";
import { SYSTEM_VERSION } from "@climate-twin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { StugubyStore } from "../src/stuguby/store.js";

const temporaryDirectories: string[] = [];

function preparedDatabase(): { directory: string; path: string; stugubyId: string } {
  const directory = mkdtempSync(join(tmpdir(), "stugu-mcp-read-only-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "climate.db");
  const database = new ClimateDatabase(path, true);
  const nodeId = randomUUID();
  const store = new StugubyStore(database.db, nodeId);
  const stuguby = store.createCoordinatedStuguby({
    name: "Shared cottages",
    coordinatorUrl: "http://127.0.0.1:3000",
  }, {
    nodeId,
    displayName: "Host Stugu",
    publicKey: "test-public-key",
    keyFingerprint: "0".repeat(64),
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  });
  store.adoptProperty(stuguby.id, "property-main", 1);
  database.setPropertyStugubyLink("property-main", {
    stugubyId: stuguby.id,
    authorityNodeId: nodeId,
    isAuthority: true,
    editPolicy: "collaborative",
    syncState: "synced",
    authorityEpoch: 1,
    lastSyncedRevision: 1,
    pendingChangeCount: 0,
    conflictCount: 0,
  });
  database.setHouseStugubyLink("house-main", {
    stugubyId: stuguby.id,
    authorityNodeId: nodeId,
    publicationId: randomUUID(),
    ownership: "local",
    editPolicy: "editable",
    syncState: "synced",
    authorityEpoch: 1,
    pendingChangeCount: 0,
    conflictCount: 0,
    recoveryState: "not-enabled",
  });
  database.close();
  return { directory, path, stugubyId: stuguby.id };
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("read-only MCP server", () => {
  it("advertises current inspection tools and cannot change its SQLite workspace", async () => {
    const fixture = preparedDatabase();
    const before = fileHash(fixture.path);
    const readOnlyDatabase = new ClimateDatabase(fixture.path, false, { readOnly: true });
    expect(() => readOnlyDatabase.createProperty({ name: "Forbidden MCP write" }))
      .toThrow(/read.?only/i);
    readOnlyDatabase.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/api/src/mcp-server.ts"],
      cwd: process.cwd().replace(/[\\/]apps[\\/]api$/, ""),
      env: {
        ...getDefaultEnvironment(),
        NODE_ENV: "test",
        DATABASE_PATH: fixture.path,
        MOCK_ENABLED: "true",
        HA_URL: "http://homeassistant.local:8123",
        HA_TOKEN: "configured-token",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stugu-read-only-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toEqual({ name: "stugu-local", version: SYSTEM_VERSION });
      expect(client.getInstructions()).toContain("read-only inspection surface");

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(listed.tools).toHaveLength(61);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining([
        "list_properties",
        "list_houses",
        "list_stugubys",
        "get_stuguby",
        "get_daily_analytics_findings",
        "get_property_energy_optimization",
        "list_property_notes",
        "get_house_opening_states",
        "get_opening_activity",
        "get_home_performance",
        "get_home_monitoring",
        "compare_calendar_periods",
        "get_house_energy_cost",
        "get_house_energy_summary",
        "query_outdoor_temperature_history",
        "get_home_moisture_response",
        "summarize_home_measurements",
        "get_house_thermal_isolation",
        "list_notification_deliveries",
        "list_action_playbooks",
        "list_action_runs",
        "list_sensor_data_gaps",
        "get_backup_status",
        "get_setup_doctor",
        "get_house_weather",
        "list_maintenance_tasks",
        "get_integration_status",
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "create_house",
        "update_house",
        "delete_house",
        "ingest_measurements",
        "create_observation",
        "update_maintenance_task",
        "select_mock_scenario",
        "start_replay",
      ]));
      expect(listed.tools.every((tool) => (
        tool.annotations?.readOnlyHint === true
        && tool.annotations.destructiveHint === false
        && tool.annotations.idempotentHint === true
      ))).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "get_house_weather")?.inputSchema.properties)
        .not.toHaveProperty("persistObservation");
      expect(listed.tools.find((tool) => tool.name === "get_house_weather")?.annotations)
        .toMatchObject({ openWorldHint: true });

      const call = async (name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await client.callTool({ name, arguments: arguments_ });
        return (response.structuredContent as { result: unknown }).result;
      };
      const properties = await call("list_properties") as Array<{ stuguby?: { isAuthority: boolean } }>;
      expect(properties[0]?.stuguby).toMatchObject({ isAuthority: true });
      const houses = await call("list_houses") as Array<{
        id: string;
        stuguby?: { ownership: string; editPolicy: string };
      }>;
      expect(houses).toContainEqual(expect.objectContaining({
        id: "house-main",
        stuguby: expect.objectContaining({ ownership: "local", editPolicy: "editable" }),
      }));
      const stugubys = await call("list_stugubys") as Array<{
        id: string;
        side: string;
        ownedHomeCount: number;
      }>;
      expect(stugubys).toContainEqual(expect.objectContaining({
        id: fixture.stugubyId,
        side: "host",
        ownedHomeCount: 1,
      }));
      const detail = await call("get_stuguby", { stugubyId: fixture.stugubyId }) as {
        stuguby: { side: string };
        members: Array<{ side: string; isHost: boolean }>;
        homes: Array<{ stuguby?: { ownership: string; editPolicy: string } }>;
      };
      expect(detail.stuguby.side).toBe("host");
      expect(detail.members).toContainEqual(expect.objectContaining({ side: "host", isHost: true }));
      expect(detail.homes[0]?.stuguby).toMatchObject({ ownership: "local", editPolicy: "editable" });

      await call("get_property", { propertyId: "property-main" });
      await call("get_daily_analytics_findings", { houseId: "house-main" });
      await call("get_property_energy_optimization", { propertyId: "property-main" });
      await call("get_property_electricity", { propertyId: "property-main" });
      await call("list_property_notes", { propertyId: "property-main" });
      await call("get_house_opening_states", { houseId: "house-main" });
      await call("get_house_electricity_price", { houseId: "house-main" });
      await call("get_house_energy_cost", { houseId: "house-main", sensorId: "sensor-01" });
      await call("get_house_energy_summary", { houseId: "house-main" });
      await call("query_outdoor_temperature_history", { houseId: "house-main" });
      await call("get_home_moisture_response", { houseId: "house-main" });
      await call("get_house_thermal_isolation", { houseId: "house-main" });
      await call("list_notification_deliveries");
      await call("list_action_playbooks");
      await call("list_action_runs");
      await call("list_sensor_data_gaps");
      await call("get_backup_status");
      await call("get_setup_doctor");
      await call("get_integration_status");
      await expect(client.callTool({ name: "create_house", arguments: {} }))
        .rejects.toThrow("Unknown tool: create_house");
    } finally {
      await client.close();
    }

    expect(fileHash(fixture.path)).toBe(before);
  }, 15_000);

  it("offers a focused, voice-friendly ChatGPT profile", async () => {
    const fixture = preparedDatabase();
    const writableDatabase = new ClimateDatabase(fixture.path, false);
    writableDatabase.activateRealDataMode();
    writableDatabase.insertMeasurementSamples([
      {
        sensorId: "sensor-01",
        metric: "temperature",
        value: 20,
        canonicalUnit: "°C",
        timestamp: "2026-07-29T19:00:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-01",
        metric: "temperature",
        value: 22,
        canonicalUnit: "°C",
        timestamp: "2026-07-30T03:00:00.000Z",
        source: "api",
        quality: "good",
      },
    ]);
    writableDatabase.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/api/src/chatgpt-mcp-server.ts"],
      cwd: process.cwd().replace(/[\\/]apps[\\/]api$/, ""),
      env: {
        ...getDefaultEnvironment(),
        NODE_ENV: "test",
        DATABASE_PATH: fixture.path,
        MOCK_ENABLED: "true",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stugu-chatgpt-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toEqual({
        name: "stugu-chatgpt",
        version: SYSTEM_VERSION,
      });
      expect(client.getInstructions()).toContain("voice conversations");
      expect(client.getInstructions()).toContain("Never infer that wind caused");

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(listed.tools).toHaveLength(20);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining([
        "get_measurement_snapshot",
        "query_measurement_history",
        "summarize_home_measurements",
        "get_house_opening_states",
        "get_house_energy_summary",
        "get_house_weather",
        "get_home_moisture_response",
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "get_setup_doctor",
        "get_stuguby",
        "create_house",
        "update_house",
      ]));
      expect(listed.tools.every((tool) => (
        Boolean(tool.title)
        && tool.annotations?.readOnlyHint === true
        && tool.annotations.destructiveHint === false
        && tool.annotations.idempotentHint === true
      ))).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "get_measurement_snapshot"))
        .toMatchObject({
          title: "Get current Home readings",
          description: expect.stringContaining("timestamped"),
        });
      expect(listed.tools.find((tool) => tool.name === "get_home_moisture_response")?.description)
        .toContain("not whether wind caused");

      const summaryResponse = await client.callTool({
        name: "summarize_home_measurements",
        arguments: {
          houseId: "house-main",
          measurementId: "temperature",
          sensorIds: ["sensor-01"],
          from: "2026-07-29T19:00:00.000Z",
          to: "2026-07-30T04:00:00.000Z",
        },
      });
      expect(summaryResponse.structuredContent).toMatchObject({
        result: {
          timezone: "Europe/Helsinki",
          measurementId: "temperature",
          homeMean: 21,
          quality: { sensorsWithData: 1, sampleCount: 2 },
        },
      });
    } finally {
      await client.close();
    }
  }, 15_000);
});
