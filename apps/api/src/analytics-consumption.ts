import type { MeasurementSample } from "@climate-twin/contracts";
import { consumptionBuckets } from "@climate-twin/analytics-kernel";

/** Bucket kWh from an energy counter or power series; other metrics carry no consumption. */
export function analyticsConsumptionBuckets(
  samples: readonly MeasurementSample[], metric: string, bucketMs: number, end: number,
  start = -Infinity,
): Map<number, number | null> {
  if (metric !== "energy" && metric !== "power") return new Map();
  return consumptionBuckets(
    samples.map((sample) => ({ at: Date.parse(sample.timestamp), value: sample.value })),
    metric === "energy" ? "counter" : "power",
    bucketMs,
    end,
    start,
  );
}
