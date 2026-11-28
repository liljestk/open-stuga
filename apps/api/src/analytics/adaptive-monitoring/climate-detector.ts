import type { AdaptiveEvidenceEpoch } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HOUR_MS, hourStart } from "../forecast/models.js";
import { ADAPTIVE_CAPTURE_HORIZON_MS, ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import { detectProspectiveDeparture, initialDetectorState, type DetectorHour, type DetectorState } from "./prospective-departure.js";
import type { ResidualEvidence } from "./residual-policy.js";
import { AdaptiveClimateContext, type ClimateContextGuard } from "./climate-context.js";

const CAPTURE_GRACE_MS = 2 * HOUR_MS;
const MAX_DECISIONS_PER_PASS = 8;
const CALIBRATION_WINDOW_MS = 168 * HOUR_MS;

interface DecisionRow {
  target_hour: number;
  issued_at: number;
  frozen_at: number | null;
  outcome: number | null;
  observed_at: number | null;
  observed: number | null;
  prediction: number;
}

function hourInput(hour: number, row: DecisionRow | undefined): DetectorHour {
  return {
    hour, issuedAt: row?.issued_at ?? null, frozenAt: row?.frozen_at ?? null,
    error: row?.observed != null ? row.observed - row.prediction : null,
    issue: !row ? "missing-prediction" : row.observed === null ? "missing-observation" : null,
  };
}

export class AdaptiveClimateDetector {
  readonly #context: AdaptiveClimateContext;

  constructor(private readonly database: ClimateDatabase) {
    this.#context = new AdaptiveClimateContext(database);
  }

  #history(epochId: string, issuedAt: number): ResidualEvidence[] {
    return this.database.db.prepare(`SELECT target_hour AS time, decided_at AS availableAt, error
      FROM adaptive_climate_detector_hours WHERE epoch_id = ? AND admitted = 1
      AND target_hour >= ? AND target_hour < ? AND decided_at <= ? ORDER BY target_hour`)
      .all(epochId, issuedAt - CALIBRATION_WINDOW_MS, issuedAt, issuedAt) as unknown as ResidualEvidence[];
  }

  /** Called inside the ledger's transaction, after outcomes and before new forecasts. */
  advance(epoch: AdaptiveEvidenceEpoch, now: number): DetectorState {
    const checkpoint = this.database.db.prepare("SELECT through_hour, state_json FROM adaptive_climate_detector_state WHERE epoch_id = ?")
      .get(epoch.id) as { through_hour: number; state_json: string } | undefined;
    const state: DetectorState = checkpoint ? JSON.parse(checkpoint.state_json) : initialDetectorState();
    const first = this.database.db.prepare("SELECT min(target_hour) AS hour FROM adaptive_climate_predictions WHERE epoch_id = ?")
      .get(epoch.id) as { hour: number | null };
    if (first.hour === null) return state;
    const earliest = hourStart(now - ADAPTIVE_CAPTURE_HORIZON_MS);
    const from = Math.max(first.hour, earliest, (checkpoint?.through_hour ?? first.hour - HOUR_MS) + HOUR_MS);
    const to = Math.min(hourStart(now), from + MAX_DECISIONS_PER_PASS * HOUR_MS);
    if (from >= to) return state;
    const rows = this.database.db.prepare(`SELECT prediction.target_hour, prediction.issued_at, prediction.frozen_at,
        prediction.prediction, outcome.scored_at AS outcome, outcome.observed_at, outcome.observed
      FROM adaptive_climate_predictions prediction
      LEFT JOIN adaptive_climate_outcomes outcome USING (epoch_id, target_hour)
      WHERE prediction.epoch_id = ? AND prediction.target_hour >= ? AND prediction.target_hour < ?`)
      .all(epoch.id, from, to) as unknown as DecisionRow[];
    const byHour = new Map(rows.map((row) => [row.target_hour, row]));
    let through = from - HOUR_MS;
    for (let hour = from; hour < to; hour += HOUR_MS) {
      const row = byHour.get(hour);
      if (row && (row.outcome === null || row.outcome > now) && now < hour + HOUR_MS + CAPTURE_GRACE_MS) break;
      this.#recordHour(epoch, { hour, row, state, now });
      through = hour;
    }
    if (through >= from) {
      this.database.db.prepare(`INSERT INTO adaptive_climate_detector_state (epoch_id, through_hour, state_json)
        VALUES (?, ?, ?) ON CONFLICT (epoch_id) DO UPDATE SET through_hour = excluded.through_hour,
        state_json = excluded.state_json`).run(epoch.id, through, JSON.stringify(state));
    }
    return state;
  }

  #recordHour(epoch: AdaptiveEvidenceEpoch, { hour, row, state, now }: {
    hour: number; row: DecisionRow | undefined; state: DetectorState; now: number;
  }): void {
    const available = row && row.outcome !== null && row.outcome <= now ? row : undefined;
    const sample = hourInput(hour, row && !available ? { ...row, observed: null } : available);
    const guard = available?.observed_at != null && available.observed !== null
      ? this.#context.forHour(epoch, { hour, knownAt: available.observed_at })
      : null;
    this.#record(epoch, { sample, state, now, guard });
  }

  #record(epoch: AdaptiveEvidenceEpoch, { sample, state, now, guard }: {
    sample: DetectorHour; state: DetectorState; now: number; guard: ClimateContextGuard | null;
  }): void {
    const decision = detectProspectiveDeparture({
      state, sample, now, metric: epoch.metric,
      history: state.frozen || sample.issuedAt === null ? [] : this.#history(epoch.id, sample.issuedAt),
      ...(guard ? { guard } : {}),
    });
    this.database.db.prepare(`INSERT INTO adaptive_climate_detector_hours
        (epoch_id, target_hour, decided_at, error, calibration_json, admitted, reason, context_guard_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(epoch.id, sample.hour, now, sample.error,
      decision.calibration ? JSON.stringify(decision.calibration) : null, Number(decision.admitted), decision.reason,
      guard ? JSON.stringify(guard) : null);
    if (decision.revision) {
      const { direction, state: status } = decision.revision;
      this.database.db.prepare(`INSERT INTO adaptive_climate_episode_revisions
        (epoch_id, direction, revision, state, target_hour, recorded_at)
        VALUES (?, ?, (SELECT coalesce(max(revision), 0) + 1 FROM adaptive_climate_episode_revisions
          WHERE epoch_id = ? AND direction = ?), ?, ?, ?)`)
        .run(epoch.id, direction, epoch.id, direction, status, sample.hour, now);
    }
  }

  hasExpiredEvidence(): boolean {
    return this.database.db.prepare("SELECT 1 FROM adaptive_climate_detector_hours WHERE target_hour < ? LIMIT 1")
      .get(Date.now() - ADAPTIVE_HOUR_RETENTION_MS) !== undefined;
  }

  pruneExpired(): void {
    this.database.db.prepare(`DELETE FROM adaptive_climate_detector_hours WHERE (epoch_id, target_hour) IN (
      SELECT epoch_id, target_hour FROM adaptive_climate_detector_hours WHERE target_hour < ? ORDER BY target_hour LIMIT 1024
    )`).run(Date.now() - ADAPTIVE_HOUR_RETENTION_MS);
  }
}
