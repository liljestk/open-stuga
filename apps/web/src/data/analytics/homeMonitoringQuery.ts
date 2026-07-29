import { useQuery } from "@tanstack/react-query";
import type { DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useHomeMonitoringCollectionQuery(
  dataMode: DataMode,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.homeMonitoringCollection(dataMode),
    queryFn: ({ signal }) => api.homeMonitoringCollection(dataMode, signal),
    enabled,
    staleTime: 5_000,
  }, queryClient);
}

export function useHomeMonitoringQuery(
  houseId: string,
  dataMode: DataMode,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.homeMonitoring(houseId, dataMode),
    queryFn: ({ signal }) => api.homeMonitoring(houseId, dataMode, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 5_000,
  }, queryClient);
}
