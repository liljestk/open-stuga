import type {
  ActionPlaybook,
  ActionRun,
  ActionRunStartInput,
  AppSession,
  AnalyticsCoverageRequest,
  AnalyticsCoverageResponse,
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentAttachmentUploadInput,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  BackupOperationStatus,
  DataExportPreview,
  DataExportPrivacyLevel,
  DailyAnalyticsFindingsResponse,
  EnergyOptimizationReport,
  AlertRulePatch,
  AppleNotesGrantCreated,
  AppleNotesGrantSummary,
  AlertEvent,
  AlertRule,
  ForecastPoint,
  House,
  HouseLocation,
  HouseMapPlacement,
  HouseWeather,
  HomeElectricityPricePoint,
  HomeEnergyCost,
  IntegrationStatus,
  IntegrationTestResult,
  LocalInvitationRegistrationInput,
  LocalLoginInput,
  LocalOwnerSetupInput,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MaintenanceTask,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  MockScenario,
  NotificationDeliveryStatus,
  ObservationRevision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OpeningStateSnapshot,
  OutdoorTemperatureSample,
  Reading,
  Sensor,
  SensorDataGap,
  SensorLabelDescriptor,
  SensorSnapshot,
  SetupDoctorReport,
  StaticParameter,
  GuestAccessGrant,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyInventorySnapshot,
  TenantMemberSummary,
  TenantInvitationCreated,
  TelemetryEvent,
  TelegramConfigInput,
  TelegramDiscoveryResult,
  MoistureResponseResult,
  ThermalIsolationResult,
  ThermalSimulationResult,
  EquipmentTrackingBinding,
  TrackingCapabilities,
  TrackingEvent,
  TrackingMapSnapshot,
  TrackingEndpoint,
  TrackingEndpointEnrollmentInput,
  TrackingProfileManifest,
  TrackedEquipmentState,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import type {
  StugubyDatasetGrant,
  StugubyDeletionReceipt,
  StugubyGrantAudience,
  StugubyInvitation,
  StugubyMember,
  StugubyMemberState,
  StugubyNodeIdentity,
  StugubyPropertyConflict,
  StugubyRemoteResource,
  StugubyRole,
  StugubyShareGrant,
  StugubySharedProperty,
  StugubySummary,
} from "@climate-twin/stuguby-protocol";
import {
  spatialCalibrationSessionResult,
  spatialCalibrationSessions,
  spatialLayerEngines,
  spatialLayerHealth,
  spatialLayerSnapshotEvent,
  spatialLayerSnapshots,
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
  type SpatialLayerSnapshotEvent,
  type SpatialCalibrationSession,
  type SpatialCalibrationSessionInput,
  type SpatialCalibrationSessionResult,
} from "../spatialLayers";
import { publishAuthEpoch } from "../authEpoch";
import { API_BASE, API_REQUEST_TIMEOUT_MS, API_V2_BASE, ApiRequestError, COLLECTION_PAGE_SIZE, SAFE_API_PATH, SAFE_HTTP_METHODS, STREAM_STABILITY_DELAY_MS, TRACKING_EVENT_TYPES, activeRequestControllers, apiClientState, apiRequestGeneration, assertSafeApiPath, authorizationChange, authorizationListeners, cancelPendingApiRequests, collectionPagePath, completeAuthentication, completeCollection, entity, houseResponse, isPollingHeartbeat, list, memberSummary, notifyAuthorizationChange, observationResponse, rememberSession, request, requestFrom, requestV2, sensorResponse, spatialConfigurationResponse, subscribeToApiAuthorizationChanges, subscribeToEvents, subscribeToMeasurementEvents, subscribeToSpatialLayerEvents, subscribeToSystemUpdateEvents, subscribeToTrackingEvents, updateHouseGeoreference } from "./support";
import type { ApiAuthorizationChange, AppleNotesSetupMetadata, CloudflareSetupOperation, CloudflareSetupPhase, CloudflareSetupStartInput, CloudflareSetupStartResult, CloudflareSetupStatus, CoordinateDefaults, CreateHouseInput, CreateSensorInput, HistoricalImportResult, HomeAssistantDiscoveredInstance, HouseGeoreferencePatch, HousePatch, IntegrationDiscoveryResult, LocationSuggestion, MaintenanceTaskFilters, MeasurementHistoryPage, OutdoorTemperatureHistoryPage, SensorMeasurementPage, SensorPatch, StugubyAuthorityTransfer, StugubyDetailResponse, StugubyHomeProjection, StugubyInvitationCreated, StugubyListResponse, StugubyLocalInvitation, StugubyLocalMember, StugubyLocalPublicationCatalog, StugubyPropertyAdoption, StugubyRemoteTelemetrySample, SystemRelease, SystemUpdateDay, SystemUpdateLiveStatus, SystemUpdateOperation, SystemUpdateSettings, SystemUpdateStatus, TenantMembersResponse, TpLinkDiscoveredSource, TpLinkHistoryExportJob, TpLinkHistoryExportJobStatus, TpLinkHistoryExportJobsResponse, TpLinkHistoryExportProvider } from "./support";

const measurementHistoryPageRequest = async (
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    limit = 500,
    bucketSeconds?: number,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ sensorId, metric, from, to, limit: String(limit) });
    if (bucketSeconds !== undefined) query.set("bucketSeconds", String(bucketSeconds));
    const result = await requestV2<Partial<Omit<MeasurementHistoryPage, "samples">> & { samples: MeasurementSample[] }>(
      `/measurements/history?${query.toString()}`,
      signal ? { signal } : undefined,
    );
    return {
      samples: result.samples,
      from: result.from ?? from,
      to: result.to ?? to,
      bucketSeconds: result.bucketSeconds ?? null,
      truncated: result.truncated ?? result.samples.length >= limit,
    } satisfies MeasurementHistoryPage;
  };

