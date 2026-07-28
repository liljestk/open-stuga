import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { loadOrCreateStugubyNodeKeys } from "../src/stuguby/identity.js";
import { StugubyService } from "../src/stuguby/service.js";
import { StugubyStore } from "../src/stuguby/store.js";

describe("Stuguby store migration", () => {
  it("normalizes mutable legacy stugbyId snapshots before publishing a Home", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuguby-store-migration-"));
    const database = new ClimateDatabase(join(directory, "legacy.sqlite"), false);
    const keys = loadOrCreateStugubyNodeKeys(join(directory, "stuguby-identity.json"), "Migration test");
    const stugubyId = "stuguby-legacy";
    const publicationId = "home-publication";
    const now = "2026-07-27T12:00:00.000Z";

    try {
      new StugubyStore(database.db, keys.identity.nodeId);
      database.db.prepare(`INSERT INTO stugby_federations
        (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,
         is_coordinator,created_at,updated_at)
        VALUES (?,?,?,?,?,'steward','active',1,?,?)`)
        .run(stugubyId, "Legacy Stuguby", null, keys.identity.nodeId, "https://stuguby.test", now, now);
      database.createProperty({ id: "property-legacy", name: "Legacy property" });
      database.createHouse({
        id: "house-legacy",
        propertyId: "property-legacy",
        name: "Legacy Home",
        timezone: "Europe/Helsinki",
        floors: [],
      });
      database.setHouseStugubyLink("house-legacy", {
        stugubyId,
        authorityNodeId: keys.identity.nodeId,
        publicationId,
        ownership: "local",
        editPolicy: "editable",
        syncState: "current",
        authorityEpoch: 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled",
      });

      const legacyGrant = {
        id: "grant-legacy",
        stugbyId: stugubyId,
        authorityNodeId: keys.identity.nodeId,
        publicationId,
        localHouseId: "house-legacy",
        audience: { kind: "all-members", nodeIds: [] },
        datasets: [{
          dataset: "home.directory.v1",
          enabled: true,
          includeLocalIds: false,
          allowReplicaCache: true,
          retentionDays: 30,
        }],
        housePolicy: {
          editPolicy: "read-only",
          recoveryMode: "none",
          designatedSuccessorNodeId: null,
        },
        epoch: 1,
        revision: 1,
        expiresAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      database.db.prepare(`INSERT INTO stugby_share_grants
        (id,stugby_id,authority_node_id,publication_id,epoch,revision,expires_at,revoked_at,grant_json,updated_at)
        VALUES (?,?,?,?,1,1,NULL,NULL,?,?)`)
        .run(legacyGrant.id, stugubyId, keys.identity.nodeId, publicationId, JSON.stringify(legacyGrant), now);
      database.db.prepare(`INSERT INTO stugby_shared_properties
        (stugby_id,revision,property_json,updated_at) VALUES (?,1,?,?)`)
        .run(stugubyId, JSON.stringify({ stugbyId: stugubyId }), now);
      database.db.prepare(`INSERT INTO stugby_property_commands
        (id,stugby_id,actor_node_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,'applied',?,0,?,?,?)`)
        .run(
          "property-command-legacy",
          stugubyId,
          keys.identity.nodeId,
          JSON.stringify({ stugbyId: stugubyId }),
          JSON.stringify({ property: { stugbyId: stugubyId } }),
          now,
          now,
          now,
        );
      database.db.prepare(`INSERT INTO stugby_home_commands
        (id,stugby_id,authority_node_id,publication_id,command_json,status,result_json,attempts,
         next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',NULL,0,?,?,?)`)
        .run(
          "home-command-legacy",
          stugubyId,
          keys.identity.nodeId,
          publicationId,
          JSON.stringify({ stugbyId: stugubyId }),
          now,
          now,
          now,
        );

      const migratedStore = new StugubyStore(database.db, keys.identity.nodeId);
      expect(migratedStore.getGrant(legacyGrant.id)).toMatchObject({ stugubyId });
      expect(migratedStore.getSharedProperty(stugubyId)).toMatchObject({ stugubyId });
      const rows = database.db.prepare(`SELECT command_json, result_json FROM stugby_property_commands
        WHERE id='property-command-legacy'`).get() as { command_json: string; result_json: string };
      expect(JSON.parse(rows.command_json)).toEqual({ stugubyId });
      expect(JSON.parse(rows.result_json)).toEqual({ property: { stugubyId } });
      const homeCommand = database.db.prepare(`SELECT command_json FROM stugby_home_commands
        WHERE id='home-command-legacy'`).get() as { command_json: string };
      expect(JSON.parse(homeCommand.command_json)).toEqual({ stugubyId });

      const service = new StugubyService({
        database,
        store: migratedStore,
        keys,
        bus: new TelemetryBus(),
        assetDirectory: directory,
      });
      expect(() => service.captureHomeMutation("house-legacy")).not.toThrow();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
