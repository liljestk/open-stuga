import { registerDatabaseMethods } from "../core.js";

const LOOKBACK_MS = 3 * 86_400_000;
const REFRESH_MS = 86_400_000;
/** Fewer gaps than this say little about a sensor's normal rhythm. */
const MINIMUM_GAPS = 20;

interface StoredInterval {
  interval_seconds: number | null;
  computed_at: string;
}

/** Same identity encoding as `analyticsSeriesKey`. */
const seriesKey = (sensorId: string, metric: string) => JSON.stringify([sensorId, metric]);

registerDatabaseMethods({
  expectedReportingIntervals(
    series: ReadonlyArray<{ sensorId: string; metric: string }>,
    now = Date.now(),
  ): Map<string, number> {
    const result = new Map<string, number>();
    const read = this.db.prepare(`SELECT interval_seconds, computed_at FROM sensor_reporting_intervals
      WHERE sensor_id = ? AND metric = ?`);
    // The median gap between consecutive non-stale readings; sub-second and
    // day-long gaps are duplicates and outages, not the reporting rhythm.
    const measure = this.db.prepare(`WITH gaps AS (
        SELECT (julianday(timestamp) - julianday(LAG(timestamp) OVER (ORDER BY timestamp))) * 86400.0 AS gap
        FROM measurement_samples INDEXED BY idx_measurement_samples_sensor_metric_time
        WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND quality <> 'stale'
      ), usable AS (
        SELECT gap FROM gaps WHERE gap >= 1 AND gap <= 86400
      )
      SELECT (SELECT COUNT(*) FROM usable) AS gap_count,
        (SELECT gap FROM usable ORDER BY gap LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM usable)) AS median_gap`);
    const store = this.db.prepare(`INSERT INTO sensor_reporting_intervals (sensor_id, metric, interval_seconds, gap_count, computed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sensor_id, metric) DO UPDATE SET interval_seconds = excluded.interval_seconds,
        gap_count = excluded.gap_count, computed_at = excluded.computed_at`);
    for (const { sensorId, metric } of series) {
      const stored = read.get(sensorId, metric) as unknown as StoredInterval | undefined;
      let interval = stored?.interval_seconds ?? null;
      if (!stored || now - Date.parse(stored.computed_at) > REFRESH_MS) {
        const measured = measure.get(sensorId, metric, new Date(now - LOOKBACK_MS).toISOString()) as unknown as {
          gap_count: number;
          median_gap: number | null;
        };
        interval = Number(measured.gap_count) >= MINIMUM_GAPS && measured.median_gap !== null
          ? Math.round(Number(measured.median_gap) * 10) / 10
          : null;
        store.run(sensorId, metric, interval, Number(measured.gap_count), new Date(now).toISOString());
      }
      if (interval !== null && interval > 0) result.set(seriesKey(sensorId, metric), interval);
    }
    return result;
  },
});
