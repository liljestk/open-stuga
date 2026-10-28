import { ResponseShapeError, withSignal } from "@climate-twin/contracts";
import { parseSpatialCalibrationSessionResult, parseSpatialCalibrationSessions, parseSpatialInferenceSession, parseSpatialLayerEngines, parseSpatialLayerHealth, parseSpatialLayerSnapshots, type SpatialLayerEngineHealth, type SpatialLayerEngineManifest, type SpatialLayerAssignment, type SpatialLayerConfigurationResponse, type SpatialContextEvent, type SpatialGroundTruth, type SpatialSensorBinding, type SpatialSensorCalibration, type SpatialTopology, type SpatialLayerSnapshot, type SpatialCalibrationSession, type SpatialCalibrationSessionInput, type SpatialCalibrationSessionResult, type SpatialInferenceSession, type SpatialInferenceSessionStartInput } from "../spatialLayers";
import { request, spatialConfigurationResponse } from "./support/request";
import { spatialContextEventShape, spatialGroundTruthShape, spatialSensorBindingShape, spatialSensorCalibrationShape } from "./support/entity-shapes";
import { anyBody, arrayOf, fields } from "./support/response-shapes";

/** Spatial-layer engines, configuration, inference sessions, bindings, calibrations, context, ground truth and layers. */
export const spatialLayersApi = {
  spatialLayerEngines: async (signal?: AbortSignal): Promise<SpatialLayerEngineManifest[]> => parseSpatialLayerEngines(
      await request("/layer-engines", anyBody, withSignal(signal)),
    ),
  houseSpatialLayerConfig: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request(`/houses/${encodeURIComponent(houseId)}/layers/config`, anyBody, withSignal(signal)),
    ),
  updateHouseSpatialLayerConfig: async (
      houseId: string,
      input: { baseVersion: number; config: Record<string, unknown>; assignments: SpatialLayerAssignment[] },
      signal?: AbortSignal,
    ): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(await request(`/houses/${encodeURIComponent(houseId)}/layers/config`, anyBody, {
      method: "PUT",
      body: JSON.stringify(input),
      ...withSignal(signal),
    })),
  houseSpatialInferenceSession: async (houseId: string, signal?: AbortSignal): Promise<SpatialInferenceSession | null> => parseSpatialInferenceSession(
      await request(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, anyBody, withSignal(signal)),
    ),
  startHouseSpatialInferenceSession: async (houseId: string, input: SpatialInferenceSessionStartInput, signal?: AbortSignal): Promise<SpatialInferenceSession> => {
      const session = parseSpatialInferenceSession(await request(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, anyBody, {
        method: "POST",
        body: JSON.stringify(input),
        ...withSignal(signal),
      }));
      if (!session) throw new ResponseShapeError("/houses/{id}/layers/inference-session");
      return session;
    },
  stopHouseSpatialInferenceSession: async (houseId: string, signal?: AbortSignal): Promise<SpatialInferenceSession | null> => parseSpatialInferenceSession(
      await request(`/houses/${encodeURIComponent(houseId)}/layers/inference-session`, anyBody, { method: "DELETE", ...withSignal(signal) }),
    ),
  houseSpatialLayerBindings: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorBinding[]> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, fields({ bindings: arrayOf(spatialSensorBindingShape) }), withSignal(signal))).bindings,
  createHouseSpatialLayerBinding: async (houseId: string, binding: SpatialSensorBinding, signal?: AbortSignal): Promise<SpatialSensorBinding> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, fields({ binding: spatialSensorBindingShape }), { method: "POST", body: JSON.stringify(binding), ...withSignal(signal) })).binding,
  houseSpatialLayerCalibrations: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorCalibration[]> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, fields({ calibrations: arrayOf(spatialSensorCalibrationShape) }), withSignal(signal))).calibrations,
  createHouseSpatialLayerCalibration: async (houseId: string, calibration: SpatialSensorCalibration, signal?: AbortSignal): Promise<SpatialSensorCalibration> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, fields({ calibration: spatialSensorCalibrationShape }), { method: "POST", body: JSON.stringify(calibration), ...withSignal(signal) })).calibration,
  houseSpatialLayerCalibrationSessions: async (houseId: string, signal?: AbortSignal): Promise<SpatialCalibrationSession[]> => parseSpatialCalibrationSessions(
      await request(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, anyBody, withSignal(signal)),
    ),
  createHouseSpatialLayerCalibrationSession: async (houseId: string, input: SpatialCalibrationSessionInput, signal?: AbortSignal): Promise<SpatialCalibrationSessionResult> => {
      const response = parseSpatialCalibrationSessionResult(await request(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, anyBody, {
        method: "POST",
        body: JSON.stringify(input),
        ...withSignal(signal),
      }));
      if (!response) throw new ResponseShapeError("/houses/{id}/layers/calibration-sessions");
      return response;
    },
  houseSpatialLayerContextEvents: async (houseId: string, signal?: AbortSignal): Promise<SpatialContextEvent[]> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, fields({ events: arrayOf(spatialContextEventShape) }), withSignal(signal))).events,
  createHouseSpatialLayerContextEvent: async (houseId: string, event: SpatialContextEvent, signal?: AbortSignal): Promise<SpatialContextEvent> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, fields({ event: spatialContextEventShape }), { method: "POST", body: JSON.stringify(event), ...withSignal(signal) })).event,
  houseSpatialLayerGroundTruth: async (houseId: string, signal?: AbortSignal): Promise<SpatialGroundTruth[]> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, fields({ groundTruth: arrayOf(spatialGroundTruthShape) }), withSignal(signal))).groundTruth,
  createHouseSpatialLayerGroundTruth: async (houseId: string, truth: SpatialGroundTruth, signal?: AbortSignal): Promise<SpatialGroundTruth> => (await request(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, fields({ groundTruth: spatialGroundTruthShape }), { method: "POST", body: JSON.stringify(truth), ...withSignal(signal) })).groundTruth,
  houseSpatialLayersCurrent: async (
      houseId: string,
      layerIds: readonly string[] = [],
      signal?: AbortSignal,
    ): Promise<{ snapshots: SpatialLayerSnapshot[]; topology: SpatialTopology | null; health: SpatialLayerEngineHealth[] }> => {
      const query = new URLSearchParams();
      if (layerIds.length) query.set("layers", layerIds.join(","));
      const suffix = query.size ? `?${query.toString()}` : "";
      const payload = await request(
        `/houses/${encodeURIComponent(houseId)}/layers/current${suffix}`, anyBody,
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
      return parseSpatialLayerSnapshots(await request(
        `/houses/${encodeURIComponent(houseId)}/layers/history?${query.toString()}`, anyBody,
        withSignal(signal),
      ));
    },
  houseSpatialLayersHealth: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => parseSpatialLayerHealth(
      await request(
        `/houses/${encodeURIComponent(houseId)}/layers/health`, anyBody,
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
      const payload = await request(
        `/properties/${encodeURIComponent(propertyId)}/layers/current${suffix}`, anyBody,
        withSignal(signal),
      );
      return {
        snapshots: parseSpatialLayerSnapshots(payload),
        topology: spatialConfigurationResponse(payload).topology ?? null,
        health: parseSpatialLayerHealth(payload),
      };
    },
  propertySpatialLayerConfig: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request(`/properties/${encodeURIComponent(propertyId)}/layers/config`, anyBody, withSignal(signal)),
    ),
  propertySpatialLayersHealth: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => parseSpatialLayerHealth(
      await request(`/properties/${encodeURIComponent(propertyId)}/layers/health`, anyBody, withSignal(signal)),
    ),
  propertySpatialLayersHistory: async (
      propertyId: string,
      options: { layerIds?: readonly string[]; from: string; to: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams({ from: options.from, to: options.to, limit: String(options.limit ?? 1_000) });
      if (options.layerIds?.length) query.set("layers", options.layerIds.join(","));
      return parseSpatialLayerSnapshots(await request(
        `/properties/${encodeURIComponent(propertyId)}/layers/history?${query.toString()}`, anyBody,
        withSignal(signal),
      ));
    },
};
