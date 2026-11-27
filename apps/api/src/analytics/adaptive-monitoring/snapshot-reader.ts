import { createHash } from "node:crypto";
import type { AdaptiveFindingState, AdaptiveHomeSnapshot, AdaptiveMetric, AdaptiveMonitoringState, AdaptiveSettingsScope } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { hourStart } from "../forecast/models.js";
import { adaptiveFindingHistoryStamp, adaptiveFindingsPage } from "./findings-reader.js";
import { adaptiveSnapshotStreams, type WorkerAvailability } from "./snapshot-streams.js";

interface Options {
  actor: string;
  visible: (sensorId: string) => boolean;
  worker: WorkerAvailability;
  limit: number;
  streamCursor?: string;
  findingCursor?: string;
  metric?: AdaptiveMetric;
  state?: AdaptiveFindingState;
}

function encode(snapshotId: string, collection: string, cursor: string): string {
  return Buffer.from(JSON.stringify([snapshotId, collection, cursor])).toString("base64url");
}

function decode(raw: string | undefined, snapshotId: string, collection: string): string | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch {
    throw new HttpError(400, "INVALID_ADAPTIVE_CURSOR", "Invalid Adaptive Home snapshot cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[1] !== collection || typeof parsed[2] !== "string") {
    throw new HttpError(400, "INVALID_ADAPTIVE_CURSOR", "Invalid Adaptive Home snapshot cursor");
  }
  if (parsed[0] !== snapshotId) {
    throw new HttpError(409, "ADAPTIVE_SNAPSHOT_CHANGED", "Adaptive Home has changed. Read the snapshot again without a cursor.",
      { action: "read-without-cursors" });
  }
  return parsed[2];
}

function overallState(counts: AdaptiveHomeSnapshot["counts"], disabled: boolean, worker: WorkerAvailability): AdaptiveMonitoringState {
  if (disabled) return "disabled";
  if (worker) return worker;
  if (counts.stale) return "stale";
  if (counts.total === 0 || counts.collecting) return "collecting";
  return "ready";
}

export function adaptiveHomeSnapshot(database: ClimateDatabase, scope: AdaptiveSettingsScope, options: Options): AdaptiveHomeSnapshot {
  return database.transaction(() => {
    const settings = database.adaptiveMonitoringSettings(scope);
    const generatedAt = new Date().toISOString();
    const through = hourStart(Date.parse(generatedAt));
    const all = adaptiveSnapshotStreams(database, { settings, through, worker: options.worker, visible: options.visible });
    const counts = { total: all.length, disabled: 0, collecting: 0, ready: 0, stale: 0, paused: 0, failed: 0 };
    let earliestEvaluated: string | null = null;
    for (const stream of all) {
      counts[stream.state] += 1;
      const time = stream.evaluatedThrough;
      if (time && (!earliestEvaluated || time < earliestEvaluated)) earliestEvaluated = time;
    }
    const state = overallState(counts, settings.mode === "off", options.worker);
    const snapshotId = createHash("sha256").update(JSON.stringify([
      options.actor, scope, settings.revision, through, state, all,
      adaptiveFindingHistoryStamp(database, scope), options.metric, options.state,
    ])).digest("hex");
    const streamOffset = Number(decode(options.streamCursor, snapshotId, "streams") ?? 0);
    if (!Number.isSafeInteger(streamOffset) || streamOffset < 0) throw new HttpError(400, "INVALID_ADAPTIVE_CURSOR", "Invalid stream position");
    const selected = options.metric ? all.filter(({ metric }) => metric === options.metric) : all;
    const nextOffset = streamOffset + options.limit;
    const findingsCursor = decode(options.findingCursor, snapshotId, "findings");
    const findings = adaptiveFindingsPage(database, scope, {
      ...options, ...(findingsCursor === undefined ? {} : { cursor: findingsCursor }),
    });
    const evaluatedThrough = all.every((stream) => stream.evaluatedThrough !== null) ? earliestEvaluated : null;
    const evaluatedAt = earliestEvaluated ?? generatedAt;
    return {
      apiVersion: "1.0", ...scope, generatedAt, evaluatedAt, evaluatedThrough, settings, state, snapshotId, counts, warnings: [],
      completeness: state === "ready" ? "complete" : earliestEvaluated ? "partial" : "unavailable",
      provenance: { algorithmKey: "adaptive-home", algorithmVersion: "snapshot/v1", evaluatedAt, sourceIds: ["local-adaptive-evidence"] },
      streams: { items: selected.slice(streamOffset, nextOffset),
        nextCursor: nextOffset < selected.length ? encode(snapshotId, "streams", String(nextOffset)) : null },
      findings: { items: findings.items, nextCursor: findings.nextCursor ? encode(snapshotId, "findings", findings.nextCursor) : null },
    };
  });
}
