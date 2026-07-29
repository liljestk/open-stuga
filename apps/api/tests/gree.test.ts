import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HeatPumpStateStore } from "../src/heat-pump-state.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";
import type { TimeseriesStore } from "../src/timeseries/store.js";

const MAC = "AABBCCDDEEFF";
const BINDING_KEY = "bound-key-123456";

describe("direct Gree/Wilfa integration", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("binds explicitly, keeps the key write-only, stores typed state, and retains history on disconnect", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-gree-"));
    const helper = join(directory, "gree-helper.mjs");
    const secretsPath = join(directory, "private", "integrations.json");
    writeFileSync(helper, `
      if (process.argv.includes("--discover")) {
        process.stdout.write(JSON.stringify({ type: "discovery", devices: [{
          host: "192.168.1.55", port: 7000, mac: "${MAC}",
          name: "Nordkapp", brand: "Wilfa", model: "Nordkapp 30", version: "4.0"
        }] }) + "\\n");
        process.exit(0);
      }
      const message = {
        type: "bound",
        device: {
          host: "192.168.1.55", port: 7000, mac: "${MAC}",
          name: "Nordkapp", brand: "Wilfa", model: "Nordkapp 30", version: "4.0"
        },
        key: "${BINDING_KEY}",
        cipherVersion: 1,
        state: {
          observedAt: "2026-07-29T08:00:00.000Z",
          available: true,
          power: true,
          selectedMode: "cool",
          targetTemperatureC: 22,
          currentTemperatureC: 25.5,
          currentTemperatureSource: "reported",
          fanSpeed: "Auto",
          horizontalSwing: "Default",
          verticalSwing: "FullSwing",
          quiet: false,
          turbo: false,
          xfan: true,
          activity: "unknown",
          activityEvidence: "unavailable"
        }
      };
      process.stdout.write(JSON.stringify(message) + "\\n");
    `);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      GREE_PYTHON: process.execPath,
      GREE_BRIDGE_SCRIPT: helper,
    });
    runtime = createApi({ config, startBackground: false });

    expect(runtime.status.value.gree).toBeUndefined();
    const discovered = await request(runtime.app)
      .post("/api/v1/integrations/gree/discover")
      .send({ houseId: "house-main" })
      .expect(200);
    expect(discovered.body.devices).toEqual([expect.objectContaining({
      mac: MAC,
      model: "Nordkapp 30",
    })]);
    expect(runtime.status.value.gree).toBeUndefined();

    const configured = await request(runtime.app)
      .put("/api/v1/integrations/gree/config")
      .send({ houseId: "house-main", mac: "aa:bb:cc:dd:ee:ff" })
      .expect(200);

    expect(configured.body).toMatchObject({
      ok: true,
      configured: true,
      connectionId: "gree-aabbccddeeff",
      houseId: "house-main",
      state: {
        power: true,
        selectedMode: "cool",
        activity: "unknown",
        activityEvidence: "unavailable",
      },
      integration: {
        gree: { configured: true, connections: [{ mac: MAC, name: "Nordkapp" }] },
      },
    });
    expect(JSON.stringify(configured.body)).not.toContain(BINDING_KEY);

    const secrets = readIntegrationSecrets(secretsPath);
    expect(secrets.greeConnections).toEqual([expect.objectContaining({
      id: "gree-aabbccddeeff",
      houseId: "house-main",
      host: "192.168.1.55",
      mac: MAC,
      key: BINDING_KEY,
      cipherVersion: 1,
    })]);
    expect(readFileSync(secretsPath, "utf8")).toContain(BINDING_KEY);
    expect(runtime.database.getAreaEquipment(`heat-pump-${MAC.toLowerCase()}`)).toMatchObject({
      houseId: "house-main",
      kind: "air-source-heat-pump",
      manufacturer: "Wilfa",
      model: "Nordkapp 30",
      serialNumber: MAC,
    });

    const states = await request(runtime.app).get("/api/v1/heat-pumps?houseId=house-main").expect(200);
    expect(states.body.states).toEqual([expect.objectContaining({
      connectionId: "gree-aabbccddeeff",
      currentTemperatureC: 25.5,
      currentTemperatureSource: "reported",
    })]);
    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-aabbccddeeff/history")
      .expect(200)
      .expect(({ body }) => expect(body.states).toHaveLength(1));
    expect(runtime.heatPumpStates.archivePage(0, 10)).toEqual([
      expect.objectContaining({
        rowId: 1,
        record: expect.objectContaining({ currentTemperatureC: 25.5 }),
      }),
    ]);

    const disconnected = await request(runtime.app)
      .delete("/api/v1/integrations/gree/config/gree-aabbccddeeff")
      .expect(200);
    expect(disconnected.body.integration.gree).toBeUndefined();
    expect(readIntegrationSecrets(secretsPath).greeConnections).toEqual([]);
    await request(runtime.app).get("/api/v1/heat-pumps?houseId=house-main").expect(200)
      .expect(({ body }) => expect(body.states).toEqual([]));
    await request(runtime.app).get("/api/v1/heat-pumps/gree-aabbccddeeff/history").expect(200)
      .expect(({ body }) => {
        expect(body.states).toHaveLength(2);
        expect(body.states).toEqual(expect.arrayContaining([
          expect.objectContaining({ available: false }),
        ]));
      });
  });

  it("rejects conflicting Gree identities before writing the protected file", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-gree-secrets-"));
    const path = join(directory, "integrations.json");
    expect(() => writeIntegrationSecrets(path, {
      version: 1,
      greeConnections: [
        {
          id: "first", houseId: "house-main", host: "192.168.1.10", port: 7000,
          mac: MAC, key: "first-key", cipherVersion: 1,
        },
        {
          id: "second", houseId: "house-main", host: "192.168.1.11", port: 7000,
          mac: "aa:bb:cc:dd:ee:ff", key: "second-key", cipherVersion: 2,
        },
      ],
    })).toThrow(/conflicting identities/u);
  });

  it("journals every timestamped poll while reporting only semantic changes", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    runtime = createApi({ config, startBackground: false });
    const store = new HeatPumpStateStore(runtime.database);
    const base = {
      connectionId: "gree-history",
      houseId: "house-main",
      equipmentId: null,
      deviceId: MAC,
      name: "Heat pump",
      brand: "Wilfa",
      model: "Nordkapp 30",
      observedAt: "2026-07-29T08:00:00.000Z",
      receivedAt: "2026-07-29T08:00:01.000Z",
      available: true,
      power: true,
      selectedMode: "cool" as const,
      targetTemperatureC: 22,
      currentTemperatureC: null,
      currentTemperatureSource: "unavailable" as const,
      fanSpeed: "Auto",
      horizontalSwing: null,
      verticalSwing: null,
      quiet: false,
      turbo: false,
      xfan: false,
      activity: "unknown" as const,
      activityEvidence: "unavailable" as const,
    };
    expect(store.record(base)).toBe(true);
    expect(store.record({
      ...base,
      observedAt: "2026-07-29T08:01:00.000Z",
      receivedAt: "2026-07-29T08:01:01.000Z",
    })).toBe(false);
    expect(store.record({
      ...base,
      observedAt: "2026-07-29T08:02:00.000Z",
      receivedAt: "2026-07-29T08:02:01.000Z",
      targetTemperatureC: 21,
    })).toBe(true);
    expect(store.history("gree-history")).toHaveLength(3);
    expect(store.archivePage(0, 10).map(({ record }) => record.observedAt)).toEqual([
      "2026-07-29T08:00:00.000Z",
      "2026-07-29T08:01:00.000Z",
      "2026-07-29T08:02:00.000Z",
    ]);
  });

  it("merges TimeDB history and fails closed when retained history cannot be read", async () => {
    const archivedState = {
      connectionId: "gree-history",
      houseId: "house-main",
      equipmentId: null,
      deviceId: MAC,
      name: "Nordkapp",
      brand: "Wilfa",
      model: "Nordkapp 30",
      observedAt: "2024-01-01T08:00:00.000Z",
      receivedAt: "2024-01-01T08:00:01.000Z",
      available: true,
      power: true,
      selectedMode: "heat" as const,
      targetTemperatureC: 21,
      currentTemperatureC: 20,
      currentTemperatureSource: "reported" as const,
      fanSpeed: "Auto",
      horizontalSwing: null,
      verticalSwing: null,
      quiet: false,
      turbo: false,
      xfan: false,
      activity: "unknown" as const,
      activityEvidence: "unavailable" as const,
    };
    const archiveHistory = vi.fn(async () => [archivedState]);
    const timeseriesStore = {
      heatPumpStateHistory: archiveHistory,
      initialize: vi.fn(async () => { throw new Error("TimeDB unavailable"); }),
      close: vi.fn(async () => undefined),
    } as unknown as TimeseriesStore;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      TIMESERIES_ENABLED: "true",
      RETENTION_DAYS: "30",
    });
    runtime = createApi({ config, startBackground: false, timeseriesStore });
    runtime.heatPumpStates.record({
      ...archivedState,
      observedAt: "2026-07-29T08:00:00.000Z",
      receivedAt: "2026-07-29T08:00:01.000Z",
      currentTemperatureC: 21,
    });

    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-history/history")
      .expect(200)
      .expect(({ body }) => {
        expect(body.states.map((state: { observedAt: string }) => state.observedAt)).toEqual([
          "2026-07-29T08:00:00.000Z",
          "2024-01-01T08:00:00.000Z",
        ]);
      });

    archiveHistory.mockRejectedValueOnce(new Error("TimeDB unavailable"));
    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-history/history?from=2024-01-01T00:00:00.000Z")
      .expect(503)
      .expect(({ body }) => {
        expect(body.error).toMatchObject({ code: "TELEMETRY_ARCHIVE_REQUIRED" });
      });
  });
});
