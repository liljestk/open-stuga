import { useQuery } from "@tanstack/react-query";
import type { HomeElectricityPricePoint } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

// Spot prices change on quarter-hour boundaries at most; refreshing every five
// minutes keeps the card current without adding load. On a refetch failure the
// query keeps serving the last projection instead of emptying the card.
const HOUSE_PRICE_REFRESH_MS = 5 * 60_000;

export function useHouseElectricityPriceQuery(houseId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.houseElectricityPrice(houseId),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<HomeElectricityPricePoint | null> => (
      (await api.houseElectricityPrice(houseId, undefined, undefined, signal)).current
    ),
    enabled: Boolean(houseId) && enabled,
    staleTime: HOUSE_PRICE_REFRESH_MS,
    refetchInterval: enabled ? HOUSE_PRICE_REFRESH_MS : false,
  }, queryClient);
}
