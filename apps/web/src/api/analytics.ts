import { type AnalyticsCoverageRequest, type AnalyticsDiagnostics, type AnalyticsQueryRequest, type CalendarComparisonRequest, type DurableDerivedAnalyticsResponse, type OpeningActivityRequest, expectShape, isAnalyticsDiagnostics, withSignal } from "@climate-twin/contracts";
import { request, requestV2 } from "./support/request";
import { analyticsCoverageResponseShape, analyticsQueryResponseShape, calendarComparisonResponseShape, dailyAnalyticsFindingsResponseShape, homeMonitoringCollectionResponseShape, homeMonitoringDetailResponseShape, homePerformanceResponseShape, moistureResponseResultShape, openingActivityResponseShape, thermalIsolationResultShape, thermalSimulationResultShape } from "./support/entity-shapes";
import { anyBody, entity, optional, fields, type ResponseShape } from "./support/response-shapes";

/** Derived analytics: findings, diagnostics, coverage, queries, monitoring, comparisons, and thermal and moisture models. */
/** A durable derived-analytics envelope whose `result`, when present, `result` parses. */
function durableDerivedAnalytics<Result>(result: ResponseShape<Result>): ResponseShape<DurableDerivedAnalyticsResponse<Result>> {
  const envelope = entity<DurableDerivedAnalyticsResponse<Result>>("DurableDerivedAnalyticsResponse", {
    apiVersion: "string", kind: "string", houseId: "string", dataMode: "string", windowDays: "number", cutoff: "string",
    state: "string", stale: "boolean", artifact: "object|null",
  });
  return (value, endpoint) => {
    const parsed = envelope(value, endpoint);
    return { ...parsed, result: parsed.result === null ? null : result(parsed.result, endpoint) };
  };
}

export const analyticsApi = {
  analyticsFindings: (houseId: string, signal?: AbortSignal) => requestV2(
      `/analytics/findings?houseId=${encodeURIComponent(houseId)}`, dailyAnalyticsFindingsResponseShape,
      withSignal(signal),
    ),
  analyticsDiagnostics: async (houseId: string, signal?: AbortSignal): Promise<AnalyticsDiagnostics> => expectShape(
      (await requestV2(`/analytics/diagnostics?houseId=${encodeURIComponent(houseId)}`, fields({ diagnostics: optional(anyBody) }), signal ? { signal } : undefined)).diagnostics,
      isAnalyticsDiagnostics,
      "/analytics/diagnostics",
    ),
  openingActivity: (input: OpeningActivityRequest, signal?: AbortSignal) => requestV2(
      "/analytics/opening-activity", openingActivityResponseShape,
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
  ) => requestV2("/analytics/calendar-comparison", calendarComparisonResponseShape, {
    method: "POST",
    schedulingClass: "background",
    body: JSON.stringify(input),
    ...withSignal(signal),
  }),
  homePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`, durableDerivedAnalytics(homePerformanceResponseShape),
      withSignal(signal),
    ),
  refreshHomePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`, durableDerivedAnalytics(homePerformanceResponseShape),
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
  homeMonitoringCollection: (
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2(
    `/monitoring/houses?dataMode=${dataMode}`, homeMonitoringCollectionResponseShape,
    withSignal(signal),
  ),
  homeMonitoring: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2(
    `/monitoring/houses/${encodeURIComponent(houseId)}?dataMode=${dataMode}&include=insights`, homeMonitoringDetailResponseShape,
    withSignal(signal),
  ),
  analyticsCoverage: (input: AnalyticsCoverageRequest, signal?: AbortSignal) => requestV2("/analytics/coverage", analyticsCoverageResponseShape, {
      method: "POST",
      schedulingClass: "background",
      body: JSON.stringify(input),
      ...withSignal(signal),
    }),
  analyticsQuery: (input: AnalyticsQueryRequest, signal?: AbortSignal) => requestV2("/analytics/query", analyticsQueryResponseShape, {
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
      return (await request(
        `/houses/${encodeURIComponent(houseId)}/thermal-simulation?${query.toString()}`, fields({ simulation: thermalSimulationResultShape }),
      )).simulation;
    },
  thermalIsolation: async (
      houseId: string,
      options: { from: string; to: string },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ from: options.from, to: options.to });
      return (await request(
        `/houses/${encodeURIComponent(houseId)}/thermal-isolation?${query.toString()}`, fields({ isolation: thermalIsolationResultShape }),
        withSignal(signal),
      )).isolation;
    },
  moistureResponse: async (
      houseId: string,
      options: { from: string; to: string },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ from: options.from, to: options.to });
      return (await request(
        `/houses/${encodeURIComponent(houseId)}/moisture-response?${query.toString()}`, fields({ moistureResponse: moistureResponseResultShape }),
        withSignal(signal),
      )).moistureResponse;
    },
  cachedThermalIsolation: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2(
      `/analytics/thermal-isolation?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`, durableDerivedAnalytics(thermalIsolationResultShape),
      withSignal(signal),
    ),
  refreshCachedThermalIsolation: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2(
      `/analytics/thermal-isolation?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`, durableDerivedAnalytics(thermalIsolationResultShape),
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
  cachedMoistureResponse: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2(
      `/analytics/moisture-response?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`, durableDerivedAnalytics(moistureResponseResultShape),
      withSignal(signal),
    ),
  refreshCachedMoistureResponse: (
      houseId: string,
      options: { windowDays: 1 | 7 | 14; dataMode: "live" | "demo" },
      signal?: AbortSignal,
    ) => requestV2(
      `/analytics/moisture-response?houseId=${encodeURIComponent(houseId)}&dataMode=${options.dataMode}&windowDays=${options.windowDays}`, durableDerivedAnalytics(moistureResponseResultShape),
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
};
