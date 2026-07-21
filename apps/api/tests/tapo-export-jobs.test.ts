import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClimateDataValidationError,
  ClimateDatabase,
  type TapoHistoryExportJobInput,
} from "../src/db.js";

const BASE_TIME = "2026-07-18T00:00:00.000Z";
const APP_ARTIFACT_AUDIT = {
  sourceArtifactSha256: "a".repeat(64),
  sourceArtifactBytes: 321,
  parserVersion: "test-parser-v1",
  sourceSchemaSignature: "b".repeat(64),
} as const;

function request(overrides: Partial<TapoHistoryExportJobInput> = {}): TapoHistoryExportJobInput {
  return {
    provider: "appium",
    sensorId: "sensor-01",
    expectedDeviceId: "tapo-device-01",
    deviceName: "Living room sensor",
    metric: "temperature",
    expectedRecipient: "stuga+job@example.com",
    rangeStart: "2026-07-01T00:00:00Z",
    rangeEnd: "2026-07-02T00:00:00Z",
    intervalMinutes: 15,
    ...overrides,
  };
}

describe("durable Tapo history export jobs", () => {
  const databases: ClimateDatabase[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function database(): ClimateDatabase {
    const value = new ClimateDatabase(":memory:", true);
    databases.push(value);
    return value;
  }

  it("deduplicates immutable requests and survives a database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-tapo-export-store-"));
    directories.push(directory);
    const path = join(directory, "climate.db");
    const first = new ClimateDatabase(path, true);
    const created = first.enqueueTapoHistoryExportJob(request(), BASE_TIME);

    expect(created).toMatchObject({
      created: true,
      job: {
        provider: "appium",
        sensorId: "sensor-01",
        expectedDeviceId: "tapo-device-01",
        deviceId: "tapo-device-01",
        deviceName: "Living room sensor",
        timeZone: "Europe/Helsinki",
        metric: "temperature",
        expectedRecipient: "stuga+job@example.com",
        rangeStart: "2026-07-01T00:00:00.000Z",
        from: "2026-07-01T00:00:00.000Z",
        rangeEnd: "2026-07-02T00:00:00.000Z",
        to: "2026-07-02T00:00:00.000Z",
        intervalMinutes: 15,
        status: "queued",
        attemptCount: 0,
      },
    });
    expect(first.enqueueTapoHistoryExportJob(request(), "2026-07-18T00:01:00Z"))
      .toEqual({ job: created.job, created: false });
    first.db.close();

    const reopened = new ClimateDatabase(path, false);
    databases.push(reopened);
    expect(reopened.getTapoHistoryExportJob(created.job.id)).toEqual(created.job);
    expect(reopened.listTapoHistoryExportJobs({ provider: "appium" })).toEqual([created.job]);
  });

  it("leases one worker at a time, rejects stale tokens, and enforces the attempt budget", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request({ maxAttempts: 2 }), BASE_TIME);
    const first = db.claimNextTapoHistoryExportJob(
      "android-01", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    );
    expect(first).toMatchObject({ job: { id: job.id, status: "claimed", leaseOwner: "android-01", attemptCount: 1 } });
    expect(first?.leaseToken).toBeTruthy();
    expect(db.claimNextTapoHistoryExportJob(
      "android-02", "2026-07-18T00:04:00Z", "2026-07-18T00:09:00Z", ["appium"],
    )).toBeNull();
    expect(() => db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:01:00Z", leaseToken: "wrong-token",
    })).toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_LEASE_LOST" }));

    expect(db.heartbeatTapoHistoryExportJob(
      job.id, first!.leaseToken, "2026-07-18T00:02:00Z", "2026-07-18T00:07:00Z",
    )).toMatchObject({ heartbeatAt: "2026-07-18T00:02:00.000Z", leaseExpiresAt: "2026-07-18T00:07:00.000Z" });
    expect(db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:03:00Z", leaseToken: first!.leaseToken,
    })).toMatchObject({ status: "running" });
    expect(() => db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:03:01Z", leaseToken: "wrong-token",
    })).toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_LEASE_LOST" }));
    expect(() => db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:07:00Z", leaseToken: first!.leaseToken,
    })).toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_LEASE_LOST" }));

    const reclaimed = db.claimNextTapoHistoryExportJob(
      "android-02", "2026-07-18T00:08:00Z", "2026-07-18T00:13:00Z", ["appium"],
    );
    expect(reclaimed).toMatchObject({ job: { status: "claimed", attemptCount: 2, leaseOwner: "android-02" } });
    expect(reclaimed!.leaseToken).not.toBe(first!.leaseToken);
    expect(() => db.transitionTapoHistoryExportJob(job.id, {
      status: "failed", at: "2026-07-18T00:09:00Z", leaseToken: first!.leaseToken,
    })).toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_LEASE_LOST" }));
    expect(db.transitionTapoHistoryExportJob(job.id, {
      status: "failed",
      at: "2026-07-18T00:09:00Z",
      availableAt: "2026-07-18T00:10:00Z",
      leaseToken: reclaimed!.leaseToken,
      error: "UI changed",
    })).toMatchObject({ status: "failed", lastError: "UI changed", leaseOwner: null });
    expect(db.claimNextTapoHistoryExportJob(
      "android-03", "2026-07-18T00:11:00Z", "2026-07-18T00:16:00Z", ["appium"],
    )).toBeNull();
    expect(db.cancelTapoHistoryExportJob(job.id, "2026-07-18T00:12:00Z"))
      .toMatchObject({ status: "cancelled", attemptCount: 2 });
    expect(db.requeueTapoHistoryExportJob(job.id, "2026-07-18T00:13:00Z"))
      .toMatchObject({ status: "queued", attemptCount: 0 });
    expect(db.claimNextTapoHistoryExportJob(
      "android-03", "2026-07-18T00:13:00Z", "2026-07-18T00:18:00Z", ["appium"],
    )).toMatchObject({ job: { status: "claimed", attemptCount: 1 } });
  });

  it("permits only one live lease for a physical worker target", () => {
    const db = database();
    db.enqueueTapoHistoryExportJob(request({ dedupeKey: "first-job" }), BASE_TIME);
    db.enqueueTapoHistoryExportJob(request({
      dedupeKey: "second-job", rangeStart: "2026-07-03T00:00:00Z", rangeEnd: "2026-07-04T00:00:00Z",
    }), BASE_TIME);
    expect(db.claimNextTapoHistoryExportJob(
      "tapo-target-one", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    )).not.toBeNull();
    expect(db.claimNextTapoHistoryExportJob(
      "tapo-target-one", "2026-07-18T00:01:00Z", "2026-07-18T00:06:00Z", ["appium"],
    )).toBeNull();
    expect(db.claimNextTapoHistoryExportJob(
      "tapo-target-two", "2026-07-18T00:01:00Z", "2026-07-18T00:06:00Z", ["appium"],
    )).not.toBeNull();
  });

  it("fails an expired final-attempt lease instead of leaving a permanently running job", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request({ maxAttempts: 1 }), BASE_TIME);
    const claim = db.claimNextTapoHistoryExportJob(
      "android-01", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    )!;
    db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:01:00Z", leaseToken: claim.leaseToken,
    });
    expect(db.expireExhaustedTapoHistoryExportLeases("2026-07-18T00:06:00Z")).toBe(1);
    expect(db.getTapoHistoryExportJob(job.id)).toMatchObject({
      status: "failed", leaseOwner: null, lastError: expect.stringMatching(/final mobile-worker attempt/),
    });
  });

  it("claims each mailbox message once and stages normalized samples idempotently", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request(), BASE_TIME);
    const claim = db.claimNextTapoHistoryExportJob(
      "android-01", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    )!;
    db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:01:00Z", leaseToken: claim.leaseToken,
    });
    db.transitionTapoHistoryExportJob(job.id, {
      status: "waiting-email", at: "2026-07-18T00:02:00Z", leaseToken: claim.leaseToken,
    });
    expect(db.attachTapoHistoryExportMailboxMessage(job.id, "gmail-message-01", "2026-07-18T00:03:00Z"))
      .toMatchObject({ mailboxMessageId: "gmail-message-01", status: "waiting-email" });
    expect(db.attachTapoHistoryExportMailboxMessage(job.id, "gmail-message-01", "2026-07-18T00:03:01Z"))
      .toMatchObject({ mailboxMessageId: "gmail-message-01" });

    const other = db.enqueueTapoHistoryExportJob(request({
      dedupeKey: "other-gap",
      rangeStart: "2026-07-03T00:00:00Z",
      rangeEnd: "2026-07-04T00:00:00Z",
    }), BASE_TIME).job;
    expect(() => db.attachTapoHistoryExportMailboxMessage(other.id, "gmail-message-01"))
      .toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_MAILBOX_MESSAGE_CLAIMED" }));

    const inputs = [{
      metric: "temperature",
      value: 20.5,
      canonicalUnit: "°C",
      timestamp: "2026-07-01T01:00:00Z",
      sourceIdentity: "csv:line-2",
      quality: "estimated" as const,
    }, {
      metric: "humidity",
      value: 47,
      canonicalUnit: "%",
      timestamp: "2026-07-01T01:00:00Z",
      sourceIdentity: "csv:line-2",
      quality: "estimated" as const,
    }];
    const completion = db.completeTapoHistoryExportJobWithSamples(job.id, inputs, {
      ...APP_ARTIFACT_AUDIT,
      mailboxMessageId: "gmail-message-01",
      completedAt: "2026-07-18T00:04:00Z",
      expectedRecipient: job.expectedRecipient!,
      expectedSubmittedAt: "2026-07-18T00:02:00.000Z",
    });
    expect(completion).toMatchObject({
      duplicateCount: 0,
      job: { status: "completed", stagedSampleCount: 2, consumedSampleCount: 0 },
    });
    expect(completion.staged).toHaveLength(2);
    expect(db.completeTapoHistoryExportJobWithSamples(job.id, inputs, {
      ...APP_ARTIFACT_AUDIT,
      mailboxMessageId: "gmail-message-01",
      completedAt: "2026-07-18T00:05:00Z",
    })).toMatchObject({ duplicateCount: 2, staged: [], job: { stagedSampleCount: 2 } });

    const temperature = db.listTapoHistoryExportStagedSamples({
      jobId: job.id,
      sensorId: "sensor-01",
      metric: "temperature",
      from: "2026-07-01T00:30:00Z",
      to: "2026-07-01T01:30:00Z",
      consumed: false,
    });
    expect(temperature).toEqual([expect.objectContaining({
      jobId: job.id,
      sensorId: "sensor-01",
      metric: "temperature",
      value: 20.5,
      source: "tp-link",
      sourceIdentity: "csv:line-2",
      consumedAt: null,
    })]);
    expect(db.markTapoHistoryExportStagedSamplesConsumed(
      job.id, temperature.map((sample) => sample.id), "2026-07-18T00:06:00Z",
    )).toBe(1);
    expect(db.markTapoHistoryExportStagedSamplesConsumed(
      job.id, temperature.map((sample) => sample.id), "2026-07-18T00:07:00Z",
    )).toBe(0);
    expect(db.getTapoHistoryExportJob(job.id)).toMatchObject({ consumedSampleCount: 1, stagedSampleCount: 2 });
    expect(db.listTapoHistoryExportStagedSamples({ jobId: job.id, consumed: false }))
      .toEqual([expect.objectContaining({ metric: "humidity" })]);
  });

  it("reads and consumes a completed metric beyond the former 100000-row boundary", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request(), BASE_TIME);
    db.db.exec(`WITH digits(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
      numbers(n) AS (
        SELECT a.n + b.n*10 + c.n*100 + d.n*1000 + e.n*10000 + f.n*100000
        FROM digits a, digits b, digits c, digits d, digits e, digits f
        LIMIT 100001
      )
      INSERT INTO tapo_history_export_staged_samples
        (job_id, sensor_id, metric, value, canonical_unit, timestamp, source, quality,
         source_identity, created_at, consumed_at)
      SELECT '${job.id}', 'sensor-01', 'temperature', 20, 'Â°C', '2026-07-01T01:00:00.000Z',
        'tp-link', 'good', 'bulk-' || n, '${BASE_TIME}', NULL FROM numbers`);
    const rows = db.listTapoHistoryExportStagedSamples({ jobId: job.id, metric: "temperature", limit: 250_000 });
    expect(rows).toHaveLength(100_001);
    expect(db.markTapoHistoryExportStagedSamplesConsumed(job.id, rows.map((row) => row.id), BASE_TIME)).toBe(100_001);
    expect(db.getTapoHistoryExportJob(job.id)).toMatchObject({ stagedSampleCount: 100_001, consumedSampleCount: 100_001 });
  }, 15_000);

  it("rolls back mailbox assignment and staged rows when any sample is invalid", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request(), BASE_TIME);
    const claim = db.claimNextTapoHistoryExportJob(
      "android-01", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    )!;
    db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:00:30Z", leaseToken: claim.leaseToken,
    });
    db.transitionTapoHistoryExportJob(job.id, {
      status: "waiting-email", at: "2026-07-18T00:01:00Z", leaseToken: claim.leaseToken,
    });
    expect(() => db.completeTapoHistoryExportJobWithSamples(job.id, [{
      metric: "temperature",
      value: 20,
      canonicalUnit: "°C",
      timestamp: "2026-07-01T01:00:00Z",
      sourceIdentity: "csv:valid",
    }, {
      metric: "humidity",
      value: 120,
      canonicalUnit: "%",
      timestamp: "2026-07-01T01:00:00Z",
      sourceIdentity: "csv:invalid",
    }], {
      ...APP_ARTIFACT_AUDIT,
      mailboxMessageId: "gmail-rollback",
      completedAt: "2026-07-18T00:02:00Z",
      expectedRecipient: job.expectedRecipient!,
      expectedSubmittedAt: "2026-07-18T00:01:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "INVALID_TAPO_EXPORT_VALUE" }));
    expect(db.getTapoHistoryExportJob(job.id)).toMatchObject({
      status: "waiting-email", mailboxMessageId: null, stagedSampleCount: 0,
    });
    expect(db.listTapoHistoryExportStagedSamples({ jobId: job.id })).toEqual([]);
  });

  it("fences a late mailbox completion after cancel and retry create a new attempt", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request(), BASE_TIME);
    const claim = db.claimNextTapoHistoryExportJob(
      "android-01", BASE_TIME, "2026-07-18T00:05:00Z", ["appium"],
    )!;
    db.transitionTapoHistoryExportJob(job.id, {
      status: "running", at: "2026-07-18T00:01:00Z", leaseToken: claim.leaseToken,
    });
    const waiting = db.transitionTapoHistoryExportJob(job.id, {
      status: "waiting-email", at: "2026-07-18T00:02:00Z", leaseToken: claim.leaseToken,
    })!;
    db.cancelTapoHistoryExportJob(job.id, "2026-07-18T00:03:00Z");
    db.requeueTapoHistoryExportJob(job.id, "2026-07-18T00:04:00Z");

    expect(() => db.completeTapoHistoryExportJobWithSamples(job.id, [{
      metric: "temperature", value: 20, canonicalUnit: "Â°C",
      timestamp: "2026-07-01T01:00:00Z", sourceIdentity: "gmail:late:line-2",
    }], {
      ...APP_ARTIFACT_AUDIT,
      mailboxMessageId: "gmail-late",
      completedAt: "2026-07-18T00:04:30Z",
      expectedRecipient: waiting.expectedRecipient!,
      expectedSubmittedAt: waiting.submittedAt!,
    })).toThrowError(expect.objectContaining({ code: "TAPO_EXPORT_GENERATION_CHANGED" }));
    expect(db.getTapoHistoryExportJob(job.id)).toMatchObject({
      status: "queued", submittedAt: null, mailboxMessageId: null, stagedSampleCount: 0,
    });
    expect(db.listTapoHistoryExportStagedSamples({ jobId: job.id })).toEqual([]);
  });

  it("expedites an overlapping failed or partial sensor gap when an asynchronous export arrives", () => {
    const db = database();
    const gap = db.noteHistoricalSensorDataGap(
      "sensor-01", "temperature", "tp-link", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", BASE_TIME,
    );
    db.claimSensorDataGapRecovery(gap.id, BASE_TIME, "2026-07-18T00:05:00Z");
    db.updateSensorDataGapRecovery(
      gap.id, "partial", 0, BASE_TIME, "Waiting for CSV", "2026-07-19T00:00:00Z",
    );
    expect(db.expediteSensorDataGapRecovery(
      "sensor-01", "tp-link", "2026-07-01T12:00:00Z", "2026-07-02T12:00:00Z", "2026-07-18T00:02:00Z",
    )).toBe(1);
    expect(db.sensorDataGap(gap.id)).toMatchObject({
      recoveryState: "partial",
      nextAttemptAt: "2026-07-18T00:02:00.000Z",
      recoveryError: null,
    });
    expect(db.expediteSensorDataGapRecovery(
      "sensor-01", "tp-link", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z", "2026-07-18T00:03:00Z",
    )).toBe(0);
  });

  it("rejects a reused source identity whose content changed", () => {
    const db = database();
    const { job } = db.enqueueTapoHistoryExportJob(request({ provider: "private-cloud", expectedRecipient: null }), BASE_TIME);
    db.completeTapoHistoryExportJobWithSamples(job.id, [{
      metric: "temperature", value: 20, canonicalUnit: "°C",
      timestamp: "2026-07-01T01:00:00Z", sourceIdentity: "private:record-1",
    }], { completedAt: "2026-07-18T00:01:00Z" });
    expect(() => db.completeTapoHistoryExportJobWithSamples(job.id, [{
      metric: "temperature", value: 21, canonicalUnit: "°C",
      timestamp: "2026-07-01T01:00:00Z", sourceIdentity: "private:record-1",
    }], { completedAt: "2026-07-18T00:02:00Z" })).toThrowError(ClimateDataValidationError);
    expect(db.listTapoHistoryExportStagedSamples({ jobId: job.id })).toHaveLength(1);
  });

  it("prunes consumed jobs atomically while retaining recent unconsumed recovery evidence", () => {
    const db = database();
    const completePrivate = (dedupeKey: string, rangeStart: string) => {
      const rangeEnd = new Date(Date.parse(rangeStart) + 24 * 60 * 60_000).toISOString();
      const job = db.enqueueTapoHistoryExportJob(request({
        provider: "private-cloud",
        expectedRecipient: null,
        dedupeKey,
        rangeStart,
        rangeEnd,
      }), "2026-01-01T00:00:00Z").job;
      return db.completeTapoHistoryExportJobWithSamples(job.id, [{
        metric: "temperature",
        value: 20,
        canonicalUnit: "\u00b0C",
        timestamp: new Date(Date.parse(rangeStart) + 60 * 60_000).toISOString(),
        sourceIdentity: `${dedupeKey}:row-1`,
      }], { completedAt: "2026-01-02T00:00:00Z" });
    };
    const consumed = completePrivate("retention:consumed", "2025-12-01T00:00:00Z");
    const pending = completePrivate("retention:pending", "2025-12-03T00:00:00Z");
    const canary = completePrivate("canary:retention", "2025-12-05T00:00:00Z");
    db.markTapoHistoryExportStagedSamplesConsumed(
      consumed.job.id,
      consumed.staged.map((sample) => sample.id),
      "2026-01-03T00:00:00Z",
    );

    const pruned = db.pruneTapoHistoryExportHistory({
      consumedBefore: "2026-02-01T00:00:00Z",
      completedBefore: "2025-01-01T00:00:00Z",
      canaryBefore: "2026-02-01T00:00:00Z",
    });

    expect(pruned).toEqual({ jobs: 2, samples: 2 });
    expect(db.getTapoHistoryExportJob(consumed.job.id)).toBeNull();
    expect(db.getTapoHistoryExportJob(canary.job.id)).toBeNull();
    expect(db.getTapoHistoryExportJob(pending.job.id)).toMatchObject({ status: "completed", stagedSampleCount: 1 });
    expect(db.listTapoHistoryExportStagedSamples({ jobId: pending.job.id })).toHaveLength(1);
  });
});
