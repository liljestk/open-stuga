import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import type { AppConfig } from "../src/config.js";

import { waitFor } from "./waitForTestSupport.js";

describe("direct TP-Link H100/H200/H500 bridge", () => {
  let runtime: ApiRuntime | null = null;

  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
    vi.unstubAllEnvs();
  });

  it("runs independent TP-Link meter connections per house", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-houses-"));
    const helperPath = join(temporaryDirectory, "fake-house-meters.mjs");
    writeFileSync(helperPath, `
      const second = process.env.TP_LINK_HOST === "192.0.2.32";
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date(Date.now() - 1000).toISOString(),
        sourceType: "energy-device", hubModel: "P110", sourceAlias: second ? "Cottage meter" : "Home meter", devices: [{
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
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath, tpLinkDiscoveryTargets: ["192.168.71.255"],
      corsOrigin: null,
      localAuthTestBypass: true,
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
      expect.objectContaining({
        id: "main-meter", houseId: "house-main", connected: true, host: "192.0.2.31",
        sourceType: "energy-device", sourceModel: "P110", sourceAlias: "Home meter",
      }),
      expect.objectContaining({
        id: "cottage-meter", houseId: "house-cottage", connected: true, host: "192.0.2.32",
        sourceType: "energy-device", sourceModel: "P110", sourceAlias: "Cottage meter",
      }),
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
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath, tpLinkDiscoveryTargets: ["192.168.71.255"],
      corsOrigin: null,
      localAuthTestBypass: true,
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
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath, tpLinkDiscoveryTargets: ["192.168.71.255"],
      corsOrigin: null,
      localAuthTestBypass: true,
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
      deviceType: "climate",
      mappedSensorId: null,
      mappedOpening: null,
    });
    expect(Object.keys(discovered.body.devices[0]).sort()).toEqual([
      "alias", "battery", "contactOpen", "deviceId", "deviceType", "energy", "houseId", "humidity", "lastSeenAt", "mappedOpening", "mappedSensorId", "model", "power", "status", "temperature",
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

  it("discovers H100/H200/H500 hubs and capability-verified energy devices", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-lan-discovery-"));
    const helperPath = join(temporaryDirectory, "fake-lan-discovery-helper.mjs");
    writeFileSync(helperPath, `
      if (!process.argv.includes("--discover")) process.exit(2);
      if (process.env.TP_LINK_USERNAME !== "draft@example.test" || process.env.TP_LINK_PASSWORD !== "draft-secret") process.exit(3);
      process.stdout.write(JSON.stringify({
        type: "discovery",
        sources: [
          { host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: "h200-source", credential: "must-not-leak" },
          { host: "192.168.1.43", model: "H500", alias: "HomeBase", sourceType: "hub", deviceId: "h500-source", credential: "must-not-leak" },
          { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: "p110-source", credential: "must-not-leak" },
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
      tpLinkConnections: [{
        id: "saved-laundry", houseId: "house-main", host: "192.168.1.99",
        username: "draft@example.test", password: "draft-secret", deviceId: "P110-SOURCE",
      }],
      tpLinkLegacyDisabled: true,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      corsOrigin: null,
      localAuthTestBypass: true,
    };
    runtime = createApi({ config, startBackground: false });

    expect(await runtime.tpLink.discoverSources(undefined, {
      username: "draft@example.test",
      password: "draft-secret",
    })).toEqual({
      sources: [
        { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: "p110-source", configuredConnectionId: "saved-laundry" },
        { host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: "h200-source" },
        { host: "192.168.1.43", model: "H500", alias: "HomeBase", sourceType: "hub", deviceId: "h500-source" },
      ],
      warnings: ["One directed broadcast was unreachable"],
    });
  });

  it("keeps an H500 connected while surfacing hidden local children", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-h500-"));
    const helperPath = join(temporaryDirectory, "fake-h500-helper.mjs");
    const warning = "H500 connected, but its local API reports 3 paired devices and exposes 0 to Stugu; only locally exposed devices are available.";
    writeFileSync(helperPath, `
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), sourceType: "hub",
        hubModel: "H500", sourceDeviceId: "h500-source", reportedChildCount: 3,
        warning: ${JSON.stringify(warning)}, devices: []
      }) + "\\n");
      if (process.argv.includes("--list")) process.exit(0);
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.168.1.50", tpLinkUsername: "user", tpLinkPassword: "password",
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath, tpLinkDiscoveryTargets: ["192.168.71.255"],
      corsOrigin: null,
      localAuthTestBypass: true,
    };
    runtime = createApi({ config, startBackground: false });
    await expect(runtime.tpLink.testCredentials("192.168.1.50", "user", "password"))
      .resolves.toMatchObject({
        ok: true,
        connected: true,
        message: warning,
        details: { model: "H500", sourceType: "hub", warning },
      });
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.connected === true);
    expect(runtime.status.value.tpLink).toMatchObject({
      connected: true,
      hubModel: "H500",
      error: warning,
    });
  });

  it("tries every saved sign-in when searching for additional TP-Link sources", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-multi-account-discovery-"));
    const helperPath = join(temporaryDirectory, "fake-multi-account-discovery-helper.mjs");
    writeFileSync(helperPath, `
      if (!process.argv.includes("--discover")) process.exit(2);
      const source = process.env.TP_LINK_USERNAME === "first@example.test"
        ? { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: "p110-source" }
        : process.env.TP_LINK_USERNAME === "second@example.test"
          ? { host: "192.168.1.42", model: "P115", alias: "Water heater", sourceType: "energy-device", deviceId: "p115-source" }
          : null;
      if (!source) process.exit(3);
      process.stdout.write(JSON.stringify({ type: "discovery", sources: [source], warnings: [] }) + "\\n");
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
      tpLinkConnections: [
        { id: "saved-first", houseId: "house-main", host: "192.168.1.10", username: "first@example.test", password: "first-secret", deviceId: "saved-first-source" },
        { id: "saved-second", houseId: "house-main", host: "192.168.1.11", username: "second@example.test", password: "second-secret", deviceId: "saved-second-source" },
      ],
      tpLinkLegacyDisabled: true,
      tpLinkPollIntervalMs: 10_000, tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      corsOrigin: null,
      localAuthTestBypass: true,
    };
    runtime = createApi({ config, startBackground: false });

    expect(await runtime.tpLink.discoverSources("house-main")).toEqual({
      sources: [
        { host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: "p110-source" },
        { host: "192.168.1.42", model: "P115", alias: "Water heater", sourceType: "energy-device", deviceId: "p115-source" },
      ],
      warnings: [],
    });
  });

  it("passes LAN discovery targets to the live address-recovery helper", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-live-recovery-"));
    const helperPath = join(temporaryDirectory, "fake-live-recovery-helper.mjs");
    writeFileSync(helperPath, `
      if (process.env.TP_LINK_DISCOVERY_TARGETS !== "192.168.71.255") process.exit(3);
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), sourceType: "hub",
        hubModel: "H200", sourceDeviceId: "stable-hub", devices: []
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.168.68.54", tpLinkUsername: "user", tpLinkPassword: "password",
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 10_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath, tpLinkDiscoveryTargets: ["192.168.71.255"],
      corsOrigin: null,
      localAuthTestBypass: true,
    };
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();

    await waitFor(() => runtime?.status.value.tpLink.connected === true);
    expect(runtime.status.value.tpLink.hubModel).toBe("H200");
  });
});
