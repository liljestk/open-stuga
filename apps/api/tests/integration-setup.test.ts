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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for integration state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    runtime = createApi({
      config,
      startBackground: false,
      homeAssistantCredentialTester: successfulDraftTest,
      tpLinkCredentialTester: successfulDraftTest,
    });

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
      homeAssistantConnections: [{ houseId: "house-main", url: "http://homeassistant.local:8123", token: "ha-secret-token" }],
      tpLinkConnections: [{
        id: tpLink.body.connectionId,
        houseId: "house-main",
        host: "192.168.1.42",
        username: "person@example.test",
        password: "tp-link-secret",
      }],
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

    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      HA_TOKEN: "environment-wins",
    })).toThrow(/requires HA_URL, HA_TOKEN/);
    const reloaded = loadConfig({
      NODE_ENV: "production", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath,
      HA_URL: "http://environment-ha.local:8123", HA_TOKEN: "environment-wins",
    });
    expect(reloaded.haUrl).toBe("http://environment-ha.local:8123");
    expect(reloaded.haToken).toBe("environment-wins");
    expect(reloaded.tpLinkConnections?.[0]?.password).toBe("tp-link-secret");
    expect(readFileSync(secretsPath, "utf8")).not.toContain("SQLite");
  });

  it("follows stable TP-Link identities across address changes without overwriting different hardware", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-identities-"));
    const secretsPath = join(directory, "integrations.json");
    const identities = new Map([
      ["192.168.1.56", "h200-stable-id"],
      ["192.168.1.57", "hs110-stable-id"],
      ["192.168.1.58", "h200-stable-id"],
    ]);
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath }),
      startBackground: false,
      tpLinkCredentialTester: async (host) => ({
        ok: true,
        connected: true,
        message: "validated",
        details: { sourceDeviceId: identities.get(host) },
      }),
    });

    const hub = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      houseId: "house-main", host: "192.168.1.56", username: "owner@example.test", password: "secret",
    }).expect(200);
    const beforeMismatch = readFileSync(secretsPath, "utf8");
    await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      houseId: "house-main",
      connectionId: hub.body.connectionId,
      host: "192.168.1.57",
      username: "owner@example.test",
      password: "secret",
    }).expect(409).expect(({ body }) => {
      expect(body.error.code).toBe("TP_LINK_CONNECTION_IDENTITY_MISMATCH");
    });
    expect(readFileSync(secretsPath, "utf8")).toBe(beforeMismatch);

    const plug = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      houseId: "house-main", host: "192.168.1.57", username: "owner@example.test", password: "secret",
    }).expect(200);

    expect(plug.body.connectionId).not.toBe(hub.body.connectionId);
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hub.body.connectionId, host: "192.168.1.56", deviceId: "h200-stable-id" }),
      expect.objectContaining({ id: plug.body.connectionId, host: "192.168.1.57", deviceId: "hs110-stable-id" }),
    ]));

    const movedHub = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      houseId: "house-main", host: "192.168.1.58", username: "owner@example.test", password: "new-secret",
    }).expect(200);
    expect(movedHub.body.connectionId).toBe(hub.body.connectionId);
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hub.body.connectionId, host: "192.168.1.58", password: "new-secret" }),
      expect.objectContaining({ id: plug.body.connectionId, host: "192.168.1.57" }),
    ]));

  });

  it("keeps multiple P110 energy monitors connected and independently mapped in one Home", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-multiple-p110-"));
    const secretsPath = join(directory, "integrations.json");
    const helperPath = join(directory, "fake-p110-sources.mjs");
    const sources = {
      "192.168.1.61": { deviceId: "p110-laundry", alias: "Laundry plug", power: 410 },
      "192.168.1.62": { deviceId: "p110-kitchen", alias: "Kitchen plug", power: 825 },
    } as const;
    writeFileSync(helperPath, `
      const sources = ${JSON.stringify(sources)};
      const source = sources[process.env.TP_LINK_HOST];
      if (!source) throw new Error("Unexpected TP-Link host");
      process.stdout.write(JSON.stringify({
        type: "snapshot",
        timestamp: new Date().toISOString(),
        sourceType: "energy-device",
        sourceDeviceId: source.deviceId,
        hubModel: "P110",
        devices: [{
          deviceId: source.deviceId,
          model: "P110",
          alias: source.alias,
          status: "online",
          power: source.power,
          energy: null
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
    });
    config.tpLinkPython = process.execPath;
    config.tpLinkBridgeScript = helperPath;
    runtime = createApi({
      config,
      startBackground: false,
      tpLinkCredentialTester: async (host) => {
        const source = sources[host as keyof typeof sources];
        return source
          ? {
              ok: true,
              connected: true,
              message: "validated",
              details: { sourceDeviceId: source.deviceId, deviceIds: [source.deviceId] },
            }
          : { ok: false, connected: false, message: "unknown source" };
      },
    });

    const connectionIds: string[] = [];
    for (const host of Object.keys(sources)) {
      const configured = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
        houseId: "house-main",
        host,
        username: "owner@example.test",
        password: "secret",
      }).expect(200);
      connectionIds.push(configured.body.connectionId as string);
    }

    expect(new Set(connectionIds).size).toBe(2);
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionIds[0], houseId: "house-main", deviceId: "p110-laundry" }),
      expect.objectContaining({ id: connectionIds[1], houseId: "house-main", deviceId: "p110-kitchen" }),
    ]));
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "p110-laundry",
      tpLinkConnectionId: connectionIds[0],
    });
    runtime.database.updateSensor("sensor-02", {
      tpLinkDeviceId: "p110-kitchen",
      tpLinkConnectionId: connectionIds[1],
    });

    runtime.tpLink.start();
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "power")?.value === 410);
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-02", "power")?.value === 825);

    await request(runtime.app).get("/api/v1/integrations/status?houseId=house-main").expect(200).expect(({ body }) => {
      expect(body.tpLink.connections).toHaveLength(2);
      expect(body.tpLink.connections.every((connection: { connected: boolean }) => connection.connected)).toBe(true);
    });
    await request(runtime.app).get("/api/v1/integrations/tp-link/devices?houseId=house-main").expect(200).expect(({ body }) => {
      expect(body.devices).toEqual(expect.arrayContaining([
        expect.objectContaining({ connectionId: connectionIds[0], deviceId: "p110-laundry", mappedSensorId: "sensor-01", power: 410 }),
        expect.objectContaining({ connectionId: connectionIds[1], deviceId: "p110-kitchen", mappedSensorId: "sensor-02", power: 825 }),
      ]));
    });
  });

  it("materializes an environment-backed TP-Link source before adding different hardware", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-legacy-addition-"));
    const secretsPath = join(directory, "integrations.json");
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        INTEGRATION_SECRETS_FILE: secretsPath,
        TP_LINK_HOST: "192.168.1.56",
        TP_LINK_USERNAME: "owner@example.test",
        TP_LINK_PASSWORD: "legacy-secret",
      }),
      startBackground: false,
      tpLinkCredentialTester: async () => ({
        ok: true,
        connected: true,
        message: "validated",
        details: { sourceDeviceId: "hs110-stable-id" },
      }),
    });

    const added = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      houseId: "house-main", host: "192.168.1.57", username: "owner@example.test", password: "new-secret",
    }).expect(200);

    expect(added.body.connectionId).not.toBe("legacy");
    expect(readIntegrationSecrets(secretsPath)).toMatchObject({
      tpLinkLegacyDisabled: true,
      tpLinkConnections: expect.arrayContaining([
        expect.objectContaining({ id: "legacy", host: "192.168.1.56", password: "legacy-secret" }),
        expect.objectContaining({ id: added.body.connectionId, host: "192.168.1.57", deviceId: "hs110-stable-id" }),
      ]),
    });
    expect(runtime.status.value.tpLink.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy", houseId: "house-main" }),
      expect.objectContaining({ id: added.body.connectionId, houseId: "house-main" }),
    ]));
  });

  it("atomically scopes legacy sensor bindings when a second TP-Link source is added", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-binding-migration-"));
    const secretsPath = join(directory, "integrations.json");
    const helperPath = join(directory, "existing-tp-link-source.mjs");
    const existingConnection = {
      id: "existing-source",
      houseId: "house-main",
      host: "192.168.1.56",
      username: "owner@example.test",
      password: "existing-secret",
      deviceId: "h200-stable-id",
    };
    writeIntegrationSecrets(secretsPath, {
      version: 1,
      tpLinkLegacyDisabled: true,
      tpLinkConnections: [existingConnection],
    });
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        sourceDeviceId: "h200-stable-id", devices: [{
          deviceId: "existing-child", model: "T310", alias: "Existing sensor", status: "online",
          temperature: 20, temperatureUnit: "celsius", humidity: 40, battery: 90
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath });
    config.tpLinkPython = process.execPath;
    config.tpLinkBridgeScript = helperPath;
    runtime = createApi({
      config,
      startBackground: false,
      tpLinkCredentialTester: async () => ({
        ok: true,
        connected: true,
        message: "validated",
        details: { sourceDeviceId: "hs110-stable-id", deviceIds: ["new-child"] },
      }),
    });
    runtime.database.updateSensor("sensor-01", { tpLinkDeviceId: "existing-child", tpLinkConnectionId: null });
    runtime.database.updateSensor("sensor-02", { tpLinkDeviceId: "new-child", tpLinkConnectionId: null });
    runtime.database.updateSensor("sensor-03", { tpLinkDeviceId: "unknown-child", tpLinkConnectionId: null });
    runtime.tpLink.start();
    await waitFor(() => runtime?.status.value.tpLink.connected === true);

    const newSource = {
      houseId: "house-main", host: "192.168.1.57", username: "owner@example.test", password: "new-secret",
    };
    await request(runtime.app).put("/api/v1/integrations/tp-link/config").send(newSource)
      .expect(409).expect(({ body }) => {
        expect(body.error).toMatchObject({
          code: "TP_LINK_BINDING_MIGRATION_REQUIRED",
          details: { sensorIds: ["sensor-03"] },
        });
      });
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual([existingConnection]);
    expect(runtime.database.getSensor("sensor-01")).not.toHaveProperty("tpLinkConnectionId");
    expect(runtime.database.getSensor("sensor-02")).not.toHaveProperty("tpLinkConnectionId");
    runtime.database.updateSensor("sensor-03", { tpLinkDeviceId: null });

    const added = await request(runtime.app).put("/api/v1/integrations/tp-link/config").send({
      ...newSource,
    }).expect(200);

    expect(runtime.database.getSensor("sensor-01")).toMatchObject({
      tpLinkDeviceId: "existing-child", tpLinkConnectionId: existingConnection.id,
    });
    expect(runtime.database.getSensor("sensor-02")).toMatchObject({
      tpLinkDeviceId: "new-child", tpLinkConnectionId: added.body.connectionId,
    });
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toHaveLength(2);
  });

  it("does not treat an explicit saved connection named legacy as the global compatibility source", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-explicit-legacy-delete-"));
    const secretsPath = join(directory, "integrations.json");
    writeIntegrationSecrets(secretsPath, {
      version: 1,
      tpLinkLegacyDisabled: true,
      tpLinkConnections: [{
        id: "legacy", houseId: "house-main", host: "192.168.1.57",
        username: "owner@example.test", password: "secret", deviceId: "hs110-stable-id",
      }],
    });
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath }),
      startBackground: false,
    });
    runtime.database.updateSensor("sensor-01", { tpLinkDeviceId: "scoped-device", tpLinkConnectionId: "legacy" });
    runtime.database.updateSensor("sensor-02", { tpLinkDeviceId: "unscoped-device", tpLinkConnectionId: null });

    await request(runtime.app).delete("/api/v1/integrations/tp-link/config/legacy").expect(200).expect(({ body }) => {
      expect(body.detachedSensorIds).toEqual(["sensor-01"]);
    });
    expect(runtime.database.getSensor("sensor-01")).not.toHaveProperty("tpLinkDeviceId");
    expect(runtime.database.getSensor("sensor-02")).toMatchObject({ tpLinkDeviceId: "unscoped-device" });
  });

  it("keeps shared Home Assistant and TP-Link endpoints scoped to independent Home assignments", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-house-integrations-"));
    const secretsPath = join(directory, "integrations.json");
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath }),
      startBackground: false,
      homeAssistantCredentialTester: successfulDraftTest,
      tpLinkCredentialTester: successfulDraftTest,
    });
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-cabin",
      name: "Cabin",
      timezone: "Europe/Helsinki",
      floors: [{ id: "floor-cabin", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    for (const houseId of ["house-main", "house-cabin"]) {
      await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
        .send({ houseId, url: "http://shared-homeassistant.local:8123", token: `token-${houseId}` }).expect(200);
    }
    const tpConnections: Array<{ connectionId: string; houseId: string }> = [];
    for (const [houseId, host] of [
      ["house-main", "192.168.10.20"],
      ["house-cabin", "192.168.10.20"],
      ["house-cabin", "192.168.20.21"],
    ]) {
      const configured = await request(runtime.app).put("/api/v1/integrations/tp-link/config")
        .send({ houseId, host, username: "owner@example.test", password: "secret" }).expect(200);
      tpConnections.push(configured.body as { connectionId: string; houseId: string });
    }

    await request(runtime.app).get("/api/v1/integrations/status?houseId=house-cabin").expect(200).expect(({ body }) => {
      expect(body.homeAssistant).toMatchObject({ configured: true, connections: [{ houseId: "house-cabin" }] });
      expect(body.tpLink.configured).toBe(true);
      expect(body.tpLink.connections).toHaveLength(2);
      expect(body.tpLink.connections.every((connection: { houseId: string }) => connection.houseId === "house-cabin")).toBe(true);
    });
    const secrets = readIntegrationSecrets(secretsPath);
    expect(secrets.homeAssistantConnections).toHaveLength(2);
    expect(secrets.tpLinkConnections).toHaveLength(3);
    expect(tpConnections[0]!.connectionId).not.toBe(tpConnections[1]!.connectionId);

    const mainConnection = tpConnections.find((connection) => connection.houseId === "house-main")!;
    const cabinConnection = tpConnections.find((connection) => connection.houseId === "house-cabin")!;
    const commonSensor = {
      name: "Washer", room: "Utility", model: "Tapo P110", x: 1, y: 1, z: 0.3,
      tags: [], enabled: true, tpLinkDeviceId: "shared-meter-id",
    };
    await request(runtime.app).post("/api/v1/sensors").send({
      ...commonSensor, id: "washer-main", houseId: "house-main", floorId: "floor-ground",
      tpLinkConnectionId: mainConnection.connectionId,
    }).expect(201);
    await request(runtime.app).post("/api/v1/sensors").send({
      ...commonSensor, id: "washer-cabin", houseId: "house-cabin", floorId: "floor-cabin",
      tpLinkConnectionId: cabinConnection.connectionId,
    }).expect(201);

    await request(runtime.app).delete(`/api/v1/integrations/tp-link/config/${mainConnection.connectionId}`).expect(200)
      .expect(({ body }) => expect(body.detachedSensorIds).toEqual(["washer-main"]));
    expect(runtime.database.getSensor("washer-main")).not.toHaveProperty("tpLinkDeviceId");
    expect(runtime.database.getSensor("washer-main")).not.toHaveProperty("tpLinkConnectionId");
    expect(runtime.database.getSensor("washer-cabin")).toMatchObject({
      tpLinkDeviceId: "shared-meter-id",
      tpLinkConnectionId: cabinConnection.connectionId,
    });

    await request(runtime.app).delete("/api/v1/integrations/home-assistant/config/house-main").expect(200);
    await request(runtime.app).get("/api/v1/integrations/status?houseId=house-cabin").expect(200).expect(({ body }) => {
      expect(body.homeAssistant.configured).toBe(true);
      expect(body.tpLink.connections).toHaveLength(2);
    });
    const remainingSecrets = readIntegrationSecrets(secretsPath);
    expect(remainingSecrets.homeAssistantConnections?.map((connection) => connection.houseId)).toEqual(["house-cabin"]);
    expect(remainingSecrets.tpLinkConnections?.every((connection) => connection.houseId === "house-cabin")).toBe(true);
  });

  it("moves saved Home Assistant and TP-Link assignments without exposing or re-entering credentials", async () => {
    directory = mkdtempSync(join(tmpdir(), "climate-twin-move-integrations-"));
    const secretsPath = join(directory, "integrations.json");
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", INTEGRATION_SECRETS_FILE: secretsPath }),
      startBackground: false,
      homeAssistantCredentialTester: successfulDraftTest,
      tpLinkCredentialTester: successfulDraftTest,
    });
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-cabin",
      name: "Cabin",
      timezone: "Europe/Helsinki",
      floors: [{ id: "floor-cabin", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
      .send({ houseId: "house-main", url: "http://homeassistant.local:8123", token: "ha-secret" }).expect(200);
    const configuredTpLink = await request(runtime.app).put("/api/v1/integrations/tp-link/config")
      .send({ houseId: "house-main", host: "192.168.10.20", username: "owner@example.test", password: "tp-secret" }).expect(200);
    const connectionId = configuredTpLink.body.connectionId as string;
    await request(runtime.app).post("/api/v1/sensors").send({
      id: "sensor-main", houseId: "house-main", floorId: "floor-ground", name: "Hall", room: "Hall",
      model: "Tapo T315", x: 1, y: 1, z: 1.2, tags: [], enabled: true,
      tpLinkDeviceId: "child-hall", tpLinkConnectionId: connectionId,
    }).expect(201);

    await request(runtime.app).patch(`/api/v1/integrations/tp-link/config/${connectionId}`)
      .send({ houseId: "house-cabin" }).expect(200).expect(({ body }) => {
        expect(body).toMatchObject({ ok: true, fromHouseId: "house-main", houseId: "house-cabin" });
        expect(body.detachedSensorIds).toEqual(["sensor-main"]);
      });
    await request(runtime.app).patch("/api/v1/integrations/home-assistant/config/house-main")
      .send({ houseId: "house-cabin" }).expect(200).expect(({ body }) => {
        expect(body).toMatchObject({ ok: true, fromHouseId: "house-main", houseId: "house-cabin" });
      });

    expect(runtime.database.getSensor("sensor-main")).not.toHaveProperty("tpLinkDeviceId");
    expect(runtime.database.getSensor("sensor-main")).not.toHaveProperty("tpLinkConnectionId");
    const secrets = readIntegrationSecrets(secretsPath);
    expect(secrets.tpLinkConnections).toEqual([expect.objectContaining({
      id: connectionId, houseId: "house-cabin", host: "192.168.10.20", username: "owner@example.test", password: "tp-secret",
    })]);
    expect(secrets.homeAssistantConnections).toEqual([expect.objectContaining({
      houseId: "house-cabin", url: "http://homeassistant.local:8123", token: "ha-secret",
    })]);
    await request(runtime.app).get("/api/v1/integrations/status?houseId=house-cabin").expect(200).expect(({ body }) => {
      expect(body.homeAssistant.connections).toEqual([expect.objectContaining({ houseId: "house-cabin" })]);
      expect(body.tpLink.connections).toEqual([expect.objectContaining({ id: connectionId, houseId: "house-cabin" })]);
    });
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
