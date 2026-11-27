import { createHash } from "node:crypto";
import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope, AdaptiveHourlyEvidence } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { runAdaptiveClimateIsolated } from "../derived-artifacts/fit-isolate.js";
import { ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import { ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, type ClimateQualificationResult } from "./climate-qualification.js";
import { latestClosedQualificationWindow } from "./evidence.js";

interface StoredRow {
  evaluated_through: number;
  recorded_at: number;
  input_digest: string;
  report_json: string;
}

const QUALIFICATION_BASIS = "sqlite-sealed-indoor";

export class AdaptiveClimateArtifacts {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly runQualification = runAdaptiveClimateIsolated,
  ) {}

  #latest(epochId: string): StoredRow | undefined {
    return this.database.db.prepare(`SELECT evaluated_through, recorded_at, input_digest, report_json
      FROM adaptive_climate_artifacts WHERE epoch_id = ? AND algorithm_version = ? ORDER BY evaluated_through DESC LIMIT 1`)
      .get(epochId, ADAPTIVE_CLIMATE_QUALIFICATION_VERSION) as StoredRow | undefined;
  }

  read(scope: AdaptiveEvidenceScope) {
    return this.database.transaction(() => {
      const epoch = this.database.readAdaptiveEvidenceEpoch(scope);
      if (!epoch) return null;
      const row = this.#latest(epoch.id);
      return row ? {
        epochId: epoch.id,
        algorithmVersion: ADAPTIVE_CLIMATE_QUALIFICATION_VERSION,
        evaluatedThrough: row.evaluated_through,
        recordedAt: row.recorded_at,
        inputDigest: row.input_digest,
        basis: QUALIFICATION_BASIS,
        report: JSON.parse(row.report_json) as ClimateQualificationResult,
      } : null;
    });
  }

  #evidence(epoch: AdaptiveEvidenceEpoch, window: { from: number; to: number }) {
    return this.database.readAdaptiveHours({ scope: epoch, epochId: epoch.id, ...window }).flatMap(({ outcome }) =>
      outcome.evidence && outcome.evidence.availableAt <= window.to ? [outcome.evidence] : []);
  }

  #digest(epoch: AdaptiveEvidenceEpoch, { to, points }: { to: number; points: AdaptiveHourlyEvidence[] }): string {
    return createHash("sha256").update(JSON.stringify([
      QUALIFICATION_BASIS, ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, epoch.id,
      epoch.dataMode, epoch.propertyId, epoch.houseId, epoch.sensorId, epoch.metric, epoch.configurationDigest, to, points,
    ])).digest("hex");
  }

  /** Each elapsed four-week cohort gets at most one report. A failed cohort can qualify on fresh evidence. */
  async evaluate(epoch: AdaptiveEvidenceEpoch, signal: AbortSignal): Promise<boolean> {
    if (epoch.purpose !== "climate") return false;
    const trustworthyFrom = Date.parse(epoch.effectiveAt);
    const now = Date.now();
    const window = latestClosedQualificationWindow(trustworthyFrom, now);
    if (!window) return false;
    const previous = this.#latest(epoch.id);
    if (previous && (previous.evaluated_through >= window.to || JSON.parse(previous.report_json).state === "technical-pass")) return false;
    if (window.from < now - ADAPTIVE_HOUR_RETENTION_MS) return false;
    signal.throwIfAborted();
    const evidence = this.#evidence(epoch, window);
    const digest = this.#digest(epoch, { to: window.to, points: evidence });
    const report = await this.runQualification({
      evidence, metric: epoch.metric, evaluatedAt: window.to,
      policy: { epochId: epoch.id, dataMode: epoch.dataMode, trustworthyFrom: window.from },
    }, signal);
    signal.throwIfAborted();
    return this.database.transaction(() => {
      if (this.database.readAdaptiveEvidenceEpoch(epoch)?.id !== epoch.id
        || this.#digest(epoch, { to: window.to, points: this.#evidence(epoch, window) }) !== digest) return false;
      return this.database.db.prepare(`INSERT INTO adaptive_climate_artifacts
        (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, report_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (epoch_id, algorithm_version, evaluated_through) DO NOTHING`)
        .run(epoch.id, ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, window.to, Date.now(), digest, JSON.stringify(report)).changes === 1;
    });
  }
}
