import { createHash } from "node:crypto";
import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HOUR_MS, hourStart } from "../forecast/models.js";
import { AdaptiveClimateArtifacts } from "./climate-artifacts.js";
import { CausalClimatePredictor, CLIMATE_FIT_WINDOW_MS, climateBaselines } from "./climate-prediction.js";
import { ADAPTIVE_CAPTURE_HORIZON_MS, ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import { evidenceByHour } from "./evidence.js";

interface ClimateLedgerEntry {
  target_hour: number;
  issued_at: number;
  recorded_at: number;
  artifact_version: string;
  artifact_cutoff: number;
  input_digest: string;
  prediction: number;
  persistence: number | null;
  seasonal: number | null;
  scored_at: number | null;
  observed_at: number | null;
  observed: number | null;
  gap_reason: string | null;
}

export class AdaptiveClimateLedger {
  constructor(private readonly database: ClimateDatabase, private readonly artifacts: AdaptiveClimateArtifacts) {}

  advance(epoch: AdaptiveEvidenceEpoch): { predictions: number; outcomes: number } {
    return this.database.transaction(() => {
      if (epoch.purpose !== "climate" || this.database.readAdaptiveEvidenceEpoch(epoch)?.id !== epoch.id) {
        return { predictions: 0, outcomes: 0 };
      }
      const now = Date.now();
      const outcomes = this.#score(epoch.id, now);
      const predictions = this.#predict(epoch, now);
      return { predictions, outcomes };
    });
  }

  #score(epochId: string, now: number): number {
    const closedThrough = now - HOUR_MS;
    const expiry = closedThrough - ADAPTIVE_CAPTURE_HORIZON_MS;
    return Number(this.database.db.prepare(`INSERT INTO adaptive_climate_outcomes
        (epoch_id, target_hour, scored_at, observed_at, observed, gap_reason)
      SELECT prediction.epoch_id, prediction.target_hour, ?, captured.captured_at, captured.value,
        CASE WHEN captured.hour IS NULL THEN 'capture-expired' ELSE captured.gap_reason END
      FROM adaptive_climate_predictions prediction
      LEFT JOIN adaptive_hourly_evidence captured ON captured.epoch_id = prediction.epoch_id
        AND captured.hour = prediction.target_hour AND captured.captured_at <= ?
      LEFT JOIN adaptive_climate_outcomes outcome ON outcome.epoch_id = prediction.epoch_id
        AND outcome.target_hour = prediction.target_hour
      WHERE prediction.epoch_id = ? AND prediction.target_hour BETWEEN ? AND ?
        AND outcome.epoch_id IS NULL AND (captured.hour IS NOT NULL OR prediction.target_hour < ?)
      ORDER BY prediction.target_hour LIMIT 64`)
      .run(now, now, epochId, now - ADAPTIVE_HOUR_RETENTION_MS, closedThrough, expiry).changes);
  }

  #predict(epoch: AdaptiveEvidenceEpoch, issuedAt: number): number {
    const targetHour = hourStart(issuedAt) + HOUR_MS;
    if (this.database.db.prepare("SELECT 1 FROM adaptive_climate_predictions WHERE epoch_id = ? AND target_hour = ?")
      .get(epoch.id, targetHour)) return 0;
    const artifact = this.artifacts.read(epoch);
    if (!artifact || artifact.report.state !== "technical-pass" || artifact.recordedAt > issuedAt) return 0;
    // Automatic qualification currently has indoor evidence only.
    const policy = artifact.report.candidates[0]?.policy;
    if (policy?.kind !== "daily-profile") return 0;
    const points = this.database.readAdaptiveHours({
      scope: epoch, epochId: epoch.id, from: targetHour - CLIMATE_FIT_WINDOW_MS, to: targetHour,
    }).flatMap(({ outcome }) =>
      outcome.evidence && outcome.evidence.availableAt <= issuedAt ? [outcome.evidence] : []);
    const target = evidenceByHour(points, {
      epochId: epoch.id, dataMode: epoch.dataMode, trustworthyFrom: Date.parse(epoch.effectiveAt),
    });
    const value = new CausalClimatePredictor({ target, outdoor: new Map() }, policy).predict(targetHour, issuedAt);
    const { persistence, seasonal } = climateBaselines(target, targetHour, issuedAt);
    const publishedAt = Date.now();
    if (value === null || !Number.isFinite(value) || publishedAt >= targetHour || publishedAt < issuedAt) return 0;
    const digest = createHash("sha256").update(JSON.stringify([
      artifact.inputDigest, targetHour, issuedAt, [...target.values()],
    ])).digest("hex");
    return Number(this.database.db.prepare(`INSERT INTO adaptive_climate_predictions
      (epoch_id, target_hour, issued_at, recorded_at, artifact_version, artifact_cutoff, input_digest, prediction, persistence, seasonal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(epoch.id, targetHour, issuedAt, publishedAt, artifact.algorithmVersion, artifact.evaluatedThrough, digest,
        value, persistence, seasonal).changes);
  }

  read(scope: AdaptiveEvidenceScope, window: { from: number; to: number }): ClimateLedgerEntry[] {
    return this.database.transaction(() => {
      const epoch = this.database.readAdaptiveEvidenceEpoch(scope);
      if (!epoch || !Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to)) return [];
      return this.database.db.prepare(`SELECT prediction.target_hour, prediction.issued_at, prediction.recorded_at, prediction.artifact_version,
          prediction.artifact_cutoff, prediction.input_digest, prediction.prediction, prediction.persistence, prediction.seasonal,
          outcome.scored_at, outcome.observed_at, outcome.observed, outcome.gap_reason
        FROM adaptive_climate_predictions prediction
        LEFT JOIN adaptive_climate_outcomes outcome USING (epoch_id, target_hour)
        WHERE prediction.epoch_id = ? AND prediction.target_hour >= ? AND prediction.target_hour < ? ORDER BY prediction.target_hour`)
        .all(epoch.id, Math.max(window.from, Date.now() - ADAPTIVE_HOUR_RETENTION_MS), window.to) as unknown as ClimateLedgerEntry[];
    });
  }

  hasExpired(): boolean {
    return this.database.db.prepare("SELECT 1 FROM adaptive_climate_predictions WHERE target_hour < ? LIMIT 1")
      .get(Date.now() - ADAPTIVE_HOUR_RETENTION_MS) !== undefined;
  }

  pruneExpired(): void {
    this.database.db.prepare(`DELETE FROM adaptive_climate_predictions WHERE (epoch_id, target_hour) IN (
        SELECT epoch_id, target_hour FROM adaptive_climate_predictions WHERE target_hour < ? ORDER BY target_hour LIMIT 1024
      )`).run(Date.now() - ADAPTIVE_HOUR_RETENTION_MS);
  }
}
