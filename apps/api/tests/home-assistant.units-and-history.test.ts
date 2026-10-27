import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import "../src/home-assistant.js";
import {
  HomeAssistantConnectionBridgeCore,
  homeAssistantConnectionBridgeState,
  type HomeAssistantConnectionBridgeInternals,
} from "../src/home-assistant/core.js";
import { HA_HISTORY_CHUNK_MS, type EntityTarget, type HaState } from "../src/home-assistant/support/01-home-assistant-measurement-binding-to-validate-entit.js";

function config(directory: string, haUrl: string): AppConfig {
  return {
    port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(directory, "secrets.json"), assetDirectory: directory,
    mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
    haUrl, haToken: "test-token", haEntityMapFile: null,
    tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
    tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
    alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
  };
}

describe("Home Assistant bridge unit conversion and recorder history", () => {
  let runtime: ApiRuntime | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function bridgeFixture(fetcher?: typeof fetch, haUrl = "http://ha.example.test") {
    directory = mkdtempSync(join(tmpdir(), "stugu-ha-units-history-"));
    const appConfig = config(directory, haUrl);
    runtime = createApi({ config: appConfig, startBackground: false });
    const status = { value: structuredClone(runtime.status.value), changed: vi.fn() };
    const bridge = new HomeAssistantConnectionBridgeCore(
      appConfig,
      runtime.telemetry,
      runtime.measurements,
      runtime.database,
      status,
      undefined,
      { fetcher },
    ) as unknown as HomeAssistantConnectionBridgeInternals;
    const sensorId = runtime.database.listSensors()[0]!.id;
    const bind = (entityId: string, target: Omit<EntityTarget, "sensorId">) => {
      bridge[homeAssistantConnectionBridgeState].entities.set(entityId, { sensorId, ...target });
    };
    return { bridge, status, sensorId, bind, database: runtime.database };
  }

  const state = (entityId: string, value: string, unit?: string, lastUpdated = "2026-07-14T09:00:00Z"): HaState => ({
    entity_id: entityId,
    state: value,
    last_updated: lastUpdated,
    ...(unit === undefined ? {} : { attributes: { unit_of_measurement: unit } }),
  });

  it("converts live values to canonical units and reports why a state was rejected", () => {
    const { bridge, status, sensorId, bind } = bridgeFixture();
    bind("sensor.temperature", { metric: "temperature", legacy: true });
    bind("sensor.battery", { metric: "battery", legacy: false });
    bind("sensor.power", { metric: "power", legacy: false, automaticElectricityUnitConversion: true });
    bind("sensor.co2", { metric: "co2", legacy: false });
    bind("sensor.co2_ppb", { metric: "co2", legacy: false, expectedUnit: "ppb" });
    bind("sensor.co2_scaled", { metric: "co2", legacy: false, expectedUnit: "ppb", scale: 0.001, offset: 1 });
    bind("sensor.unknown", { metric: "not-a-metric", legacy: false });
    const rejected = (entityState: HaState, error: string) => {
      expect(bridge.applyState(entityState)).toBeNull();
      expect(status.value.homeAssistant.error).toBe(error);
    };

    expect(bridge.applyState(state("sensor.temperature", "70", "°F"))).toMatchObject({ sensorId, metric: "temperature", value: (70 - 32) * 5 / 9 });
    expect(bridge.applyState(state("sensor.battery", "87", "%"))).toMatchObject({ metric: "battery", value: 87 });
    expect(bridge.applyState(state("sensor.co2", "850", "ppm"))).toMatchObject({ metric: "co2", value: 850 });
    expect(bridge.applyState(state("sensor.co2_scaled", "900000", "ppb"))).toMatchObject({ metric: "co2", value: 901 });
    expect(bridge.applyState(state("sensor.power", "1.5", "kW"))).toMatchObject({ metric: "power", value: 1500 });

    rejected(state("sensor.temperature", "20", "furlongs"), "Unsupported temperature unit for entity sensor.temperature");
    rejected(state("sensor.power", "1", "horsepower"), "Unsupported unit horsepower for power entity sensor.power");
    rejected(state("sensor.power", "1"), "Unsupported unit (missing) for power entity sensor.power");
    rejected(state("sensor.unknown", "1", "x"), "Unknown measurement metric not-a-metric for entity sensor.unknown");
    rejected(state("sensor.co2", "850", "ppb"), "Unit for entity sensor.co2 must be ppm");
    rejected(state("sensor.co2", "850"), "Unit for entity sensor.co2 must be ppm");
    rejected(state("sensor.co2_ppb", "850", "ppb"), "Entity sensor.co2_ppb requires an explicit scale or offset to convert ppb to ppm");

    status.value.homeAssistant.error = null;
    expect(bridge.applyState(state("sensor.co2", "not-a-number", "ppm"))).toBeNull();
    expect(bridge.applyState(state("sensor.unbound", "1", "ppm"))).toBeNull();
    expect(bridge.applyState({ entity_id: "", state: "1" } as HaState)).toBeNull();
    expect(status.value.homeAssistant.error).toBeNull();

    expect(bridge.applyState(state("sensor.temperature", "18", "°C", "2026-07-14T08:00:00Z"))).toBeNull();
  });

  it("merges the compatibility map with unclaimed persisted sensor bindings", () => {
    const { bridge, database } = bridgeFixture();
    const mappingPath = join(directory!, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [
      { sensorId: "file-sensor", temperature: "sensor.file_temp" },
      { sensorId: "disabled-sensor", humidity: "sensor.disabled_humidity" },
      { sensorId: "ghost-sensor", humidity: "sensor.ghost_humidity" },
    ] }));
    bridge[homeAssistantConnectionBridgeState].config.haEntityMapFile = mappingPath;
    const sensor = (id: string, enabled: boolean, bindings: Record<string, unknown>) => database.createSensor({
      id, houseId: "house-main", floorId: "floor-ground", name: id, room: "Utility",
      model: "Home Assistant", x: 1, y: 1, z: 1, tags: [], enabled, ...bindings,
    });
    sensor("file-sensor", true, { measurementEntityIds: { temperature: "sensor.db_temp", co2: " sensor.file_temp " } });
    sensor("disabled-sensor", false, { measurementEntityIds: { humidity: "sensor.disabled_db_humidity" } });
    sensor("db-sensor", true, {
      temperatureEntityId: "sensor.legacy_temp",
      measurementEntityIds: { humidity: "sensor.db_humidity", co2: "sensor.db_co2" },
    });

    const mappings = bridge.configuredMappings();

    expect(bridge[homeAssistantConnectionBridgeState].mappingWarning)
      .toBe("Ignored Home Assistant mappings for unknown or disabled sensors: disabled-sensor");
    expect(mappings).toContainEqual({ sensorId: "file-sensor", temperature: "sensor.file_temp" });
    expect(mappings).toContainEqual({
      sensorId: "db-sensor",
      temperature: "sensor.legacy_temp",
      humidity: "sensor.db_humidity",
      measurements: { co2: "sensor.db_co2" },
    });
    expect(mappings.map((mapping) => mapping.sensorId)).not.toContain("disabled-sensor");
    expect(mappings.map((mapping) => mapping.sensorId)).not.toContain("ghost-sensor");
    expect(mappings.filter((mapping) => mapping.sensorId === "file-sensor")).toHaveLength(1);
  });

  it("ignores live states for a disabled sensor", () => {
    const { bridge, sensorId, bind, database } = bridgeFixture();
    bind("sensor.co2", { metric: "co2", legacy: false });
    database.updateSensor(sensorId, { enabled: false });
    expect(bridge.applyState(state("sensor.co2", "850", "ppm"))).toBeNull();
  });

  it("refuses history recovery without a binding or a valid range", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { bridge, sensorId, bind } = bridgeFixture(fetcher);
    await expect(bridge.recoverHistory(sensorId, "co2", "2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z")).resolves.toEqual({
      state: "not-supported", samples: [], error: "The sensor metric has no active Home Assistant history binding",
    });
    await expect(bridge.recoverHistory("missing-sensor", "co2", "2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z")).resolves.toEqual({
      state: "not-supported", samples: [], error: "Home Assistant history recovery requires local Home authority",
    });
    bind("sensor.co2", { metric: "co2", legacy: false });
    for (const [from, to] of [["not-a-date", "2026-07-15T00:00:00Z"], ["2026-07-15T00:00:00Z", "2026-07-14T00:00:00Z"]]) {
      await expect(bridge.recoverHistory(sensorId, "co2", from!, to!)).resolves.toEqual({ state: "complete", samples: [], error: null });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches recorder history per day and keeps only valid in-range samples", async () => {
    const start = Date.parse("2026-07-14T00:00:00.000Z");
    const responses = [
      [
        "not-a-group",
        [
          null,
          { state: "850", last_updated: "2026-07-14T06:00:00Z", attributes: { unit_of_measurement: "ppm" } },
          { state: "860", last_updated: "invalid", last_changed: "2026-07-14T05:00:00Z", attributes: { unit_of_measurement: "ppm" } },
          { state: "870", last_updated: "invalid", attributes: { unit_of_measurement: "ppm" } },
          { state: "880", last_updated: "2026-07-13T23:00:00Z", attributes: { unit_of_measurement: "ppm" } },
          { state: "unavailable", last_updated: "2026-07-14T07:00:00Z", attributes: { unit_of_measurement: "ppm" } },
          { state: "890", last_updated: "2026-07-14T08:00:00Z", attributes: { unit_of_measurement: "ppb" } },
        ],
      ],
      [[{ state: "900", last_updated: "2026-07-15T03:00:00Z", attributes: { unit_of_measurement: "ppm" } }]],
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(responses.shift())));
    const { bridge, sensorId, bind } = bridgeFixture(fetcher, "http://ha.example.test/base/");
    bind("sensor.co2", { metric: "co2", legacy: false });

    const result = await bridge.recoverHistory(
      sensorId,
      "co2",
      new Date(start).toISOString(),
      new Date(start + HA_HISTORY_CHUNK_MS + 6 * 60 * 60_000).toISOString(),
    );

    expect(result.state).toBe("complete");
    expect(result.error).toBeNull();
    expect(result.samples.map(({ value, timestamp }) => ({ value, timestamp }))).toEqual([
      { value: 860, timestamp: "2026-07-14T05:00:00.000Z" },
      { value: 850, timestamp: "2026-07-14T06:00:00.000Z" },
      { value: 900, timestamp: "2026-07-15T03:00:00.000Z" },
    ]);
    expect(result.samples[0]).toMatchObject({ sensorId, metric: "co2", canonicalUnit: "ppm", source: "home-assistant", quality: "good" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetcher.mock.calls[0]!;
    const url = new URL(String(firstUrl));
    expect(url.pathname).toBe(`/base/api/history/period/${encodeURIComponent("2026-07-14T00:00:00.000Z")}`);
    expect(url.searchParams.get("end_time")).toBe("2026-07-15T00:00:00.000Z");
    expect(url.searchParams.get("filter_entity_id")).toBe("sensor.co2");
    expect(firstInit?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("end_time")).toBe("2026-07-15T06:00:00.000Z");
  });

  it("reports a missing recorder and rejects failed or malformed responses", async () => {
    const from = "2026-07-14T00:00:00Z";
    const to = "2026-07-14T06:00:00Z";
    const cases: Array<[Response, unknown]> = [
      [new Response("missing", { status: 404 }), { state: "not-supported", samples: [], error: "Home Assistant recorder history is not available" }],
      [new Response("boom", { status: 500 }), "Home Assistant history request failed with status 500"],
      [new Response(JSON.stringify({ not: "an array" })), "Home Assistant history returned an invalid response"],
    ];
    for (const [response, expected] of cases) {
      const { bridge, sensorId, bind } = bridgeFixture(vi.fn<typeof fetch>(async () => response));
      bind("sensor.co2", { metric: "co2", legacy: false });
      const recovery = bridge.recoverHistory(sensorId, "co2", from, to);
      if (typeof expected === "string") await expect(recovery).rejects.toThrow(expected);
      else await expect(recovery).resolves.toEqual(expected);
      await runtime?.close();
      runtime = null;
      if (directory) rmSync(directory, { recursive: true, force: true });
      directory = null;
    }
  });
});
