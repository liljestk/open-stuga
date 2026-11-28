import type { AdaptiveFindingEvidenceHour, AdaptiveFindingEvidencePage, AdaptiveShadowFinding } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HOUR_MS } from "../forecast/models.js";
import { ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";

interface EvidenceRequest {
  firstHour: number;
  lastHour: number;
  before: number;
  limit: number;
  visible: (sensorId: string) => boolean;
}

interface DecisionRow { target_hour: number; recorded_at: number; reason: string; context_guard_json: string | null }
interface ClimateRow extends DecisionRow {
  observed_at: number | null;
  observed: number | null;
  prediction: number | null;
  calibration_json: string | null;
  coverage: number | null;
  artifact_version: string | null;
  artifact_cutoff: number | null;
}
interface ReferenceRow extends DecisionRow {
  pair_offset: number | null;
  pair_available_at: number | null;
  paired_hours: number;
}

const iso = (time: number): string => new Date(time).toISOString();
const nullableIso = (time: number | null): string | null => time === null ? null : iso(time);

function objectRecord(parsed: unknown): Record<string, unknown> {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseObject(value: string | null): Record<string, unknown> {
  return objectRecord(value === null ? null : JSON.parse(value));
}

function guard(value: string | null): AdaptiveFindingEvidenceHour["contextGuard"] {
  const { reason, sourceId, until } = parseObject(value);
  if ((reason === "opening-state-change" || reason === "heating-setting-change")
    && typeof sourceId === "string" && typeof until === "number" && Number.isFinite(until)) {
    return { reason, sourceId, until: iso(until) };
  }
  return null;
}

function range(expected: number | null, threshold: unknown): AdaptiveFindingEvidenceHour["range"] {
  return expected !== null && typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0
    ? { lower: expected - threshold, upper: expected + threshold } : null;
}

function common(row: DecisionRow) {
  return { hour: iso(row.target_hour), recordedAt: iso(row.recorded_at), reason: row.reason, contextGuard: guard(row.context_guard_json) };
}

function readClimate(database: ClimateDatabase, epochId: string, window: { from: number; before: number; limit: number }) {
  const rows = database.db.prepare(`SELECT decision.target_hour, decision.decided_at AS recorded_at, decision.reason,
    decision.context_guard_json, decision.calibration_json, prediction.prediction, prediction.artifact_version,
    prediction.artifact_cutoff, outcome.observed, outcome.observed_at, capture.coverage
    FROM adaptive_climate_detector_hours decision
    LEFT JOIN adaptive_climate_predictions prediction USING (epoch_id, target_hour)
    LEFT JOIN adaptive_climate_outcomes outcome ON outcome.epoch_id = decision.epoch_id AND outcome.target_hour = decision.target_hour
      AND outcome.scored_at <= decision.decided_at
    LEFT JOIN adaptive_hourly_evidence capture ON capture.epoch_id = decision.epoch_id AND capture.hour = decision.target_hour
      AND capture.captured_at <= decision.decided_at
    WHERE decision.epoch_id = ? AND decision.target_hour >= ? AND decision.target_hour < ?
    ORDER BY decision.target_hour DESC LIMIT ?`).all(epochId, window.from, window.before, window.limit + 1) as unknown as ClimateRow[];
  return rows.map((row): AdaptiveFindingEvidenceHour => {
    const { bias, threshold } = parseObject(row.calibration_json);
    const expected = row.prediction !== null && typeof bias === "number" && Number.isFinite(bias) ? row.prediction + bias : null;
    return {
      ...common(row), availableAt: nullableIso(row.observed_at), observed: row.observed, expected,
      range: range(expected, threshold), coverage: row.coverage,
      model: row.artifact_version && row.artifact_cutoff !== null
        ? { version: row.artifact_version, evaluatedThrough: iso(row.artifact_cutoff) } : null,
    };
  });
}

function referenceArtifact(database: ClimateDatabase, epochId: string, lastHour: number) {
  const row = database.db.prepare(`SELECT algorithm_version, evaluated_through, result_json FROM adaptive_reference_artifacts
    WHERE epoch_id = ? AND evaluated_through <= ? AND json_type(result_json, '$.calibration') = 'object'
    ORDER BY evaluated_through DESC LIMIT 1`).get(epochId, lastHour) as
    { algorithm_version: string; evaluated_through: number; result_json: string } | undefined;
  if (!row) return null;
  const result = parseObject(row.result_json);
  const calibration = objectRecord(result.calibration);
  const references: unknown = result.references;
  if (!Array.isArray(references) || !references.length || !references.every((id) => typeof id === "string")) return null;
  const expected = typeof calibration.offset === "number" && Number.isFinite(calibration.offset) ? calibration.offset : null;
  return { references: references as string[], expected, range: range(expected, calibration.threshold),
    model: { version: row.algorithm_version, evaluatedThrough: iso(row.evaluated_through) } };
}

function readReference(database: ClimateDatabase, epochId: string, window: { from: number; before: number; limit: number }, artifact: NonNullable<ReturnType<typeof referenceArtifact>>) {
  const rows = database.db.prepare(`SELECT target_hour, recorded_at, reason, context_guard_json, pair_offset, pair_available_at, paired_hours
    FROM adaptive_reference_decisions WHERE epoch_id = ? AND target_hour >= ? AND target_hour < ?
    ORDER BY target_hour DESC LIMIT ?`).all(epochId, window.from, window.before, window.limit + 1) as unknown as ReferenceRow[];
  return rows.map((row): AdaptiveFindingEvidenceHour => ({
    ...common(row), availableAt: nullableIso(row.pair_available_at), observed: row.pair_offset, expected: artifact.expected,
    range: artifact.range, coverage: row.paired_hours / 24, model: artifact.model,
  }));
}

export function adaptiveFindingEvidence(database: ClimateDatabase, finding: AdaptiveShadowFinding, request: EvidenceRequest): AdaptiveFindingEvidencePage {
  const comparison = finding.kind === "sensor-comparison";
  const quantity = comparison ? "temperature-offset" : "measurement";
  const from = Math.max(request.firstHour - (comparison ? 23 : 2) * HOUR_MS, Date.now() - ADAPTIVE_HOUR_RETENTION_MS);
  const before = Math.min(request.before, request.lastHour + 1);
  const window = { from, before, limit: request.limit };
  const artifact = comparison ? referenceArtifact(database, finding.epochId, request.lastHour) : null;
  if (comparison && (!artifact || !artifact.references.every(request.visible))) {
    return { quantity, availability: "unavailable", referenceSensorIds: [], items: [], nextBefore: null };
  }
  const rows = artifact ? readReference(database, finding.epochId, window, artifact) : readClimate(database, finding.epochId, window);
  const items = rows.slice(0, request.limit);
  return {
    quantity, availability: items.length ? "available" : "unavailable",
    referenceSensorIds: artifact?.references ?? [], items, nextBefore: rows.length > request.limit ? items.at(-1)!.hour : null,
  };
}
