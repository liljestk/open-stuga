import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { initializeTrackingSchema } from "../src/tracking/schema.js";

describe("tracking schema compatibility", () => {
  let climate: ClimateDatabase | null = null;

  afterEach(() => {
    climate?.close();
    climate = null;
  });

  function database(): DatabaseSync {
    climate = new ClimateDatabase(":memory:", false);
    return climate.db;
  }

  function createLegacySchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE tracking_property_settings (
        property_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL
      );
      CREATE TABLE tracking_observations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        observer_id TEXT NOT NULL
      );
      CREATE INDEX idx_tracking_observations_property_time
        ON tracking_observations(property_id, id);
    `);
  }

  it("rebuilds an empty tag-centric preview schema", () => {
    const db = database();
    createLegacySchema(db);

    initializeTrackingSchema(db);

    const observationRows = db.prepare("PRAGMA table_info(tracking_observations)").all() as unknown as Array<{
      name: string;
    }>;
    const settingRows = db.prepare("PRAGMA table_info(tracking_property_settings)").all() as unknown as Array<{
      name: string;
    }>;
    const observationColumns = observationRows.map((column) => column.name);
    const settingColumns = settingRows.map((column) => column.name);
    expect(observationColumns).toEqual(expect.arrayContaining([
      "data_mode", "endpoint_id", "equipment_id", "binding_id",
    ]));
    expect(settingColumns).toEqual(expect.arrayContaining([
      "observation_retention_days", "rollup_retention_days", "estimate_retention_days",
    ]));
  });

  it("refuses to discard non-empty legacy tracking data", () => {
    const db = database();
    createLegacySchema(db);
    db.prepare(`INSERT INTO tracking_observations(
      id, tenant_id, property_id, tag_id, observer_id
    ) VALUES (?, ?, ?, ?, ?)`).run("observation-1", "tenant", "property-main", "tag-1", "observer-1");

    expect(() => initializeTrackingSchema(db)).toThrow(/explicit migration/u);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tracking_observations").get())
      .toMatchObject({ count: 1 });
  });
});
