import { useQuery } from "@tanstack/react-query";
import type { DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useHomePerformanceQuery(
  houseId: string,
  dataMode: DataMode,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.homePerformance(houseId, dataMode),
    queryFn: ({ signal }) => api.homePerformance(houseId, dataMode, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 60_000,
  }, queryClient);
}
