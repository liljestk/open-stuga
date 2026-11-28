import { createHash } from "node:crypto";
import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { runAdaptiveClimateIsolated } from "../derived-artifacts/fit-isolate.js";
import { ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import { ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, type ClimateQualificationResult, type QualificationInput } from "./climate-qualification.js";
import { latestClosedQualificationWindow } from "./evidence.js";
import { readAdaptiveWeather } from "./weather-evidence.js";

interface StoredRow {
  algorithm_version: string;
  evaluated_through: number;
  recorded_at: number;
  input_digest: string;
  report_json: string;
}

type QualificationEvidence = Pick<QualificationInput, "evidence" | "outdoor">;
type StoredReport = ClimateQualificationResult & { basis?: "sqlite-sealed-indoor" | "sqlite-sealed-indoor-and-weather" };
const PREVIOUS_INDOOR_VERSION = "adaptive-climate-qualification/v1";

export class AdaptiveClimateArtifacts {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly runQualification = runAdaptiveClimateIsolated,
  ) {}

  #latest(epochId: string): StoredRow | undefined {
    return this.database.db.prepare(`SELECT algorithm_version, evaluated_through, recorded_at, input_digest, report_json
      FROM adaptive_climate_artifacts WHERE epoch_id = ? AND algorithm_version IN (?, ?)
      ORDER BY evaluated_through DESC, algorithm_version DESC LIMIT 1`)
      .get(epochId, ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, PREVIOUS_INDOOR_VERSION) as StoredRow | undefined;
  }

  read(scope: AdaptiveEvidenceScope) {
    return this.database.transaction(() => {
      const epoch = this.database.readAdaptiveEvidenceEpoch(scope);
      if (!epoch) return null;
      const row = this.#latest(epoch.id);
      if (!row) return null;
      const report = JSON.parse(row.report_json) as StoredReport;
      return {
        epochId: epoch.id,
        algorithmVersion: row.algorithm_version,
        evaluatedThrough: row.evaluated_through,
        recordedAt: row.recorded_at,
        inputDigest: row.input_digest,
        basis: report.basis ?? "sqlite-sealed-indoor",
        report,
      };
    });
  }

  #evidence(epoch: AdaptiveEvidenceEpoch, window: { from: number; to: number }): QualificationEvidence {
    const evidence = this.database.readAdaptiveHours({ scope: epoch, epochId: epoch.id, ...window }).flatMap(({ outcome }) =>
      outcome.evidence && outcome.evidence.availableAt <= window.to ? [outcome.evidence] : []);
    const outdoor = readAdaptiveWeather(this.database, epoch, { ...window, knownAt: window.to });
    return { evidence, outdoor };
  }

  #digest(epoch: AdaptiveEvidenceEpoch, input: QualificationEvidence & { to: number }): string {
    return createHash("sha256").update(JSON.stringify([
      ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, epoch.id,
      epoch.dataMode, epoch.propertyId, epoch.houseId, epoch.sensorId, epoch.metric, epoch.configurationDigest,
      input.to, input.evidence, input.outdoor,
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
    const evidence = this.database.transaction(() => this.#evidence(epoch, window));
    const digest = this.#digest(epoch, { to: window.to, ...evidence });
    const report = await this.runQualification({
      ...evidence, metric: epoch.metric, evaluatedAt: window.to,
      policy: { epochId: epoch.id, dataMode: epoch.dataMode, trustworthyFrom: window.from },
    }, signal);
    signal.throwIfAborted();
    return this.database.transaction(() => {
      if (this.database.readAdaptiveEvidenceEpoch(epoch)?.id !== epoch.id
        || this.#digest(epoch, { to: window.to, ...this.#evidence(epoch, window) }) !== digest) return false;
      const basis = evidence.outdoor?.length ? "sqlite-sealed-indoor-and-weather" : "sqlite-sealed-indoor";
      return this.database.db.prepare(`INSERT INTO adaptive_climate_artifacts
        (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, report_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (epoch_id, algorithm_version, evaluated_through) DO NOTHING`)
        .run(epoch.id, ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, window.to, Date.now(), digest, JSON.stringify({ ...report, basis })).changes === 1;
    });
  }
}
