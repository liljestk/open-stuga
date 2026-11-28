import { createHash } from "node:crypto";
import { maximum } from "@climate-twin/analytics-kernel";
import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope, AdaptiveHourlyEvidence } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { yieldToEventLoop } from "../../timeseries/read-support.js";
import { HOUR_MS, hourStart } from "../forecast/models.js";
import { AdaptiveClimateContext } from "./climate-context.js";
import { ADAPTIVE_CAPTURE_HORIZON_MS, ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import { latestClosedQualificationWindow, evidenceByHour } from "./evidence.js";
import {
  assessReferenceDay, pairTemperatures, peersAgree, qualifyReferencePairs, REFERENCE_COMPARISON_VERSION, REFERENCE_DAY_HOURS,
  type ReferenceCalibration, type ReferenceDirection, type ReferencePair, type ReferenceQualification, type ReferenceState,
} from "./reference-policy.js";

type HourWindow = { from: number; to: number };
type Members = { epoch: AdaptiveEvidenceEpoch; references: string[] };
type RecordResult = ReferenceQualification & { references: string[] };
type Artifact = { cutoff: number; recordedAt: number; result: RecordResult };
type Decision = { target_hour: number; state: ReferenceState; direction: ReferenceDirection | null };
type EvidenceMap = ReadonlyMap<number, AdaptiveHourlyEvidence>;
const PAIR_WAIT_MS = 2 * HOUR_MS;
const MAX_ASSESSMENTS_PER_PASS = 8;

function makePair(series: EvidenceMap[], hour: number, knownAt: number): ReferencePair | null {
  const points = series.map((member) => member.get(hour));
  const target = points[0];
  if (!target || !points.every((point) => point && point.availableAt <= knownAt)) return null;
  return pairTemperatures({
    hour, availableAt: maximum(points.map((point) => point!.availableAt))!,
    target: target.value, references: points.slice(1).map((point) => point!.value),
  });
}

export class AdaptiveReferenceDetector {
  readonly #context: AdaptiveClimateContext;

  constructor(private readonly database: ClimateDatabase) {
    this.#context = new AdaptiveClimateContext(database);
  }

  #members(scope: AdaptiveEvidenceScope): Members | null {
    if (scope.metric !== "temperature") return null;
    const settings = this.database.adaptiveMonitoringSettings(scope);
    const group = settings.referenceGroups.find(({ targetSensorId }) => targetSensorId === scope.sensorId);
    if (!group) return null;
    const epoch = this.database.ensureAdaptiveEvidenceEpoch({ ...scope, purpose: "sensor-comparison" });
    return epoch ? { epoch, references: group.referenceSensorIds } : null;
  }

  #series({ epoch, references }: Members, window: HourWindow): EvidenceMap[] {
    return [epoch.sensorId, ...references].map((sensorId) => {
      const scope = { houseId: epoch.houseId, dataMode: epoch.dataMode, sensorId, metric: "temperature", purpose: "climate" } as const;
      const memberEpoch = this.database.readAdaptiveEvidenceEpoch(scope);
      if (!memberEpoch) return new Map();
      const points = this.database.readAdaptiveHours({ scope, epochId: memberEpoch.id, ...window })
        .flatMap(({ outcome }) => outcome.evidence ? [outcome.evidence] : []);
      return evidenceByHour(points, {
        epochId: memberEpoch.id, dataMode: epoch.dataMode, trustworthyFrom: Date.parse(epoch.effectiveAt),
      });
    });
  }

  #artifact(epochId: string): Artifact | null {
    const row = this.database.db.prepare(`SELECT evaluated_through, recorded_at, result_json FROM adaptive_reference_artifacts
      WHERE epoch_id = ? AND algorithm_version = ? ORDER BY evaluated_through DESC LIMIT 1`)
      .get(epochId, REFERENCE_COMPARISON_VERSION) as { evaluated_through: number; recorded_at: number; result_json: string } | undefined;
    return row ? { cutoff: row.evaluated_through, recordedAt: row.recorded_at, result: JSON.parse(row.result_json) as RecordResult } : null;
  }

  async #qualify(members: Members, window: HourWindow, signal: AbortSignal): Promise<boolean> {
    const { epoch, references } = members;
    const series = this.#series(members, window);
    const pairs: ReferencePair[] = [];
    for (let hour = window.from; hour < window.to; hour += HOUR_MS) {
      signal.throwIfAborted();
      const pair = makePair(series, hour, Math.min(window.to, hour + HOUR_MS + PAIR_WAIT_MS));
      if (pair && !this.#context.forHour(epoch, { hour, knownAt: pair.availableAt })) pairs.push(pair);
      if ((hour - window.from) % (REFERENCE_DAY_HOURS * HOUR_MS) === 0) await yieldToEventLoop();
    }
    signal.throwIfAborted();
    const result: RecordResult = { references, ...qualifyReferencePairs(pairs, window.from) };
    const inputDigest = createHash("sha256").update(JSON.stringify([epoch.id, references, window, pairs])).digest("hex");
    return this.database.transaction(() => {
      if (this.database.readAdaptiveEvidenceEpoch(epoch)?.id !== epoch.id) return false;
      return this.database.db.prepare(`INSERT INTO adaptive_reference_artifacts
        (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, result_json)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (epoch_id, algorithm_version, evaluated_through) DO NOTHING`)
        .run(epoch.id, REFERENCE_COMPARISON_VERSION, window.to, Date.now(), inputDigest, JSON.stringify(result)).changes === 1;
    });
  }

  async advance(scope: AdaptiveEvidenceScope, { signal, allowQualification }: {
    signal: AbortSignal; allowQualification: boolean;
  }): Promise<boolean> {
    signal.throwIfAborted();
    const members = this.#members(scope);
    if (!members) return false;
    const artifact = this.#artifact(members.epoch.id);
    const now = Date.now();
    if (artifact?.result.calibration) {
      this.database.transaction(() => this.#assess(members, artifact, now));
      return false;
    }
    if (!allowQualification) return false;
    const window = latestClosedQualificationWindow(Date.parse(members.epoch.effectiveAt), now);
    if (!window || window.from < now - ADAPTIVE_HOUR_RETENTION_MS || (artifact && artifact.cutoff >= window.to)) return false;
    return this.#qualify(members, window, signal);
  }

  #assess(members: Members, artifact: Artifact, now: number): void {
    const { epoch } = members;
    if (this.database.readAdaptiveEvidenceEpoch(epoch)?.id !== epoch.id) return;
    const calibration = artifact.result.calibration!;
    const before = this.database.db.prepare(`SELECT target_hour, state, direction FROM adaptive_reference_decisions
      WHERE epoch_id = ? ORDER BY target_hour DESC LIMIT 1`).get(epoch.id) as Decision | undefined;
    const start = Math.ceil(artifact.recordedAt / HOUR_MS) * HOUR_MS;
    const from = Math.max(start, hourStart(now - ADAPTIVE_CAPTURE_HORIZON_MS), (before?.target_hour ?? start - HOUR_MS) + HOUR_MS);
    const to = Math.min(hourStart(now), from + MAX_ASSESSMENTS_PER_PASS * HOUR_MS);
    if (from >= to) return;
    const series = this.#series(members, { from, to });
    let previous = before;
    for (let hour = from; hour < to; hour += HOUR_MS) {
      const pair = makePair(series, hour, Math.min(now, hour + HOUR_MS + PAIR_WAIT_MS));
      if (!pair && now < hour + HOUR_MS + PAIR_WAIT_MS) break;
      previous = this.#record(epoch, { hour, now, pair, calibration, previous });
    }
  }

  #record(epoch: AdaptiveEvidenceEpoch, { hour, now, pair, calibration, previous }: {
    hour: number; now: number; pair: ReferencePair | null; calibration: ReferenceCalibration; previous: Decision | undefined;
  }): Decision {
    const guard = pair && this.#context.forHour(epoch, { hour, knownAt: pair.availableAt });
    const agreement = pair && peersAgree(pair, calibration.peerSpreadLimit);
    const usable = agreement && !guard ? pair : null;
    const pairs = this.database.db.prepare(`SELECT target_hour AS hour, pair_offset AS offset,
        pair_spread AS spread, pair_available_at AS availableAt FROM adaptive_reference_decisions
      WHERE epoch_id = ? AND target_hour >= ? AND target_hour < ? AND pair_offset IS NOT NULL ORDER BY target_hour`)
      .all(epoch.id, hour - (REFERENCE_DAY_HOURS - 1) * HOUR_MS, hour) as unknown as ReferencePair[];
    if (usable) pairs.push(usable);
    const active = previous?.state === "candidate" || previous?.state === "stale" ? previous.direction : null;
    const { state, direction, offsetChange } = assessReferenceDay({ hour, pairs, calibration, active });
    const reason = guard?.reason ?? (!pair ? "missing-pair" : !agreement ? "peer-disagreement" : "paired");
    this.database.db.prepare(`INSERT INTO adaptive_reference_decisions
      (epoch_id, target_hour, recorded_at, state, direction, offset_change, paired_hours, reason,
       pair_offset, pair_spread, pair_available_at, context_guard_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(epoch.id, hour, now, state, direction, offsetChange, pairs.length, reason,
        usable?.offset ?? null, usable?.spread ?? null, usable?.availableAt ?? null, guard ? JSON.stringify(guard) : null);
    if (direction && (previous?.state !== state || previous.direction !== direction)) {
      this.database.db.prepare(`INSERT INTO adaptive_reference_episode_revisions
        (epoch_id, direction, revision, target_hour, recorded_at, state)
        VALUES (?, ?, (SELECT coalesce(max(revision), 0) + 1 FROM adaptive_reference_episode_revisions
            WHERE epoch_id = ? AND direction = ?), ?, ?, ?)`).run(epoch.id, direction, epoch.id, direction, hour, now, state);
    }
    return { target_hour: hour, state, direction };
  }

  hasExpiredEvidence(): boolean {
    return this.database.db.prepare("SELECT 1 FROM adaptive_reference_decisions WHERE target_hour < ? LIMIT 1")
      .get(Date.now() - ADAPTIVE_HOUR_RETENTION_MS) !== undefined;
  }

  pruneExpired(): void {
    this.database.db.prepare(`DELETE FROM adaptive_reference_decisions WHERE (epoch_id, target_hour) IN (
      SELECT epoch_id, target_hour FROM adaptive_reference_decisions WHERE target_hour < ? ORDER BY target_hour LIMIT 1024
    )`).run(Date.now() - ADAPTIVE_HOUR_RETENTION_MS);
  }
}
