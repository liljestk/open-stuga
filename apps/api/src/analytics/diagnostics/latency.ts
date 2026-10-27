import { ANALYTICS_LATENCY_TARGETS_MS, type AnalyticsLatencyOperation } from "@climate-twin/contracts";

const DAY_MS = 86_400_000;

/** Histogram bucket upper edges in milliseconds; the last bucket holds everything slower. */
export const LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, Number.MAX_SAFE_INTEGER] as const;

/** Live requests mix cache hits and computed answers, so they are held to the cold target. */
export const LATENCY_TARGET_P95_MS = Object.fromEntries(
  Object.entries(ANALYTICS_LATENCY_TARGETS_MS).map(([operation, target]) => [operation, target.cold]),
) as Readonly<Record<AnalyticsLatencyOperation, number>>;

/** The benchmark scenario an analytics query range belongs to, by length. */
export function queryLatencyOperation(rangeMs: number): AnalyticsLatencyOperation {
  if (rangeMs <= 1.05 * DAY_MS) return "query-24h";
  if (rangeMs <= 7.5 * DAY_MS) return "query-7d";
  if (rangeMs <= 32 * DAY_MS) return "query-30d";
  return "query-365d";
}

/** Only roughly month-long summaries share the 30-day target. */
export function summaryLatencyOperation(rangeMs: number): AnalyticsLatencyOperation | null {
  return rangeMs >= 28 * DAY_MS && rangeMs <= 32 * DAY_MS ? "energy-summary-30d" : null;
}

export function latencyBucket(durationMs: number): number {
  return LATENCY_BUCKETS_MS.find((edge) => durationMs <= edge) ?? LATENCY_BUCKETS_MS.at(-1)!;
}

/** The upper edge of the bucket holding `probability` of the requests; null without requests. */
export function histogramPercentile(buckets: ReadonlyMap<number, number>, probability: number): number | null {
  const total = [...buckets.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * probability);
  let seen = 0;
  for (const edge of LATENCY_BUCKETS_MS) {
    seen += buckets.get(edge) ?? 0;
    // Slower than the last finite edge reads as that edge, which is far beyond every target.
    if (seen >= target) return edge === Number.MAX_SAFE_INTEGER ? LATENCY_BUCKETS_MS.at(-2)! : edge;
  }
  return null;
}
