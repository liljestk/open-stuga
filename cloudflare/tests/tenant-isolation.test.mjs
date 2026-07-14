import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHouse,
  createSensor,
  deleteHouse,
  getHouse,
  insertTelemetry,
  latestTelemetryRows,
  saveStaticParameter,
  updateHouse,
} from "../src/data.js";
import { resolveTenant } from "../src/tenant.js";

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

const databases = [];

afterEach(() => {
  while (databases.length) databases.pop().close();
});

function testEnvironment() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(readFileSync(new URL("../migrations/0001_multi_tenant_core.sql", import.meta.url), "utf8"));
  return { DB: new SqliteD1(database) };
}

function request(tenantId) {
  return new Request("http://localhost/api/v1/session", tenantId ? { headers: { "X-Stuga-Tenant": tenantId } } : undefined);
}

function principal(email) {
  return { kind: "development", email, subject: `development:${email}` };
}

describe("hosted tenant isolation", () => {
  it("denies forged tenant selection and scopes duplicate resource IDs", async () => {
    const env = testEnvironment();
    const alice = principal("alice@example.com");
    const bob = principal("bob@example.com");
    const aliceTenant = await resolveTenant(request(), alice, env);
    const bobTenant = await resolveTenant(request(), bob, env);

    expect(aliceTenant.id).not.toBe(bobTenant.id);
    await expect(resolveTenant(request(bobTenant.id), alice, env)).rejects.toMatchObject({
      status: 403,
      code: "TENANT_ACCESS_DENIED",
    });

    const sharedId = "same-visible-id";
    await createHouse(env.DB, aliceTenant.id, { id: sharedId, name: "Alice home", timezone: "UTC", floors: [] });
    await createHouse(env.DB, bobTenant.id, { id: sharedId, name: "Bob home", timezone: "UTC", floors: [] });
    await createHouse(env.DB, bobTenant.id, { id: "bob-only", name: "Hidden", timezone: "UTC", floors: [] });

    expect((await getHouse(env.DB, aliceTenant.id, sharedId)).name).toBe("Alice home");
    expect((await getHouse(env.DB, bobTenant.id, sharedId)).name).toBe("Bob home");
    expect(await getHouse(env.DB, aliceTenant.id, "bob-only")).toBeNull();

    await updateHouse(env.DB, aliceTenant.id, sharedId, { name: "Alice updated" });
    expect((await getHouse(env.DB, aliceTenant.id, sharedId)).name).toBe("Alice updated");
    expect((await getHouse(env.DB, bobTenant.id, sharedId)).name).toBe("Bob home");

    await expect(deleteHouse(env.DB, aliceTenant.id, "bob-only")).rejects.toMatchObject({ status: 404 });
    await deleteHouse(env.DB, aliceTenant.id, sharedId);
    expect(await getHouse(env.DB, aliceTenant.id, sharedId)).toBeNull();
    expect((await getHouse(env.DB, bobTenant.id, sharedId)).name).toBe("Bob home");
  });

  it("retrieves only each tenant's latest sensor bucket", async () => {
    const env = testEnvironment();
    const aliceTenant = await resolveTenant(request(), principal("latest-alice@example.com"), env);
    const bobTenant = await resolveTenant(request(), principal("latest-bob@example.com"), env);
    const sensor = {
      id: "shared-sensor", houseId: "house-home", floorId: "floor-ground", name: "Sensor",
      room: "Room", model: "Test", x: 1, y: 2, z: 1, tags: [],
    };
    await createSensor(env.DB, aliceTenant.id, sensor);
    await createSensor(env.DB, bobTenant.id, sensor);
    const group = (timestamp, temperature) => ({
      sensorId: sensor.id, timestamp, source: "api", quality: "good",
      values: { temperature }, units: { temperature: "°C" },
    });
    await insertTelemetry(env.DB, aliceTenant.id, [
      group("2026-07-14T10:00:00.000Z", 20),
      group("2026-07-14T10:10:00.000Z", 21),
    ]);
    await insertTelemetry(env.DB, bobTenant.id, [group("2026-07-14T10:20:00.000Z", 99)]);

    const aliceLatest = await latestTelemetryRows(env.DB, aliceTenant.id);
    const bobLatest = await latestTelemetryRows(env.DB, bobTenant.id);
    expect(aliceLatest).toHaveLength(1);
    expect(JSON.parse(aliceLatest[0].values_json).temperature).toBe(21);
    expect(aliceLatest[0].timestamp).toBe("2026-07-14T10:10:00.000Z");
    expect(JSON.parse(bobLatest[0].values_json).temperature).toBe(99);
  });

  it("keeps a stable row id when a natural-key parameter is upserted", async () => {
    const env = testEnvironment();
    const tenant = await resolveTenant(request(), principal("parameters@example.com"), env);
    const naturalKey = {
      houseId: "house-home", scopeType: "house", scopeId: "house-home", key: "insulation", value: 1,
    };
    const created = await saveStaticParameter(env.DB, tenant.id, naturalKey);
    const updated = await saveStaticParameter(env.DB, tenant.id, { ...naturalKey, id: "client-tried-to-replace-id", value: 2 });
    const stored = await env.DB.prepare(`SELECT id, data_json FROM static_parameters WHERE tenant_id = ?
      AND house_id = ? AND scope_type = ? AND scope_id = ? AND parameter_key = ?`)
      .bind(tenant.id, naturalKey.houseId, naturalKey.scopeType, naturalKey.scopeId, naturalKey.key)
      .first();

    expect(updated.id).toBe(created.id);
    expect(stored.id).toBe(created.id);
    expect(JSON.parse(stored.data_json)).toMatchObject({ id: created.id, value: 2 });
  });

  it("does not rewrite the user row on every authenticated read", async () => {
    const env = testEnvironment();
    const identity = principal("read-only@example.com");
    await resolveTenant(request(), identity, env);
    await env.DB.prepare("UPDATE users SET updated_at = 'sentinel' WHERE email = ?").bind(identity.email).run();

    await resolveTenant(request(), identity, env);
    const row = await env.DB.prepare("SELECT updated_at FROM users WHERE email = ?").bind(identity.email).first();
    expect(row.updated_at).toBe("sentinel");
  });
});
