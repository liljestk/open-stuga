import type { DailyAnalyticsFindingsSnapshot } from "@climate-twin/contracts";
import { StoredDailyAnalyticsFindings } from "../support/record-types.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void;
    recordDailyAnalyticsFindingsFailure(houseId: string, dataMode: "live" | "demo", attemptedAt: string, error: string): void;
  }

  interface ClimateDatabaseCore {
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void;
    recordDailyAnalyticsFindingsFailure(houseId: string, dataMode: "live" | "demo", attemptedAt: string, error: string): void;
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
  saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void {
      if (!this.getHouse(snapshot.houseId)) throw new Error(`House ${snapshot.houseId} does not exist`);
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
    },
  recordDailyAnalyticsFindingsFailure(
      houseId: string,
      dataMode: "live" | "demo",
      attemptedAt: string,
      error: string,
    ): void {
      if (!this.getHouse(houseId)) return;
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
    },
});
