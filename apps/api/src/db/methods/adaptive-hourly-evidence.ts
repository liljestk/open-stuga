import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope, MeasurementDefinition } from "@climate-twin/contracts";
import {
  ADAPTIVE_CADENCE_LOOKBACK_MS, ADAPTIVE_CAPTURE_HORIZON_MS, ADAPTIVE_HOUR_RETENTION_MS, ADAPTIVE_MAX_CADENCE_ROWS,
  ADAPTIVE_MAX_HOUR_ROWS, expectedCadenceMs, isObservedSource, missingHour, summarizeClosedHour,
  type ClosedHour, type HourGap,
} from "../../analytics/adaptive-monitoring/closed-hour.js";
import { HOUR_MS } from "../../analytics/forecast/models.js";
import { sealAdaptiveWeather } from "../../analytics/adaptive-monitoring/weather-evidence.js";
import { registerDatabaseMethods, type DatabaseInternals } from "../core.js";

interface EpochRequest { scope: AdaptiveEvidenceScope; epochId: string }
interface HourCapture extends EpochRequest { hour: number }
interface HourRange extends EpochRequest { from: number; to: number }
interface CapturedHour { hour: number; capturedAt: number; outcome: ClosedHour }
type CaptureResult =
  | { status: "sealed"; capture: CapturedHour }
  | { status: "epoch-changed" | "outside-capture-window" | "local-history-incomplete" };

interface CaptureRow {
  hour: number;
  captured_at: number;
  value: number | null;
  coverage: number;
  observation_source: string | null;
  gap_reason: HourGap | null;
}

interface RawRow {
  timestamp: string;
  recorded_at: string;
  value: number;
  canonical_unit: string;
  source: string;
}

function toCapture(epoch: AdaptiveEvidenceEpoch, row: CaptureRow): CapturedHour {
  const { hour, captured_at: capturedAt, value, coverage, observation_source: source, gap_reason: reason } = row;
  const outcome: ClosedHour = value === null ? missingHour(reason!, coverage) : {
    source: source!, reason: null, coverage,
    evidence: {
      epochId: epoch.id, time: hour, availableAt: capturedAt, value, coverage, quality: "good",
      source: epoch.dataMode === "live" ? "observed" : "demo", archiveComplete: true,
    },
  };
  return { hour, capturedAt, outcome };
}

function captureRows(database: DatabaseInternals, { epochId, from, to }: Omit<HourRange, "scope">): CaptureRow[] {
  return database.db.prepare(`SELECT hour, captured_at, value, coverage, observation_source, gap_reason
    FROM adaptive_hourly_evidence WHERE epoch_id = ? AND hour >= ? AND hour < ? ORDER BY hour`)
    .all(epochId, from, to) as unknown as CaptureRow[];
}

function rawRows(database: DatabaseInternals, input: {
  epoch: AdaptiveEvidenceEpoch; from: number; to: number; capturedAt: number; source?: string;
}): RawRow[] {
  const { epoch, from, to, capturedAt, source } = input;
  const bySource = source === undefined ? "" : "AND source = ?";
  return database.db.prepare(`SELECT timestamp, recorded_at, value, canonical_unit, source
    FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND data_mode = ?
      AND timestamp >= ? AND timestamp < ? AND recorded_at IS NOT NULL AND recorded_at <= ? AND quality = 'good'
      ${bySource}
    ORDER BY timestamp DESC, id DESC LIMIT ?`)
    .all(epoch.sensorId, epoch.metric, epoch.dataMode, new Date(from).toISOString(), new Date(to).toISOString(),
      new Date(capturedAt).toISOString(), ...(source === undefined ? [] : [source]),
      source === undefined ? ADAPTIVE_MAX_HOUR_ROWS + 1 : ADAPTIVE_MAX_CADENCE_ROWS) as unknown as RawRow[];
}

function observedTime(row: RawRow, definition: MeasurementDefinition): number | null {
  const time = Date.parse(row.timestamp);
  if (!Number.isFinite(time) || !(Date.parse(row.recorded_at) >= time)) return null;
  if (!Number.isFinite(row.value) || row.canonical_unit !== definition.unit) return null;
  if (definition.validMin !== null && row.value < definition.validMin) return null;
  if (definition.validMax !== null && row.value > definition.validMax) return null;
  return time;
}

function localPrunedThrough(database: DatabaseInternals): number {
  const row = database.db.prepare("SELECT value FROM metadata WHERE key = 'adaptive_local_measurements_pruned_through'")
    .get() as { value: string } | undefined;
  return row ? Date.parse(row.value) : Number.NEGATIVE_INFINITY;
}

