import { useQuery } from "@tanstack/react-query";
import type { AnalyticsQueryResponse, AnalyticsResolution, DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { createClientUuid } from "../../clientUuid";
import { timeRangeHours, type TimeRange } from "../../domain";
import { queryClient } from "../queryClient";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";
import { historyRefreshInterval } from "./historyPreparation";

export interface ElectricityHistorySource { id: string; energy: boolean; power: boolean }

export function consumptionResolution(range: TimeRange): AnalyticsResolution {
  return ({ "6h": "5m", "24h": "15m", "7d": "120m", "30d": "360m", "90d": "720m", "1y": "1d" } as const)[range];
}

export function electricityHistoryQueryOptions(
  houseId: string, sources: readonly ElectricityHistorySource[], range: TimeRange,
  timeZone: string, dataMode: DataMode, enabled: boolean,
) {
  const ordered = [...sources].sort((left, right) => left.id.localeCompare(right.id));
  const refreshMs = timeRangeHours(range) > 7 * 24 ? 5 * 60_000 : 60_000;
  return {
    queryKey: ["house", houseId, "electricity-consumption", dataMode, range, timeZone, ordered] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<AnalyticsQueryResponse[]> => {
      const end = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const start = new Date(end.getTime() - timeRangeHours(range) * 3_600_000);
      const responses: AnalyticsQueryResponse[] = [];
      // At most two requests run at once and each has <=24 series/367 points.
      // Long history stays in the database's ordered rollups, never raw pages.
      for (let offset = 0; offset < ordered.length; offset += 24) {
        if (signal.aborted) throw signal.reason;
        const batch = ordered.slice(offset, offset + 24);
        const current = await Promise.all((["energy", "power"] as const).flatMap((metric) => {
          const entityIds = batch.filter((source) => source[metric]).map((source) => source.id);
          if (!entityIds.length) return [];
          return [api.analyticsQuery({
            apiVersion: "1.0", dataMode, scope: { kind: "house", id: houseId, entityIds },
            measurementIds: [metric],
            range: { start: start.toISOString(), end: end.toISOString(), timezone: timeZone },
            resolution: consumptionResolution(range),
            aggregation: metric === "energy" ? "delta" : "time_weighted_mean",
            qualityFilter: { include: ["good", "estimated"] },
            include: ["series", "summary", "quality", "provenance"], maxPointsPerSeries: 400,
            requestId: `electricity-${metric}-${offset}-${createClientUuid()}`,
          }, signal)];
        }));
        responses.push(...current);
      }
      return responses;
    },
    enabled: enabled && Boolean(houseId) && ordered.length > 0,
    staleTime: refreshMs,
    refetchOnWindowFocus: true,
    refetchInterval: historyRefreshInterval(enabled, refreshMs),
  } as const;
}

export function useElectricityHistoryQuery(
  houseId: string, sources: readonly ElectricityHistorySource[], range: TimeRange,
  timeZone: string, dataMode: DataMode, enabled: boolean,
) {
  const options = electricityHistoryQueryOptions(houseId, sources, range, timeZone, dataMode, enabled);
  const query = useQuery(options, queryClient);
  useCancelInactiveQuery(options.queryKey, options.enabled);
  return query;
}
