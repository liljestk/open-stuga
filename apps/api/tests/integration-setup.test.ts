import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { homeAssistantInstanceFromService } from "../src/discovery.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

describe("guided integration setup", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("turns a Home Assistant mDNS service into a safe local setup choice", () => {
    expect(homeAssistantInstanceFromService({
      name: "homeassistant",
      host: "homeassistant.local",
      port: 8123,
      addresses: ["127.0.0.1", "192.168.1.20"],
      txt: { location_name: Buffer.from("Our home"), internal_url: "http://homeassistant.local:8123/", version: "2026.7.1" },
    })).toEqual({
      name: "Our home",
      url: "http://homeassistant.local:8123",
      host: "192.168.1.20",
      port: 8123,
      version: "2026.7.1",
    });
  });

  it("stores write-only credentials outside SQLite and reloads them with environment overrides", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-integration-setup-"));
    const secretsPath = join(directory, "private", "integrations.json");
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath, MOCK_ENABLED: "true" });
    runtime = createApi({ config, startBackground: false });

    expect(runtime.status.value.mock).toMatchObject({ enabled: true, mode: "demo", activatedAt: null });
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBeGreaterThan(0);
    runtime.database.createAlertEvent({
      ruleId: "rule-high-humidity", sensorId: "sensor-09", metric: "humidity", value: 75, threshold: 65,
      severity: "warning", startedAt: "2026-07-14T10:00:00.000Z",
    });
    const replay = runtime.replay.start(["sensor-01"], new Date(Date.now() - 3_600_000).toISOString(), new Date().toISOString(), 10_000);
    expect(replay.count).toBeGreaterThan(0);

    const homeAssistant = await request(runtime.app).put("/api/v1/integrations/home-assistant/config").send({
      url: "http://homeassistant.local:8123/",
      token: "ha-secret-token",
    }).expect(200);
    const tpLink = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      host: "192.168.1.42",
      username: "person@example.test",
      password: "tp-link-secret",
    }).expect(200);

    expect(homeAssistant.body).toMatchObject({ ok: true, configured: true, integration: { mock: { enabled: false, mode: "real" } } });
    expect(tpLink.body).toMatchObject({ ok: true, configured: true, integration: { mock: { enabled: false, mode: "real" } } });
    expect(JSON.stringify([homeAssistant.body, tpLink.body])).not.toContain("secret");
    expect(readIntegrationSecrets(secretsPath)).toEqual({
      version: 1,
      homeAssistant: { url: "http://homeassistant.local:8123", token: "ha-secret-token" },
      tpLink: { host: "192.168.1.42", username: "person@example.test", password: "tp-link-secret" },
    });
    expect(runtime.status.value.homeAssistant.configured).toBe(true);
    expect(runtime.status.value.tpLink.configured).toBe(true);
    expect(runtime.status.value.mock).toMatchObject({ enabled: false, mode: "real" });
    expect(runtime.status.value.mock.activatedAt).not.toBeNull();
    expect(runtime.replay.state.count).toBe(0);
    expect(runtime.database.listAlertEvents()).toHaveLength(0);
    for (const [table, predicate] of [
      ["readings", "source IN ('mock', 'replay')"],
      ["measurement_samples", "source IN ('mock', 'replay')"],
      ["outdoor_temperature_samples", "source = 'mock'"],
    ] as const) {
      const row = runtime.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as { count: number };
      expect(row.count).toBe(0);
    }
    await request(runtime.app).post("/api/v1/mock/tick").expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("DEMO_DATA_DISABLED"));

    const reloaded = loadConfig({
      NODE_ENV: "production",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      HA_TOKEN: "environment-wins",
    });
    expect(reloaded.haUrl).toBe("http://homeassistant.local:8123");
    expect(reloaded.haToken).toBe("environment-wins");
    expect(reloaded.tpLinkPassword).toBe("tp-link-secret");
    expect(readFileSync(secretsPath, "utf8")).not.toContain("SQLite");
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

  it("rejects mixed batches, then atomically switches on the first real sample", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-real-sample-"));
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: join(directory, "integrations.json"), MOCK_ENABLED: "true",
    });
    runtime = createApi({ config, startBackground: false });
    const mockCountBefore = (runtime.database.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'").get() as { count: number }).count;

    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      { sensorId: "sensor-01", metric: "co2", value: 700, canonicalUnit: "ppm", timestamp: "2026-07-14T10:00:00Z", source: "mock" },
      { sensorId: "sensor-01", metric: "co2", value: 710, canonicalUnit: "ppm", timestamp: "2026-07-14T10:01:00Z", source: "api" },
    ] }).expect(409).expect(({ body }) => expect(body.error.code).toBe("MIXED_DATA_MODES"));
    expect(runtime.database.isRealDataMode()).toBe(false);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples WHERE source = 'mock'").get() as { count: number }).count).toBe(mockCountBefore);

    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 720, canonicalUnit: "ppm", timestamp: "2026-07-14T10:02:00Z",
    }).expect(201);
    expect(runtime.database.isRealDataMode()).toBe(true);
    expect(runtime.database.measurementHistory("sensor-01", "co2", "2026-07-14T00:00:00Z", "2026-07-15T00:00:00Z"))
      .toEqual([expect.objectContaining({ value: 720, source: "api" })]);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBe(0);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 730, canonicalUnit: "ppm", timestamp: "2026-07-14T10:03:00Z", source: "mock",
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("DEMO_DATA_DISABLED"));

    await request(runtime.app).post("/api/v1/readings").send({
      sensorId: "sensor-01", timestamp: "2026-07-14T10:04:00Z", temperature: 21, humidity: 42, battery: 88,
    }).expect(201);
    await request(runtime.app).post("/api/v1/replay").send({
      sensorIds: ["sensor-01"], from: "2026-07-14T10:03:30Z", to: "2026-07-14T10:04:30Z", speed: 10_000,
    }).expect(202).expect(({ body }) => expect(body.replay.count).toBe(1));
    await request(runtime.app).delete("/api/v1/replay").expect(200);
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

      const repeated = runtime.database.activateRealDataMode();
      expect(repeated).toMatchObject({ activated: false, activatedAt: activation.activatedAt });
      expect(runtime.database.listAlertEvents()).toHaveLength(1);

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
    runtime = createApi({ config: loadConfig(environment), startBackground: false });
    await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      host: "192.168.1.42", username: "person@example.test", password: "tp-link-secret",
    }).expect(200);
    const activatedAt = runtime.status.value.mock.activatedAt;
    runtime.close();
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
