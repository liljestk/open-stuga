import type { DailyAnalyticsFindingsSnapshot, DataMode } from "@climate-twin/contracts";
import { StoredDailyAnalyticsFindings } from "../support/record-types.js";
import { registerDatabaseMethods } from "../core.js";

interface DailyFindingsFailure {
  houseId: string;
  dataMode: DataMode;
  attemptedAt: string;
  error: string;
}

interface DailyFindingsEvidenceScope {
  houseId: string;
  dataMode: DataMode;
  locationKey: string | null;
  windows: readonly { start: string; end: string }[];
}

interface DailyFindingsEvidence {
  revision: number;
  current: boolean;
}

declare module "../core.js" {
  interface DatabaseInternals {
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    watchDailyFindingsEvidence(scope: DailyFindingsEvidenceScope): DailyFindingsEvidence;
    adoptDailyFindingsArchiveGeneration(archiveGeneration: string): void;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot, evidenceRevision: number): boolean;
    recordDailyAnalyticsFindingsFailure(failure: DailyFindingsFailure): void;
  }

  interface ClimateDatabaseCore {
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    watchDailyFindingsEvidence(scope: DailyFindingsEvidenceScope): DailyFindingsEvidence;
    adoptDailyFindingsArchiveGeneration(archiveGeneration: string): void;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot, evidenceRevision: number): boolean;
    recordDailyAnalyticsFindingsFailure(failure: DailyFindingsFailure): void;
  }
}

registerDatabaseMethods({
  dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null {
      if (!this.getHouse(houseId)) return null;
      const row = this.db.prepare(`SELECT snapshot_json, last_attempt_at, last_error
        FROM analytics_daily_findings WHERE house_id = ? AND data_mode = ?`)
        .get(houseId, dataMode) as { snapshot_json: string | null; last_attempt_at: string; last_error: string | null } | undefined;
      if (!row) return null;
      let snapshot: DailyAnalyticsFindingsSnapshot | null = null;
      if (row.snapshot_json) {
        try {
          snapshot = JSON.parse(row.snapshot_json) as DailyAnalyticsFindingsSnapshot;
        } catch {
          return { snapshot: null, lastAttemptAt: row.last_attempt_at, lastError: "Stored daily findings are unreadable" };
        }
      }
      return { snapshot, lastAttemptAt: row.last_attempt_at, lastError: row.last_error };
    },
  watchDailyFindingsEvidence({ houseId, dataMode, locationKey, windows }: DailyFindingsEvidenceScope): DailyFindingsEvidence {
    return this.immediateTransaction(() => {
      const windowsJson = JSON.stringify(windows.map(({ start, end }) => ({ start, end })));
      this.db.prepare(`INSERT INTO daily_findings_evidence (house_id, data_mode, location_key, windows_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(house_id) DO UPDATE SET data_mode = excluded.data_mode,
          location_key = excluded.location_key, windows_json = excluded.windows_json,
          revision = daily_findings_evidence.revision + 1
        WHERE daily_findings_evidence.windows_json <> excluded.windows_json
          OR daily_findings_evidence.location_key IS NOT excluded.location_key
          OR daily_findings_evidence.data_mode <> excluded.data_mode`).run(houseId, dataMode, locationKey, windowsJson);
      // Once a worker has read this revision, the next overlapping change must
      // advance it, even while the worker is still reading evidence.
      this.db.prepare(`UPDATE daily_findings_evidence SET observed_revision = revision
        WHERE house_id = ? AND observed_revision <> revision`).run(houseId);
      const row = this.db.prepare(`SELECT revision, published_revision FROM daily_findings_evidence
        WHERE house_id = ?`).get(houseId) as { revision: number; published_revision: number | null };
      return { revision: row.revision, current: row.published_revision === row.revision };
    });
  },
  adoptDailyFindingsArchiveGeneration(archiveGeneration: string): void {
    this.immediateTransaction(() => {
      const result = this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('daily_findings_archive_generation', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE metadata.value <> excluded.value`).run(archiveGeneration);
      if (Number(result.changes) === 0) return;
      this.db.prepare("DELETE FROM analytics_daily_findings").run();
      // Advance revisions so calculations started against the previous archive cannot publish.
      this.db.prepare("UPDATE daily_findings_evidence SET revision = revision + 1, published_revision = NULL").run();
    });
  },
  saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot, evidenceRevision: number): boolean {
    return this.immediateTransaction(() => {
      if ((snapshot.dataMode === "live") !== this.isRealDataMode()) return false;
      if (!this.getHouse(snapshot.houseId)) return false;
      const evidence = this.db.prepare(`UPDATE daily_findings_evidence SET published_revision = revision
        WHERE house_id = ? AND data_mode = ? AND revision = ?`)
        .run(snapshot.houseId, snapshot.dataMode, evidenceRevision);
      if (Number(evidence.changes) === 0) return false;
      const snapshotJson = JSON.stringify(snapshot);
      if (Buffer.byteLength(snapshotJson, "utf8") > 1_000_000) throw new Error("Daily analytics snapshot exceeds 1 MB");
      this.db.prepare(`INSERT INTO analytics_daily_findings
          (house_id, data_mode, evaluated_through, generated_at, algorithm_version, snapshot_json, last_attempt_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(house_id) DO UPDATE SET
          data_mode = excluded.data_mode,
          evaluated_through = excluded.evaluated_through,
          generated_at = excluded.generated_at,
          algorithm_version = excluded.algorithm_version,
          snapshot_json = excluded.snapshot_json,
          last_attempt_at = excluded.last_attempt_at,
          last_error = NULL`)
        .run(snapshot.houseId, snapshot.dataMode, snapshot.evaluatedThrough, snapshot.generatedAt,
          snapshot.algorithmVersion, snapshotJson, snapshot.generatedAt);
      return true;
    });
  },
  recordDailyAnalyticsFindingsFailure({ houseId, dataMode, attemptedAt, error }: DailyFindingsFailure): void {
    this.immediateTransaction(() => {
      if ((dataMode === "live") !== this.isRealDataMode() || !this.getHouse(houseId)) return;
      const detail = error.trim().slice(0, 1_000) || "Daily analytics run failed";
      this.db.prepare(`INSERT INTO analytics_daily_findings
          (house_id, data_mode, evaluated_through, generated_at, algorithm_version, snapshot_json, last_attempt_at, last_error)
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(house_id) DO UPDATE SET
          data_mode = excluded.data_mode,
          evaluated_through = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.evaluated_through ELSE NULL END,
          generated_at = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.generated_at ELSE NULL END,
          algorithm_version = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.algorithm_version ELSE NULL END,
          snapshot_json = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.snapshot_json ELSE NULL END,
          last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error`)
        .run(houseId, dataMode, attemptedAt, detail);
    });
  },
});
