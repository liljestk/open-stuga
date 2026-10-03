import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";
import { historyRefreshInterval } from "./historyPreparation";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

export function homeEnergySummaryQueryOptions(
  houseId: string,
  intervalId: string,
  durationMs: number,
  enabled: boolean,
  refreshMs: number,
) {
  return {
    queryKey: queryKeys.homeEnergySummary(houseId, intervalId, durationMs),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      // Align rolling snapshots so tabs and household clients share the same
      // exact server cache key without changing the requested calculation.
      const to = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
      const from = new Date(Date.parse(to) - durationMs).toISOString();
      return api.houseEnergySummary(houseId, from, to, signal);
    },
    enabled: Boolean(houseId) && enabled,
    staleTime: refreshMs,
    refetchInterval: historyRefreshInterval(enabled, refreshMs),
  } as const;
}

export function useHomeEnergySummaryQuery(
  houseId: string,
  intervalId: string,
  durationMs: number,
  enabled: boolean,
  refreshMs: number,
) {
  const options = homeEnergySummaryQueryOptions(
    houseId, intervalId, durationMs, enabled, refreshMs,
  );
  const query = useQuery(options, queryClient);
  useCancelInactiveQuery(options.queryKey, options.enabled);
  return query;
}
