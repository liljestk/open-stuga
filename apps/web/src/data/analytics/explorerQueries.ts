import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  HomeElectricityPricePoint,
  MeasurementForecastEvaluation,
  OutdoorTemperatureSample,
  Sensor,
  SensorDataGap,
} from "@climate-twin/contracts";
import { api } from "../../api";
import type { MeasurementForecasts } from "../../measurements";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

/** Forecasts are supporting evidence; one per sensor is reused for five minutes within a selection. */
const FORECAST_REUSE_MS = 5 * 60_000;
const FORECAST_CONCURRENCY = 2;

export interface ExplorerContext {
  outdoorHistory: OutdoorTemperatureSample[];
  sensorGaps: SensorDataGap[];
  electricityPrices: HomeElectricityPricePoint[];
  /** The first source that failed in the latest read; failed sources keep their previous values. */
  failure: unknown;
}

/**
 * Outdoor history, durable sensor gaps and prices for the explorer window.
 * A refresh keeps whatever an individual source last delivered when that
 * source fails, so continuity evidence stays visible while it is stale.
 */
export function useExplorerContextQuery(input: {
  houseId: string;
  rangeHours: number;
  range: string;
  enabled: boolean;
  refreshRevision: number;
}) {
  const queryKey = queryKeys.analyticsExplorerContext(input.houseId, input.range);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<ExplorerContext> => {
      const previous = queryClient.getQueryData<ExplorerContext>(queryKey);
      const to = new Date();
      const from = new Date(to.getTime() - input.rangeHours * 3_600_000);
      const [outdoor, gaps, prices] = await Promise.allSettled([
        api.outdoorTemperatureHistory(input.houseId, { from: from.toISOString(), to: to.toISOString(), limit: 100_000, signal }),
        api.sensorDataGaps(input.houseId, 500, signal),
        api.houseElectricityPrice(input.houseId, { from: from.toISOString(), to: new Date(to.getTime() + 48 * 3_600_000).toISOString(), signal }),
      ]);
      return {
        outdoorHistory: outdoor.status === "fulfilled" ? outdoor.value.samples : previous?.outdoorHistory ?? [],
        sensorGaps: gaps.status === "fulfilled" ? gaps.value : previous?.sensorGaps ?? [],
        electricityPrices: prices.status === "fulfilled"
          ? prices.value.prices ?? (prices.value.current ? [prices.value.current] : [])
          : previous?.electricityPrices ?? [],
        failure: outdoor.status === "rejected" ? outdoor.reason
          : gaps.status === "rejected" ? gaps.reason : prices.status === "rejected" ? prices.reason : null,
      };
    },
    enabled: Boolean(input.houseId) && input.enabled,
    // Opening the panels always reads afresh, as the explorer did before.
    staleTime: 0,
    retry: false,
  }, queryClient);
  useCancelInactiveQuery(queryKey, Boolean(input.houseId) && input.enabled);
  const refreshRevision = useRef(input.refreshRevision);
  useEffect(() => {
    if (refreshRevision.current === input.refreshRevision) return;
    refreshRevision.current = input.refreshRevision;
    if (input.enabled) void query.refetch();
  }, [input.refreshRevision]);
  return query;
}

/**
 * One batched observation query per selection. A refresh of the same
 * selection keeps showing the previous answer until the new one arrives, and
 * after a failed refresh; any other change clears it.
 */
export function useExplorerAnalyticsQuery(input: {
  houseId: string;
  retentionIdentity: string;
  request: () => AnalyticsQueryRequest;
  requestId: string;
  enabled: boolean;
}) {
  const queryKey = queryKeys.analyticsExplorer(input.houseId, input.retentionIdentity, input.requestId);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.analyticsQuery(input.request(), signal),
    enabled: input.enabled,
    placeholderData: (previous, previousQuery) => (
      previousQuery?.queryKey[3] === input.retentionIdentity ? previous : undefined
    ),
    retry: false,
  }, queryClient);
  useCancelInactiveQuery(queryKey, input.enabled);
  const retained = useRef<{ identity: string; data: AnalyticsQueryResponse } | null>(null);
  if (query.data && !query.isPlaceholderData) retained.current = { identity: input.retentionIdentity, data: query.data };
  const data = query.data ?? (retained.current?.identity === input.retentionIdentity ? retained.current.data : undefined);
  return { query, data };
}

/** At most two optional forecasts in flight, started only once the observed batch has arrived. */
export function useExplorerForecastsQuery(input: {
  houseId: string;
  scope: string;
  metric: string;
  sensors: readonly Sensor[];
  enabled: boolean;
}) {
  const queryKey = queryKeys.analyticsExplorerForecasts(input.houseId, input.scope, input.metric);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const forecasts: MeasurementForecasts = {};
      const evaluations: Record<string, MeasurementForecastEvaluation> = {};
      const queue = input.sensors.filter((sensor) => sensor.enabled);
      let cursor = 0;
      const worker = async () => {
        while (!signal.aborted) {
          const sensor = queue[cursor++];
          if (!sensor) return;
          try {
            const result = await api.measurementForecastWithEvaluation({ sensorId: sensor.id, metric: input.metric, hours: 12, signal });
            forecasts[sensor.id] = { [input.metric]: result.forecast };
            if (result.evaluation) evaluations[sensor.id] = result.evaluation;
          } catch {
            // Forecasts are optional supporting evidence; observed history remains usable.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FORECAST_CONCURRENCY, queue.length) }, worker));
      return { forecasts, evaluations };
    },
    enabled: input.enabled,
    staleTime: FORECAST_REUSE_MS,
    retry: false,
  }, queryClient);
  useCancelInactiveQuery(queryKey, input.enabled);
  return query;
}