function summarize(database: DatabaseInternals, epoch: AdaptiveEvidenceEpoch, { hour, capturedAt }: {
  hour: number; capturedAt: number;
}): ClosedHour {
  const rows = rawRows(database, { epoch, from: hour, to: hour + HOUR_MS, capturedAt });
  if (rows.length > ADAPTIVE_MAX_HOUR_ROWS) return missingHour("row-limit");
  const definition = database.getMeasurementDefinition(epoch.metric)!;
  const observations = rows.flatMap((row) => {
    const time = observedTime(row, definition);
    return time !== null && isObservedSource(row.source, epoch.dataMode) ? [{ time, value: row.value, source: row.source }] : [];
  });
  const source = observations[0]?.source;
  const prior = database.db.prepare("SELECT observation_source AS source FROM adaptive_epoch_observation_sources WHERE epoch_id = ?")
    .get(epoch.id) as { source: string } | undefined;
  const from = Math.max(hour - ADAPTIVE_CADENCE_LOOKBACK_MS, Date.parse(epoch.effectiveAt), localPrunedThrough(database));
  const priorTimes = source ? rawRows(database, { epoch, from, to: hour, capturedAt, source })
    .flatMap((row) => {
      const time = observedTime(row, definition);
      return time === null ? [] : [time];
    }).reverse() : [];
  return summarizeClosedHour({
    epochId: epoch.id, dataMode: epoch.dataMode, hour, availableAt: capturedAt,
    observations, expectedSource: prior?.source ?? null, cadenceMs: expectedCadenceMs(priorTimes),
  });
}

function storeCapture(database: DatabaseInternals, epochId: string, capture: CapturedHour): void {
  const { hour, capturedAt, outcome } = capture;
  database.db.prepare(`INSERT INTO adaptive_hourly_evidence
    (epoch_id, hour, captured_at, value, coverage, observation_source, gap_reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(epochId, hour, capturedAt, outcome.evidence?.value ?? null, outcome.coverage, outcome.source, outcome.reason);
  if (outcome.source !== null) {
    database.db.prepare("INSERT OR IGNORE INTO adaptive_epoch_observation_sources (epoch_id, observation_source) VALUES (?, ?)")
      .run(epochId, outcome.source);
  }
}

function inCaptureWindow(epoch: AdaptiveEvidenceEpoch, hour: number, now: number): boolean {
  return hour >= Date.parse(epoch.effectiveAt) && hour + HOUR_MS <= now
    && now - (hour + HOUR_MS) <= ADAPTIVE_CAPTURE_HORIZON_MS
    && now >= Date.parse(epoch.recordedAt);
}

declare module "../core.js" {
  interface DatabaseInternals {
    captureAdaptiveHour(input: HourCapture): CaptureResult;
    readAdaptiveHours(input: HourRange): CapturedHour[];
    pruneAdaptiveHours(): number;
  }

  interface ClimateDatabaseCore {
    captureAdaptiveHour(input: HourCapture): CaptureResult;
    readAdaptiveHours(input: HourRange): CapturedHour[];
    pruneAdaptiveHours(): number;
  }
}

registerDatabaseMethods({
  captureAdaptiveHour({ scope, epochId, hour }: HourCapture): CaptureResult {
    return this.immediateTransaction(() => {
      const epoch = this.readAdaptiveEvidenceEpoch(scope);
      if (epoch?.id !== epochId) return { status: "epoch-changed" };
      if (!Number.isSafeInteger(hour) || hour % HOUR_MS !== 0) return { status: "outside-capture-window" };
      const [sealed] = captureRows(this, { epochId, from: hour, to: hour + HOUR_MS });
      if (sealed?.hour === hour) return { status: "sealed", capture: toCapture(epoch, sealed) };
      const capturedAt = Date.now();
      if (!inCaptureWindow(epoch, hour, capturedAt)) return { status: "outside-capture-window" };
      if (!(hour >= localPrunedThrough(this))) return { status: "local-history-incomplete" };
      const capture = { hour, capturedAt, outcome: summarize(this, epoch, { hour, capturedAt }) };
      storeCapture(this, epochId, capture);
      sealAdaptiveWeather(this, epoch, capture);
      return { status: "sealed", capture };
    });
  },
  readAdaptiveHours({ scope, epochId, from, to }: HourRange): CapturedHour[] {
    return this.transaction(() => {
      const epoch = this.readAdaptiveEvidenceEpoch(scope);
      if (epoch?.id !== epochId || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return [];
      const now = Date.now();
      return captureRows(this, { epochId, from: Math.max(from, now - ADAPTIVE_HOUR_RETENTION_MS), to: Math.min(to, now) })
        .map((row) => toCapture(epoch, row));
    });
  },
  pruneAdaptiveHours(): number {
    return Number(this.db.prepare(`DELETE FROM adaptive_hourly_evidence WHERE (epoch_id, hour) IN (
      SELECT epoch_id, hour FROM adaptive_hourly_evidence WHERE hour < ? ORDER BY hour LIMIT 1024
    )`).run(Date.now() - ADAPTIVE_HOUR_RETENTION_MS).changes);
  },
});
