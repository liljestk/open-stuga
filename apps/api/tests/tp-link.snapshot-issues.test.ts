import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { TpLinkConnectionBridgeCore } from "../src/tp-link/core.js";
import type { TpLinkSnapshotMessage } from "../src/tp-link/support/01-tp-link-local-climate-history-capability-revision-to.js";
import "../src/tp-link.js";

function config(directory: string): AppConfig {
  return {
    port: 0,
    apiHost: "127.0.0.1",
    databasePath: ":memory:",
    integrationSecretsFile: join(directory, "secrets.json"),
    assetDirectory: directory,
    mockEnabled: false,
    mockIntervalMs: 2_000,
    retentionDays: 730,
    ingestApiKey: null,
    haUrl: null,
    haToken: null,
    haEntityMapFile: null,
    tpLinkHost: "192.0.2.10",
    tpLinkUsername: "user",
    tpLinkPassword: "password",
    tpLinkDeviceMapFile: null,
    tpLinkPollIntervalMs: 2_000,
    tpLinkPython: process.execPath,
    tpLinkBridgeScript: "unused.py",
    corsOrigin: null,
    localAuthTestBypass: true,
  };
}

function climateDevice(deviceId: string, overrides: Partial<TpLinkSnapshotMessage["devices"][number]> = {}) {
  return {
    deviceId,
    model: "T315",
    alias: "Climate",
    status: "online",
    temperature: 21,
    temperatureUnit: "celsius",
    humidity: 45,
    battery: 90,
    ...overrides,
  };
}

