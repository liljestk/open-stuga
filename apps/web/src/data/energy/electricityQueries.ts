import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { timeRangeHours, type TimeRange } from "../../domain";
import { queryClient } from "../queryClient";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

export const propertyElectricityKey = (propertyId: string) => ["property", propertyId, "electricity"] as const;
const PRICE_REFRESH_MS = 60_000;

export function currentElectricityPrice<T extends { startAt: string; endAt: string; effectivePriceEurPerKwh: number }>(point: T | null | undefined, now: number): T | null {
  if (!point || !Number.isFinite(point.effectivePriceEurPerKwh)) return null;
  return Date.parse(point.startAt) <= now && now < Date.parse(point.endAt) ? point : null;
}

export function usePropertyElectricityQuery(propertyId: string, enabled: boolean) {
  const queryKey = propertyElectricityKey(propertyId);
  const queryEnabled = Boolean(propertyId) && enabled;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.propertyElectricity(propertyId, signal),
    enabled: queryEnabled,
    staleTime: PRICE_REFRESH_MS,
    refetchInterval: enabled ? PRICE_REFRESH_MS : false,
    refetchOnWindowFocus: true,
  }, queryClient);
  useCancelInactiveQuery(queryKey, queryEnabled);
  return query;
}

export function usePriceHistoryQuery(houseId: string, range: TimeRange, enabled: boolean) {
  const queryKey = ["house", houseId, "electricity-price-history", range] as const;
  const queryEnabled = Boolean(houseId) && enabled;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const to = new Date();
      const from = new Date(to.getTime() - timeRangeHours(range) * 3_600_000);
      const result = await api.houseElectricityPrice(houseId, from.toISOString(), to.toISOString(), signal);
      return result.prices ?? (result.current ? [result.current] : []);
    },
    enabled: queryEnabled,
    staleTime: PRICE_REFRESH_MS,
    refetchInterval: enabled ? PRICE_REFRESH_MS : false,
    refetchOnWindowFocus: true,
  }, queryClient);
  useCancelInactiveQuery(queryKey, queryEnabled);
  return query;
}

export function useEnergyOptimizationQuery(propertyId: string, enabled: boolean) {
  const queryKey = ["property", propertyId, "energy-optimization", 2] as const;
  const queryEnabled = Boolean(propertyId) && enabled;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.energyOptimization(propertyId, 2, signal),
    enabled: queryEnabled,
    staleTime: 5 * 60_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
    refetchOnWindowFocus: true,
  }, queryClient);
  useCancelInactiveQuery(queryKey, queryEnabled);
  return query;
}
