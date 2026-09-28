import { useQuery } from "@tanstack/react-query";
import type { HomeElectricityPricePoint } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

// Poll cheaply once a minute; callers validate the returned interval before
// presenting it as current. Cached data remains available during recovery.
const HOUSE_PRICE_REFRESH_MS = 60_000;

export function useHouseElectricityPriceQuery(houseId: string, enabled: boolean) {
  const queryKey = queryKeys.houseElectricityPrice(houseId);
  const queryEnabled = Boolean(houseId) && enabled;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<HomeElectricityPricePoint | null> => (
      (await api.houseElectricityPrice(houseId, undefined, undefined, signal)).current
    ),
    enabled: queryEnabled,
    staleTime: HOUSE_PRICE_REFRESH_MS,
    refetchOnWindowFocus: true,
    refetchInterval: enabled ? HOUSE_PRICE_REFRESH_MS : false,
  }, queryClient);
  useCancelInactiveQuery(queryKey, queryEnabled);
  return query;
}