describe("TP-Link snapshot source checks and per-device issues", () => {
  let runtime: ApiRuntime | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function bridgeFixture(managed: { deviceId?: string } = {}) {
    directory = mkdtempSync(join(tmpdir(), "stugu-tp-link-snapshot-issues-"));
    const appConfig = config(directory);
    runtime = createApi({ config: appConfig, startBackground: false });
    const localStatus = { value: structuredClone(runtime.status.value), changed: vi.fn() };
    localStatus.value.tpLink = {
      configured: true,
      connected: false,
      lastPollAt: null,
      mappedDevices: 0,
      discoveredDevices: 0,
      hubModel: null,
      error: null,
      connections: [],
      host: "192.0.2.10",
    };
    const onUpdate = vi.fn();
    const bridge = new TpLinkConnectionBridgeCore(
      appConfig,
      runtime.telemetry,
      runtime.measurements,
      runtime.database,
      localStatus,
      { id: "connection-1", houseId: "house-main", acceptUnscoped: true },
      { id: "connection-1", houseId: "house-main", host: "192.0.2.10", onUpdate, ...managed },
    );
    return { bridge, status: localStatus.value.tpLink, onUpdate, database: runtime.database };
  }

  const snapshot = (overrides: Partial<TpLinkSnapshotMessage> = {}): TpLinkSnapshotMessage => ({
    type: "snapshot",
    timestamp: new Date().toISOString(),
    hubModel: "H200",
    devices: [],
    ...overrides,
  });

  it("rejects unsupported models and missing or different source identities", () => {
    const { bridge, status, onUpdate } = bridgeFixture({ deviceId: "HUB-A" });

    bridge.ingestSnapshot(snapshot({ hubModel: "X999", sourceDeviceId: "HUB-A" }));
    expect(status).toMatchObject({ connected: false, error: "Unsupported TP-Link source model X999" });

    bridge.ingestSnapshot(snapshot({ hubModel: "", sourceDeviceId: "HUB-A" }));
    expect(status.error).toBe("Unsupported TP-Link source model unknown");

    bridge.ingestSnapshot(snapshot({ sourceDeviceId: "h".repeat(1_025) }));
    expect(status).toMatchObject({ connected: false, error: "TP-Link helper returned an invalid source identity" });

    for (const sourceDeviceId of [null, "HUB-B"]) {
      bridge.ingestSnapshot(snapshot({ sourceDeviceId }));
      expect(status.connected).toBe(false);
      expect(status.error).toContain("missing or different source identity");
    }
    expect(onUpdate).not.toHaveBeenCalled();

    bridge.ingestSnapshot(snapshot({ sourceDeviceId: " hub-a ", sourceAlias: "Hall hub" }));
    expect(status).toMatchObject({ connected: true, error: null, hubModel: "H200", sourceAlias: "Hall hub" });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "hub-a", sourceAlias: "Hall hub", sourceType: "hub" }));
  });

  it("learns the source identity once and accepts energy devices without a hub model", () => {
    const { bridge, status, onUpdate } = bridgeFixture();

    bridge.ingestSnapshot(snapshot({ hubModel: "P110M", sourceType: "energy-device", sourceDeviceId: "PLUG-1" }));
    expect(status).toMatchObject({ connected: true, hubModel: null, sourceType: "energy-device", sourceModel: "P110M" });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "PLUG-1", sourceModel: "P110M", sourceAlias: null }));

    bridge.ingestSnapshot(snapshot({ hubModel: "P110M", sourceType: "energy-device", sourceDeviceId: "PLUG-1" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports each mapped child that is missing, offline or without usable data", () => {
    const { bridge, status, database } = bridgeFixture();
    const [first, second, third] = database.listSensors();
    database.updateSensor(first!.id, { tpLinkDeviceId: "missing-1", tpLinkConnectionId: "connection-1" });
    database.updateSensor(second!.id, { tpLinkDeviceId: "offline-1", tpLinkConnectionId: "connection-1" });
    database.updateSensor(third!.id, { tpLinkDeviceId: "empty-1", tpLinkConnectionId: "connection-1" });

    bridge.ingestSnapshot(snapshot({
      warning: "helper warning",
      devices: [
        climateDevice("offline-1", { status: "offline" }),
        climateDevice("empty-1", { temperature: null, humidity: 40 }),
      ],
    }));

    expect(status.connected).toBe(true);
    expect(status.discoveredDevices).toBe(2);
    expect(status.error?.split("; ")).toEqual(expect.arrayContaining([
      "helper warning",
      "Mapped TP-Link child missing-1 was not found",
      "Mapped TP-Link child offline-1 is offline",
      "Mapped TP-Link device empty-1 does not expose valid climate or energy data",
    ]));
    expect(status.error?.startsWith("helper warning")).toBe(true);
  });

  it("ingests mapped climate and energy readings and reports their availability", () => {
    const { bridge, status, database } = bridgeFixture();
    const [climateSensor, energySensor] = database.listSensors();
    database.updateSensor(climateSensor!.id, { tpLinkDeviceId: "climate-1", tpLinkConnectionId: "connection-1" });
    database.updateSensor(energySensor!.id, { tpLinkDeviceId: "plug-1", tpLinkConnectionId: "connection-1" });
    const now = new Date();

    bridge.ingestSnapshot(snapshot({
      timestamp: now.toISOString(),
      devices: [
        climateDevice("climate-1", { temperature: 22.5, humidity: 41 }),
        climateDevice("plug-1", { model: "P110M", temperature: null, humidity: null, battery: null, power: 125, energy: 3.5 }),
      ],
    }));

    expect(status.error).toBeNull();
    expect(database.getLatestMeasurementSample(climateSensor!.id, "temperature")).toMatchObject({ value: 22.5, source: "tp-link" });
    expect(database.getLatestMeasurementSample(energySensor!.id, "power")).toMatchObject({ value: 125, source: "tp-link" });
    expect(database.getLatestMeasurementSample(energySensor!.id, "energy")).toMatchObject({ value: 3.5, source: "tp-link" });

    const availability = bridge.availability(now)
      .map(({ sensorId, metric, available }) => ({ sensorId, metric, available }));
    expect(availability).toEqual(expect.arrayContaining([
      { sensorId: climateSensor!.id, metric: "temperature", available: true },
      { sensorId: climateSensor!.id, metric: "humidity", available: true },
      { sensorId: energySensor!.id, metric: "power", available: true },
      { sensorId: energySensor!.id, metric: "energy", available: true },
    ]));
    expect(availability.filter((entry) => entry.sensorId === energySensor!.id).map((entry) => entry.metric))
      .not.toContain("temperature");

    bridge.ingestSnapshot(snapshot({
      timestamp: new Date(now.getTime() + 1_000).toISOString(),
      devices: [climateDevice("climate-1", { status: "offline" })],
    }));
    expect(bridge.availability(new Date(now.getTime() + 1_000))
      .filter((entry) => entry.sensorId === climateSensor!.id)
      .every((entry) => !entry.available)).toBe(true);
  });
});
