import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { loadTpLinkDeviceMappings, normalizeTpLinkTemperature } from "../src/tp-link.js";

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

  afterEach(() => {
    runtime?.close();
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

    const duplicate = join(temporaryDirectory, "duplicate.json");
    writeFileSync(duplicate, JSON.stringify({ devices: [
      { deviceId: "child-a", sensorId: "sensor-01" },
      { deviceId: "child-a", sensorId: "sensor-02" },
    ] }));
    expect(() => loadTpLinkDeviceMappings(duplicate)).toThrow(/mapped more than once/);
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
      "alias", "battery", "deviceId", "humidity", "lastSeenAt", "mappedSensorId", "model", "status", "temperature",
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

  it("discovers H100/H200 hubs without requiring credentials", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-lan-discovery-"));
    const helperPath = join(temporaryDirectory, "fake-lan-discovery-helper.mjs");
    writeFileSync(helperPath, `
      if (!process.argv.includes("--discover")) process.exit(2);
      process.stdout.write(JSON.stringify({
        type: "discovery",
        hubs: [
          { host: "192.168.1.42", model: "H200", alias: "Hall hub", credential: "must-not-leak" },
          { host: "192.168.1.41", model: "P110", alias: "Not a hub" }
        ]
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

    expect(await runtime.tpLink.discoverHubs()).toEqual([
      { host: "192.168.1.42", model: "H200", alias: "Hall hub" },
    ]);
  });
});
