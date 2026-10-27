import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import type {
  DurableDerivedAnalyticsResponse,
  MeasurementForecastEvaluation,
  MeasurementForecastPoint,
  MeasurementSample,
  MoistureResponseResult,
  ThermalIsolationResult,
  ThermalSimulationResult,
} from "@climate-twin/contracts";
import {
  parseSpatialCalibrationSessionResult,
  parseSpatialCalibrationSessions,
  parseSpatialInferenceSession,
  parseSpatialLayerEngines,
  parseSpatialLayerHealth,
  parseSpatialLayerSnapshots,
  type SpatialLayerEngineHealth,
  type SpatialLayerEngineManifest,
  type SpatialLayerAssignment,
  type SpatialLayerConfigurationResponse,
  type SpatialContextEvent,
  type SpatialGroundTruth,
  type SpatialSensorBinding,
  type SpatialSensorCalibration,
  type SpatialTopology,
  type SpatialLayerSnapshot,
  type SpatialCalibrationSession,
  type SpatialCalibrationSessionInput,
  type SpatialCalibrationSessionResult,
  type SpatialInferenceSession,
  type SpatialInferenceSessionStartInput,
} from "../spatialLayers";
import { ResponseShapeError, expectShape, isMeasurementForecastEvaluation, isMeasurementForecastPoints, withSignal } from "@climate-twin/contracts";
import { entity, list, request, requestV2, spatialConfigurationResponse } from "./support";
import type { HistoricalImportResult, MeasurementHistoryPage, SensorMeasurementPage } from "./support";

const measurementHistoryPageRequest = async (
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    limit = 500,
    bucketSeconds?: number,
    signal?: AbortSignal,
    cursor?: string | null,
  ) => {
    const query = new URLSearchParams({ sensorId, metric, from, to, limit: String(limit) });
    if (bucketSeconds !== undefined) query.set("bucketSeconds", String(bucketSeconds));
    if (cursor) query.set("cursor", cursor);
    const result = await requestV2<Partial<Omit<MeasurementHistoryPage, "samples">> & { samples: MeasurementSample[] }>(
      `/measurements/history?${query.toString()}`,
      withSignal(signal),
    );
    return {
      samples: result.samples,
      from: result.from ?? from,
      to: result.to ?? to,
      bucketSeconds: result.bucketSeconds ?? null,
      truncated: result.truncated ?? result.samples.length >= limit,
      nextCursor: result.nextCursor ?? null,
    } satisfies MeasurementHistoryPage;
  };

