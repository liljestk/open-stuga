import { registerDatabaseMethods } from "../core.js";
import { latencyBucket } from "../../analytics/diagnostics/latency.js";

registerDatabaseMethods({
  recordAnalyticsLatency(houseId: string, operation: string, durationMs: number, at = Date.now()): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.db.prepare(`INSERT INTO analytics_latency_histogram (day, house_id, operation, bucket_ms, count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(day, house_id, operation, bucket_ms) DO UPDATE SET count = count + 1`)
      .run(new Date(at).toISOString().slice(0, 10), houseId, operation, latencyBucket(durationMs));
  },
  analyticsLatencyHistogram(houseId: string, sinceDay: string): Map<string, Map<number, number>> {
    const rows = this.db.prepare(`SELECT operation, bucket_ms, SUM(count) AS count
      FROM analytics_latency_histogram WHERE house_id = ? AND day >= ?
      GROUP BY operation, bucket_ms`).all(houseId, sinceDay) as unknown as Array<{
      operation: string;
      bucket_ms: number;
      count: number;
    }>;
    const result = new Map<string, Map<number, number>>();
    for (const row of rows) {
      const buckets = result.get(row.operation) ?? new Map<number, number>();
      buckets.set(Number(row.bucket_ms), Number(row.count));
      result.set(row.operation, buckets);
    }
    return result;
  },
});
