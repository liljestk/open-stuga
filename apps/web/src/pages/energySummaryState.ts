import type { HomeEnergySummary } from "@climate-twin/contracts";
import { historyIsPreparing } from "../data/energy/historyPreparation";

interface SummaryQueryStatus {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: HomeEnergySummary | undefined;
}

/**
 * Loading and unavailable history must never be described as zero usage. A
 * failed or still-preparing refresh keeps the summary already shown.
 */
export function energySummaryState(summary: HomeEnergySummary | null, pending: boolean, error: boolean) {
  if ((error && !summary) || (summary?.failedSourceCount ?? 0) > 0) return "unavailable";
  if (pending && !summary) return "loading";
  if (!summary || summary.consumptionKwh === null) return "empty";
  if (!summary.complete) return "partial";
  return "ready";
}

/**
 * Whether a summary query is still producing its first answer or has failed
 * without one. A refresh that is preparing or fails keeps the summary shown.
 */
export function summaryRefreshState(query: SummaryQueryStatus) {
  const preparing = historyIsPreparing(query.error);
  return {
    busy: query.isPending || (preparing && !query.data),
    failed: query.isError && !preparing && !query.data,
  };
}

/** The display state of one summary query; a disabled query is neither loading nor failed. */
export function summaryQueryState(query: SummaryQueryStatus | undefined, summary: HomeEnergySummary | null) {
  if (!query) return energySummaryState(summary, false, false);
  const refresh = summaryRefreshState(query);
  return energySummaryState(summary, refresh.busy, refresh.failed);
}
