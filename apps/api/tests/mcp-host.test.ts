import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAppConfig } from "../src/config/api-defaults.js";
import type { HeatPumpState } from "@climate-twin/contracts";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";
import { HeatPumpStateStore } from "../src/heat-pump-state.js";
import { StugubyStore } from "../src/stuguby/store.js";
import { McpHost } from "../src/mcp-server/host.js";
import { createMcpRuntime } from "../src/mcp-server/runtime.js";
import { config } from "./appTestSupport.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** A seeded workspace file, migrated as the API leaves it, that the MCP runtime can open read-only. */
function fixtureDatabasePath(seed: (database: ClimateDatabase) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), "stugu-mcp-host-"));
  directories.push(directory);
  const path = join(directory, "climate.db");
  const database = new ClimateDatabase(path, true);
  new StugubyStore(database.db, randomUUID());
  seed(database);
  database.close();
  return path;
}

const HOUR = 3_600_000;

function heatPumpState(observedAt: string, targetTemperatureC: number): HeatPumpState {
  return {
    connectionId: "gree-main", houseId: "house-main", equipmentId: null, deviceId: "a1b2c3d4e5f6",
    name: "Living room heat pump", brand: "Wilfa", model: "Nordkapp 30", transport: "lan",
    observedAt, receivedAt: observedAt, available: true, power: true, selectedMode: "heat",
    targetTemperatureC, currentTemperatureC: 20.5, currentTemperatureSource: "reported",
    currentHumidityPercent: null, targetHumidityPercent: null, fanSpeed: "Auto", horizontalSwing: null,
    verticalSwing: null, freshAir: null, anion: null, sleep: null, light: null, quiet: false, turbo: false,
    xfan: false, steadyHeat: null, powerSave: null, cleanFilter: null, waterFull: null, dehumidifierMode: null,
    compressorFrequencyHz: null, diagnostics: {}, activity: "unknown", activityEvidence: "unavailable",
  } as HeatPumpState;
}

