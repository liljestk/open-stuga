import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { TpLinkConnectionBridgeCore } from "../src/tp-link/core.js";
import "../src/tp-link.js";
import { waitFor } from "./waitForTestSupport.js";

function config(directory: string, helperPath: string): AppConfig {
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
    tpLinkBridgeScript: helperPath,
    corsOrigin: null,
    localAuthTestBypass: true,
  };
}

describe("TP-Link polling wake efficiency", () => {
  let runtime: ApiRuntime | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("publishes status and wakes recovery only on availability transitions", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-tp-link-wakes-"));
    const appConfig = config(directory, "unused.py");
    runtime = createApi({ config: appConfig, startBackground: false });
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "climate-1",
      tpLinkConnectionId: "connection-1",
    });
    const localStatus = {
      value: structuredClone(runtime.status.value),
      changed: vi.fn(),
    };
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
    const onAvailabilityChange = vi.fn();
    const bridge = new TpLinkConnectionBridgeCore(
      appConfig,
      runtime.telemetry,
      runtime.measurements,
      runtime.database,
      localStatus,
      { id: "connection-1", houseId: "house-main", acceptUnscoped: true },
      {
        id: "connection-1",
        houseId: "house-main",
        host: "192.0.2.10",
        onAvailabilityChange,
      },
    );
    const snapshot = (status: "online" | "offline", offsetMs: number) => ({
      type: "snapshot" as const,
      timestamp: new Date(Date.now() + offsetMs).toISOString(),
      hubModel: "H200",
      devices: [{
        deviceId: "climate-1",
        model: "T315",
        alias: "Climate",
        status,
        temperature: 21,
        temperatureUnit: "celsius",
        humidity: 45,
        battery: 90,
      }],
    });

    bridge.ingestSnapshot(snapshot("online", 0));
    bridge.ingestSnapshot(snapshot("online", 2_000));
    expect(localStatus.changed).toHaveBeenCalledTimes(1);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1);

    bridge.ingestSnapshot(snapshot("offline", 4_000));
    bridge.ingestSnapshot(snapshot("offline", 6_000));
    expect(localStatus.changed).toHaveBeenCalledTimes(2);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(2);

    bridge.ingestSnapshot(snapshot("online", 8_000));
    expect(localStatus.changed).toHaveBeenCalledTimes(3);
    expect(onAvailabilityChange).toHaveBeenCalledTimes(3);
  });

  it("starts the 500 ms contact loop only while an opening target is configured", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-tp-link-contact-loop-"));
    const helperPath = join(directory, "contact-loop-env.mjs");
    writeFileSync(helperPath, `
      const emit = () => process.stdout.write(JSON.stringify({
          type: "snapshot",
          timestamp: new Date().toISOString(),
          hubModel: "H200",
          sourceAlias: process.env.TP_LINK_CONTACT_EVENTS_ENABLED,
          devices: []
        }) + "\\n");
      emit();
      setInterval(emit, 50);
    `);
    runtime = createApi({ config: config(directory, helperPath), startBackground: false });
    runtime.tpLink.start();
    await waitFor(() => runtime?.status.value.tpLink.sourceAlias === "0");

    const house = runtime.database.getHouse("house-main")!;
    const floors = structuredClone(house.floors);
    floors[0]!.planElements = [...(floors[0]!.planElements ?? []), {
      id: "entry-contact",
      kind: "door",
      wallId: floors[0]!.walls[0]!.id,
      position: {
        x: floors[0]!.walls[0]!.from.x,
        y: floors[0]!.walls[0]!.from.y,
      },
      rotationDegrees: 0,
      state: "closed",
      stateBinding: { provider: "tapo", externalId: "contact-1" },
    }];
    runtime.database.updateHouse(house.id, { floors });

    await waitFor(() => runtime?.status.value.tpLink.sourceAlias === "1");
  });
});
