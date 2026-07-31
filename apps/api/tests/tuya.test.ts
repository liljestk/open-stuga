import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { readIntegrationSecrets } from "../src/integration-secrets.js";
import { TuyaBridge } from "../src/tuya.js";

const LOCAL_KEY = "test-local-key-1234";
const LIGHT_ID = "test-tuya-light";
const METER_ID = "test-tuya-meter";

function helperSource(): string {
  return `
    import { createInterface } from "node:readline";
    const send = (value, done = false) => process.stdout.write(JSON.stringify(value) + "\\n", () => {
      if (done) process.exit(0);
    });
    const profile = (meter) => ({
      id: meter ? "tuya-outlet-dp1-meter-v1" : "tuya-light-dp20-v1",
      kind: meter ? "outlet" : "light",
      capabilities: {
        power: true,
        brightness: !meter,
        colorTemperature: !meter,
        color: !meter,
        measuredPower: meter,
        measuredEnergy: false
      }
    });
    const state = (meter, power) => ({
      observedAt: new Date().toISOString(),
      available: true,
      power,
      brightnessPercent: meter ? null : 52,
      colorTemperatureKelvin: meter ? null : 4000,
      color: meter ? null : { hue: 28, saturation: 20, value: 82 },
      workMode: meter ? null : "white",
      powerWatts: meter ? (power ? 12.4 : 0) : null,
      energyKwh: null,
      currentAmps: meter ? (power ? 0.054 : 0) : null,
      voltageVolts: meter ? 230 : null
    });
    if (process.argv.includes("--discover")) {
      send({ type: "discovery", devices: [{
        host: "192.168.1.60",
        deviceId: "${LIGHT_ID}",
        protocolVersion: "3.5",
        productKey: null,
        mac: null
      }] }, true);
    } else {
      const lines = createInterface({ input: process.stdin });
      if (process.argv.includes("--probe")) {
        lines.once("line", (line) => {
          const input = JSON.parse(line);
          if (input.localKey !== "${LOCAL_KEY}") {
            send({ type: "fatal", message: "Tuya device rejected the local key" }, true);
            return;
          }
          const meter = input.deviceId.includes("meter");
          send({
            type: "verified",
            host: input.host,
            profile: profile(meter),
            state: state(meter, true)
          }, true);
        });
      } else {
        let configuration;
        let power = true;
        lines.on("line", (line) => {
          const input = JSON.parse(line);
          if (!configuration) {
            configuration = input;
            send({
              type: "snapshot",
              host: configuration.host,
              state: state(configuration.profileId.includes("meter"), power)
            });
            return;
          }
          if (input.type !== "command") return;
          if (typeof input.command.power === "boolean") power = input.command.power;
          const meter = configuration.profileId.includes("meter");
          send({ type: "snapshot", host: configuration.host, state: state(meter, power) });
          send({ type: "command-result", requestId: input.requestId });
        });
      }
    }
  `;
}

