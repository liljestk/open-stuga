import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { loadEntityMappings, normalizeHomeAssistantTemperature, normalizeHomeAssistantTimestamp } from "../src/home-assistant.js";

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
    runtime?.close();
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
  });

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
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
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
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
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
});
