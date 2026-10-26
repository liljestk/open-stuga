import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /** Counts one request into today's latency histogram for the Home and operation. */
    recordAnalyticsLatency(sample: { houseId: string; operation: string; durationMs: number; at?: number }): void;
    /** Request counts per histogram bucket and operation since a UTC day (YYYY-MM-DD). */
    analyticsLatencyHistogram(houseId: string, sinceDay: string): Map<string, Map<number, number>>;
  }

  interface ClimateDatabaseCore {
    recordAnalyticsLatency(sample: { houseId: string; operation: string; durationMs: number; at?: number }): void;
    analyticsLatencyHistogram(houseId: string, sinceDay: string): Map<string, Map<number, number>>;
  }
}
