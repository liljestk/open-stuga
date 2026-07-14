import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP server policy", () => {
  it("advertises the hardened tool contract and returns privacy-safe house summaries", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/api/src/mcp-server.ts"],
      cwd: process.cwd().replace(/[\\/]apps[\\/]api$/, ""),
      env: {
        ...getDefaultEnvironment(),
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "climate-twin-test", version: "1.0.0" });
    await client.connect(transport);
    let closeDurationMs = Number.POSITIVE_INFINITY;
    try {
      expect(client.getServerVersion()).toEqual({ name: "stuga-local", version: "0.2.0" });
      expect(client.getInstructions()).toContain("not the hosted tenant or administration API");
      expect(client.getInstructions()).toContain("Raw integration credentials");
      const listedTools = await client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);
      expect(listedTools.tools).toHaveLength(58);
      expect(new Set(toolNames).size).toBe(58);
      expect(listedTools.tools.every((tool) => (
        tool.outputSchema?.type === "object"
        && Array.isArray(tool.outputSchema.required)
        && tool.outputSchema.required.includes("result")
        && JSON.stringify(tool.outputSchema.properties?.result) === JSON.stringify({
          oneOf: [{ type: "object" }, { type: "array" }],
        })
      ))).toBe(true);
      expect(toolNames).not.toContain("configure_home_assistant");
      expect(toolNames).not.toContain("configure_tp_link");
      const weatherTool = listedTools.tools.find((tool) => tool.name === "get_house_weather");
      expect(weatherTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(weatherTool?.inputSchema.properties).toMatchObject({
        persistObservation: { type: "boolean", default: false },
        confirmRealDataPersistence: { const: true },
      });
      expect(listedTools.tools.find((tool) => tool.name === "replace_house_layout")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(listedTools.tools.find((tool) => tool.name === "import_measurements")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(listedTools.tools.find((tool) => tool.name === "start_replay")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      await expect(client.callTool({
        name: "get_house_weather",
        arguments: { houseId: "house-main", persistObservation: true },
      })).rejects.toThrow("confirmRealDataPersistence must be true");

      const callStructured = async (name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await client.callTool({ name, arguments: arguments_ });
        expect(response.structuredContent).toHaveProperty("result");
        const result = (response.structuredContent as { result: unknown }).result;
        const text = response.content.find((item) => item.type === "text");
        expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(result);
        return result;
      };

      await callStructured("create_house", {
          id: "mcp-private-house",
          name: "Private cabin",
          timezone: "Europe/Helsinki",
          location: { latitude: 60.123456, longitude: 24.654321, label: "Precise private address" },
          mapPlacement: { latitude: 60.123456, longitude: 24.654321, metersPerPlanUnit: 0.25 },
          floors: [{
            id: "private-floor",
            name: "Ground",
            width: 10,
            height: 8,
            elevation: 0,
            walls: [],
            rooms: [],
            backgroundImage: "data:image/png;base64,PRIVATE_FLOOR_PLAN",
          }],
      });
      const houses = await callStructured("list_houses");
      const serialized = JSON.stringify(houses);
      expect(serialized).toContain("mcp-private-house");
      expect(serialized).toContain("visualReferenceConfigured");
      expect(serialized).not.toContain("60.123456");
      expect(serialized).not.toContain("24.654321");
      expect(serialized).not.toContain("Precise private address");
      expect(serialized).not.toContain("PRIVATE_FLOOR_PLAN");

      await callStructured("get_house", { houseId: "house-main" });
      await callStructured("list_sensors", { houseId: "house-main" });
      await callStructured("get_sensor_snapshot", { sensorId: "sensor-01" });
      await callStructured("list_measurement_definitions");
      await callStructured("select_mock_scenario", { scenario: "normal" });
      await callStructured("list_mock_scenarios");

      const from = new Date(Date.now() - 60_000).toISOString();
      await callStructured("ingest_measurements", { samples: [{
        sensorId: "sensor-01", metric: "temperature", value: 21.25, canonicalUnit: "°C", source: "api",
      }] });
      const to = new Date(Date.now() + 60_000).toISOString();
      await callStructured("get_measurement_snapshot", { houseId: "house-main" });
      await callStructured("query_measurement_history", { sensorId: "sensor-01", metric: "temperature", from, to });
      await callStructured("forecast_measurement", { sensorId: "sensor-01", metric: "temperature", hours: 1 });
      await callStructured("run_thermal_simulation", { houseId: "house-main", sensorId: "sensor-01", from, to, horizonHours: 0 });

      await callStructured("create_alert_rule", { rule: {
        id: "mcp-smoke-rule", name: "MCP smoke rule", sensorId: "sensor-01", metric: "temperature",
        operator: "gte", threshold: 99, durationSeconds: 60, severity: "warning",
      } });
      await callStructured("list_alert_rules");
      await callStructured("list_alert_events", { limit: 10 });

      await callStructured("create_observation", {
        id: "mcp-smoke-observation", houseId: "house-main", floorId: "floor-ground",
        kind: "note", severity: "info", note: "MCP structured-output smoke test",
      });
      await callStructured("list_observations", { houseId: "house-main" });
      await callStructured("upsert_static_parameter", {
        id: "mcp-smoke-parameter", houseId: "house-main", scopeType: "house", scopeId: "house-main",
        key: "mcpSmoke", value: true, label: "MCP smoke",
      });
      await callStructured("list_static_parameters", { houseId: "house-main" });

      const asset = await callStructured("upload_asset", {
        houseId: "house-main", name: "mcp-smoke.png", mimeType: "image/png", kind: "other", data: "AA==",
      }) as { id: string };
      await callStructured("list_assets", { houseId: "house-main" });
      await callStructured("get_asset_metadata", { assetId: asset.id });
      await expect(client.callTool({ name: "delete_asset", arguments: { assetId: asset.id } }))
        .rejects.toThrow("confirm must be true");
      await callStructured("delete_asset", { assetId: asset.id, confirm: true });

      await callStructured("get_integration_status");
      await callStructured("get_home_assistant_setup");
      await callStructured("get_tp_link_setup");
      await callStructured("get_replay_status");
      await callStructured("start_replay", { sensorIds: ["sensor-01"], from, to, speed: 10_000 });
      await callStructured("stop_replay");
    } finally {
      const closeStartedAt = Date.now();
      await client.close();
      closeDurationMs = Date.now() - closeStartedAt;
    }

    // Closing stdin should let the server drain and exit without the client's
    // two-second SIGTERM fallback.
    expect(closeDurationMs).toBeLessThan(1_500);
  }, 15_000);
});
