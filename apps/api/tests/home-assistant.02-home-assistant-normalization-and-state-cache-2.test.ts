import { once } from "node:events";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { WebSocketServer, type WebSocket } from "ws";

import { createApi, type ApiRuntime } from "../src/app.js";

import type { AppConfig } from "../src/config.js";

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

  it("uses one sensor with direct TP-Link as the live primary and Home Assistant as failover", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-redundant-source-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    const helperPath = join(temporaryDirectory, "fake-redundant-tp-link-helper.mjs");
    const offlineFlagPath = join(temporaryDirectory, "tp-link-offline");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "sensor-01",
      temperature: "sensor.redundant_temperature",
      humidity: "sensor.redundant_humidity",
    }] }));
    writeFileSync(helperPath, `
      import { existsSync } from "node:fs";
      const offlineFlag = ${JSON.stringify(offlineFlagPath)};
      const emit = (status) => process.stdout.write(JSON.stringify({
        type: "snapshot",
        timestamp: new Date().toISOString(),
        hubModel: "H200",
        devices: [{
          deviceId: "redundant-t315",
          model: "T315",
          alias: "Redundant sensor",
          status,
          temperature: 21,
          temperatureUnit: "celsius",
          humidity: 45,
          battery: 90
        }]
      }) + "\\n");
      emit("online");
      let offline = false;
      setInterval(() => {
        if (!offline && existsSync(offlineFlag)) {
          offline = true;
          emit("offline");
        }
      }, 10);
    `);
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
        if (message.type === "get_states") {
          const timestamp = new Date().toISOString();
          socket.send(JSON.stringify({
            id: message.id,
            type: "result",
            success: true,
            result: [
              {
                entity_id: "sensor.redundant_temperature",
                state: "21",
                last_updated: timestamp,
                attributes: { unit_of_measurement: "\u00b0C" },
              },
              {
                entity_id: "sensor.redundant_humidity",
                state: "45",
                last_updated: timestamp,
                attributes: { unit_of_measurement: "%" },
              },
            ],
          }));
        }
      });
    });
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: `http://127.0.0.1:${address.port}`, haToken: "test-token", haEntityMapFile: mappingPath,
      tpLinkHost: "192.0.2.10", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 2_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "redundant-t315",
      measurementEntityIds: {
        temperature: "sensor.redundant_temperature",
        humidity: "sensor.redundant_humidity",
      },
    });

    runtime.tpLink.start();
    await waitFor(() => runtime?.tpLink.isMetricAvailable("sensor-01", "temperature") === true);
    runtime.homeAssistant.start();
    await waitFor(() => runtime?.status.value.homeAssistant.connected === true);

    const allHistory = () => runtime!.database.measurementHistory(
      "sensor-01", "temperature", "2020-01-01T00:00:00Z", "2100-01-01T00:00:00Z", 100,
    );
    expect(allHistory().map((sample) => sample.source)).toEqual(["tp-link"]);

    writeFileSync(offlineFlagPath, "offline");
    await waitFor(() => runtime?.tpLink.isMetricAvailable("sensor-01", "temperature") === false);
    const failoverTimestamp = new Date().toISOString();
    client?.send(JSON.stringify({ type: "event", event: {
      event_type: "state_changed",
      time_fired: failoverTimestamp,
      data: {
        entity_id: "sensor.redundant_temperature",
        new_state: {
          entity_id: "sensor.redundant_temperature",
          state: "22",
          last_updated: failoverTimestamp,
          attributes: { unit_of_measurement: "\u00b0C" },
        },
      },
    } }));
    await waitFor(() => allHistory().some((sample) => sample.source === "home-assistant" && sample.value === 22));
    expect(runtime.database.listSensors().filter((sensor) => sensor.id === "sensor-01")).toHaveLength(1);
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "temperature")).toMatchObject({
      source: "home-assistant",
      value: 22,
    });
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
      value: 850, canonicalUnit: "ppm", timestamp: "2026-07-14T09:01:00.000Z",
      source: "home-assistant", quality: "estimated",
    });
    expect(runtime.database.getLatestMeasurementSample("ha-ppb", "co2")).toMatchObject({
      value: 900, canonicalUnit: "ppm", timestamp: "2026-07-14T09:02:00.000Z",
      source: "home-assistant", quality: "estimated",
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
