import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";
import { ipv4BroadcastAddress, loadTpLinkDeviceMappings, normalizeTpLinkTemperature } from "../src/tp-link.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for direct TP-Link bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("direct TP-Link H100/H200 bridge", () => {
  let runtime: ApiRuntime | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("normalizes hub temperature units and validates stable one-to-one device mappings", () => {
    expect(normalizeTpLinkTemperature(21.5, "celsius")).toBe(21.5);
    expect(normalizeTpLinkTemperature(77, "fahrenheit")).toBeCloseTo(25);
    expect(normalizeTpLinkTemperature(10, "unknown")).toBeNull();

    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-map-"));
    const valid = join(temporaryDirectory, "valid.json");
    writeFileSync(valid, JSON.stringify({ devices: [{ deviceId: "child-a", sensorId: "sensor-01" }] }));
    expect(loadTpLinkDeviceMappings(valid)).toEqual([{ deviceId: "child-a", sensorId: "sensor-01" }]);
    const empty = join(temporaryDirectory, "empty.json");
    writeFileSync(empty, JSON.stringify({ devices: [] }));
    expect(loadTpLinkDeviceMappings(empty)).toEqual([]);

    const duplicate = join(temporaryDirectory, "duplicate.json");
    writeFileSync(duplicate, JSON.stringify({ devices: [
      { deviceId: "child-a", sensorId: "sensor-01" },
      { deviceId: "child-a", sensorId: "sensor-02" },
    ] }));
    expect(() => loadTpLinkDeviceMappings(duplicate)).toThrow(/mapped more than once/);
  });

  it("bootstraps mappings without credentials, canonicalizes order, and supports an explicit clear", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-map-bootstrap-"));
    const mappingPath = join(temporaryDirectory, "devices.json");
    writeFileSync(mappingPath, JSON.stringify({ devices: [
      { deviceId: "child-b", sensorId: "sensor-02" },
      { deviceId: "child-a", sensorId: "sensor-01" },
    ] }));
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null,
      tpLinkDeviceMapFile: mappingPath, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.db.exec(`CREATE TRIGGER fail_tp_link_mapping_persistence
      BEFORE INSERT ON integration_mapping_sets WHEN NEW.kind = 'tp-link'
      BEGIN SELECT RAISE(ABORT, 'forced mapping persistence failure'); END`);
    expect(() => runtime?.tpLink.start()).toThrow(/forced mapping persistence failure/);
    expect(runtime.database.getIntegrationMappingSet("tp-link")).toBeNull();
    runtime.database.db.exec("DROP TRIGGER fail_tp_link_mapping_persistence");
    runtime.tpLink.start();
    const imported = runtime.database.getIntegrationMappingSet("tp-link");
    expect(imported).toMatchObject({ revision: 1, mappings: [
      { deviceId: "child-a", sensorId: "sensor-01" },
      { deviceId: "child-b", sensorId: "sensor-02" },
    ] });
    expect(runtime.status.value.tpLink.configured).toBe(false);

    runtime.tpLink.stop();
    writeFileSync(mappingPath, JSON.stringify({ devices: [
      { sensorId: "sensor-01", deviceId: "child-a" },
      { sensorId: "sensor-02", deviceId: "child-b" },
    ] }));
    runtime.tpLink.start();
    expect(runtime.database.getIntegrationMappingSet("tp-link")).toEqual(imported);

    runtime.tpLink.stop();
    writeFileSync(mappingPath, JSON.stringify({ devices: [] }));
    runtime.tpLink.start();
    expect(runtime.database.getIntegrationMappingSet("tp-link")).toMatchObject({ revision: 2, mappings: [] });
  });

  it("derives a directed IPv4 broadcast address for multihomed discovery", () => {
    expect(ipv4BroadcastAddress("192.168.68.55", "255.255.252.0")).toBe("192.168.71.255");
    expect(ipv4BroadcastAddress("10.0.0.4", "255.255.255.0")).toBe("10.0.0.255");
    expect(ipv4BroadcastAddress("not-an-address", "255.255.255.0")).toBeNull();
    expect(ipv4BroadcastAddress("192.168.1.2", "255.255.999.0")).toBeNull();
  });

  it("ingests mapped T310/T315 snapshots without requiring Home Assistant", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-"));
    const mappingPath = join(temporaryDirectory, "devices.json");
    const helperPath = join(temporaryDirectory, "fake-tp-link-helper.mjs");
    writeFileSync(mappingPath, JSON.stringify({ devices: [{ deviceId: "t315-living", sensorId: "sensor-01" }] }));
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot",
        timestamp: new Date(Date.now() - 1000).toISOString(),
        hubModel: "H200",
        devices: [{
          deviceId: "t315-living",
          model: "T315",
          alias: "Living room",
          status: "online",
          temperature: 77,
          temperatureUnit: "fahrenheit",
          humidity: 48,
          battery: 90
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.10", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: mappingPath, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.connected === true);
    expect(runtime.status.value.homeAssistant.configured).toBe(false);
    expect(runtime.status.value.tpLink).toMatchObject({
      connected: true, hubModel: "H200", mappedDevices: 1, discoveredDevices: 1, error: null,
    });
    expect(runtime.database.getLatestReading("sensor-01")).toMatchObject({
      source: "tp-link", temperature: 25, humidity: 48, battery: 90,
    });
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "temperature")).toMatchObject({
      source: "tp-link", value: 25, canonicalUnit: "°C",
    });
  });

  it("persists every climate change and one unchanged heartbeat per minute", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-cadence-"));
    const mappingPath = join(temporaryDirectory, "devices.json");
    const helperPath = join(temporaryDirectory, "fake-tp-link-cadence-helper.mjs");
    writeFileSync(mappingPath, JSON.stringify({ devices: [{ deviceId: "t310-cadence", sensorId: "sensor-01" }] }));
    writeFileSync(helperPath, `
      const startedAt = Date.now() - 70_000;
      const snapshots = [
        { offsetMs: 0, temperature: 20 },
        { offsetMs: 2_000, temperature: 20 },
        { offsetMs: 4_000, temperature: 21 },
        { offsetMs: 63_000, temperature: 21 },
        { offsetMs: 65_000, temperature: 21 }
      ];
      for (const snapshot of snapshots) process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date(startedAt + snapshot.offsetMs).toISOString(), hubModel: "H200",
        devices: [{
          deviceId: "t310-cadence", model: "T310", alias: "Cadence sensor", status: "online",
          temperature: snapshot.temperature, temperatureUnit: "celsius", humidity: 40, battery: 90
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.10", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: mappingPath, tpLinkPollIntervalMs: 2_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    const from = new Date(Date.now() - 120_000).toISOString();
    const to = new Date(Date.now() + 1_000).toISOString();
    await waitFor(() => runtime!.database.measurementHistory("sensor-01", "temperature", from, to)
      .filter((sample) => sample.source === "tp-link").length === 3);
    expect(runtime.database.measurementHistory("sensor-01", "temperature", from, to)
      .filter((sample) => sample.source === "tp-link").map((sample) => sample.value)).toEqual([20, 21, 21]);
    expect(runtime.database.measurementHistory("sensor-01", "humidity", from, to)
      .filter((sample) => sample.source === "tp-link").map((sample) => sample.value)).toEqual([40, 40, 40]);
  });

  it("persists an identity-verified host change emitted by the recovery helper", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-recovery-"));
    const secretsPath = join(temporaryDirectory, "secrets.json");
    const helperPath = join(temporaryDirectory, "fake-recovering-tp-link-helper.mjs");
    writeIntegrationSecrets(secretsPath, {
      version: 1,
      tpLinkConnections: [{
        id: "moving-hub", houseId: "house-main", host: "192.168.68.54",
        username: "local@example.test", password: "secret",
      }],
    });
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "host-change", previousHost: "192.168.68.54", host: "192.168.68.56",
        sourceDeviceId: "stable-hub-id"
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        sourceDeviceId: "stable-hub-id", devices: []
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: secretsPath,
      assetDirectory: temporaryDirectory, mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730,
      ingestApiKey: null, haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null,
      tpLinkConnections: [{
        id: "moving-hub", houseId: "house-main", host: "192.168.68.54",
        username: "local@example.test", password: "secret",
      }],
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.connected === true);
    expect(config.tpLinkConnections).toEqual([expect.objectContaining({
      id: "moving-hub", host: "192.168.68.56", deviceId: "stable-hub-id",
    })]);
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual([expect.objectContaining({
      id: "moving-hub", host: "192.168.68.56", deviceId: "stable-hub-id",
    })]);
  });

  it("rejects a recovered address when the helper reports a different physical source", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-recovery-mismatch-"));
    const secretsPath = join(temporaryDirectory, "secrets.json");
    const helperPath = join(temporaryDirectory, "fake-mismatched-tp-link-helper.mjs");
    const savedConnection = {
      id: "moving-hub", houseId: "house-main", host: "192.168.68.54",
      username: "local@example.test", password: "secret", deviceId: "stable-hub-id",
    };
    writeIntegrationSecrets(secretsPath, { version: 1, tpLinkConnections: [savedConnection] });
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "host-change", previousHost: "192.168.68.54", host: "192.168.68.57",
        sourceDeviceId: "different-device-id"
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        sourceDeviceId: "different-device-id", devices: []
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: secretsPath,
      assetDirectory: temporaryDirectory, mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730,
      ingestApiKey: null, haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null,
      tpLinkConnections: [savedConnection], tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.error?.includes("different source identity") === true);
    expect(config.tpLinkConnections).toEqual([savedConnection]);
    expect(readIntegrationSecrets(secretsPath).tpLinkConnections).toEqual([savedConnection]);
    expect(runtime.status.value.tpLink.connected).toBe(false);
  });

  it("ingests a bound Tapo contact as provider-owned opening state", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-contact-"));
    const helperPath = join(temporaryDirectory, "fake-tp-link-contact-helper.mjs");
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        devices: [{
          deviceId: "contact-entry", model: "contact", alias: "Entry contact", status: "online",
          temperature: null, temperatureUnit: null, humidity: null, battery: 92, contactOpen: true
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      spatialLayersEnabled: true, spatialLayersDatabasePath: join(temporaryDirectory, "spatial.sqlite"),
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.11", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    const wakeHouse = vi.spyOn(runtime.spatialLayers!.scheduler, "wakeHouse");
    const house = runtime.database.getHouse("house-main")!;
    const floors = structuredClone(house.floors);
    floors[0]!.planElements = [...(floors[0]!.planElements ?? []), {
      id: "entry-door", kind: "door", wallId: floors[0]!.walls[0]!.id,
      position: {
        x: (floors[0]!.walls[0]!.from.x + floors[0]!.walls[0]!.to.x) / 2,
        y: (floors[0]!.walls[0]!.from.y + floors[0]!.walls[0]!.to.y) / 2,
      },
      rotationDegrees: 0, state: "closed",
      stateBinding: { provider: "tapo", externalId: "contact-entry" },
    }];
    runtime.database.updateHouse(house.id, { floors });
    runtime.tpLink.start();

    await waitFor(() => runtime!.database.listOpeningStateObservations(house.id).length === 1);
    const observation = runtime.database.listOpeningStateObservations(house.id)[0]!;
    expect(observation).toMatchObject({
      floorId: floors[0]!.id, elementId: "entry-door", state: "open", source: "tapo",
      externalId: "contact-entry", connectionId: "legacy",
    });
    expect(runtime.status.value.tpLink.mappedDevices).toBe(1);
    expect(wakeHouse).toHaveBeenCalledWith(house.id, house.propertyId, observation.observedAt, "property-context-changed");
  });

  it("imports the legacy child map into SQLite and uses it after the file is removed", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-map-durable-"));
    const databasePath = join(temporaryDirectory, "climate.sqlite");
    const mappingPath = join(temporaryDirectory, "devices.json");
    const helperPath = join(temporaryDirectory, "fake-durable-tp-link-helper.mjs");
    writeFileSync(mappingPath, JSON.stringify({ devices: [
      {
        deviceId: " durable-child ",
        sensorId: " sensor-01 ",
        sourcePath: mappingPath,
        password: "must-not-be-persisted",
      },
      { deviceId: "stale-child", sensorId: "missing-sensor" },
    ] }));
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        devices: [{
          deviceId: "durable-child", model: "T315", alias: "Durable sensor", status: "online",
          temperature: 21.5, temperatureUnit: "celsius", humidity: 47, battery: 88
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath,
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.40", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: mappingPath, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };

    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();
    await waitFor(() => runtime?.status.value.tpLink.connected === true);
    const firstTimestamp = runtime.database.getLatestReading("sensor-01")?.timestamp;
    expect(firstTimestamp).toBeTruthy();
    const imported = runtime.database.getIntegrationMappingSet("tp-link");
    expect(imported).toMatchObject({
      kind: "tp-link",
      revision: 1,
      mappings: [
        { deviceId: "durable-child", sensorId: "sensor-01" },
        { deviceId: "stale-child", sensorId: "missing-sensor" },
      ],
    });
    expect(imported?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(imported?.mappings)).not.toContain(mappingPath);
    expect(JSON.stringify(imported?.mappings)).not.toContain("must-not-be-persisted");

    await runtime.close();
    runtime = null;
    rmSync(mappingPath);
    await new Promise((resolve) => setTimeout(resolve, 5));

    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();
    await waitFor(() => runtime?.database.getLatestReading("sensor-01")?.timestamp !== firstTimestamp);
    expect(runtime.status.value.tpLink).toMatchObject({
      connected: true,
      mappedDevices: 1,
      error: "Ignored TP-Link mappings for unknown sensors: missing-sensor",
    });
    expect(runtime.database.getLatestReading("sensor-01")).toMatchObject({
      source: "tp-link", temperature: 21.5, humidity: 47, battery: 88,
    });
    expect(runtime.database.getIntegrationMappingSet("tp-link")).toEqual(imported);
  });

  it("ingests direct energy-module power and only device-provided cumulative totals", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-energy-"));
    const mappingPath = join(temporaryDirectory, "devices.json");
    const helperPath = join(temporaryDirectory, "fake-tp-link-energy-helper.mjs");
    writeFileSync(mappingPath, JSON.stringify({ devices: [
      { deviceId: "tapo-power", sensorId: "sensor-01" },
      { deviceId: "kasa-total", sensorId: "sensor-02" },
    ] }));
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot",
        timestamp: new Date(Date.now() - 1000).toISOString(),
        sourceType: "energy-device",
        hubModel: "P304M",
        devices: [{
          deviceId: "tapo-power", model: "P110", alias: "Washer", status: null,
          temperature: null, temperatureUnit: null, humidity: null, battery: null,
          power: 123.4, energy: null
        }, {
          deviceId: "kasa-total", model: "HS110", alias: "Dryer", status: null,
          temperature: null, temperatureUnit: null, humidity: null, battery: null,
          power: 80, energy: 3.25
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.20", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: mappingPath, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-02", "energy") !== null);
    expect(runtime.status.value.tpLink).toMatchObject({ connected: true, hubModel: null, error: null });
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "power")).toMatchObject({
      value: 123.4, canonicalUnit: "W", source: "tp-link",
    });
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "energy")).toBeNull();
    expect(runtime.database.getLatestMeasurementSample("sensor-02", "power")).toMatchObject({ value: 80, canonicalUnit: "W" });
    expect(runtime.database.getLatestMeasurementSample("sensor-02", "energy")).toMatchObject({
      value: 3.25, canonicalUnit: "kWh", source: "tp-link",
    });
    const discovered = await request(runtime.app).get("/api/v1/integrations/tp-link/devices").expect(200);
    expect(discovered.body.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: "tapo-power", power: 123.4, energy: null, mappedSensorId: "sensor-01" }),
      expect.objectContaining({ deviceId: "kasa-total", power: 80, energy: 3.25, mappedSensorId: "sensor-02" }),
    ]));
  });

  it("runs independent TP-Link meter connections per house", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-houses-"));
    const helperPath = join(temporaryDirectory, "fake-house-meters.mjs");
    writeFileSync(helperPath, `
      const second = process.env.TP_LINK_HOST === "192.0.2.32";
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date(Date.now() - 1000).toISOString(),
        sourceType: "energy-device", hubModel: "P110", devices: [{
          deviceId: "meter", model: "P110", alias: second ? "Cottage meter" : "Home meter", status: "online",
          temperature: null, temperatureUnit: null, humidity: null, battery: null,
          power: second ? 220 : 110, energy: second ? 8 : 4
        }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null,
      tpLinkConnections: [
        { id: "main-meter", houseId: "house-main", host: "192.0.2.31", username: "u", password: "p" },
        { id: "cottage-meter", houseId: "house-cottage", host: "192.0.2.32", username: "u", password: "p" },
      ],
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    const main = runtime.database.getHouse("house-main")!;
    runtime.database.createHouse({
      id: "house-cottage", propertyId: main.propertyId, name: "Cottage", timezone: main.timezone,
      floors: main.floors,
    });
    runtime.database.updateSensor("sensor-01", { tpLinkDeviceId: "meter", tpLinkConnectionId: "main-meter" });
    runtime.database.createSensor({
      id: "cottage-electricity", houseId: "house-cottage", floorId: main.floors[0]!.id,
      name: "Cottage electricity", room: "Utility", model: "P110", x: 1, y: 1, z: 1,
      tpLinkDeviceId: "meter", tpLinkConnectionId: "cottage-meter", tags: [], enabled: true,
    });
    runtime.tpLink.start();

    await waitFor(() => runtime?.database.getLatestMeasurementSample("cottage-electricity", "power")?.value === 220);
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "power")?.value === 110);
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "power")?.value).toBe(110);
    expect(runtime.status.value.tpLink.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "main-meter", houseId: "house-main", connected: true }),
      expect.objectContaining({ id: "cottage-meter", houseId: "house-cottage", connected: true }),
    ]));
    const cottageDevices = await request(runtime.app).get("/api/v1/integrations/tp-link/devices?houseId=house-cottage").expect(200);
    expect(cottageDevices.body.devices).toEqual([expect.objectContaining({
      connectionId: "cottage-meter", houseId: "house-cottage", deviceId: "meter", mappedSensorId: "cottage-electricity",
    })]);
  });

  it("treats an explicit connection named legacy as a normally scoped saved connection", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-explicit-legacy-connection-"));
    const helperPath = join(temporaryDirectory, "fake-explicit-legacy-connections.mjs");
    writeFileSync(helperPath, `
      const legacy = process.env.TP_LINK_HOST === "192.0.2.41";
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), sourceType: "energy-device", hubModel: "P110",
        devices: [
          { deviceId: "legacy-meter", model: "P110", alias: "Legacy meter", status: "online", power: legacy ? 110 : 880, energy: null },
          { deviceId: "other-meter", model: "P110", alias: "Other meter", status: "online", power: legacy ? 990 : 220, energy: null }
        ]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkLegacyDisabled: true,
      tpLinkConnections: [
        { id: "legacy", houseId: "house-main", host: "192.0.2.41", username: "u", password: "p" },
        { id: "other", houseId: "house-main", host: "192.0.2.42", username: "u", password: "p" },
      ],
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.database.updateSensor("sensor-01", { tpLinkDeviceId: "legacy-meter", tpLinkConnectionId: "legacy" });
    runtime.database.updateSensor("sensor-02", { tpLinkDeviceId: "other-meter", tpLinkConnectionId: "other" });
    runtime.tpLink.start();

    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-01", "power")?.value === 110);
    await waitFor(() => runtime?.database.getLatestMeasurementSample("sensor-02", "power")?.value === 220);
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "power")?.value).toBe(110);
    expect(runtime.database.getLatestMeasurementSample("sensor-02", "power")?.value).toBe(220);
    const devices = await request(runtime.app).get("/api/v1/integrations/tp-link/devices?houseId=house-main").expect(200);
    expect(devices.body.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionId: "legacy", deviceId: "legacy-meter", mappedSensorId: "sensor-01" }),
      expect.objectContaining({ connectionId: "other", deviceId: "other-meter", mappedSensorId: "sensor-02" }),
    ]));
  });

  it("discovers safely without a map file and applies database bindings on later snapshots", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-discovery-"));
    const helperPath = join(temporaryDirectory, "fake-discovery-helper.mjs");
    writeFileSync(helperPath, `
      let tick = 0;
      const startedAt = Date.now() - 60_000;
      const send = () => process.stdout.write(JSON.stringify({
        type: "snapshot",
        timestamp: new Date(startedAt + tick++ * 1000).toISOString(),
        hubModel: "H200",
        devices: [{
          deviceId: "t315-discovered",
          model: "T315",
          alias: "Office",
          status: "online",
          temperature: 22.5,
          temperatureUnit: "celsius",
          humidity: 44 + tick % 10,
          battery: 87,
          credential: "must-not-leak"
        }]
      }) + "\\n");
      send();
      setInterval(send, 50);
    `);

    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.10", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: join(temporaryDirectory, "optional-map-does-not-exist.json"), tpLinkPollIntervalMs: 50,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    expect(runtime.status.value.tpLink.configured).toBe(true);
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.discoveredDevices === 1);
    const discovered = await request(runtime.app).get("/api/v1/integrations/tp-link/devices").expect(200);
    expect(discovered.body.devices).toHaveLength(1);
    expect(discovered.body.devices[0]).toMatchObject({
      houseId: "house-main",
      deviceId: "t315-discovered",
      model: "T315",
      alias: "Office",
      status: "online",
      temperature: 22.5,
      humidity: expect.any(Number),
      battery: 87,
      mappedSensorId: null,
    });
    expect(Object.keys(discovered.body.devices[0]).sort()).toEqual([
      "alias", "battery", "contactOpen", "deviceId", "energy", "houseId", "humidity", "lastSeenAt", "mappedSensorId", "model", "power", "status", "temperature",
    ]);

    await request(runtime.app).patch("/api/v1/sensors/sensor-01")
      .send({ tpLinkDeviceId: "t315-discovered" })
      .expect(200);
    await waitFor(() => runtime?.database.getLatestReading("sensor-01")?.source === "tp-link");
    expect(runtime.database.getLatestReading("sensor-01")).toMatchObject({
      source: "tp-link", temperature: 22.5, humidity: expect.any(Number), battery: 87,
    });

    const mapped = await request(runtime.app).get("/api/v1/integrations/tp-link/devices").expect(200);
    expect(mapped.body.devices[0].mappedSensorId).toBe("sensor-01");
    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({ enabled: false }).expect(200);
    const archivedReadingTimestamp = runtime.database.getLatestReading("sensor-01")?.timestamp;
    const archivedAtPoll = runtime.status.value.tpLink.lastPollAt;
    await waitFor(() => runtime?.status.value.tpLink.lastPollAt !== archivedAtPoll);
    expect(runtime.database.getLatestReading("sensor-01")?.timestamp).toBe(archivedReadingTimestamp);
    const archived = await request(runtime.app).get("/api/v1/integrations/tp-link/devices").expect(200);
    expect(archived.body.devices[0].mappedSensorId).toBe("sensor-01");

    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({ tpLinkDeviceId: null }).expect(200);
    const cleared = await request(runtime.app).get("/api/v1/integrations/tp-link/devices").expect(200);
    expect(cleared.body.devices[0].mappedSensorId).toBeNull();
  });

  it("discovers H100/H200 hubs and capability-verified energy devices", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-lan-discovery-"));
    const helperPath = join(temporaryDirectory, "fake-lan-discovery-helper.mjs");
    writeFileSync(helperPath, `
      if (!process.argv.includes("--discover")) process.exit(2);
      if (process.env.TP_LINK_USERNAME !== "draft@example.test" || process.env.TP_LINK_PASSWORD !== "draft-secret") process.exit(3);
      process.stdout.write(JSON.stringify({
        type: "discovery",
        sources: [
          { host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", credential: "must-not-leak" },
          { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", credential: "must-not-leak" },
          { host: "192.168.1.40", model: "P100", alias: "Unverified plug" }
        ],
        warnings: ["One directed broadcast was unreachable"]
      }) + "\\n");
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });

    expect(await runtime.tpLink.discoverSources(undefined, {
      username: "draft@example.test",
      password: "draft-secret",
    })).toEqual({
      sources: [
        { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device" },
        { host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub" },
      ],
      warnings: ["One directed broadcast was unreachable"],
    });
  });
});