export const apiPart04 = {
  measurementSnapshot: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => (await requestV2<{ snapshot: { sensorId: string; measurements: Record<string, MeasurementSample> }[] }>(
      `/measurements/snapshot?houseId=${encodeURIComponent(houseId)}`, { schedulingClass },
    )).snapshot,
  measurementHistoryPage: measurementHistoryPageRequest,
  measurementHistory: async (sensorId: string, metric: string, from: string, to: string, limit = 500, signal?: AbortSignal) => (
      await measurementHistoryPageRequest(sensorId, metric, from, to, limit, undefined, signal)
    ).samples,
  sensorMeasurementPage: (sensorId: string, cursor: string | null = null, limit = 100) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return requestV2<SensorMeasurementPage>(`/sensors/${encodeURIComponent(sensorId)}/measurements?${query}`);
    },
  importHistoricalMeasurements: async (
      samples: MeasurementSample[],
      onProgress?: (completed: number, total: number) => void,
    ): Promise<HistoricalImportResult> => {
      let accepted = 0;
      let ignoredDuplicates = 0;
      for (let offset = 0; offset < samples.length; offset += 1_000) {
        const batch = samples.slice(offset, offset + 1_000);
        const result = await requestV2<{ accepted: number; ignoredDuplicates: number }>("/measurements/import", {
          method: "POST",
          body: JSON.stringify({ samples: batch }),
        });
        accepted += result.accepted;
        ignoredDuplicates += result.ignoredDuplicates;
        onProgress?.(Math.min(offset + batch.length, samples.length), samples.length);
      }
      return { submitted: samples.length, accepted, ignoredDuplicates };
    },
  measurementForecast: async (sensorId: string, metric: string, hours = 12, signal?: AbortSignal) => (
      await requestV2<{ forecast: MeasurementForecastPoint[] }>(
        `/measurements/forecast?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`,
        withSignal(signal),
      )
    ).forecast,
  /** The forecast with the backtest that decided whether it is shown. */
  measurementForecastWithEvaluation: async (
      { sensorId, metric, hours = 12, signal }: { sensorId: string; metric: string; hours?: number; signal?: AbortSignal },
    ): Promise<{ forecast: MeasurementForecastPoint[]; evaluation?: MeasurementForecastEvaluation }> => {
      const endpoint = "/measurements/forecast";
      const body = await requestV2<unknown>(
        `${endpoint}?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`,
        signal ? { signal } : undefined,
      );
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const forecast = expectShape(record.forecast, isMeasurementForecastPoints, endpoint);
      const evaluation = record.evaluation === undefined ? undefined : expectShape(record.evaluation, isMeasurementForecastEvaluation, endpoint);
      return evaluation ? { forecast, evaluation } : { forecast };
    },
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
  spatialLayerEngines: async (signal?: AbortSignal): Promise<SpatialLayerEngineManifest[]> => parseSpatialLayerEngines(
      await request<unknown>("/layer-engines", withSignal(signal)),
    ),
  houseSpatialLayerConfig: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/config`, withSignal(signal)),
    ),
  updateHouseSpatialLayerConfig: async (
      houseId: string,
      input: { baseVersion: number; config: Record<string, unknown>; assignments: SpatialLayerAssignment[] },
      signal?: AbortSignal,
    ): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/config`, {
      method: "PUT",
      body: JSON.stringify(input),
      ...withSignal(signal),
    })),
  houseSpatialInferenceSession: async (houseId: string, signal?: AbortSignal): Promise<SpatialInferenceSession | null> => parseSpatialInferenceSession(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, withSignal(signal)),
    ),
  startHouseSpatialInferenceSession: async (houseId: string, input: SpatialInferenceSessionStartInput, signal?: AbortSignal): Promise<SpatialInferenceSession> => {
      const session = parseSpatialInferenceSession(await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, {
        method: "POST",
        body: JSON.stringify(input),
        ...withSignal(signal),
      }));
      if (!session) throw new ResponseShapeError("/houses/{id}/layers/inference-session");
      return session;
    },
  stopHouseSpatialInferenceSession: async (houseId: string, signal?: AbortSignal): Promise<SpatialInferenceSession | null> => parseSpatialInferenceSession(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, { method: "DELETE", ...withSignal(signal) }),
    ),
  houseSpatialLayerBindings: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorBinding[]> => list<SpatialSensorBinding>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, withSignal(signal)),
      ["bindings", "data"],
    ),
  createHouseSpatialLayerBinding: async (houseId: string, binding: SpatialSensorBinding, signal?: AbortSignal): Promise<SpatialSensorBinding> => entity(
      await request<SpatialSensorBinding | { binding: SpatialSensorBinding }>(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, { method: "POST", body: JSON.stringify(binding), ...withSignal(signal) }),
      "binding",
    ),
  houseSpatialLayerCalibrations: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorCalibration[]> => list<SpatialSensorCalibration>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, withSignal(signal)),
      ["calibrations", "sessions", "data"],
    ),
  createHouseSpatialLayerCalibration: async (houseId: string, calibration: SpatialSensorCalibration, signal?: AbortSignal): Promise<SpatialSensorCalibration> => entity(
      await request<SpatialSensorCalibration | { calibration: SpatialSensorCalibration }>(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, { method: "POST", body: JSON.stringify(calibration), ...withSignal(signal) }),
      "calibration",
    ),
  houseSpatialLayerCalibrationSessions: async (houseId: string, signal?: AbortSignal): Promise<SpatialCalibrationSession[]> => parseSpatialCalibrationSessions(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, withSignal(signal)),
    ),
  createHouseSpatialLayerCalibrationSession: async (houseId: string, input: SpatialCalibrationSessionInput, signal?: AbortSignal): Promise<SpatialCalibrationSessionResult> => {
      const response = parseSpatialCalibrationSessionResult(await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, {
        method: "POST",
        body: JSON.stringify(input),
        ...withSignal(signal),
      }));
      if (!response) throw new ResponseShapeError("/houses/{id}/layers/calibration-sessions");
      return response;
    },
  houseSpatialLayerContextEvents: async (houseId: string, signal?: AbortSignal): Promise<SpatialContextEvent[]> => list<SpatialContextEvent>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, withSignal(signal)),
      ["events", "contextEvents", "data"],
    ),
  createHouseSpatialLayerContextEvent: async (houseId: string, event: SpatialContextEvent, signal?: AbortSignal): Promise<SpatialContextEvent> => entity(
      await request<SpatialContextEvent | { event: SpatialContextEvent }>(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, { method: "POST", body: JSON.stringify(event), ...withSignal(signal) }),
      "event",
    ),
  houseSpatialLayerGroundTruth: async (houseId: string, signal?: AbortSignal): Promise<SpatialGroundTruth[]> => list<SpatialGroundTruth>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, withSignal(signal)),
      ["labels", "groundTruth", "data"],
    ),
  createHouseSpatialLayerGroundTruth: async (houseId: string, truth: SpatialGroundTruth, signal?: AbortSignal): Promise<SpatialGroundTruth> => entity(
      await request<SpatialGroundTruth | { groundTruth: SpatialGroundTruth }>(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, { method: "POST", body: JSON.stringify(truth), ...withSignal(signal) }),
      "groundTruth",
    ),
  houseSpatialLayersCurrent: async (
      houseId: string,
      layerIds: readonly string[] = [],
      signal?: AbortSignal,
    ): Promise<{ snapshots: SpatialLayerSnapshot[]; topology: SpatialTopology | null; health: SpatialLayerEngineHealth[] }> => {
      const query = new URLSearchParams();
      if (layerIds.length) query.set("layers", layerIds.join(","));
      const suffix = query.size ? `?${query.toString()}` : "";
      const payload = await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/current${suffix}`,
        withSignal(signal),
      );
      return {
        snapshots: parseSpatialLayerSnapshots(payload),
        topology: spatialConfigurationResponse(payload).topology ?? null,
        health: parseSpatialLayerHealth(payload),
      };
    },
  houseSpatialLayersHistory: async (
      houseId: string,
      options: { layerIds?: readonly string[]; from: string; to: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams({ from: options.from, to: options.to, limit: String(options.limit ?? 1_000) });
      if (options.layerIds?.length) query.set("layers", options.layerIds.join(","));
      return parseSpatialLayerSnapshots(await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/history?${query.toString()}`,
        withSignal(signal),
      ));
    },
  houseSpatialLayersHealth: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => parseSpatialLayerHealth(
      await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/health`,
        withSignal(signal),
      ),
    ),
  propertySpatialLayersCurrent: async (
      propertyId: string,
      layerIds: readonly string[] = [],
      signal?: AbortSignal,
    ): Promise<{ snapshots: SpatialLayerSnapshot[]; topology: SpatialTopology | null; health: SpatialLayerEngineHealth[] }> => {
      const query = new URLSearchParams();
      if (layerIds.length) query.set("layers", layerIds.join(","));
      const suffix = query.size ? `?${query.toString()}` : "";
      const payload = await request<unknown>(
        `/properties/${encodeURIComponent(propertyId)}/layers/current${suffix}`,
        withSignal(signal),
      );
      return {
        snapshots: parseSpatialLayerSnapshots(payload),
        topology: spatialConfigurationResponse(payload).topology ?? null,
        health: parseSpatialLayerHealth(payload),
      };
    },
  propertySpatialLayerConfig: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/layers/config`, withSignal(signal)),
    ),
  propertySpatialLayersHealth: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => parseSpatialLayerHealth(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/layers/health`, withSignal(signal)),
    ),
  propertySpatialLayersHistory: async (
      propertyId: string,
      options: { layerIds?: readonly string[]; from: string; to: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams({ from: options.from, to: options.to, limit: String(options.limit ?? 1_000) });
      if (options.layerIds?.length) query.set("layers", options.layerIds.join(","));
      return parseSpatialLayerSnapshots(await request<unknown>(
        `/properties/${encodeURIComponent(propertyId)}/layers/history?${query.toString()}`,
        withSignal(signal),
      ));
    },
};
