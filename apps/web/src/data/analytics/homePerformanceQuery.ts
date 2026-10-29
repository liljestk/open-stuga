import { useMutation, useQuery } from "@tanstack/react-query";
import type { DataMode } from "@climate-twin/contracts";
import { useRef } from "react";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";
import { derivedPollDelayMs, useRecalculationFollow } from "./derivedPolling";

export function useHomePerformanceQuery(
  houseId: string,
  dataMode: DataMode,
  enabled = true,
) {
  const key = queryKeys.homePerformance(houseId, dataMode);
  // Read lazily by refetchInterval, which runs after this render has set it.
  const following = useRef(false);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.homePerformance(houseId, dataMode, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 30_000,
    refetchInterval: ({ state }) => derivedPollDelayMs(state.data, following.current) ?? false,
  }, queryClient);
  const refresh = useMutation({
    mutationFn: () => api.refreshHomePerformance(houseId, dataMode),
    onMutate: () => follow.start(),
    onSuccess: (response) => queryClient.setQueryData(key, response),
  }, queryClient);
  const follow = useRecalculationFollow(query.data, refresh.isPending);
  following.current = follow.following;
  return {
    ...query,
    error: refresh.error ?? query.error,
    isFetching: refresh.isPending || query.isFetching,
    recalculating: follow.recalculating,
    refresh: () => refresh.mutate(),
  };
}
