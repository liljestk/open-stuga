import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { loadOrCreateStugubyNodeKeys } from "../src/stuguby/identity.js";
import { StugubyService } from "../src/stuguby/service.js";
import { StugubyStore } from "../src/stuguby/store.js";

describe("legacy Stuguby link migration", () => {
  it("normalizes the legacy stugbyId field before Home mutations use it", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-stuguby-link-"));
    const path = join(directory, "legacy.sqlite");
    const stugubyId = "stuguby-legacy";

    try {
      const original = new ClimateDatabase(path, false);
      original.createProperty({ id: "property-legacy", name: "Legacy property" });
      original.createHouse({
        id: "house-legacy",
        propertyId: "property-legacy",
        name: "Legacy Home",
        timezone: "Europe/Helsinki",
        floors: [],
      });
      original.setPropertyStugubyLink("property-legacy", {
        stugubyId,
        authorityNodeId: "node-local",
        isAuthority: true,
        editPolicy: "collaborative",
        syncState: "current",
        authorityEpoch: 1,
        lastSyncedRevision: 1,
        pendingChangeCount: 0,
        conflictCount: 0,
      });
      original.setHouseStugubyLink("house-legacy", {
        stugubyId,
        authorityNodeId: "node-local",
        publicationId: "home-publication",
        ownership: "local",
        editPolicy: "editable",
        syncState: "current",
        authorityEpoch: 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled",
      });
      original.close();

      const legacy = new DatabaseSync(path);
      for (const table of ["properties", "houses"]) {
        legacy.exec(`UPDATE ${table}
          SET stugby_json = json_remove(
            json_set(stugby_json, '$.stugbyId', json_extract(stugby_json, '$.stugubyId')),
            '$.stugubyId'
          )`);
      }
      legacy.close();

      const migrated = new ClimateDatabase(path, false);
      expect(migrated.getProperty("property-legacy")?.stuguby?.stugubyId).toBe(stugubyId);
      expect(migrated.getHouse("house-legacy")?.stuguby?.stugubyId).toBe(stugubyId);
      const keys = loadOrCreateStugubyNodeKeys(null, "Migration test");
      const stuguby = new StugubyService({
        database: migrated,
        store: new StugubyStore(migrated.db, keys.identity.nodeId),
        keys,
        bus: new TelemetryBus(),
        assetDirectory: directory,
      });
      expect(() => stuguby.captureHomeMutation("house-legacy")).not.toThrow();
      for (const table of ["properties", "houses"]) {
        const row = migrated.db.prepare(`SELECT stugby_json FROM ${table} WHERE id = ?`)
          .get(table === "properties" ? "property-legacy" : "house-legacy") as { stugby_json: string };
        expect(JSON.parse(row.stugby_json)).toMatchObject({ stugubyId });
        expect(JSON.parse(row.stugby_json)).not.toHaveProperty("stugbyId");
      }
      expect(() => migrated.migrate()).not.toThrow();
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