describe("local Tuya integration", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function setup(): { helper: string; secrets: string } {
    directory = mkdtempSync(join(tmpdir(), "stugu-tuya-"));
    const helper = join(directory, "tuya-helper.mjs");
    const secrets = join(directory, "private", "integrations.json");
    writeFileSync(helper, helperSource());
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secrets,
      TUYA_PYTHON: process.execPath,
      TUYA_BRIDGE_SCRIPT: helper,
      TUYA_POLL_INTERVAL_MS: "60000",
    });
    runtime = createApi({ config, startBackground: false });
    runtime.tuya.start();
    return { helper, secrets };
  }

  it("discovers, verifies, controls, places, and disconnects a light without leaking credentials", async () => {
    const { secrets } = setup();
    const floor = runtime!.database.getHouse("house-main")!.floors[0]!;

    await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId: "house-main",
        host: "8.8.8.8",
        deviceId: LIGHT_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.5",
      })
      .expect(400);

    await request(runtime!.app)
      .post("/api/v1/integrations/tuya/discover")
      .send({ houseId: "house-main" })
      .expect(400);

    await request(runtime!.app)
      .post("/api/v1/integrations/tuya/discover")
      .send({ houseId: "house-main", deviceId: "another-device", localKey: LOCAL_KEY })
      .expect(200)
      .expect(({ body }) => expect(body.devices).toEqual([]));

    await request(runtime!.app)
      .post("/api/v1/integrations/tuya/discover")
      .send({ houseId: "house-main", deviceId: LIGHT_ID, localKey: "wrong-local-key" })
      .expect(422)
      .expect(({ body }) => expect(JSON.stringify(body)).not.toContain("wrong-local-key"));

    await request(runtime!.app)
      .post("/api/v1/integrations/tuya/discover")
      .send({ houseId: "house-main", deviceId: LIGHT_ID, localKey: LOCAL_KEY })
      .expect(200)
      .expect("cache-control", "no-store")
      .expect(({ body }) => {
        expect(body.devices).toEqual([expect.objectContaining({
          host: "192.168.1.60",
          deviceId: LIGHT_ID,
          protocolVersion: "3.5",
        })]);
        expect(JSON.stringify(body)).not.toContain(LOCAL_KEY);
      });
    expect(readIntegrationSecrets(secrets).tuyaConnections ?? []).toEqual([]);

    const configured = await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId: "house-main",
        host: "192.168.1.60",
        deviceId: LIGHT_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.5",
        name: "Reading lamp",
        model: "A60 RGB",
        floorId: floor.id,
        x: 2,
        y: 3,
        z: floor.elevation + 1.2,
      })
      .expect(200);

    expect(configured.body).toMatchObject({
      ok: true,
      configured: true,
      state: {
        provider: "tuya-local",
        kind: "light",
        name: "Reading lamp",
        floorId: floor.id,
        power: true,
        energyKwh: null,
        capabilities: { measuredPower: false, measuredEnergy: false },
      },
      integration: { tuya: { configured: true } },
    });
    expect(JSON.stringify(configured.body)).not.toContain(LOCAL_KEY);
    expect(JSON.stringify(configured.body)).not.toContain(LIGHT_ID);

    const saved = readIntegrationSecrets(secrets).tuyaConnections![0]!;
    expect(saved).toMatchObject({
      houseId: "house-main",
      deviceId: LIGHT_ID,
      localKey: LOCAL_KEY,
      profileId: "tuya-light-dp20-v1",
    });
    expect(saved.sensorId).toBeUndefined();
    expect(readFileSync(secrets, "utf8")).toContain(LOCAL_KEY);
    expect(runtime!.database.getAreaEquipment(saved.equipmentId!)).toMatchObject({
      houseId: "house-main",
      kind: "smart-light",
      status: "active",
    });

    await request(runtime!.app)
      .get("/api/v1/connected-devices?houseId=house-main")
      .expect(200)
      .expect(({ body }) => {
        expect(body.devices).toEqual([expect.objectContaining({
          connectionId: saved.id,
          power: true,
        })]);
        expect(JSON.stringify(body)).not.toContain(LOCAL_KEY);
        expect(JSON.stringify(body)).not.toContain(LIGHT_ID);
      });

    const operationId = "11111111-1111-4111-8111-111111111111";
    await request(runtime!.app)
      .post(`/api/v1/connected-devices/${saved.id}/commands`)
      .send({ operationId, power: false })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ deduplicated: false, state: { power: false } });
      });
    await request(runtime!.app)
      .post(`/api/v1/connected-devices/${saved.id}/commands`)
      .send({ operationId, power: false })
      .expect(200)
      .expect(({ body }) => expect(body.deduplicated).toBe(true));
    await request(runtime!.app)
      .post(`/api/v1/connected-devices/${saved.id}/commands`)
      .send({ operationId, power: true })
      .expect(409);

    await request(runtime!.app)
      .patch(`/api/v1/connected-devices/${saved.id}/placement`)
      .send({ floorId: floor.id, roomId: null, x: 4, y: 5, z: floor.elevation + 1.4 })
      .expect(200)
      .expect(({ body }) => expect(body.state).toMatchObject({ x: 4, y: 5 }));
    await request(runtime!.app)
      .patch(`/api/v1/connected-devices/${saved.id}/placement`)
      .send({})
      .expect(400);
    expect(runtime!.connectedDevices.get(saved.id)).toMatchObject({ floorId: floor.id, x: 4, y: 5 });

    await request(runtime!.app)
      .delete(`/api/v1/integrations/tuya/config/${saved.id}`)
      .expect(200);
    expect(readIntegrationSecrets(secrets).tuyaConnections).toEqual([]);
    expect(runtime!.database.getAreaEquipment(saved.equipmentId!)?.status).toBe("retired");
    await request(runtime!.app).get("/api/v1/connected-devices?houseId=house-main").expect(200)
      .expect(({ body }) => expect(body.devices).toEqual([]));
  });

  it("projects only verified measured power into the canonical Energy path", async () => {
    const { secrets } = setup();
    const floor = runtime!.database.getHouse("house-main")!.floors[0]!;
    await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId: "house-main",
        host: "192.168.1.61",
        deviceId: METER_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.4",
        name: "Desk outlet",
        floorId: floor.id,
        x: 1,
        y: 1,
        z: floor.elevation + .3,
      })
      .expect(200);

    const connection = readIntegrationSecrets(secrets).tuyaConnections![0]!;
    expect(connection.sensorId).toBeTruthy();
    expect(runtime!.database.getSensor(connection.sensorId!)).toMatchObject({
      houseId: "house-main",
      energyMeterRole: "standalone",
      tags: expect.arrayContaining(["energy", "tuya", "local"]),
      enabled: true,
    });
    expect(runtime!.database.getLatestMeasurementSample(connection.sensorId!, "power")).toMatchObject({
      value: 12.4,
      canonicalUnit: "W",
      source: "tuya",
      quality: "good",
    });
    expect(runtime!.database.getLatestMeasurementSample(connection.sensorId!, "energy")).toBeNull();

    await request(runtime!.app)
      .patch(`/api/v1/connected-devices/${connection.id}/placement`)
      .send({ floorId: null, roomId: null, x: null, y: null, z: null })
      .expect(200);
    expect(runtime!.database.getSensor(connection.sensorId!)?.enabled).toBe(false);

    await request(runtime!.app)
      .patch(`/api/v1/connected-devices/${connection.id}/placement`)
      .send({ floorId: floor.id, roomId: null, x: 2, y: 2, z: floor.elevation + .3 })
      .expect(200);
    expect(runtime!.database.getSensor(connection.sensorId!)).toMatchObject({
      enabled: true,
      x: 2,
      y: 2,
    });
  });

  it("rejects floor-plan changes that would orphan a placed connected device", async () => {
    setup();
    const houseId = "tuya-layout-home";
    const floor = { id: "ground", name: "Ground", width: 8, height: 6, elevation: 0, walls: [], rooms: [] };
    await request(runtime!.app).post("/api/v1/houses").send({
      id: houseId,
      propertyId: "property-main",
      name: "Layout test",
      timezone: "Europe/Helsinki",
      floors: [floor],
    }).expect(201);
    await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId,
        host: "192.168.1.60",
        deviceId: LIGHT_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.5",
        floorId: floor.id,
      })
      .expect(200);

    await request(runtime!.app)
      .put(`/api/v1/houses/${houseId}/layout`)
      .send({ floors: [{ ...floor, id: "replacement" }] })
      .expect(409)
      .expect(({ body }) => {
        expect(body.error?.code).toBe("LAYOUT_ORPHANS_CONNECTED_DEVICE");
      });
    expect(runtime!.database.getHouse(houseId)?.floors[0]?.id).toBe(floor.id);
  });

  it("rolls back inventory and preserves pre-existing telemetry when credential persistence fails", async () => {
    const { secrets } = setup();
    const floor = runtime!.database.getHouse("house-main")!.floors[0]!;
    const connectionId = TuyaBridge.connectionId(METER_ID);
    const energySensorId = `tuya-energy-${connectionId.slice("tuya-".length)}`;
    runtime!.database.createSensor({
      id: energySensorId,
      houseId: "house-main",
      floorId: floor.id,
      name: "Preserved meter",
      roomId: null,
      room: "",
      model: "Existing meter",
      x: 1,
      y: 1,
      z: floor.elevation + .3,
      energyMeterRole: "standalone",
      tags: ["energy"],
      enabled: false,
    });
    mkdirSync(secrets, { recursive: true });

    await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId: "house-main",
        host: "192.168.1.61",
        deviceId: METER_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.4",
        floorId: floor.id,
        x: 1,
        y: 1,
        z: floor.elevation + .3,
      })
      .expect(500);

    expect(runtime!.database.getSensor(energySensorId)).toMatchObject({
      name: "Preserved meter",
      enabled: false,
      tags: ["energy"],
    });
    expect(runtime!.database.getAreaEquipment(`equipment-${connectionId}`)).toBeNull();
    expect(runtime!.connectedDevices.get(connectionId)).toBeNull();
  });

  it("keeps a Home intact when its combined credential revocation cannot be persisted", async () => {
    const { secrets } = setup();
    const houseId = "tuya-delete-home";
    const floor = { id: "ground", name: "Ground", width: 8, height: 6, elevation: 0, walls: [], rooms: [] };
    await request(runtime!.app).post("/api/v1/houses").send({
      id: houseId,
      propertyId: "property-main",
      name: "Delete test",
      timezone: "Europe/Helsinki",
      floors: [floor],
    }).expect(201);
    await request(runtime!.app)
      .put("/api/v1/integrations/tuya/config")
      .send({
        houseId,
        host: "192.168.1.60",
        deviceId: LIGHT_ID,
        localKey: LOCAL_KEY,
        protocolVersion: "3.5",
        floorId: floor.id,
      })
      .expect(200);
    const connection = readIntegrationSecrets(secrets).tuyaConnections?.[0];
    expect(connection).toBeDefined();
    runtime!.connectedDevices.deleteConnection(connection!.id);
    if (connection!.equipmentId) runtime!.database.deleteAreaEquipment(connection!.equipmentId);
    rmSync(secrets, { force: true });
    mkdirSync(secrets);

    await request(runtime!.app).delete(`/api/v1/houses/${houseId}`).expect(500);

    expect(runtime!.database.getHouse(houseId)).not.toBeNull();
    expect(runtime!.status.value.tuya?.connections).toContainEqual(
      expect.objectContaining({ id: connection!.id, houseId }),
    );
  });
});