/** Hourly temperatures over two weeks, a heat pump, a tariff, an invoice, and stored weather. */
function seedReadableHome(database: ClimateDatabase, now: number): void {
  database.insertMeasurementSamples(Array.from({ length: 15 * 24 }, (_, index) => ({
    sensorId: "sensor-01",
    metric: "temperature",
    value: 21 + Math.sin(index / 4),
    canonicalUnit: "°C",
    timestamp: new Date(now - (index + 1) * HOUR).toISOString(),
    source: "api" as const,
    quality: "good" as const,
  })));
  const heatPumps = new HeatPumpStateStore(database);
  heatPumps.record(heatPumpState(new Date(now - 2 * HOUR).toISOString(), 21));
  heatPumps.record(heatPumpState(new Date(now - HOUR).toISOString(), 22));
  database.savePropertyElectricityTariff("property-main", [{
    validFrom: "2000-01-01", energy: { kind: "spot", marginCentsPerKwh: 0.5 }, network: null,
    electricityTaxCentsPerKwh: 2.79, retailerMonthlyFeeEur: null, networkMonthlyFeeEur: null,
  }]);
  const day = new Date(now - 2 * 24 * HOUR).toISOString().slice(0, 10);
  database.createElectricityInvoice("property-main", { houseId: "house-main", periodStart: day, periodEnd: day, totalEur: 4.2 });
  const location = { latitude: 60.1699, longitude: 24.9384 };
  database.updateHouse("house-main", { location });
  database.saveWeatherSnapshot({
    houseId: "house-main", location, provider: "fmi", attribution: "Test weather",
    fetchedAt: new Date(now).toISOString(), forecastIssuedAt: new Date(now).toISOString(), stale: false,
    current: { timestamp: new Date(now).toISOString(), temperatureC: 4 }, observationStation: null,
    forecast: [{ timestamp: new Date(now + HOUR).toISOString(), temperatureC: 3 }], warnings: [], unavailable: [],
  }, outdoorLocationKey(location));
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
      maintenanceTaskId: "missing-task", assetId: "missing-asset", connectionId: "missing-heat-pump",
      invoiceId: "missing-invoice", measurementIds: ["temperature"],
    };
    // A write against the read-only workspace or a table the API would have created is a defect, not a domain answer.
    const internalFailure = /TypeError|ReferenceError|Cannot read propert|is not a function|is not iterable|readonly database|no such table/u;
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

  it("reads heat pumps, electricity contracts, bucketed analytics and forecasts from a read-only workspace", { timeout: 60_000 }, async () => {
    const now = Date.now();
    const databasePath = fixtureDatabasePath((database) => seedReadableHome(database, now));
    const runtime = createMcpRuntime(normalizeAppConfig({
      ...config,
      databasePath,
      greeConnections: [{
        id: "gree-main", houseId: "house-main", host: "192.0.2.10", port: 7000,
        mac: "a1:b2:c3:d4:e5:f6", key: "test-device-key", cipherVersion: 1,
      }],
    }));
    const host = new McpHost(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await host.connect(serverTransport);
    const client = new Client({ name: "stugu-in-process-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const call = async (name: string, arguments_: Record<string, unknown> = {}) => (
      (await client.callTool({ name, arguments: arguments_ })).structuredContent as { result: Record<string, unknown> }
    ).result;
    try {
      const heatPumps = await call("list_heat_pump_states", { houseId: "house-main" });
      expect(heatPumps.states).toEqual([expect.objectContaining({ connectionId: "gree-main", power: true, targetTemperatureC: 22 })]);
      expect(JSON.stringify(heatPumps)).not.toContain("test-device-key");
      const heatPumpHistory = await call("query_heat_pump_history", { connectionId: "gree-main" });
      expect((heatPumpHistory.states as HeatPumpState[]).map((state) => state.targetTemperatureC)).toEqual([22, 21]);

      expect(await call("get_property_electricity_tariff", { propertyId: "property-main" })).toMatchObject({
        tariff: { propertyId: "property-main", versions: [expect.objectContaining({ electricityTaxCentsPerKwh: 2.79 })] },
        timeZone: "Europe/Helsinki",
      });
      const { invoices } = await call("list_electricity_invoices", { propertyId: "property-main" }) as { invoices: Array<{ id: string; totalEur: number }> };
      expect(invoices).toEqual([expect.objectContaining({ totalEur: 4.2 })]);
      expect(await call("get_electricity_invoice_reconciliation", { propertyId: "property-main", invoiceId: invoices[0]!.id }))
        .toMatchObject({ reconciliation: expect.objectContaining({ invoiceId: invoices[0]!.id }) });
      expect(await call("get_house_energy_projection", { houseId: "house-main" })).toHaveProperty("projection");

      const from = new Date(now - 3 * 24 * HOUR).toISOString();
      const analytics = await call("query_analytics", {
        houseId: "house-main", measurementIds: ["temperature"], sensorIds: ["sensor-01"],
        from, to: new Date(now).toISOString(), resolution: "1d",
      });
      expect(analytics).toMatchObject({ resolution: "1d", series: [expect.objectContaining({ entityId: "sensor-01", measurementId: "temperature" })] });
      expect((analytics.series as Array<{ points: unknown[] }>)[0]!.points.length).toBeGreaterThan(0);
      const coverage = await call("get_measurement_coverage", { houseId: "house-main", measurementIds: ["temperature"], sensorIds: ["sensor-01"] });
      expect(coverage).toMatchObject({ series: [expect.objectContaining({ entityId: "sensor-01", measurementId: "temperature" })] });

      // A forecast without a cached evaluation is computed without writing one.
      expect(Array.isArray(await call("forecast_measurement", { sensorId: "sensor-01", metric: "temperature" }))).toBe(true);
      await call("forecast_sensor", { sensorId: "sensor-01" });
      await call("get_home_monitoring", { houseId: "house-main" });
    } finally {
      await client.close();
      await host.close();
    }
  });
});