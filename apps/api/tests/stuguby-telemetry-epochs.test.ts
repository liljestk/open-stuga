import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STUGBY_PROTOCOL_VERSION,
  type StugubyNodeIdentity,
  type StugubyShareGrant,
  type StugubySignedEvent,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";

import { ClimateDatabase } from "../src/db.js";
import { StugubyStore } from "../src/stuguby/store.js";

const stugubyId = "telemetry-epoch-stuguby";
const grantId = "telemetry-epoch-grant";
const publicationId = "home-publication";
const sensorPublicationId = "sensor-publication";
const authorityNodeId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-30T08:00:00.000Z";

describe("Stuguby telemetry epoch snapshots", () => {
  let database: ClimateDatabase;
  let store: StugubyStore;
  let sequence: number;

  beforeEach(() => {
    database = new ClimateDatabase(":memory:");
    database.db.prepare("DELETE FROM measurement_samples").run();
    store = new StugubyStore(database.db, authorityNodeId);
    const identity: StugubyNodeIdentity = {
      nodeId: authorityNodeId,
      displayName: "Telemetry epoch authority",
      publicKey: "test-public-key",
      keyFingerprint: "a".repeat(64),
      protocolVersion: STUGBY_PROTOCOL_VERSION,
    };
    store.createCoordinatedStuguby({
      id: stugubyId,
      name: "Telemetry epochs",
      coordinatorUrl: "https://stuguby.example.test",
    }, identity);
    store.projectionId(stugubyId, authorityNodeId, "sensor", sensorPublicationId, "sensor-01");
    sequence = 0;
  });

  afterEach(() => database.close());

  const grant = (epoch: number, metricIds: string[], recoveryMode: "none" | "full" = "none"): StugubyShareGrant => {
    const updatedAt = new Date(Date.parse(timestamp) + epoch * 1_000).toISOString();
    return {
      id: grantId,
      stugubyId,
      authorityNodeId,
      publicationId,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.telemetry.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 30,
        telemetry: {
          sensorPublicationIds: [],
          metricIds,
          historyFrom: "2026-01-01T00:00:00.000Z",
          live: true,
          maxSamplesPerHour: 10_000,
        },
      }],
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode,
        designatedSuccessorNodeId: recoveryMode === "full" ? authorityNodeId : null,
      },
      epoch,
      revision: epoch,
      expiresAt: null,
      revokedAt: null,
      createdAt: timestamp,
      updatedAt,
    };
  };

  const payload = (
    chunkId: string,
    complete: boolean,
    metricId?: string,
    value?: number,
    sampleTimestamp = timestamp,
  ): StugubyTelemetryPayload => ({
    publicationId,
    chunkId,
    from: sampleTimestamp,
    to: sampleTimestamp,
    complete,
    samples: metricId === undefined ? [] : [{
      sensorPublicationId,
      metricId,
      timestamp: sampleTimestamp,
      value: value ?? 0,
      quality: "good",
    }],
  });

  const event = (epoch: number, telemetry: StugubyTelemetryPayload): StugubySignedEvent => ({
    protocolVersion: STUGBY_PROTOCOL_VERSION,
    stugubyId,
    eventId: `event-${++sequence}`,
    eventKind: "dataset.published",
    authorityNodeId,
    streamId: `dataset:${grantId}:home.telemetry.v1`,
    sequence,
    schema: "home.telemetry.v1",
    resourceId: `${publicationId}:telemetry:${telemetry.chunkId}`,
    operation: "upsert",
    revision: 1,
    grantId,
    grantEpoch: epoch,
    occurredAt: timestamp,
    payload: telemetry,
    payloadHash: "0".repeat(64),
    keyFingerprint: "a".repeat(64),
    signature: "test-signature",
  });

  const apply = (epoch: number, telemetry: StugubyTelemetryPayload): void => {
    store.applyDatasetEvent(event(epoch, telemetry));
  };

  it("keeps incomplete historical chunks out of queries, counts, and recovery promotion", () => {
    store.upsertGrant(grant(1, ["temperature"], "full"));

    apply(1, payload("temperature-partial", false, "temperature", 20));

    expect(store.remoteTelemetry({ stugubyId })).toEqual([]);
    expect(store.remoteTelemetryCount(stugubyId, authorityNodeId, publicationId)).toBe(0);
    expect(store.promoteRecoveryTelemetry(stugubyId, authorityNodeId, publicationId)).toBe(0);
    expect((database.db.prepare("SELECT count(*) AS count FROM stugby_remote_telemetry_staging")
      .get() as { count: number }).count).toBe(1);
  });

  it("atomically replaces one completed snapshot only when its terminal marker arrives", () => {
    store.upsertGrant(grant(1, ["temperature"]));
    apply(1, payload("first", false, "temperature", 20));
    apply(1, payload("first-terminal", true));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 20 }),
    ]);

    apply(1, payload("replacement", false, "temperature", 21));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 20 }),
    ]);

    apply(1, payload("replacement-terminal", true));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 21 }),
    ]);
  });

  it("replays a committed terminal event idempotently after staging has been cleared", () => {
    store.upsertGrant(grant(1, ["temperature"]));
    apply(1, payload("history", false, "temperature", 20));
    const terminal = event(1, payload("history-terminal", true));

    store.applyDatasetEvent(terminal);
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 20 }),
    ]);
    expect((database.db.prepare("SELECT count(*) AS count FROM stugby_remote_telemetry_staging")
      .get() as { count: number }).count).toBe(0);

    // This bypasses inbox deduplication to model a crash after the telemetry
    // transaction commits but before the event receipt is durably recorded.
    store.applyDatasetEvent(terminal);
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 20 }),
    ]);
  });

  it("holds early live chunks behind the same epoch terminal boundary", () => {
    const liveTimestamp = "2026-07-30T09:00:00.000Z";
    store.upsertGrant(grant(1, ["temperature"]));
    apply(1, payload("history", false, "temperature", 20));
    apply(1, payload("early-live", true, "temperature", 21, liveTimestamp));

    expect(store.remoteTelemetry({ stugubyId })).toEqual([]);

    apply(1, payload("history-terminal", true));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ timestamp, value: 20 }),
      expect.objectContaining({ timestamp: liveTimestamp, value: 21 }),
    ]);
    apply(1, payload("later-live", true, "temperature", 22, "2026-07-30T10:00:00.000Z"));
    expect(store.remoteTelemetry({ stugubyId })).toHaveLength(3);
  });

  it("purges the former epoch immediately when a temperature grant narrows to CO2", () => {
    store.upsertGrant(grant(1, ["temperature"]));
    apply(1, payload("temperature", false, "temperature", 20));
    apply(1, payload("temperature-terminal", true));
    apply(1, payload("abandoned-temperature-replacement", false, "temperature", 22));

    store.upsertGrant(grant(3, ["co2"]));

    expect(store.remoteTelemetry({ stugubyId })).toEqual([]);
    expect((database.db.prepare(`SELECT
      (SELECT count(*) FROM stugby_remote_telemetry) AS visible,
      (SELECT count(*) FROM stugby_remote_telemetry_staging) AS staged`).get() as {
      visible: number;
      staged: number;
    })).toEqual({ visible: 0, staged: 0 });
    expect(() => apply(3, payload("forbidden-temperature", false, "temperature", 23)))
      .toThrow(/outside the active grant epoch/);

    apply(3, payload("co2", false, "co2", 650));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([]);
    apply(3, payload("co2-terminal", true));
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "co2", value: 650 }),
    ]);
  });

  it("rolls back the grant epoch when its physical replica purge fails", () => {
    store.upsertGrant(grant(1, ["temperature"]));
    apply(1, payload("temperature", false, "temperature", 20));
    apply(1, payload("temperature-terminal", true));
    database.db.exec(`CREATE TRIGGER fail_stuguby_epoch_purge
      BEFORE DELETE ON stugby_remote_telemetry
      BEGIN SELECT RAISE(ABORT, 'simulated epoch purge failure'); END`);

    expect(() => store.upsertGrant(grant(3, ["co2"]))).toThrow(/simulated epoch purge failure/);
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 1 });
    expect(store.remoteTelemetry({ stugubyId })).toEqual([
      expect.objectContaining({ metricId: "temperature", value: 20 }),
    ]);
  });

  it("resumes a staged recovery snapshot after restart and promotes only its completed current epoch", () => {
    store.upsertGrant(grant(1, ["temperature"], "full"));
    apply(1, payload("old-temperature", false, "temperature", 20));
    store.upsertGrant(grant(3, ["co2"], "full"));
    apply(3, payload("recovery-co2", false, "co2", 700));

    const restarted = new StugubyStore(database.db, authorityNodeId);
    expect(restarted.remoteTelemetry({ stugubyId })).toEqual([]);
    expect(restarted.promoteRecoveryTelemetry(stugubyId, authorityNodeId, publicationId)).toBe(0);

    restarted.applyDatasetEvent(event(3, payload("recovery-terminal", true)));
    expect(restarted.promoteRecoveryTelemetry(stugubyId, authorityNodeId, publicationId)).toBe(1);
    expect(database.db.prepare(`SELECT metric,value FROM measurement_samples
      WHERE sensor_id='sensor-01' ORDER BY metric`).all()).toEqual([
      { metric: "co2", value: 700 },
    ]);
  });
});
