import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

class SqliteD1Statement {
  #statement;
  #values = [];

  constructor(statement) {
    this.#statement = statement;
  }

  bind(...values) {
    this.#values = values;
    return this;
  }

  async first() {
    return this.#statement.get(...this.#values) ?? null;
  }

  async all() {
    return { results: this.#statement.all(...this.#values), success: true, meta: {} };
  }

  async run() {
    const result = this.#statement.run(...this.#values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database.prepare(query));
  }

  async batch(statements) {
    const results = [];
    this.database.exec("BEGIN");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryR2Bucket {
  objects = new Map();

  async put(key, value, options = {}) {
    this.objects.set(key, { bytes: new Uint8Array(value), contentType: options.httpMetadata?.contentType });
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes]).stream(),
      httpEtag: '"test-etag"',
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

const databases = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length) databases.pop().close();
});

function testEnvironment() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(readFileSync(new URL("../migrations/0001_multi_tenant_core.sql", import.meta.url), "utf8"));
  return {
    DB: new SqliteD1(database),
    ASSET_BUCKET: new MemoryR2Bucket(),
    ASSETS: {},
    AUTH_MODE: "development",
    DEV_USER_EMAIL: "owner@example.com",
    TEAM_DOMAIN: "https://CHANGE-ME.cloudflareaccess.com",
    POLICY_AUD: "CHANGE-ME",
    INGEST_MIN_INTERVAL_SECONDS: "600",
    RAW_RETENTION_DAYS: "30",
  };
}

function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  let body;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return new Request(`http://localhost${path}`, { method: options.method ?? "GET", headers, body });
}

async function call(env, path, options) {
  return worker.fetch(apiRequest(path, options), env, {});
}

async function jsonBody(response) {
  return response.json();
}

