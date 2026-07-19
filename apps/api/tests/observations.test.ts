import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";

const baseObservation = {
  houseId: "house-main",
  floorId: "floor-ground",
  kind: "note",
  severity: "info",
  note: "Checked the cellar",
};

describe("manual observation time and revision model", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
  });

  afterEach(async () => { await runtime.close(); });

  it("keeps legacy create payloads compatible while recording immutable provenance defaults", async () => {
    const response = await request(runtime.app).post("/api/v1/observations").send(baseObservation).expect(201);
    expect(response.body).toMatchObject({
      ...baseObservation,
      sensorId: null,
      x: null,
      y: null,
      timePrecision: "exact",
      validFrom: null,
      validTo: null,
      source: "unknown",
      sourceDetail: null,
      confidence: "uncertain",
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 1,
    });
    expect(response.body.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.createdAt).toBe(response.body.updatedAt);

    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      createdAt: "2000-01-01T00:00:00Z",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      status: "resolved",
      resolutionNote: "Already fixed",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
  });

  it("canonicalizes instants and preserves date-only and date-range values", async () => {
    const exact = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      occurredAt: "2026-07-14T12:00:00+03:00",
      source: "owner",
      sourceDetail: "Departure inspection",
      confidence: "confirmed",
    }).expect(201);
    expect(exact.body).toMatchObject({
      occurredAt: "2026-07-14T09:00:00.000Z",
      source: "owner",
      sourceDetail: "Departure inspection",
      confidence: "confirmed",
    });

    const approximate = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      timePrecision: "approximate",
      occurredAt: "2026-07-14T10:15:00+03:00",
    }).expect(201);
    expect(approximate.body.occurredAt).toBe("2026-07-14T07:15:00.000Z");

    const dateOnly = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      timePrecision: "date-only",
      occurredAt: "2026-01-17",
    }).expect(201);
    expect(dateOnly.body).toMatchObject({ occurredAt: "2026-01-17", validFrom: null, validTo: null });

    const range = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      timePrecision: "date-range",
      validFrom: "2026-01-01",
      validTo: "2026-01-31",
    }).expect(201);
    expect(range.body).toMatchObject({
      occurredAt: "2026-01-01",
      timePrecision: "date-range",
      validFrom: "2026-01-01",
      validTo: "2026-01-31",
    });

    const unknown = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      timePrecision: "unknown",
    }).expect(201);
    expect(unknown.body).toMatchObject({ occurredAt: "", timePrecision: "unknown", validFrom: null, validTo: null });
  });

  it("rejects inconsistent temporal combinations and reversed calendar ranges", async () => {
    const invalidBodies = [
      { ...baseObservation, timePrecision: "approximate" },
      { ...baseObservation, timePrecision: "date-only", occurredAt: "2026-01-17T00:00:00Z" },
      { ...baseObservation, timePrecision: "date-range", validFrom: "2026-02-01", validTo: "2026-01-01" },
      { ...baseObservation, timePrecision: "date-range", validFrom: "2026-01-01" },
      { ...baseObservation, timePrecision: "unknown", occurredAt: "2026-01-01" },
      { ...baseObservation, timePrecision: "exact", validFrom: "2026-01-01" },
    ];
    for (const body of invalidBodies) {
      await request(runtime.app).post("/api/v1/observations").send(body).expect(422);
    }
  });

  it("validates house, floor, sensor, and coordinate scope before writing", async () => {
    await request(runtime.app).post("/api/v1/observations").send({ ...baseObservation, houseId: "missing" })
      .expect(404).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_HOUSE_NOT_FOUND"));
    await request(runtime.app).post("/api/v1/observations").send({ ...baseObservation, floorId: "missing" })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_FLOOR_NOT_FOUND"));

    const sensorOnAnotherFloor = runtime.database.listSensors("house-main")
      .find((sensor) => sensor.floorId !== baseObservation.floorId);
    expect(sensorOnAnotherFloor).toBeDefined();
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      sensorId: sensorOnAnotherFloor?.id,
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_SENSOR_SCOPE_MISMATCH"));
    await request(runtime.app).post("/api/v1/observations").send({ ...baseObservation, x: 1 })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_OBSERVATION_POSITION"));
    await request(runtime.app).post("/api/v1/observations").send({ ...baseObservation, x: -1, y: 1 })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_OUT_OF_BOUNDS"));
  });

  it("prevents layout edits and direct writes from stranding observation evidence", async () => {
    const floor = { id: "evidence-floor", name: "Evidence floor", width: 10, height: 6, elevation: 0, walls: [], rooms: [] };
    runtime.database.createHouse({ id: "evidence-house", name: "Evidence house", timezone: "Europe/Helsinki", floors: [floor] });
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "placed-evidence",
      houseId: "evidence-house",
      floorId: floor.id,
      x: 8,
      y: 4,
    }).expect(201);

    await request(runtime.app).patch("/api/v1/houses/evidence-house").send({ floors: [] })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("LAYOUT_ORPHANS_OBSERVATION"));
    await request(runtime.app).patch("/api/v1/houses/evidence-house").send({
      floors: [{ ...floor, width: 7 }],
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("LAYOUT_EXCLUDES_OBSERVATION"));
    await request(runtime.app).patch("/api/v1/houses/evidence-house").send({
      floors: [{ ...floor, width: 8, height: 4 }],
    }).expect(200);

    expect(() => runtime.database.db.prepare("UPDATE houses SET floors_json = '[]' WHERE id = 'evidence-house'").run())
      .toThrow(/LAYOUT_ORPHANS_OBSERVATION/);
    expect(() => runtime.database.db.prepare(`UPDATE houses SET floors_json = ? WHERE id = 'evidence-house'`)
      .run(JSON.stringify([{ ...floor, width: 7, height: 4 }])))
      .toThrow(/LAYOUT_EXCLUDES_OBSERVATION/);
    expect(() => runtime.database.db.prepare("UPDATE observations SET floor_id = 'missing' WHERE id = 'placed-evidence'").run())
      .toThrow(/OBSERVATION_FLOOR_NOT_FOUND/);
    expect(() => runtime.database.db.prepare("UPDATE observations SET x = 9 WHERE id = 'placed-evidence'").run())
      .toThrow(/OBSERVATION_OUT_OF_BOUNDS/);

    runtime.database.createHouse({ id: "unplaced-house", name: "Unplaced evidence", timezone: "Europe/Helsinki", floors: [floor] });
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "unplaced-evidence",
      houseId: "unplaced-house",
      floorId: floor.id,
    }).expect(201);
    await request(runtime.app).patch("/api/v1/houses/unplaced-house").send({
      floors: [{ ...floor, width: 1, height: 1 }],
    }).expect(200);
  });

  it("keeps lifecycle updates available when a linked sensor later moves", async () => {
    const sensor = runtime.database.listSensors("house-main").find((candidate) => candidate.floorId === baseObservation.floorId)!;
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "historical-sensor-evidence",
      sensorId: sensor.id,
      kind: "leak",
      severity: "warning",
    }).expect(201);
    expect(runtime.database.updateSensor(sensor.id, { floorId: "floor-upper", x: 1, y: 1 })).not.toBeNull();

    await request(runtime.app).patch("/api/v1/observations/historical-sensor-evidence").send({
      baseRevision: 1,
      floorId: baseObservation.floorId,
      note: "Historical sensor provenance retained",
    }).expect(200).expect(({ body }) => expect(body).toMatchObject({ revision: 2, sensorId: sensor.id }));

    await request(runtime.app).patch("/api/v1/observations/historical-sensor-evidence").send({
      baseRevision: 2,
      status: "resolved",
      resolutionNote: "Fixed leak after the sensor was relocated",
    }).expect(200).expect(({ body }) => expect(body).toMatchObject({
      status: "resolved",
      sensorId: sensor.id,
      resolutionNote: "Fixed leak after the sensor was relocated",
    }));
  });

  it("updates optimistically and records append-only REST revisions without changing recorded time", async () => {
    const created = await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "revision-observation",
      timePrecision: "date-only",
      occurredAt: "2026-01-17",
    }).expect(201);

    const updated = await request(runtime.app).patch("/api/v1/observations/revision-observation").send({
      baseRevision: 1,
      note: "Cellar stayed dry",
      confidence: "confirmed",
    }).expect(200);
    expect(updated.body).toMatchObject({ revision: 2, note: "Cellar stayed dry", confidence: "confirmed" });
    expect(updated.body.createdAt).toBe(created.body.createdAt);

    const history = await request(runtime.app).get("/api/v1/observations/revision-observation/revisions").expect(200);
    expect(history.body.revisions).toHaveLength(2);
    expect(history.body.revisions[0]).toMatchObject({
      observationId: "revision-observation",
      revision: 1,
      actor: "local-rest",
      snapshot: { revision: 1, note: baseObservation.note },
    });
    expect(history.body.revisions[1]).toMatchObject({
      revision: 2,
      actor: "local-rest",
      changedFields: ["note", "confidence"],
      snapshot: { revision: 2, note: "Cellar stayed dry", confidence: "confirmed" },
    });

    await request(runtime.app).patch("/api/v1/observations/revision-observation").send({
      baseRevision: 1,
      note: "Stale edit",
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_REVISION_CONFLICT"));
    await request(runtime.app).patch("/api/v1/observations/revision-observation").send({
      baseRevision: 2,
      createdAt: "2000-01-01T00:00:00Z",
    }).expect(400);
    await request(runtime.app).patch("/api/v1/observations/revision-observation").send({ baseRevision: 2 }).expect(400);
  });

  it("resolves with an audited outcome, preserves the resolution instant on edits, and can reopen", async () => {
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "leak-lifecycle",
      kind: "leak",
      severity: "warning",
      note: "Leak below kitchen sink",
    }).expect(201);

    const resolved = await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 1,
      status: "resolved",
      resolutionNote: "  Fixed leak and tightened the drain coupling  ",
    }).expect(200);
    expect(resolved.body).toMatchObject({
      status: "resolved",
      resolutionNote: "Fixed leak and tightened the drain coupling",
      revision: 2,
    });
    expect(resolved.body.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolved.body.updatedAt).toBe(resolved.body.resolvedAt);

    const unchangedResolution = await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 2,
      status: "resolved",
    }).expect(200);
    expect(unchangedResolution.body).toMatchObject({
      status: "resolved",
      resolutionNote: "Fixed leak and tightened the drain coupling",
      resolvedAt: resolved.body.resolvedAt,
      revision: 2,
    });

    const edited = await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 2,
      resolutionNote: "Replaced the coupling and dried the cabinet",
    }).expect(200);
    expect(edited.body).toMatchObject({
      status: "resolved",
      resolutionNote: "Replaced the coupling and dried the cabinet",
      resolvedAt: resolved.body.resolvedAt,
      revision: 3,
    });

    await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 2,
      status: "open",
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_REVISION_CONFLICT"));

    await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 3,
      status: "open",
      resolutionNote: "Contradictory retained outcome",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_OBSERVATION_RESOLUTION"));

    const reopened = await request(runtime.app).patch("/api/v1/observations/leak-lifecycle").send({
      baseRevision: 3,
      status: "open",
    }).expect(200);
    expect(reopened.body).toMatchObject({
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 4,
    });

    const history = await request(runtime.app).get("/api/v1/observations/leak-lifecycle/revisions").expect(200);
    expect(history.body.revisions).toHaveLength(4);
    expect(history.body.revisions[1]).toMatchObject({
      revision: 2,
      changedFields: ["status", "resolutionNote", "resolvedAt"],
      snapshot: {
        status: "resolved",
        resolutionNote: "Fixed leak and tightened the drain coupling",
        resolvedAt: resolved.body.resolvedAt,
      },
    });
    expect(history.body.revisions[2]).toMatchObject({ revision: 3, changedFields: ["resolutionNote"] });
    expect(history.body.revisions[3]).toMatchObject({
      revision: 4,
      changedFields: ["status", "resolutionNote", "resolvedAt"],
      snapshot: { status: "open", resolutionNote: null, resolvedAt: null },
    });
  });

  it("rejects incomplete or client-timestamped resolution state", async () => {
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "invalid-resolution",
    }).expect(201);

    await request(runtime.app).patch("/api/v1/observations/invalid-resolution").send({
      baseRevision: 1,
      resolutionNote: null,
    }).expect(200).expect(({ body }) => expect(body).toMatchObject({ status: "open", revision: 1 }));
    await request(runtime.app).patch("/api/v1/observations/invalid-resolution").send({
      baseRevision: 1,
      status: "resolved",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_OBSERVATION_RESOLUTION"));
    await request(runtime.app).patch("/api/v1/observations/invalid-resolution").send({
      baseRevision: 1,
      status: "resolved",
      resolutionNote: "   ",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app).patch("/api/v1/observations/invalid-resolution").send({
      baseRevision: 1,
      resolutionNote: "Cannot resolve implicitly",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_OBSERVATION_RESOLUTION"));
    await request(runtime.app).patch("/api/v1/observations/invalid-resolution").send({
      baseRevision: 1,
      status: "resolved",
      resolutionNote: "Fixed leak",
      resolvedAt: "2000-01-01T00:00:00.000Z",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));

    expect(runtime.database.getObservation("invalid-resolution")).toMatchObject({
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 1,
    });
  });

  it("accepts a 5,000-character resolution outcome and rejects 5,001 characters", async () => {
    await request(runtime.app).post("/api/v1/observations").send({
      ...baseObservation,
      id: "bounded-resolution",
    }).expect(201);

    await request(runtime.app).patch("/api/v1/observations/bounded-resolution").send({
      baseRevision: 1,
      status: "resolved",
      resolutionNote: "x".repeat(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH + 1),
    }).expect(400).expect(({ body }) => expect(body.error).toMatchObject({
      code: "INVALID_FIELD",
      message: `resolutionNote must be a non-empty string of at most ${MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH} characters or null`,
    }));

    const accepted = await request(runtime.app).patch("/api/v1/observations/bounded-resolution").send({
      baseRevision: 1,
      status: "resolved",
      resolutionNote: "x".repeat(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH),
    }).expect(200);
    expect(accepted.body).toMatchObject({ status: "resolved", revision: 2 });
    expect(accepted.body.resolutionNote).toHaveLength(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH);
  });

  it("retains existing permanent deletion semantics and cascades revision rows", async () => {
    const created = await request(runtime.app).post("/api/v1/observations").send(baseObservation).expect(201);
    const revisionsBefore = runtime.database.listObservationRevisions(created.body.id);
    expect(() => runtime.database.db.prepare(`INSERT OR REPLACE INTO observation_revisions
      (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
      VALUES (?, 1, ?, 'local-mcp', '[]', '{}')`)
      .run(created.body.id, "2099-01-01T00:00:00.000Z"))
      .toThrow(/OBSERVATION_REVISIONS_ARE_APPEND_ONLY/);
    expect(runtime.database.listObservationRevisions(created.body.id)).toEqual(revisionsBefore);
    expect(() => runtime.database.migrate()).not.toThrow();
    expect(() => runtime.database.db.prepare("DELETE FROM observation_revisions WHERE observation_id = ?").run(created.body.id))
      .toThrow(/OBSERVATION_REVISIONS_ARE_APPEND_ONLY/);
    await request(runtime.app).delete(`/api/v1/observations/${created.body.id}`).expect(204);
    expect(runtime.database.listObservationRevisions(created.body.id)).toEqual([]);
    await request(runtime.app).get(`/api/v1/observations/${created.body.id}/revisions`).expect(404);
  });
});

describe("legacy observation migration", () => {
  it("rechecks the completion marker after acquiring the migration lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-observation-migration-lock-"));
    const path = join(directory, "empty.sqlite");
    type TransactionPrototype = {
      immediateTransaction: (this: ClimateDatabase, operation: () => unknown) => unknown;
    };
    const prototype = ClimateDatabase.prototype as unknown as TransactionPrototype;
    const originalTransaction = prototype.immediateTransaction;
    let injectedCompetingCompletion = false;
    prototype.immediateTransaction = function (operation) {
      const revisionTableExists = this.db.prepare(`SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'observation_revisions'`).get();
      const completion = revisionTableExists
        ? this.db.prepare("SELECT value FROM metadata WHERE key = 'observation_revisions_v1'").get()
        : undefined;
      if (revisionTableExists && !completion && !injectedCompetingCompletion) {
        // Deterministically model another process committing while this process
        // waited between its optimistic check and BEGIN IMMEDIATE.
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('observation_revisions_v1', 'complete')").run();
        injectedCompetingCompletion = true;
      }
      return originalTransaction.call(this, operation);
    };

    let migrated: ClimateDatabase | undefined;
    try {
      expect(() => { migrated = new ClimateDatabase(path, false); }).not.toThrow();
      expect(injectedCompetingCompletion).toBe(true);
      expect(migrated?.db.prepare(
        "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
      ).get()).toEqual({ value: "complete" });
    } finally {
      migrated?.close();
      prototype.immediateTransaction = originalTransaction;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills conservative metadata without inventing a REST or MCP actor", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-observation-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE houses (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL,
          location_json TEXT, map_placement_json TEXT, orientation_degrees REAL,
          floors_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE observations (
          id TEXT PRIMARY KEY,
          house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
          floor_id TEXT NOT NULL,
          sensor_id TEXT,
          kind TEXT NOT NULL,
          severity TEXT NOT NULL,
          note TEXT NOT NULL,
          x REAL,
          y REAL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      const timestamp = "2025-12-01T08:00:00.000Z";
      const floors = [{ id: "legacy-floor", name: "Cellar", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }];
      legacy.prepare(`INSERT INTO houses
        (id, name, timezone, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run("legacy-house", "Legacy house", "Europe/Helsinki", JSON.stringify(floors), timestamp, timestamp);
      legacy.prepare(`INSERT INTO observations
        (id, house_id, floor_id, sensor_id, kind, severity, note, x, y, occurred_at, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`)
        .run("legacy-observation", "legacy-house", "legacy-floor", "note", "info", "Older evidence", timestamp, timestamp);
      legacy.close();

      const migrated = new ClimateDatabase(path, false);
      try {
        expect(migrated.getObservation("legacy-observation")).toMatchObject({
          timePrecision: "exact",
          source: "unknown",
          confidence: "uncertain",
          status: "open",
          resolutionNote: null,
          resolvedAt: null,
          revision: 1,
          updatedAt: timestamp,
        });
        expect(migrated.listObservationRevisions("legacy-observation")).toEqual([
          expect.objectContaining({
            actor: "system-service",
            revision: 1,
            snapshot: expect.objectContaining({ status: "open", resolutionNote: null, resolvedAt: null }),
          }),
        ]);
        expect(migrated.db.prepare(
          "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
        ).get()).toEqual({ value: "complete" });
        expect(() => migrated.migrate()).not.toThrow();
        expect(() => migrated.db.prepare(`UPDATE observation_revisions
          SET actor = 'local-rest' WHERE observation_id = 'legacy-observation'`).run())
          .toThrow(/OBSERVATION_REVISIONS_ARE_APPEND_ONLY/);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
