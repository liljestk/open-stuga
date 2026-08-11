import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { resolvePlanElementOpeningState, type AirflowPlanElement } from "@climate-twin/contracts";
import { ClimateDatabase } from "../src/db.js";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const opening: AirflowPlanElement = {
  id: "door", kind: "door", variant: "exterior", wallId: "wall",
  position: { x: 2, y: 0 }, rotationDegrees: 0, width: 1, state: "closed",
};

function createHouse(database: ClimateDatabase, id = "current-house"): void {
  database.createHouse({
    id, name: "Current state", timezone: "UTC",
    floors: [{
      id: "ground", name: "Ground", type: "ground", width: 10, height: 8, elevation: 0,
      walls: [{ id: "wall", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [], planElements: [opening],
    }],
  });
}

describe("current opening-state candidates", () => {
  afterEach(() => vi.useRealTimers());

  it("retains an older baseline beneath overlapping temporary observations", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T09:00:00.000Z");
    const database = new ClimateDatabase(":memory:", false);
    try {
      createHouse(database);
      database.recordOpeningStateObservation("current-house", {
        id: "baseline", floorId: "ground", elementId: "door", state: "closed", source: "api",
        observedAt: "2026-08-08T10:00:00.000Z",
      });
      database.recordOpeningStateObservation("current-house", {
        id: "long", floorId: "ground", elementId: "door", state: "open", source: "api",
        observedAt: "2026-08-08T10:10:00.000Z", validUntil: "2026-08-08T10:40:00.000Z",
      });
      database.recordOpeningStateObservation("current-house", {
        id: "short", floorId: "ground", elementId: "door", state: "closed", source: "api",
        observedAt: "2026-08-08T10:20:00.000Z", validUntil: "2026-08-08T10:30:00.000Z",
      });

      const at = (timestamp: string) => database.listCurrentOpeningStateCandidates("current-house", timestamp);
      expect(at("2026-08-08T10:25:00.000Z").map((item) => item.id)).toEqual(["short", "long", "baseline"]);
      expect(resolvePlanElementOpeningState(opening, at("2026-08-08T10:25:00.000Z"), "2026-08-08T10:25:00.000Z").state).toBe("closed");
      expect(resolvePlanElementOpeningState(opening, at("2026-08-08T10:35:00.000Z"), "2026-08-08T10:35:00.000Z").state).toBe("open");
      expect(at("2026-08-08T10:45:00.000Z").map((item) => item.id)).toEqual(["baseline"]);

      vi.setSystemTime("2026-08-08T10:35:00.000Z");
      database.purgeReadingsBefore("2027-01-01T00:00:00.000Z", 100);
      expect(database.db.prepare(`SELECT observation_id FROM opening_state_current_candidates
        WHERE house_id = ? ORDER BY observed_at DESC`).all("current-house"))
        .toEqual([{ observation_id: "long" }, { observation_id: "baseline" }]);
      expect(resolvePlanElementOpeningState(opening, at("2026-08-08T10:35:00.000Z"), "2026-08-08T10:35:00.000Z").state).toBe("open");

      vi.setSystemTime("2026-08-08T10:45:00.000Z");
      database.purgeReadingsBefore("2027-01-01T00:00:00.000Z", 100);
      expect(resolvePlanElementOpeningState(opening, at("2026-08-08T10:45:00.000Z"), "2026-08-08T10:45:00.000Z").state).toBe("closed");

      database.recordOpeningStateObservation("current-house", {
        id: "replacement", floorId: "ground", elementId: "door", state: "open", source: "api",
        observedAt: "2026-08-08T10:50:00.000Z",
      });
      expect(resolvePlanElementOpeningState(opening, at("2026-08-08T10:45:00.000Z"), "2026-08-08T10:45:00.000Z").state).toBe("closed");
      expect(database.listCurrentOpeningStateCandidates("current-house", "2026-08-08T11:00:00.000Z")
        .map((item) => item.id)).toEqual(["replacement", "baseline"]);

      const house = database.getHouse("current-house")!;
      database.updateHouse(house.id, {
        floors: house.floors.map((floor) => ({ ...floor, planElements: [] })),
      });
      expect(database.listCurrentOpeningStateCandidates("current-house", "2026-08-08T11:00:00.000Z"))
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills the bounded projection for an existing control database", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T09:00:00.000Z");
    const database = new ClimateDatabase(":memory:", false);
    try {
      createHouse(database);
      database.recordOpeningStateObservation("current-house", {
        id: "existing", floorId: "ground", elementId: "door", state: "open", source: "manual",
        observedAt: "2026-08-08T08:55:00.000Z",
      });
      database.db.exec(`
        DELETE FROM opening_state_current_candidates;
        DELETE FROM metadata WHERE key = 'opening_state_current_candidates_v1';
      `);

      database.migrateCoreAndResourceSchema();
      expect(database.listCurrentOpeningStateCandidates("current-house", "2026-08-08T09:00:00.000Z")
        .map((item) => item.id)).toEqual(["existing"]);
      database.migrateCoreAndResourceSchema();
      expect(database.db.prepare("SELECT COUNT(*) AS count FROM opening_state_current_candidates")
        .get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("survives rollback inserts and repairs a missing persistent trigger idempotently", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T09:00:00.000Z");
    const database = new ClimateDatabase(":memory:", false);
    const insertLegacyObservation = (id: string, observedAt: string) => database.db.prepare(`
      INSERT INTO opening_state_observations (
        id, house_id, floor_id, element_id, state, open_fraction, source,
        observed_at, valid_until, external_id, connection_id, created_at
      ) VALUES (?, 'current-house', 'ground', 'door', 'open', NULL, 'api', ?, NULL, NULL, NULL, ?)
    `).run(id, observedAt, "2026-08-08T09:00:00.000Z");
    try {
      createHouse(database);
      insertLegacyObservation("rollback-triggered", "2026-08-08T08:50:00.000Z");
      expect(database.listCurrentOpeningStateCandidates("current-house", "2026-08-08T09:00:00.000Z")
        .map((item) => item.id)).toEqual(["rollback-triggered"]);

      database.db.exec("DROP TRIGGER opening_state_current_candidate_insert");
      insertLegacyObservation("rollback-repaired", "2026-08-08T08:55:00.000Z");
      expect(database.db.prepare(`SELECT 1 FROM opening_state_current_candidates
        WHERE observation_id = 'rollback-repaired'`).get()).toBeUndefined();
      expect(database.db.prepare(`SELECT value FROM metadata
        WHERE key = 'opening_state_current_candidates_rowid_v2'`).get()).toEqual({ value: "0" });

      database.migrate();
      expect(database.listCurrentOpeningStateCandidates("current-house", "2026-08-08T09:00:00.000Z")
        .map((item) => item.id)).toEqual(["rollback-repaired"]);
      expect(database.db.prepare(`SELECT value FROM metadata
        WHERE key = 'opening_state_current_candidates_rowid_v2'`).get()).toEqual({ value: "2" });
      database.migrate();
      expect(database.db.prepare("SELECT COUNT(*) AS count FROM opening_state_current_candidates").get())
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("advances the runtime repair checkpoint only in bounded batches", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T09:00:00.000Z");
    const database = new ClimateDatabase(":memory:", false);
    const checkpoint = () => Number((database.db.prepare(`SELECT value FROM metadata
      WHERE key = 'opening_state_current_candidates_rowid_v2'`).get() as { value: string }).value);
    const maximumRowId = () => Number((database.db.prepare(`SELECT MAX(rowid) AS maximum
      FROM opening_state_observations`).get() as { maximum: number }).maximum);
    try {
      createHouse(database);
      const initialCheckpoint = checkpoint();
      for (let index = 1; index < 256; index += 1) {
        database.recordOpeningStateObservation("current-house", {
          id: `batch-${index}`, floorId: "ground", elementId: "door", state: "closed", source: "api",
          observedAt: new Date(Date.parse("2026-08-08T08:00:00.000Z") + index).toISOString(),
        });
      }
      expect(checkpoint()).toBe(initialCheckpoint);
      expect(maximumRowId() - checkpoint()).toBe(255);

      database.recordOpeningStateObservation("current-house", {
        id: "batch-256", floorId: "ground", elementId: "door", state: "open", source: "api",
        observedAt: "2026-08-08T08:00:00.256Z",
      });
      expect(checkpoint()).toBe(maximumRowId());
      expect(maximumRowId() - checkpoint()).toBeLessThan(256);
    } finally {
      database.close();
    }
  });
});

const config: AppConfig = {
  port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json", assetDirectory: ".",
  mockEnabled: false, mockIntervalMs: 25, retentionDays: 730, ingestApiKey: null,
  haUrl: null, haToken: null, haEntityMapFile: null,
  tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
};

describe("opening-state current API", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("keeps the ordinary GET local and bounds explicit archive reads", async () => {
    runtime = createApi({ config, startBackground: false });
    createHouse(runtime.database, "route-house");
    runtime.database.recordOpeningStateObservation("route-house", {
      floorId: "ground", elementId: "door", state: "open", source: "api",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const snapshot = vi.spyOn(runtime.telemetryReader, "openingStateSnapshot");
    const history = vi.spyOn(runtime.telemetryReader, "openingStateHistory");

    await request(runtime.app).get("/api/v1/houses/route-house/opening-states").expect(200)
      .expect(({ body }) => expect(body.snapshot.states[0]).toMatchObject({ elementId: "door", state: "open" }));
    expect(snapshot).not.toHaveBeenCalled();

    const at = new Date().toISOString();
    await request(runtime.app).get(`/api/v1/houses/route-house/opening-states?at=${encodeURIComponent(at)}`).expect(200);
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      houseId: "route-house", at, timeoutMs: 5_000, signal: expect.any(AbortSignal),
    }));

    const from = new Date(Date.now() - 60_000).toISOString();
    await request(runtime.app).get(`/api/v1/houses/route-house/opening-states?from=${encodeURIComponent(from)}&to=${encodeURIComponent(at)}`).expect(200);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({
      houseId: "route-house", from, to: at, timeoutMs: 5_000, signal: expect.any(AbortSignal),
    }));

    const snapshotCalls = snapshot.mock.calls.length;
    await request(runtime.app).get(`/api/v1/houses/route-house/opening-states?from=${encodeURIComponent(at)}&to=${encodeURIComponent(from)}`).expect(400);
    expect(snapshot).toHaveBeenCalledTimes(snapshotCalls);
  });
});
