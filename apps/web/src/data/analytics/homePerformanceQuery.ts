import { useMutation, useQuery } from "@tanstack/react-query";
import type { DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useHomePerformanceQuery(
  houseId: string,
  dataMode: DataMode,
  enabled = true,
) {
  const key = queryKeys.homePerformance(houseId, dataMode);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.homePerformance(houseId, dataMode, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 30_000,
    refetchInterval: ({ state }) => {
      const status = state.data?.state;
      return status === "queued" || status === "refreshing"
        || (status === "failed" && Boolean(state.data?.job?.nextAttemptAt))
        ? 30_000
        : false;
    },
  }, queryClient);
  const refresh = useMutation({
    mutationFn: () => api.refreshHomePerformance(houseId, dataMode),
    onSuccess: (response) => queryClient.setQueryData(key, response),
  }, queryClient);
  return {
    ...query,
    error: refresh.error ?? query.error,
    isFetching: refresh.isPending || query.isFetching,
    refresh: () => refresh.mutate(),
  };
}
