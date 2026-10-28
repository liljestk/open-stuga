import { type AnalyticsCoverageRequest, type AnalyticsCoverageResponse, type AnalyticsDiagnostics, type AnalyticsQueryRequest, type AnalyticsQueryResponse, type CalendarComparisonRequest, type CalendarComparisonResponse, type DailyAnalyticsFindingsResponse, type DurableDerivedAnalyticsResponse, type HomeMonitoringCollectionResponse, type HomeMonitoringDetailResponse, type HomePerformanceResponse, type OpeningActivityRequest, type OpeningActivityResponse, expectShape, isAnalyticsDiagnostics, withSignal, type MoistureResponseResult, type ThermalIsolationResult, type ThermalSimulationResult } from "@climate-twin/contracts";
import { request, requestV2 } from "./support/request";

/** Derived analytics: findings, diagnostics, coverage, queries, monitoring, comparisons, and thermal and moisture models. */
export const analyticsApi = {
  analyticsFindings: (houseId: string, signal?: AbortSignal) => requestV2<DailyAnalyticsFindingsResponse>(
      `/analytics/findings?houseId=${encodeURIComponent(houseId)}`,
      withSignal(signal),
    ),
  analyticsDiagnostics: async (houseId: string, signal?: AbortSignal): Promise<AnalyticsDiagnostics> => expectShape(
      (await requestV2<{ diagnostics?: unknown }>(`/analytics/diagnostics?houseId=${encodeURIComponent(houseId)}`, signal ? { signal } : undefined)).diagnostics,
      isAnalyticsDiagnostics,
      "/analytics/diagnostics",
    ),
  openingActivity: (input: OpeningActivityRequest, signal?: AbortSignal) => requestV2<OpeningActivityResponse>(
      "/analytics/opening-activity",
      {
        method: "POST",
        schedulingClass: "background",
        body: JSON.stringify(input),
        ...withSignal(signal),
      },
    ),
  calendarComparison: (
    input: CalendarComparisonRequest,
    signal?: AbortSignal,
  ) => requestV2<CalendarComparisonResponse>("/analytics/calendar-comparison", {
    method: "POST",
    schedulingClass: "background",
    body: JSON.stringify(input),
    ...withSignal(signal),
  }),
  homePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<DurableDerivedAnalyticsResponse<HomePerformanceResponse>>(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`,
      withSignal(signal),
    ),
  refreshHomePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<DurableDerivedAnalyticsResponse<HomePerformanceResponse>>(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`,
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
  homeMonitoringCollection: (
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<HomeMonitoringCollectionResponse>(
    `/monitoring/houses?dataMode=${dataMode}`,
    withSignal(signal),
  ),
  homeMonitoring: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<HomeMonitoringDetailResponse>(
    `/monitoring/houses/${encodeURIComponent(houseId)}?dataMode=${dataMode}&include=insights`,
    withSignal(signal),
  ),
  analyticsCoverage: (input: AnalyticsCoverageRequest, signal?: AbortSignal) => requestV2<AnalyticsCoverageResponse>("/analytics/coverage", {
      method: "POST",
      schedulingClass: "background",
      body: JSON.stringify(input),
      ...withSignal(signal),
    }),
  analyticsQuery: (input: AnalyticsQueryRequest, signal?: AbortSignal) => requestV2<AnalyticsQueryResponse>("/analytics/query", {
      method: "POST",
      schedulingClass: "background",
      body: JSON.stringify(input),
      ...withSignal(signal),
    }),
  thermalSimulation: async (
      houseId: string,
      options: {
        sensorId: string;
        from: string;
        to: string;
        horizonHours: number;
        scenarioOutdoorTemperatureC?: number;
      },
    ) => {
      const query = new URLSearchParams({
        sensorId: options.sensorId,
        from: options.from,
        to: options.to,
        horizonHours: String(options.horizonHours),
      });
      if (options.scenarioOutdoorTemperatureC !== undefined) {
        query.set("scenarioOutdoorTemperatureC", String(options.scenarioOutdoorTemperatureC));
      }
      return (await request<{ simulation: ThermalSimulationResult }>(
        `/houses/${encodeURIComponent(houseId)}/thermal-simulation?${query.toString()}`,
      )).simulation;
    },
  thermalIsolation: async (
      houseId: string,
      options: { from: string; to: string },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ from: options.from, to: options.to });
      return (await request<{ isolation: ThermalIsolationResult }>(
        `/houses/${encodeURIComponent(houseId)}/thermal-isolation?${query.toString()}`,
        withSignal(signal),
      )).isolation;
    },
  moistureResponse: async (
      houseId: string,
      options: { from: string; to: string },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ from: options.from, to: options.to });
      return (await request<{ moistureResponse: MoistureResponseResult }>(
        `/houses/${encodeURIComponent(houseId)}/moisture-response?${query.toString()}`,
        withSignal(signal),
      )).moistureResponse;
    },
  cachedThermalIsolation: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2<DurableDerivedAnalyticsResponse<ThermalIsolationResult>>(
      `/analytics/thermal-isolation?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`,
      withSignal(signal),
    ),
  refreshCachedThermalIsolation: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2<DurableDerivedAnalyticsResponse<ThermalIsolationResult>>(
      `/analytics/thermal-isolation?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`,
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
  cachedMoistureResponse: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2<DurableDerivedAnalyticsResponse<MoistureResponseResult>>(
      `/analytics/moisture-response?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`,
      withSignal(signal),
    ),
  refreshCachedMoistureResponse: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2<DurableDerivedAnalyticsResponse<MoistureResponseResult>>(
      `/analytics/moisture-response?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`,
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
};
