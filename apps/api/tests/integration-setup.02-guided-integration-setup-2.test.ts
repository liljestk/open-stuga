import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import { homeAssistantInstanceFromService } from "../src/discovery.js";

import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

import { waitFor } from "./integration-setupTestSupport.js";

describe("guided integration setup", () => {
  let directory: string | null = null;

  let runtime: ApiRuntime | null = null;

  const successfulDraftTest = async () => ({ ok: true, connected: true, message: "validated" });

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("migrates legacy environment connections when they are moved and keeps them disconnected after restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-move-legacy-integrations-"));
    const secretsPath = join(directory, "integrations.json");
    const legacyEnvironment = {
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      HA_URL: "http://legacy-homeassistant.local:8123",
      HA_TOKEN: "legacy-ha-secret",
      TP_LINK_HOST: "192.168.10.20",
      TP_LINK_USERNAME: "owner@example.test",
      TP_LINK_PASSWORD: "legacy-tp-secret",
    };
    runtime = createApi({ config: loadConfig(legacyEnvironment), startBackground: false });
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-cabin",
      name: "Cabin",
      timezone: "Europe/Helsinki",
      floors: [{ id: "floor-cabin", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    runtime.status.value.tpLink.connections = [{
      id: "legacy", houseId: "house-main", configured: true, connected: true, lastPollAt: null,
      mappedDevices: 1, discoveredDevices: 1, hubModel: "H200", error: null,
    }];
    runtime.status.value.homeAssistant.connections = [{
      houseId: "house-main", configured: true, connected: true, lastEventAt: null, mappedEntities: 1, error: null,
    }];
    await request(runtime.app).post("/api/v1/sensors").send({
      id: "legacy-sensor", houseId: "house-main", floorId: "floor-ground", name: "Legacy hall", room: "Hall",
      model: "Tapo T315", x: 1, y: 1, z: 1.2, tags: [], enabled: true, tpLinkDeviceId: "legacy-child",
    }).expect(201);

    await request(runtime.app).patch("/api/v1/integrations/tp-link/config/legacy")
      .send({ houseId: "house-cabin" }).expect(200).expect(({ body }) => {
        expect(body).toMatchObject({ ok: true, fromHouseId: "house-main", houseId: "house-cabin" });
        expect(body.detachedSensorIds).toEqual(["legacy-sensor"]);
      });
    await request(runtime.app).patch("/api/v1/integrations/home-assistant/config/house-main")
      .send({ houseId: "house-cabin" }).expect(200);

    expect(runtime.database.getSensor("legacy-sensor")).not.toHaveProperty("tpLinkDeviceId");
    expect(readIntegrationSecrets(secretsPath)).toMatchObject({
      version: 1,
      homeAssistantLegacyDisabled: true,
      homeAssistantConnections: [{ houseId: "house-cabin", url: "http://legacy-homeassistant.local:8123", token: "legacy-ha-secret" }],
      tpLinkLegacyDisabled: true,
      tpLinkConnections: [{
        id: "legacy", houseId: "house-cabin", host: "192.168.10.20",
        username: "owner@example.test", password: "legacy-tp-secret",
      }],
    });

    await request(runtime.app).delete("/api/v1/integrations/tp-link/config/legacy").expect(200);
    await request(runtime.app).delete("/api/v1/integrations/home-assistant/config/house-cabin").expect(200);
    const reloaded = loadConfig(legacyEnvironment);
    expect(reloaded).toMatchObject({
      homeAssistantLegacyDisabled: true,
      homeAssistantConnections: [],
      tpLinkLegacyDisabled: true,
      tpLinkConnections: [],
    });
    expect(readIntegrationSecrets(secretsPath)).toMatchObject({
      homeAssistantLegacyDisabled: true,
      homeAssistantConnections: [],
      tpLinkLegacyDisabled: true,
      tpLinkConnections: [],
    });
  });

  it("rejects unsafe addresses without changing the secret store", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-integration-validation-"));
    const secretsPath = join(directory, "integrations.json");
    writeIntegrationSecrets(secretsPath, { version: 1 });
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath });
    runtime = createApi({ config, startBackground: false });

    await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
      .send({ url: "javascript:alert(1)", token: "secret" }).expect(400);
    await request(runtime.app).put("/api/v1/integrations/tp-link/config")
      .send({ host: "http://192.168.1.42", username: "person@example.test", password: "secret" }).expect(400);
    expect(readIntegrationSecrets(secretsPath)).toEqual({ version: 1 });
  });

  it("removes plaintext temporary secret files when atomic replacement fails", () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-secret-cleanup-"));
    const target = join(directory, "integrations.json");
    mkdirSync(target);
    expect(() => writeIntegrationSecrets(target, { version: 1, homeAssistant: { url: "http://ha.local", token: "secret" } }))
      .toThrow();
    expect(readdirSync(directory).filter((name) => name.startsWith("integrations.json."))).toEqual([]);
  });

  it("tests draft credentials without persisting or crossing the real-data boundary", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-integration-draft-"));
    const secretsPath = join(directory, "integrations.json");
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath, MOCK_ENABLED: "true",
    });
    const rejected = async () => ({ ok: false, connected: false, message: "Draft credentials were rejected." });
    runtime = createApi({
      config, startBackground: false, homeAssistantCredentialTester: rejected, tpLinkCredentialTester: rejected,
    });
    const mockCount = (runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count;

    await request(runtime.app).post("/api/v1/integrations/home-assistant/test-draft")
      .send({ url: "http://homeassistant.local:8123", token: "draft-token" }).expect(200)
      .expect(({ body }) => expect(body).toEqual({ ok: false, connected: false, message: "Draft credentials were rejected." }));
    await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
      .send({ url: "http://homeassistant.local:8123", token: "draft-token" }).expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INTEGRATION_VALIDATION_FAILED"));
    expect(readIntegrationSecrets(secretsPath)).toEqual({ version: 1 });
    expect(runtime.database.isRealDataMode()).toBe(false);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count)
      .toBe(mockCount);
  });

  it("assigns public ingestion provenance server-side and atomically switches on the first real sample", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-real-sample-"));
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: join(directory, "integrations.json"), MOCK_ENABLED: "true",
    });
    runtime = createApi({ config, startBackground: false });
    const mockCountBefore = (runtime.database.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'").get() as { count: number }).count;

    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      { sensorId: "sensor-01", metric: "co2", value: 700, canonicalUnit: "ppm", timestamp: "2026-07-14T10:00:00Z", source: "mock" },
      { sensorId: "sensor-01", metric: "co2", value: 710, canonicalUnit: "ppm", timestamp: "2026-07-14T10:01:00Z", source: "home-assistant" },
    ] }).expect(201).expect(({ body }) => {
      expect(body.samples).toEqual([
        expect.objectContaining({ value: 700, source: "api" }),
        expect.objectContaining({ value: 710, source: "api" }),
      ]);
    });
    expect(runtime.database.isRealDataMode()).toBe(true);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'").get() as { count: number }).count).toBe(0);

    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 720, canonicalUnit: "ppm", timestamp: "2026-07-14T10:02:00Z",
    }).expect(201);
    expect(runtime.database.isRealDataMode()).toBe(true);
    expect(runtime.database.measurementHistory("sensor-01", "co2", "2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ value: 720, source: "api" })]));
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBe(0);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 730, canonicalUnit: "ppm", timestamp: "2026-07-14T10:03:00Z", source: "mock",
    }).expect(201).expect(({ body }) => expect(body.samples[0]).toMatchObject({ source: "api" }));

    await request(runtime.app).post("/api/v1/readings").send({
      sensorId: "sensor-01", timestamp: "2026-07-14T10:04:00Z", temperature: 21, humidity: 42, battery: 88,
    }).expect(201);
    await request(runtime.app).post("/api/v1/replay").send({
      sensorIds: ["sensor-01"], from: "2026-07-14T10:03:30Z", to: "2026-07-14T10:04:30Z", speed: 10_000,
    }).expect(202).expect(({ body }) => expect(body.replay.count).toBe(1));
    await request(runtime.app).delete("/api/v1/replay").expect(200);
  });

  it("rolls back the real-data latch and demo purge when the first real sample cannot persist", () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-real-sample-rollback-"));
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: join(directory, "integrations.json"), MOCK_ENABLED: "true",
    });
    runtime = createApi({ config, startBackground: false });
    runtime.database.createAlertEvent({
      ruleId: "rule-high-humidity", sensorId: "sensor-09", metric: "humidity", value: 75, threshold: 65,
      severity: "warning", startedAt: "2026-07-14T10:00:00.000Z",
    });
    const mockReadings = (runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'",
    ).get() as { count: number }).count;
    const mockSamples = (runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'",
    ).get() as { count: number }).count;
    runtime.database.db.exec(`CREATE TRIGGER reject_first_real_sample
      BEFORE INSERT ON measurement_samples WHEN NEW.source = 'api'
      BEGIN SELECT RAISE(ABORT, 'forced real sample failure'); END`);

    expect(() => runtime!.measurements.ingest({
      sensorId: "sensor-01",
      metric: "co2",
      value: 700,
      canonicalUnit: "ppm",
      timestamp: new Date().toISOString(),
      source: "api",
      quality: "good",
    })).toThrow(/forced real sample failure/);
    expect(runtime.database.isRealDataMode()).toBe(false);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count)
      .toBe(mockReadings);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'").get() as { count: number }).count)
      .toBe(mockSamples);
    expect(runtime.database.listAlertEvents()).toHaveLength(1);
  });

  it("observes another process's activation, stops mock writes, and never repeats the destructive purge", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-cross-process-latch-"));
    const databasePath = join(directory, "climate.sqlite");
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: databasePath, INTEGRATION_SECRETS_FILE: join(directory, "integrations.json"),
      MOCK_ENABLED: "true", MOCK_INTERVAL_MS: "10",
    });
    runtime = createApi({ config, startBackground: true });
    const secondProcess = new ClimateDatabase(databasePath, false);

    try {
      const activation = secondProcess.activateRealDataMode();
      expect(activation.activated).toBe(true);
      secondProcess.createAlertEvent({
        ruleId: "rule-high-humidity", sensorId: "sensor-09", metric: "humidity", value: 75, threshold: 65,
        severity: "warning", startedAt: "2026-07-14T10:00:00.000Z",
      });
      secondProcess.db.prepare(`INSERT INTO alert_evaluation_state
        (rule_id, sensor_id, latest_timestamp, condition_since) VALUES (?, ?, ?, ?)`)
        .run("rule-high-humidity", "sensor-09", "2026-07-14T10:05:00.000Z", "2026-07-14T10:00:00.000Z");

      const repeated = runtime.database.activateRealDataMode();
      expect(repeated).toMatchObject({ activated: false, activatedAt: activation.activatedAt });
      expect(runtime.database.listAlertEvents()).toHaveLength(1);
      expect(runtime.database.db.prepare(`SELECT latest_timestamp FROM alert_evaluation_state
        WHERE rule_id = 'rule-high-humidity' AND sensor_id = 'sensor-09'`).get())
        .toEqual({ latest_timestamp: "2026-07-14T10:05:00.000Z" });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await request(runtime.app).get("/api/v1/integrations/status").expect(200)
        .expect(({ body }) => expect(body.mock).toMatchObject({ enabled: false, mode: "real", activatedAt: activation.activatedAt }));
      expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBe(0);
      expect(runtime.database.listAlertEvents()).toHaveLength(1);
    } finally {
      secondProcess.close();
    }
  });

  it("persists the real-data latch even after integration credentials are removed", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-real-latch-"));
    const databasePath = join(directory, "climate.sqlite");
    const secretsPath = join(directory, "integrations.json");
    const environment = {
      NODE_ENV: "test", DATABASE_PATH: databasePath, INTEGRATION_SECRETS_FILE: secretsPath, MOCK_ENABLED: "true",
    };
    runtime = createApi({
      config: loadConfig(environment), startBackground: false, tpLinkCredentialTester: successfulDraftTest,
    });
    await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      host: "192.168.1.42", username: "person@example.test", password: "tp-link-secret",
    }).expect(200);
    const activatedAt = runtime.status.value.mock.activatedAt;
    await runtime.close();
    runtime = null;

    writeIntegrationSecrets(secretsPath, { version: 1 });
    runtime = createApi({ config: loadConfig(environment), startBackground: false });
    expect(runtime.status.value.tpLink.configured).toBe(false);
    expect(runtime.status.value.mock).toEqual({ enabled: false, intervalMs: 2_000, mode: "real", activatedAt });
    expect(() => runtime!.database.db.prepare(`INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-01', '2026-07-14T12:00:00.000Z', 20, 40, 90, 'mock', 'good')`).run()).toThrow(/DEMO_DATA_DISABLED/);
    expect(() => runtime!.database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-01', 'humidity', 40, '%', '2026-07-14T12:00:00.000Z', 'mock', 'good')`).run()).toThrow(/DEMO_DATA_DISABLED/);
    expect(() => runtime!.database.db.prepare(`INSERT INTO outdoor_temperature_samples
      (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
      VALUES ('house-main', 'unlocated', '2026-07-14T12:00:00.000Z', 10, 'mock', '2026-07-14T12:00:00.000Z', NULL, NULL)`).run()).toThrow(/DEMO_DATA_DISABLED/);
    await request(runtime.app).post("/api/v1/mock/tick").expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("DEMO_DATA_DISABLED"));
    await request(runtime.app).put("/api/v1/mock/scenario").send({ scenario: "shower" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("DEMO_DATA_DISABLED"));
    await request(runtime.app).post("/api/v1/mock/scenario").send({ scenarioId: "shower" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("DEMO_DATA_DISABLED"));
  });
});
