import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useHomeEnergySummaryQuery(
  houseId: string,
  intervalId: string,
  durationMs: number,
  enabled: boolean,
  refreshMs: number,
) {
  return useQuery({
    queryKey: queryKeys.homeEnergySummary(houseId, intervalId, durationMs),
    queryFn: ({ signal }) => {
      const to = new Date().toISOString();
      const from = new Date(Date.parse(to) - durationMs).toISOString();
      return api.houseEnergySummary(houseId, from, to, signal);
    },
    enabled: Boolean(houseId) && enabled,
    staleTime: refreshMs,
    refetchInterval: enabled ? refreshMs : false,
  }, queryClient);
}
