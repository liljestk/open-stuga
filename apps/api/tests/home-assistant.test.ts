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

import { waitFor } from "./home-assistantTestSupport.js";

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
    expect(wakeHouse).toHaveBeenCalledWith(house.id, null, initial.observedAt, "property-context-changed");

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
    expect(wakeHouse).toHaveBeenCalledWith(house.id, null, changed.observedAt, "property-context-changed");
  });
});
