import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

export function useConnectedDevicesQuery(houseId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.connectedDevices(houseId),
    queryFn: ({ signal }) => api.connectedDevices(houseId, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: 15_000,
  }, queryClient);
}