export const apiPart04 = {
  measurementSnapshot: async (houseId: string) => (await requestV2<{ snapshot: { sensorId: string; measurements: Record<string, MeasurementSample> }[] }>(
      `/measurements/snapshot?houseId=${encodeURIComponent(houseId)}`,
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
  measurementForecast: async (sensorId: string, metric: string, hours = 12) => (
      await requestV2<{ forecast: MeasurementForecastPoint[] }>(
        `/measurements/forecast?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`,
      )
    ).forecast,
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
        signal ? { signal } : undefined,
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
        signal ? { signal } : undefined,
      )).moistureResponse;
    },
  spatialLayerEngines: async (): Promise<SpatialLayerEngineManifest[]> => spatialLayerEngines(
      await request<unknown>("/layer-engines"),
    ),
  houseSpatialLayerConfig: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/config`, signal ? { signal } : undefined),
    ),
  updateHouseSpatialLayerConfig: async (
      houseId: string,
      input: { baseVersion: number; config: Record<string, unknown>; assignments: SpatialLayerAssignment[]; enabled?: boolean },
    ): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/config`, {
      method: "PUT",
      body: JSON.stringify(input),
    })),
  houseSpatialLayerBindings: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorBinding[]> => list<SpatialSensorBinding>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, signal ? { signal } : undefined),
      ["bindings", "data"],
    ),
  createHouseSpatialLayerBinding: async (houseId: string, binding: SpatialSensorBinding): Promise<SpatialSensorBinding> => entity(
      await request<SpatialSensorBinding | { binding: SpatialSensorBinding }>(`/houses/${encodeURIComponent(houseId)}/layers/bindings`, { method: "POST", body: JSON.stringify(binding) }),
      "binding",
    ),
  houseSpatialLayerCalibrations: async (houseId: string, signal?: AbortSignal): Promise<SpatialSensorCalibration[]> => list<SpatialSensorCalibration>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, signal ? { signal } : undefined),
      ["calibrations", "sessions", "data"],
    ),
  createHouseSpatialLayerCalibration: async (houseId: string, calibration: SpatialSensorCalibration): Promise<SpatialSensorCalibration> => entity(
      await request<SpatialSensorCalibration | { calibration: SpatialSensorCalibration }>(`/houses/${encodeURIComponent(houseId)}/layers/calibrations`, { method: "POST", body: JSON.stringify(calibration) }),
      "calibration",
    ),
  houseSpatialLayerCalibrationSessions: async (houseId: string, signal?: AbortSignal): Promise<SpatialCalibrationSession[]> => spatialCalibrationSessions(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, signal ? { signal } : undefined),
    ),
  createHouseSpatialLayerCalibrationSession: async (houseId: string, input: SpatialCalibrationSessionInput): Promise<SpatialCalibrationSessionResult> => {
      const response = spatialCalibrationSessionResult(await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/calibration-sessions`, {
        method: "POST",
        body: JSON.stringify(input),
      }));
      if (!response) throw new Error("The spatial calibration-session response was invalid");
      return response;
    },
  houseSpatialLayerContextEvents: async (houseId: string, signal?: AbortSignal): Promise<SpatialContextEvent[]> => list<SpatialContextEvent>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, signal ? { signal } : undefined),
      ["events", "contextEvents", "data"],
    ),
  createHouseSpatialLayerContextEvent: async (houseId: string, event: SpatialContextEvent): Promise<SpatialContextEvent> => entity(
      await request<SpatialContextEvent | { event: SpatialContextEvent }>(`/houses/${encodeURIComponent(houseId)}/layers/context-events`, { method: "POST", body: JSON.stringify(event) }),
      "event",
    ),
  houseSpatialLayerGroundTruth: async (houseId: string, signal?: AbortSignal): Promise<SpatialGroundTruth[]> => list<SpatialGroundTruth>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, signal ? { signal } : undefined),
      ["labels", "groundTruth", "data"],
    ),
  createHouseSpatialLayerGroundTruth: async (houseId: string, truth: SpatialGroundTruth): Promise<SpatialGroundTruth> => entity(
      await request<SpatialGroundTruth | { groundTruth: SpatialGroundTruth }>(`/houses/${encodeURIComponent(houseId)}/layers/ground-truth`, { method: "POST", body: JSON.stringify(truth) }),
      "groundTruth",
    ),
  houseSpatialLayersCurrent: async (houseId: string, layerIds: readonly string[] = [], signal?: AbortSignal): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams();
      if (layerIds.length) query.set("layers", layerIds.join(","));
      const suffix = query.size ? `?${query.toString()}` : "";
      return spatialLayerSnapshots(await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/current${suffix}`,
        signal ? { signal } : undefined,
      ));
    },
  houseSpatialLayersHistory: async (
      houseId: string,
      options: { layerIds?: readonly string[]; from: string; to: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams({ from: options.from, to: options.to, limit: String(options.limit ?? 1_000) });
      if (options.layerIds?.length) query.set("layers", options.layerIds.join(","));
      return spatialLayerSnapshots(await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/history?${query.toString()}`,
        signal ? { signal } : undefined,
      ));
    },
  houseSpatialLayersHealth: async (houseId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => spatialLayerHealth(
      await request<unknown>(
        `/houses/${encodeURIComponent(houseId)}/layers/health`,
        signal ? { signal } : undefined,
      ),
    ),
  propertySpatialLayersCurrent: async (propertyId: string, layerIds: readonly string[] = [], signal?: AbortSignal): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams();
      if (layerIds.length) query.set("layers", layerIds.join(","));
      const suffix = query.size ? `?${query.toString()}` : "";
      return spatialLayerSnapshots(await request<unknown>(
        `/properties/${encodeURIComponent(propertyId)}/layers/current${suffix}`,
        signal ? { signal } : undefined,
      ));
    },
  propertySpatialLayerConfig: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerConfigurationResponse> => spatialConfigurationResponse(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/layers/config`, signal ? { signal } : undefined),
    ),
  propertySpatialLayersHealth: async (propertyId: string, signal?: AbortSignal): Promise<SpatialLayerEngineHealth[]> => spatialLayerHealth(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/layers/health`, signal ? { signal } : undefined),
    ),
  propertySpatialLayersHistory: async (
      propertyId: string,
      options: { layerIds?: readonly string[]; from: string; to: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<SpatialLayerSnapshot[]> => {
      const query = new URLSearchParams({ from: options.from, to: options.to, limit: String(options.limit ?? 1_000) });
      if (options.layerIds?.length) query.set("layers", options.layerIds.join(","));
      return spatialLayerSnapshots(await request<unknown>(
        `/properties/${encodeURIComponent(propertyId)}/layers/history?${query.toString()}`,
        signal ? { signal } : undefined,
      ));
    },
};
