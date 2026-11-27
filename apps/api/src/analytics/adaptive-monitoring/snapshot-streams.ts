import type {
  AdaptiveEvidenceScope, AdaptiveMonitoringSettings, AdaptiveMonitoringState, AdaptiveStreamReason, AdaptiveStreamStatus,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HOUR_MS } from "../forecast/models.js";
import { AdaptiveCollectionStore } from "./collection-store.js";

export type WorkerAvailability = "paused" | "failed" | null;

interface Options {
  settings: AdaptiveMonitoringSettings;
  through: number;
  worker: WorkerAvailability;
  visible: (sensorId: string) => boolean;
}

interface EvidenceStatus {
  through: number | null;
  coverage: number | null;
  state: AdaptiveMonitoringState;
  reason: AdaptiveStreamReason;
}

type Decision = { target_hour: number; reason: string; calibration_json: string | null };

function climateProgress(database: ClimateDatabase, epochId: string, through: number): EvidenceStatus {
  const decision = database.db.prepare(`SELECT target_hour, reason, calibration_json FROM adaptive_climate_detector_hours
    WHERE epoch_id = ? AND target_hour < ? ORDER BY target_hour DESC LIMIT 1`).get(epochId, through) as Decision | undefined;
  const count = database.db.prepare(`SELECT count(value) AS available FROM adaptive_hourly_evidence
    WHERE epoch_id = ? AND hour >= ? AND hour < ?`).get(epochId, through - 24 * HOUR_MS, through) as { available: number };
  const coverage = count.available / 24;
  if (!decision) {
    const artifact = database.db.prepare(`SELECT json_extract(report_json, '$.state') AS state FROM adaptive_climate_artifacts
      WHERE epoch_id = ? ORDER BY evaluated_through DESC LIMIT 1`).get(epochId) as { state: string } | undefined;
    const reason = artifact?.state === "rejected" ? "qualification-rejected" : "awaiting-evidence";
    return { through: null, coverage, state: "collecting", reason };
  }
  const evaluated = decision.target_hour + HOUR_MS;
  if (through - evaluated > 2 * HOUR_MS || !["calibrated", "frozen-calibration", "insufficient-calibration"].includes(decision.reason)) {
    return { through: evaluated, coverage, state: "stale", reason: "evidence-gap" };
  }
  return decision.calibration_json
    ? { through: evaluated, coverage, state: "ready", reason: "current-evidence" }
    : { through: evaluated, coverage, state: "collecting", reason: "calibration-pending" };
}

function comparisonProgress(database: ClimateDatabase, epochId: string, through: number): EvidenceStatus {
  const decision = database.db.prepare(`SELECT target_hour, paired_hours, state FROM adaptive_reference_decisions
    WHERE epoch_id = ? AND target_hour < ? ORDER BY target_hour DESC LIMIT 1`).get(epochId, through) as
    { target_hour: number; paired_hours: number; state: string } | undefined;
  if (!decision) return { through: null, coverage: null, state: "collecting", reason: "awaiting-evidence" };
  const evaluated = decision.target_hour + HOUR_MS;
  const coverage = decision.paired_hours / 24;
  if (through - evaluated > 2 * HOUR_MS || decision.state === "stale") {
    return { through: evaluated, coverage, state: "stale", reason: "evidence-gap" };
  }
  return decision.state === "collecting"
    ? { through: evaluated, coverage, state: "collecting", reason: "awaiting-evidence" }
    : { through: evaluated, coverage, state: "ready", reason: "current-evidence" };
}

function streamStatus(database: ClimateDatabase, scope: AdaptiveEvidenceScope, options: Options): AdaptiveStreamStatus {
  const { sensorId, metric, purpose } = scope;
  const base = { sensorId, metric, purpose, epochId: null, coverage: null, evaluatedThrough: null };
  if (options.settings.mode === "off") return { ...base, state: "disabled", reason: "monitoring-off" };
  const epoch = database.readAdaptiveEvidenceEpoch(scope);
  const progress = !epoch ? { through: null, coverage: null, state: "collecting", reason: "awaiting-evidence" } as const
    : purpose === "climate" ? climateProgress(database, epoch.id, options.through) : comparisonProgress(database, epoch.id, options.through);
  const evaluatedThrough = progress.through === null ? null : new Date(progress.through).toISOString();
  const detail = { ...base, epochId: epoch?.id ?? null, coverage: progress.coverage, evaluatedThrough };
  if (options.worker) return { ...detail, state: options.worker, reason: options.worker === "paused" ? "worker-paused" : "worker-failed" };
  return { ...detail, state: progress.state, reason: progress.reason };
}

export function adaptiveSnapshotStreams(database: ClimateDatabase, options: Options): AdaptiveStreamStatus[] {
  const { houseId, dataMode, referenceGroups } = options.settings;
  const scope = { houseId, dataMode };
  const inventory = new AdaptiveCollectionStore(database).houseStreams(scope);
  const comparisons = referenceGroups.map(({ targetSensorId }): AdaptiveEvidenceScope => ({
    ...scope, sensorId: targetSensorId, metric: "temperature", purpose: "sensor-comparison",
  }));
  return [...inventory, ...comparisons].filter(({ sensorId }) => options.visible(sensorId))
    .map((stream) => streamStatus(database, stream, options));
}
