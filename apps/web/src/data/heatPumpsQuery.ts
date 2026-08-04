import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

export function useHeatPumpsQuery(houseId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.heatPumps(houseId),
    queryFn: ({ signal }) => api.heatPumpStates(houseId, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 20_000,
    refetchInterval: 60_000,
  }, queryClient);
}