describe("hosted worker request boundary", () => {
  it("keeps public health available while restricting development auth to localhost", async () => {
    const env = testEnvironment();
    const health = await call(env, "/api/v1/health");
    expect(health.status).toBe(200);
    await expect(jsonBody(health)).resolves.toMatchObject({ status: "ok", runtime: "cloudflare-workers" });

    const missing = await call(env, "/api/v1/not-a-route");
    expect(missing.status).toBe(404);

    const remoteRequest = new Request("https://example.com/api/v1/session");
    const rejected = await worker.fetch(remoteRequest, env, {});
    expect(rejected.status).toBe(403);
    await expect(jsonBody(rejected)).resolves.toMatchObject({ error: { code: "DEVELOPMENT_AUTH_REJECTED" } });
  });

  it("routes tenant-scoped houses, sensors, telemetry, and observations end to end", async () => {
    const env = testEnvironment();
    const session = await call(env, "/api/v1/session");
    expect(session.status).toBe(200);
    await expect(jsonBody(session)).resolves.toMatchObject({ authenticated: true, tenant: { role: "owner" } });

    const floor = await call(env, "/api/v1/houses/house-home/floors/floor-ground", {
      method: "PUT",
      body: {
        id: "floor-ground", name: "Ground floor", type: "ground", width: 1000, height: 640,
        elevation: 0, ceilingHeight: 2.8, walls: [], rooms: [], planElements: [],
      },
    });
    expect(floor.status).toBe(200);

    const invalidFloor = await call(env, "/api/v1/houses/house-home/floors/floor-ground", {
      method: "PUT",
      body: { id: "floor-ground", name: "Broken", width: -1, height: 10, elevation: 0, walls: [], rooms: [] },
    });
    expect(invalidFloor.status).toBe(400);

    const createdHouse = await call(env, "/api/v1/houses", {
      method: "POST",
      body: { id: "house-two", name: "Second home", timezone: "Europe/Helsinki", floors: [] },
    });
    expect(createdHouse.status).toBe(201);

    const renamedHouse = await call(env, "/api/v1/houses/house-two", {
      method: "PATCH",
      body: {
        name: "Sauna",
        location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
        mapPlacement: { latitude: 60.17, longitude: 24.94, metersPerPlanUnit: 0.25 },
      },
    });
    await expect(jsonBody(renamedHouse)).resolves.toMatchObject({ house: { name: "Sauna", location: { label: "Helsinki" } } });

    const invalidLocation = await call(env, "/api/v1/houses/house-two", {
      method: "PATCH",
      body: { location: { latitude: "north", longitude: 24.94 } },
    });
    expect(invalidLocation.status).toBe(400);

    const sensor = {
      id: "sensor-two", houseId: "house-two", floorId: "floor", name: "Sauna sensor",
      room: "Sauna", model: "T315", x: 1, y: 2, z: 1.4, tags: [], enabled: true,
    };
    const createdSensor = await call(env, "/api/v1/sensors", { method: "POST", body: sensor });
    expect(createdSensor.status).toBe(201);

    const timestamp = new Date().toISOString();
    const ingested = await call(env, "/api/v2/measurements", {
      method: "POST",
      body: [
        { sensorId: sensor.id, metric: "temperature", value: 22.4, timestamp, source: "api" },
        { sensorId: sensor.id, metric: "humidity", value: 48, timestamp, source: "api" },
      ],
    });
    expect(ingested.status).toBe(201);
    await expect(jsonBody(ingested)).resolves.toMatchObject({ accepted: 2, persistedBuckets: 1 });

    const snapshot = await call(env, "/api/v2/measurements/snapshot?houseId=house-two");
    await expect(jsonBody(snapshot)).resolves.toMatchObject({ snapshot: [{ sensorId: sensor.id }] });

    const history = await call(env, `/api/v2/measurements/history?sensorId=${sensor.id}&metric=temperature&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`);
    await expect(jsonBody(history)).resolves.toMatchObject({ samples: [{ value: 22.4 }] });

    const observation = await call(env, "/api/v1/observations", {
      method: "POST",
      body: {
        houseId: " house-two ", floorId: "floor", sensorId: sensor.id, kind: "note", severity: "info",
        note: "Checked ventilation", x: 1, y: 2, occurredAt: "2026-07-14T12:00:00+03:00",
      },
    });
    expect(observation.status).toBe(201);
    await expect(jsonBody(observation)).resolves.toMatchObject({ houseId: "house-two", occurredAt: "2026-07-14T09:00:00.000Z" });

    const invalidObservation = await call(env, "/api/v1/observations", {
      method: "POST",
      body: { houseId: "house-two", occurredAt: { invalid: true } },
    });
    expect(invalidObservation.status).toBe(400);
  });

  it("enforces API-token scopes and interactive-only tenant administration", async () => {
    const env = testEnvironment();
    await call(env, "/api/v1/session");
    const tokenResponse = await call(env, "/api/v1/tenant/tokens", {
      method: "POST",
      body: { label: "dashboard", scopes: ["read"] },
    });
    const token = (await jsonBody(tokenResponse)).token.value;
    const authorization = { authorization: `bearer ${token}` };

    const houses = await call(env, "/api/v1/houses", { headers: authorization });
    expect(houses.status).toBe(200);

    const writeDenied = await call(env, "/api/v1/houses", {
      method: "POST",
      headers: authorization,
      body: { name: "Denied", timezone: "UTC", floors: [] },
    });
    expect(writeDenied.status).toBe(403);
    await expect(jsonBody(writeDenied)).resolves.toMatchObject({ error: { code: "API_TOKEN_SCOPE_REQUIRED" } });

    const adminDenied = await call(env, "/api/v1/tenant/tokens", { headers: authorization });
    expect(adminDenied.status).toBe(403);
    await expect(jsonBody(adminDenied)).resolves.toMatchObject({ error: { code: "INTERACTIVE_IDENTITY_REQUIRED" } });

    const malformed = await call(env, "/api/v1/houses", { headers: { authorization: "Bearer stuga_short" } });
    expect(malformed.status).toBe(401);
    await expect(jsonBody(malformed)).resolves.toMatchObject({ error: { code: "INVALID_API_TOKEN" } });
  });

  it("stores and streams only tenant-authorized asset types", async () => {
    const env = testEnvironment();
    await call(env, "/api/v1/session");
    const uploaded = await call(env, "/api/v1/assets", {
      method: "POST",
      body: {
        houseId: "house-home", name: " plan.png ", mimeType: "image/png", kind: "floor-plan",
        data: btoa("test image"),
      },
    });
    expect(uploaded.status).toBe(201);
    const metadata = await jsonBody(uploaded);
    expect(metadata.name).toBe("plan.png");

    const downloaded = await call(env, `/api/v1/assets/${metadata.id}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    await expect(downloaded.text()).resolves.toBe("test image");

    const removed = await call(env, `/api/v1/assets/${metadata.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(env.ASSET_BUCKET.objects.size).toBe(0);
  });

  it("dispatches tenant administration and token lifecycle routes", async () => {
    const env = testEnvironment();
    await call(env, "/api/v1/session");

    const renamed = await call(env, "/api/v1/tenant", { method: "PATCH", body: { name: "Family Stuga" } });
    await expect(jsonBody(renamed)).resolves.toMatchObject({ tenant: { name: "Family Stuga", role: "owner" } });

    const invitation = await call(env, "/api/v1/tenant/members", {
      method: "POST",
      body: { email: "guest@example.com", role: "admin" },
    });
    expect(invitation.status).toBe(201);
    const members = await call(env, "/api/v1/tenant/members");
    await expect(jsonBody(members)).resolves.toMatchObject({
      members: [expect.objectContaining({ email: "owner@example.com", role: "owner" })],
      invitations: [expect.objectContaining({ email: "guest@example.com", role: "admin" })],
    });

    const removedInvitation = await call(env, "/api/v1/tenant/members/guest%40example.com", { method: "DELETE" });
    expect(removedInvitation.status).toBe(204);

    const created = await call(env, "/api/v1/tenant/tokens", {
      method: "POST",
      body: { label: "connector", scopes: ["read", "ingest"] },
    });
    const token = (await jsonBody(created)).token;
    const tokens = await call(env, "/api/v1/tenant/tokens");
    await expect(jsonBody(tokens)).resolves.toMatchObject({ tokens: [expect.objectContaining({ id: token.id, scopes: ["read", "ingest"] })] });

    const revoked = await call(env, `/api/v1/tenant/tokens/${token.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    const rejected = await call(env, "/api/v1/houses", { headers: { authorization: `Bearer ${token.value}` } });
    expect(rejected.status).toBe(401);
  });

  it("dispatches compatibility telemetry, definitions, and domain resource routes", async () => {
    const env = testEnvironment();
    await call(env, "/api/v1/session");
    const sensorBody = {
      id: "sensor-domain", houseId: "house-home", floorId: "floor-ground", name: "Living room",
      room: "Living room", model: "T315", x: 2, y: 3, z: 1.2, tags: ["primary"], enabled: true,
    };
    await call(env, "/api/v1/sensors", { method: "POST", body: sensorBody });
    const updatedSensor = await call(env, `/api/v1/sensors/${sensorBody.id}`, {
      method: "PUT",
      body: { ...sensorBody, name: "Main sensor", enabled: false },
    });
    await expect(jsonBody(updatedSensor)).resolves.toMatchObject({ sensor: { name: "Main sensor", enabled: false } });

    const timestamp = new Date().toISOString();
    const legacy = await call(env, "/api/v1/readings", {
      method: "POST",
      body: { reading: { sensorId: sensorBody.id, temperature: 21, humidity: 44, battery: 88, timestamp, source: "tp-link" } },
    });
    expect(legacy.status).toBe(201);
    await expect(jsonBody(await call(env, "/api/v1/readings/latest"))).resolves.toMatchObject({ readings: [{ sensorId: sensorBody.id }] });
    await expect(jsonBody(await call(env, `/api/v1/readings?sensorId=${sensorBody.id}&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`))).resolves.toMatchObject({ readings: [{ temperature: 21 }] });
    expect((await call(env, "/api/v1/events")).headers.get("content-type")).toContain("text/event-stream");

    const definition = await call(env, "/api/v2/measurement-definitions", {
      method: "POST",
      body: { id: "voc", labels: { en: "VOC" }, unit: "ppb", precision: 0, enabled: true },
    });
    expect(definition.status).toBe(201);
    await expect(jsonBody(await call(env, "/api/v2/measurement-definitions"))).resolves.toMatchObject({ definitions: expect.arrayContaining([expect.objectContaining({ id: "voc" })]) });
    await expect(jsonBody(await call(env, "/api/v2/measurement-definitions/voc", { method: "PATCH", body: { unit: "µg/m³" } }))).resolves.toMatchObject({ definition: { unit: "µg/m³" } });
    await call(env, "/api/v2/measurement-definitions/voc", { method: "DELETE" });

    const ruleResponse = await call(env, "/api/v1/alert-rules", {
      method: "POST",
      body: { id: "rule", name: "Humidity", sensorId: sensorBody.id, metric: "humidity", operator: "gte", threshold: 65, durationSeconds: 60, severity: "warning", enabled: true },
    });
    expect(ruleResponse.status).toBe(201);
    await expect(jsonBody(await call(env, "/api/v1/alert-rules"))).resolves.toMatchObject({ rules: [expect.objectContaining({ id: "rule" })] });
    await expect(jsonBody(await call(env, "/api/v1/alert-rules/rule", { method: "PATCH", body: { threshold: 70 } }))).resolves.toMatchObject({ threshold: 70 });
    expect((await call(env, "/api/v1/alert-rules/rule", { method: "DELETE" })).status).toBe(204);

    const observationResponse = await call(env, "/api/v1/observations", {
      method: "POST",
      body: { houseId: "house-home", floorId: "floor-ground", sensorId: null, kind: "maintenance", severity: "info", note: "Filter", x: 1, y: 1 },
    });
    const observation = await jsonBody(observationResponse);
    await expect(jsonBody(await call(env, "/api/v1/observations?houseId=house-home"))).resolves.toMatchObject({ observations: [expect.objectContaining({ id: observation.id })] });
    expect((await call(env, `/api/v1/observations/${observation.id}`, { method: "DELETE" })).status).toBe(204);

    const parameterResponse = await call(env, "/api/v1/parameters", {
      method: "POST",
      body: { houseId: "house-home", scopeType: "house", scopeId: "house-home", key: "insulation", value: 1, unit: null },
    });
    const parameter = await jsonBody(parameterResponse);
    await expect(jsonBody(await call(env, "/api/v1/static-parameters?houseId=house-home"))).resolves.toMatchObject({ parameters: [expect.objectContaining({ id: parameter.id })] });
    expect((await call(env, `/api/v1/parameters/${parameter.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await call(env, `/api/v1/sensors/${sensorBody.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("dispatches location, weather, integration-boundary, and scheduled-retention paths", async () => {
    const env = testEnvironment();
    await call(env, "/api/v1/session");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "geocoding-api.open-meteo.com") {
        return Response.json({ results: [{ id: 1, name: "Helsinki", latitude: 60.17, longitude: 24.94, timezone: "Europe/Helsinki" }] });
      }
      if (parsed.searchParams.get("timezone") === "auto") return Response.json({ timezone: "Europe/Helsinki" });
      return Response.json({ hourly: { time: ["2026-07-14T12:00:00Z"], temperature_2m: [18], relative_humidity_2m: [50] } });
    }));

    await expect(jsonBody(await call(env, "/api/v1/locations/search?q=Helsinki&language=en"))).resolves.toMatchObject({ results: [expect.objectContaining({ name: "Helsinki" })] });
    await expect(jsonBody(await call(env, "/api/v1/locations/defaults?latitude=60.17&longitude=24.94"))).resolves.toMatchObject({ timezone: "Europe/Helsinki" });
    await call(env, "/api/v1/houses/house-home", { method: "PATCH", body: { location: { latitude: 60.17, longitude: 24.94 } } });
    await expect(jsonBody(await call(env, "/api/v1/houses/house-home/weather?hours=1"))).resolves.toMatchObject({ weather: { current: { temperatureC: 18 } } });
    expect((await call(env, "/api/v1/houses/house-home/thermal-simulation")).status).toBe(501);

    await expect(jsonBody(await call(env, "/api/v1/integrations/status"))).resolves.toMatchObject({ homeAssistant: { configured: false } });
    await expect(jsonBody(await call(env, "/api/v1/integrations/discover", { method: "POST" }))).resolves.toMatchObject({ homeAssistant: [], tpLink: [] });
    expect((await call(env, "/api/v1/integrations/home-assistant/config", { method: "PUT", body: {} })).status).toBe(409);
    await expect(jsonBody(await call(env, "/api/v1/integrations/tp-link/test", { method: "POST" }))).resolves.toMatchObject({ ok: false });
    await expect(jsonBody(await call(env, "/api/v1/integrations/home-assistant/setup"))).resolves.toMatchObject({ hosted: true, credentialStorage: "local-only" });
    await expect(jsonBody(await call(env, "/api/v1/mock/scenarios"))).resolves.toMatchObject({ enabled: false });

    const timestamp = "2020-01-01T00:00:00.000Z";
    await env.DB.prepare(`INSERT INTO sensors(tenant_id, id, house_id, data_json, created_at, updated_at)
      SELECT id, 'old-sensor', 'house-home', ?, ?, ? FROM tenants LIMIT 1`)
      .bind(JSON.stringify({ id: "old-sensor", houseId: "house-home" }), timestamp, timestamp).run();
    await env.DB.prepare(`INSERT INTO telemetry_samples
      (tenant_id, sensor_id, timestamp, source, quality, values_json, units_json, created_at, updated_at)
      SELECT id, 'old-sensor', ?, 'api', 'good', '{}', '{}', ?, ? FROM tenants LIMIT 1`)
      .bind(timestamp, timestamp, timestamp).run();
    let retentionTask;
    await worker.scheduled({}, env, { waitUntil(promise) { retentionTask = promise; } });
    await retentionTask;
    const retained = await env.DB.prepare("SELECT COUNT(*) AS count FROM telemetry_samples").first();
    expect(retained.count).toBe(0);
  });
});
