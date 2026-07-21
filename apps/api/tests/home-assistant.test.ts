import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WebSocketServer, type WebSocket } from "ws";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  loadEntityMappings,
  normalizeHomeAssistantElectricityMeasurement,
  normalizeHomeAssistantTemperature,
  normalizeHomeAssistantTimestamp,
  testHomeAssistantCredentials,
} from "../src/home-assistant.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for Home Assistant bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Home Assistant normalization and state cache", () => {
  let runtime: ApiRuntime | null = null;
  let server: WebSocketServer | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await runtime?.close();
    runtime = null;
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("normalizes Fahrenheit, Kelvin, Celsius, and offset timestamps", () => {
    expect(normalizeHomeAssistantTemperature(77, "°F")).toBeCloseTo(25);
    expect(normalizeHomeAssistantTemperature(300.15, "K")).toBeCloseTo(27);
    expect(normalizeHomeAssistantTemperature(21.5, "°C")).toBe(21.5);
    expect(normalizeHomeAssistantTemperature(10, "bananas")).toBeNull();
    expect(normalizeHomeAssistantTimestamp("2026-07-14T12:00:00+03:00")).toBe("2026-07-14T09:00:00.000Z");
  });

  it("normalizes safe electricity unit variants to built-in canonical units", () => {
    expect(normalizeHomeAssistantElectricityMeasurement("power", 1.5, "kW")).toBe(1_500);
    expect(normalizeHomeAssistantElectricityMeasurement("power", 250, "W")).toBe(250);
    expect(normalizeHomeAssistantElectricityMeasurement("energy", 750, "Wh")).toBe(0.75);
    expect(normalizeHomeAssistantElectricityMeasurement("energy", 1.25, "MWh")).toBe(1_250);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 0.09, "EUR/kWh")).toBe(0.09);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 9, "c/kWh")).toBe(0.09);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 8.5, "ct/kWh")).toBe(0.085);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 7.5, "snt/kWh")).toBe(0.075);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 6, "cent/kWh")).toBe(0.06);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 50, "€/MWh")).toBe(0.05);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 45, "EUR/MWh")).toBe(0.045);
    expect(normalizeHomeAssistantElectricityMeasurement("electricity_price", 0.12, "€/kWh")).toBe(0.12);
    expect(normalizeHomeAssistantElectricityMeasurement("power", 1, "VA")).toBeNull();
  });

  it("rejects empty and duplicate generic entity bindings", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-map-validation-"));
    const emptyString = join(temporaryDirectory, "empty-string.json");
    writeFileSync(emptyString, JSON.stringify({ entities: [{ sensorId: "sensor-01", measurements: { co2: "" } }] }));
    expect(() => loadEntityMappings(emptyString)).toThrow(/Invalid co2 measurement mapping/);

    const emptyObject = join(temporaryDirectory, "empty-object.json");
    writeFileSync(emptyObject, JSON.stringify({ entities: [{ sensorId: "sensor-01", measurements: { co2: { entityId: "" } } }] }));
    expect(() => loadEntityMappings(emptyObject)).toThrow(/Invalid co2 measurement mapping/);

    const noEntities = join(temporaryDirectory, "no-entities.json");
    writeFileSync(noEntities, JSON.stringify({ entities: [{ sensorId: "sensor-01", measurements: {} }] }));
    expect(() => loadEntityMappings(noEntities)).toThrow(/has no entities/);

    const duplicate = join(temporaryDirectory, "duplicate.json");
    writeFileSync(duplicate, JSON.stringify({ entities: [
      { sensorId: "sensor-01", measurements: { co2: "sensor.same_co2" } },
      { sensorId: "sensor-01", measurements: { co2: { entityId: "sensor.same_co2", unit: "ppb", scale: 0.001 } } },
    ] }));
    expect(() => loadEntityMappings(duplicate)).toThrow(/mapped more than once/);

    const duplicateMetric = join(temporaryDirectory, "duplicate-metric.json");
    writeFileSync(duplicateMetric, JSON.stringify({ entities: [
      { sensorId: "sensor-01", measurements: { co2: "sensor.first_co2" } },
      { sensorId: "sensor-01", measurements: { co2: "sensor.second_co2" } },
    ] }));
    expect(() => loadEntityMappings(duplicateMetric)).toThrow(/sensor sensor-01 metric co2 is mapped more than once/);
  });

  it("bootstraps a canonical map without credentials and ignores semantic reordering", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-map-bootstrap-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [
      { sensorId: "sensor-02", measurements: {
        power: "sensor.second_power",
        co2: { entityId: "sensor.second_co2", unit: "ppb", scale: 0.001, offset: 0 },
      } },
      { sensorId: "sensor-01", temperature: "sensor.first_temperature" },
    ] }));
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.db.exec(`CREATE TRIGGER fail_ha_mapping_persistence
      BEFORE INSERT ON integration_mapping_sets WHEN NEW.kind = 'home-assistant'
      BEGIN SELECT RAISE(ABORT, 'forced mapping persistence failure'); END`);
    expect(() => runtime?.homeAssistant.start()).toThrow(/forced mapping persistence failure/);
    expect(runtime.database.getIntegrationMappingSet("home-assistant")).toBeNull();
    runtime.database.db.exec("DROP TRIGGER fail_ha_mapping_persistence");
    runtime.homeAssistant.start();
    const imported = runtime.database.getIntegrationMappingSet("home-assistant");
    expect(imported).toMatchObject({ revision: 1, mappings: [
      { sensorId: "sensor-02", measurements: {
        co2: { entityId: "sensor.second_co2", offset: 0, scale: 0.001, unit: "ppb" },
        power: "sensor.second_power",
      } },
      { sensorId: "sensor-01", temperature: "sensor.first_temperature" },
    ] });
    expect(runtime.status.value.homeAssistant.configured).toBe(false);

    runtime.homeAssistant.stop();
    writeFileSync(mappingPath, JSON.stringify({ entities: [
      { sensorId: "sensor-01", temperature: "sensor.first_temperature" },
      { sensorId: "sensor-02", measurements: {
        co2: { offset: 0, scale: 0.001, unit: "ppb", entityId: "sensor.second_co2" },
        power: "sensor.second_power",
      } },
    ] }));
    runtime.homeAssistant.start();
    expect(runtime.database.getIntegrationMappingSet("home-assistant")).toEqual(imported);
  });

  it("imports an advanced legacy map into SQLite and uses it after the file is removed", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-map-durable-"));
    const databasePath = join(temporaryDirectory, "climate.sqlite");
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: " sensor-01 ",
      measurements: {
        co2: { entityId: " sensor.persisted_co2 ", unit: " ppb ", scale: 0.001, offset: 0.5 },
      },
      sourcePath: mappingPath,
      token: "must-not-be-persisted",
    }] }));

    let rawCo2 = 900_000;
    let stateTimestamp = "2026-07-14T09:01:00Z";
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result: [{
            entity_id: "sensor.persisted_co2",
            state: String(rawCo2),
            last_updated: stateTimestamp,
            attributes: { unit_of_measurement: "ppb" },
          }],
        }));
      });
    });

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath,
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };

    runtime = createApi({ config, startBackground: false });
    runtime.homeAssistant.start();
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "co2")?.value === 900.5);
    const firstImport = runtime.database.getIntegrationMappingSet("home-assistant");
    expect(firstImport).toMatchObject({
      kind: "home-assistant",
      revision: 1,
      mappings: [{
        sensorId: "sensor-01",
        measurements: { co2: { entityId: "sensor.persisted_co2", unit: "ppb", scale: 0.001, offset: 0.5 } },
      }],
    });
    expect(firstImport?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(firstImport?.mappings)).not.toContain(mappingPath);
    expect(JSON.stringify(firstImport?.mappings)).not.toContain("must-not-be-persisted");

    runtime.database.db.prepare(`UPDATE integration_mapping_sets
      SET content_hash = ? WHERE kind = 'home-assistant'`).run("0".repeat(64));
    expect(() => runtime?.database.getIntegrationMappingSet("home-assistant")).toThrow(/hash does not match/);

    runtime.database.db.exec("PRAGMA ignore_check_constraints = ON");
    runtime.database.db.prepare(`UPDATE integration_mapping_sets
      SET mappings_json = 'not-json', content_hash = ? WHERE kind = 'home-assistant'`)
      .run("0".repeat(64));
    runtime.database.db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => runtime?.database.getIntegrationMappingSet("home-assistant")).toThrow(/invalid JSON/);

    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "sensor-01",
      measurements: {
        co2: { entityId: "sensor.persisted_co2", unit: "ppb", scale: 0.001, offset: 1 },
      },
    }] }));
    rawCo2 = 925_000;
    stateTimestamp = "2026-07-14T09:01:30Z";
    runtime.homeAssistant.restart();
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "co2")?.value === 926);
    const imported = runtime.database.getIntegrationMappingSet("home-assistant");
    expect(imported).toMatchObject({
      revision: 2,
      createdAt: firstImport?.createdAt,
      mappings: [{
        sensorId: "sensor-01",
        measurements: { co2: { entityId: "sensor.persisted_co2", unit: "ppb", scale: 0.001, offset: 1 } },
      }],
    });
    expect(imported?.contentHash).not.toBe(firstImport?.contentHash);

    await runtime.close();
    runtime = null;
    rmSync(mappingPath);
    rawCo2 = 950_000;
    stateTimestamp = "2026-07-14T09:02:00Z";

    runtime = createApi({ config, startBackground: false });
    runtime.homeAssistant.start();
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "co2")?.value === 951);
    expect(runtime.status.value.homeAssistant).toMatchObject({ connected: true, mappedEntities: 1, error: null });
    expect(runtime.database.getIntegrationMappingSet("home-assistant")).toEqual(imported);
  });

  it("validates both the HA subscription and initial state request before accepting credentials", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    const requests: string[] = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        requests.push(message.type ?? "unknown");
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: [] }));
        }
      });
    });

    await expect(testHomeAssistantCredentials(`http://127.0.0.1:${address.port}`, "test-token", 1_000))
      .resolves.toMatchObject({ ok: true, connected: true });
    expect(requests).toEqual(["auth", "subscribe_events", "get_states"]);
  });

  it("rejects HA credentials when get_states fails after a successful subscription", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: false, result: null }));
        }
      });
    });

    await expect(testHomeAssistantCredentials(`http://127.0.0.1:${address.port}`, "test-token", 1_000))
      .resolves.toEqual({ ok: false, connected: false, message: "Home Assistant initial state request failed." });
  });

  it("safely tears down a draft socket that times out before opening", async () => {
    const stalledServer = createServer(() => undefined);
    let stalledSocket: Socket | null = null;
    stalledServer.listen(0, "127.0.0.1");
    await once(stalledServer, "listening");
    const address = stalledServer.address();
    if (!address || typeof address === "string") throw new Error("Stalled HA server did not bind");
    try {
      const validation = testHomeAssistantCredentials(`http://127.0.0.1:${address.port}`, "test-token", 500);
      [stalledSocket] = await once(stalledServer, "connection") as [Socket];
      // The validator deliberately resets a TCP peer that never completes its
      // WebSocket upgrade; consume that expected peer-side ECONNRESET.
      stalledSocket.on("error", () => undefined);
      await expect(validation)
        .resolves.toEqual({
          ok: false,
          connected: false,
          message: "Home Assistant did not complete WebSocket validation in time.",
        });
      await waitFor(() => stalledSocket?.destroyed === true, 1_000);
    } finally {
      stalledSocket?.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
    }
  }, 3_000);

  it("loads initial HA states for a sensor with no history and does not ingest battery-only changes", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "ha-new", temperature: "sensor.new_temperature", humidity: "sensor.new_humidity", battery: "sensor.new_battery",
    }] }));

    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    let client: WebSocket | null = null;
    const receivedTypes: string[] = [];
    server.on("connection", (socket) => {
      client = socket;
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type) receivedTypes.push(message.type);
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id, type: "result", success: true, result: [
            { entity_id: "sensor.new_temperature", state: "77", last_updated: "2026-07-14T12:00:00+03:00", attributes: { unit_of_measurement: "°F" } },
            { entity_id: "sensor.new_humidity", state: "48", last_updated: "2026-07-14T12:00:00+03:00", attributes: { unit_of_measurement: "%" } },
            { entity_id: "sensor.new_battery", state: "90", last_updated: "2026-07-14T12:00:00+03:00", attributes: { unit_of_measurement: "%" } },
          ],
        }));
        if (message.type === "subscribe_events") socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
      });
    });

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.createSensor({
      id: "ha-new", houseId: "house-main", floorId: "floor-ground", name: "New HA sensor", room: "Utility",
      model: "test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    runtime.homeAssistant.start();

    await waitFor(() => runtime?.database.getLatestReading("ha-new") !== null);
    const initial = runtime.database.getLatestReading("ha-new");
    expect(initial).toMatchObject({ temperature: 25, humidity: 48, battery: 90, source: "home-assistant" });
    expect(initial?.timestamp).toBe("2026-07-14T09:00:00.000Z");
    expect(receivedTypes).toEqual(expect.arrayContaining(["auth", "get_states", "subscribe_events"]));
    expect(receivedTypes.indexOf("subscribe_events")).toBeLessThan(receivedTypes.indexOf("get_states"));

    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed", time_fired: "2026-07-14T12:01:00+03:00", data: {
        entity_id: "sensor.new_battery",
        new_state: { entity_id: "sensor.new_battery", state: "75", last_updated: "2026-07-14T12:01:00+03:00", attributes: { unit_of_measurement: "%" } },
      },
    } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.database.history(["ha-new"], "2020-01-01T00:00:00Z", "2100-01-01T00:00:00Z", 100)).toHaveLength(1);

    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed", time_fired: "2026-07-14T12:02:00+03:00", data: {
        entity_id: "sensor.new_temperature",
        new_state: { entity_id: "sensor.new_temperature", state: "300.15", last_updated: "2026-07-14T12:02:00+03:00", attributes: { unit_of_measurement: "K" } },
      },
    } }));
    await waitFor(() => runtime?.database.history(["ha-new"], "2020-01-01T00:00:00Z", "2100-01-01T00:00:00Z", 100).length === 2);
    expect(runtime.database.getLatestReading("ha-new")).toMatchObject({ temperature: 27, humidity: 48, battery: 75 });
    expect(runtime.database.getLatestReading("ha-new")?.timestamp).toBe("2026-07-14T09:02:00.000Z");

    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed", time_fired: "2026-07-14T12:10:00+03:00", data: {
        entity_id: "sensor.new_temperature",
        new_state: { entity_id: "sensor.new_temperature", state: "301.15", last_updated: "2026-07-14T12:10:00+03:00", attributes: { unit_of_measurement: "K" } },
      },
    } }));
    await waitFor(() => runtime?.database.getLatestMeasurementSample("ha-new", "temperature")?.value === 28);
    expect(runtime.database.history(["ha-new"], "2020-01-01T00:00:00Z", "2100-01-01T00:00:00Z", 100)).toHaveLength(2);
  });

  it("ingests bound opening contacts and treats a fresh snapshot as current observation", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-contact-"));
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    let client: WebSocket | null = null;
    server.on("connection", (socket) => {
      client = socket;
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id, type: "result", success: true, result: [{
            entity_id: "binary_sensor.entry", state: "on", last_updated: "2020-01-01T00:00:00Z", attributes: {},
          }],
        }));
      });
    });
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      spatialLayersEnabled: true, spatialLayersDatabasePath: join(temporaryDirectory, "spatial.sqlite"),
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    const wakeHouse = vi.spyOn(runtime.spatialLayers!.scheduler, "wakeHouse");
    const house = runtime.database.getHouse("house-main")!;
    const floors = structuredClone(house.floors);
    floors[0]!.planElements = [...(floors[0]!.planElements ?? []), {
      id: "entry-vent", kind: "vent", position: { x: floors[0]!.width / 2, y: floors[0]!.height / 2 }, rotationDegrees: 0,
      state: "closed", stateBinding: { provider: "home-assistant", externalId: "binary_sensor.entry" },
    }];
    runtime.database.updateHouse(house.id, { floors });
    const startedAt = Date.now();
    runtime.homeAssistant.start();

    await waitFor(() => runtime!.database.listOpeningStateObservations(house.id).length === 1);
    const initial = runtime.database.listOpeningStateObservations(house.id)[0]!;
    expect(initial).toMatchObject({ elementId: "entry-vent", state: "open", source: "home-assistant",
      externalId: "binary_sensor.entry", connectionId: "house-main" });
    expect(Date.parse(initial.observedAt)).toBeGreaterThanOrEqual(startedAt);
    expect(runtime.status.value.homeAssistant.mappedEntities).toBe(1);
    expect(wakeHouse).toHaveBeenCalledWith(house.id, house.propertyId, initial.observedAt, "property-context-changed");

    wakeHouse.mockClear();
    const changedAt = new Date().toISOString();
    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed", time_fired: changedAt, data: { entity_id: "binary_sensor.entry", new_state: {
        entity_id: "binary_sensor.entry", state: "off", last_updated: changedAt, attributes: {},
      } },
    } }));
    await waitFor(() => runtime!.database.listOpeningStateObservations(house.id).length === 2);
    const changed = runtime.database.listOpeningStateObservations(house.id)[0]!;
    expect(changed).toMatchObject({ state: "closed", source: "home-assistant" });
    expect(wakeHouse).toHaveBeenCalledWith(house.id, house.propertyId, changed.observedAt, "property-context-changed");
  });

  it("does not report connected or request a snapshot when the subscription is rejected", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-rejected-"));
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    const requests: string[] = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        requests.push(message.type ?? "unknown");
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: false, result: null }));
        }
      });
    });
    runtime = createApi({
      config: {
        port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
        mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
        haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: null,
        tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
        tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
        alertWebhookUrl: null, alertWebhookBearerToken: null, telegramBotToken: null, telegramChatId: null,
        appleNotesGrants: [], corsOrigin: null,
      },
      startBackground: false,
    });
    runtime.homeAssistant.start();
    await waitFor(() => runtime?.status.value.homeAssistant.error?.includes("rejected") === true);
    expect(runtime.status.value.homeAssistant.connected).toBe(false);
    expect(requests).not.toContain("get_states");
  });

  it("keeps the bridge disconnected and aborts when the initial state snapshot times out", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    let snapshotRequested!: () => void;
    const snapshotRequest = new Promise<void>((resolve) => { snapshotRequested = resolve; });
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") snapshotRequested();
      });
    });
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: "unused.json", assetDirectory: ".",
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    vi.useFakeTimers();
    runtime.homeAssistant.start();
    await snapshotRequest;
    expect(runtime.status.value.homeAssistant.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.status.value.homeAssistant).toMatchObject({
      connected: false,
      error: "Home Assistant initial state request timed out",
    });
  });

  it("aborts a pending snapshot instead of growing its event replay buffer without bound", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-buffer-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "ha-buffer", temperature: "sensor.buffer_temperature",
    }] }));
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") {
          for (let index = 0; index <= 1_000; index += 1) {
            socket.send(JSON.stringify({ type: "event", event: {
              event_type: "state_changed",
              time_fired: new Date(1_700_000_000_000 + index).toISOString(),
              data: { entity_id: "sensor.buffer_temperature", new_state: {
                entity_id: "sensor.buffer_temperature", state: String(20 + index / 1_000),
                last_updated: new Date(1_700_000_000_000 + index).toISOString(),
                attributes: { unit_of_measurement: "°C" },
              } },
            } }));
          }
        }
      });
    });
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.createSensor({
      id: "ha-buffer", houseId: "house-main", floorId: "floor-ground", name: "Buffer sensor", room: "Utility",
      model: "test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    runtime.homeAssistant.start();

    await waitFor(() => runtime?.status.value.homeAssistant.error?.includes("buffer limit") === true);
    expect(runtime.status.value.homeAssistant.connected).toBe(false);
    expect(runtime.database.getLatestReading("ha-buffer")).toBeNull();
  });

  it("ingests generic HA metrics independently with exact or explicitly converted units", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-generic-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [
      { sensorId: "ha-ppm", measurements: { co2: "sensor.room_co2_ppm" } },
      { sensorId: "ha-ppb", measurements: { co2: { entityId: "sensor.room_co2_ppb", unit: "ppb", scale: 0.001 } } },
    ] }));

    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    let client: WebSocket | null = null;
    server.on("connection", (socket) => {
      client = socket;
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id, type: "result", success: true, result: [
            { entity_id: "sensor.room_co2_ppm", state: "850", last_updated: "2026-07-14T09:01:00Z", attributes: { unit_of_measurement: "ppm" } },
            { entity_id: "sensor.room_co2_ppb", state: "900000", last_updated: "2026-07-14T09:02:00Z", attributes: { unit_of_measurement: "ppb" } },
          ],
        }));
        if (message.type === "subscribe_events") socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
      });
    });

    const genericConfig: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config: genericConfig, startBackground: false });
    for (const id of ["ha-ppm", "ha-ppb"]) runtime.database.createSensor({
      id, houseId: "house-main", floorId: "floor-ground", name: id, room: "Utility",
      model: "test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    runtime.homeAssistant.start();

    await waitFor(() => runtime?.database.getLatestMeasurementSample("ha-ppm", "co2") !== null
      && runtime?.database.getLatestMeasurementSample("ha-ppb", "co2") !== null);
    expect(runtime.database.getLatestMeasurementSample("ha-ppm", "co2")).toMatchObject({
      value: 850, canonicalUnit: "ppm", timestamp: "2026-07-14T09:01:00.000Z", source: "home-assistant",
    });
    expect(runtime.database.getLatestMeasurementSample("ha-ppb", "co2")).toMatchObject({
      value: 900, canonicalUnit: "ppm", timestamp: "2026-07-14T09:02:00.000Z", source: "home-assistant",
    });
    expect(runtime.database.getLatestReading("ha-ppm")).toBeNull();

    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed", data: { entity_id: "sensor.room_co2_ppm", new_state: {
        entity_id: "sensor.room_co2_ppm", state: "1000", last_updated: "2026-07-14T09:03:00Z",
        attributes: { unit_of_measurement: "mg/m³" },
      } },
    } }));
    await waitFor(() => runtime?.status.value.homeAssistant.error?.includes("must be ppm") === true);
    expect(runtime.database.measurementHistory("ha-ppm", "co2", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toHaveLength(1);
  });

  it("merges persisted mappings behind file overrides and refreshes them after sensor CRUD", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-ha-persisted-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "ha-electric",
      measurements: { power: "sensor.file_power" },
    }] }));

    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    const states = [
      { entity_id: "sensor.file_power", state: "1.5", last_updated: "2026-07-14T09:01:00Z", attributes: { unit_of_measurement: "kW" } },
      { entity_id: "sensor.db_power_ignored", state: "999", last_updated: "2026-07-14T09:01:00Z", attributes: { unit_of_measurement: "W" } },
      { entity_id: "sensor.db_energy", state: "1.25", last_updated: "2026-07-14T09:02:00Z", attributes: { unit_of_measurement: "MWh" } },
      { entity_id: "sensor.db_price", state: "8.5", last_updated: "2026-07-14T09:03:00Z", attributes: { unit_of_measurement: "ct/kWh" } },
      { entity_id: "sensor.dynamic_energy", state: "2", last_updated: "2026-07-14T09:04:00Z", attributes: { unit_of_measurement: "kWh" } },
      { entity_id: "sensor.dynamic_power", state: "2", last_updated: "2026-07-14T09:05:00Z", attributes: { unit_of_measurement: "kW" } },
    ];
    let connectionCount = 0;
    server.on("connection", (socket) => {
      connectionCount += 1;
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id, type: "result", success: true, result: states,
        }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
      });
    });

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.createSensor({
      id: "ha-electric", houseId: "house-main", floorId: "floor-ground", name: "Electricity", room: "Utility",
      model: "Home Assistant", x: 1, y: 1, z: 1, tags: [], enabled: true,
      measurementEntityIds: {
        power: "sensor.db_power_ignored",
        energy: "sensor.db_energy",
        electricity_price: "sensor.db_price",
      },
    });
    runtime.database.createSensor({
      id: "ha-file-entity-collision", houseId: "house-main", floorId: "floor-ground", name: "File collision", room: "Utility",
      model: "Home Assistant", x: 2, y: 2, z: 1, tags: [], enabled: true,
      measurementEntityIds: { energy: "sensor.file_power" },
    });
    runtime.homeAssistant.start();

    await waitFor(() => runtime?.database.getLatestMeasurementSample("ha-electric", "electricity_price") !== null);
    expect(connectionCount).toBe(1);
    expect(runtime.status.value.homeAssistant.mappedEntities).toBe(3);
    expect(runtime.database.getLatestMeasurementSample("ha-electric", "power")).toMatchObject({ value: 1_500, canonicalUnit: "W" });
    expect(runtime.database.getLatestMeasurementSample("ha-electric", "energy")).toMatchObject({ value: 1_250, canonicalUnit: "kWh" });
    expect(runtime.database.getLatestMeasurementSample("ha-electric", "electricity_price")).toMatchObject({ value: 0.085, canonicalUnit: "€/kWh" });
    expect(runtime.database.measurementHistory("ha-electric", "power", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toHaveLength(1);
    expect(runtime.database.getLatestMeasurementSample("ha-file-entity-collision", "energy")).toBeNull();

    const sensorInput = (id: string, bindings: Record<string, unknown>) => ({
      id,
      houseId: "house-main",
      floorId: "floor-ground",
      name: id,
      room: "Utility",
      model: "Home Assistant",
      x: 2,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
      ...bindings,
    });
    const expectBindingConflict = async (id: string, bindings: Record<string, unknown>) => {
      await request(runtime!.app).post("/api/v1/sensors")
        .send(sensorInput(id, bindings))
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe("HOME_ASSISTANT_ENTITY_ALREADY_MAPPED"));
      expect(runtime!.database.getSensor(id)).toBeNull();
    };

    await expectBindingConflict("ha-duplicate-generic", {
      measurementEntityIds: { power: "sensor.same_entity", energy: "sensor.same_entity" },
    });
    await expectBindingConflict("ha-duplicate-legacy-within", {
      temperatureEntityId: "sensor.same_legacy_entity",
      batteryEntityId: "sensor.same_legacy_entity",
    });
    await expectBindingConflict("ha-duplicate-temperature", { temperatureEntityId: "sensor.db_energy" });
    await expectBindingConflict("ha-duplicate-humidity", { humidityEntityId: "sensor.db_energy" });
    await expectBindingConflict("ha-duplicate-battery", { batteryEntityId: "sensor.db_energy" });
    expect(runtime.status.value.homeAssistant).toMatchObject({ connected: true, mappedEntities: 3, error: null });

    await request(runtime.app).patch("/api/v1/sensors/ha-electric")
      .send({ name: "Electricity meter", x: 1.5 }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connectionCount).toBe(1);
    expect(runtime.status.value.homeAssistant).toMatchObject({ connected: true, mappedEntities: 3, error: null });

    await request(runtime.app).post("/api/v1/sensors").send({
      id: "ha-dynamic", houseId: "house-main", floorId: "floor-ground", name: "Dynamic", room: "Utility",
      model: "Home Assistant", x: 2, y: 1, z: 1, tags: [], enabled: true,
      measurementEntityIds: { energy: "sensor.dynamic_energy" },
    }).expect(201);
    await waitFor(() => runtime?.database.getLatestMeasurementSample("ha-dynamic", "energy")?.value === 2);
    expect(connectionCount).toBe(2);
    expect(runtime.status.value.homeAssistant.mappedEntities).toBe(4);

    await request(runtime.app).patch("/api/v1/sensors/ha-dynamic")
      .send({ measurementEntityIds: { power: "sensor.db_energy" } })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("HOME_ASSISTANT_ENTITY_ALREADY_MAPPED"));
    expect(runtime.database.getSensor("ha-dynamic")?.measurementEntityIds).toEqual({ energy: "sensor.dynamic_energy" });
    expect(runtime.status.value.homeAssistant).toMatchObject({ connected: true, mappedEntities: 4, error: null });

    await request(runtime.app).patch("/api/v1/sensors/ha-dynamic")
      .send({ measurementEntityIds: { power: "sensor.dynamic_power" } }).expect(200);
    await waitFor(() => runtime?.database.getLatestMeasurementSample("ha-dynamic", "power")?.value === 2_000);
    expect(runtime.status.value.homeAssistant.mappedEntities).toBe(4);

    await request(runtime.app).post("/api/v1/houses").send({
      id: "ha-temporary-house",
      name: "Temporary mapped house",
      timezone: "UTC",
      floors: [{
        id: "temporary-floor", name: "Temporary floor", width: 5, height: 5, elevation: 0,
        walls: [], rooms: [],
      }],
    }).expect(201);
    await request(runtime.app).post("/api/v1/sensors").send({
      id: "ha-cascade-mapped",
      houseId: "ha-temporary-house",
      floorId: "temporary-floor",
      name: "Cascade mapped",
      room: "Temporary",
      model: "Home Assistant",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
      measurementEntityIds: { power: "sensor.cascade_power" },
    }).expect(201);
    await waitFor(() => runtime?.status.value.homeAssistant.mappedEntities === 5);

    await request(runtime.app).delete("/api/v1/houses/ha-temporary-house").expect(204);
    await waitFor(() => runtime?.status.value.homeAssistant.mappedEntities === 4);
    expect(runtime.database.getSensor("ha-cascade-mapped")).toBeNull();

    await request(runtime.app).delete("/api/v1/sensors/ha-dynamic")
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("TELEMETRY_LINEAGE_REQUIRED"));
    expect(runtime.database.getSensor("ha-dynamic")).not.toBeNull();
    expect(runtime.status.value.homeAssistant.mappedEntities).toBe(4);
  });
});
