import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

/** The server recomputes a projection at most hourly, or when weather, tariffs or history change. */
const PROJECTION_REFRESH_MS = 15 * 60_000;

export function useHomeEnergyProjectionQuery(houseId: string, enabled: boolean) {
  const options = {
    queryKey: queryKeys.homeEnergyProjection(houseId),
    queryFn: ({ signal }: { signal: AbortSignal }) => api.houseEnergyProjection(houseId, signal),
    enabled: Boolean(houseId) && enabled,
    staleTime: PROJECTION_REFRESH_MS,
    refetchInterval: enabled ? PROJECTION_REFRESH_MS : false,
  } as const;
  const query = useQuery(options, queryClient);
  useCancelInactiveQuery(options.queryKey, options.enabled);
  return query;
}
