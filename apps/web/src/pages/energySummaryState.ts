import type { HomeEnergySummary } from "@climate-twin/contracts";

/** Loading and unavailable history must never be described as zero usage. */
export function energySummaryState(summary: HomeEnergySummary | null, pending: boolean, error: boolean) {
  if (error || (summary?.failedSourceCount ?? 0) > 0) return "unavailable";
  if (pending && !summary) return "loading";
  if (!summary || summary.consumptionKwh === null) return "empty";
  if (!summary.complete) return "partial";
  return "ready";
}
