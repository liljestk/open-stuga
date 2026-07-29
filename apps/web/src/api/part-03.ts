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
  GreeDiscoveredDevice,
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
  HeatPumpState,
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
import { discoverIntegrationsInBackground, latestIntegrationDiscovery, resumeIntegrationDiscovery } from "./integration-discovery";



export const apiPart03 = {
  updateAlertRule: async (id: string, patch: AlertRulePatch) => {
      const response = await request<AlertRule | { rule: AlertRule }>(`/alert-rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return "rule" in response ? response.rule : response;
    },
  alerts: async () => list<AlertEvent>(await request<unknown>("/alerts"), ["alerts", "events", "data"]),
  acknowledgeAlert: (id: string) => request<AlertEvent>(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
  notificationDeliveries: async (options: { subjectKind?: string; subjectId?: string; deadLettersOnly?: boolean; limit?: number } = {}) => {
      const query = new URLSearchParams();
      if (options.subjectKind) query.set("subjectKind", options.subjectKind);
      if (options.subjectId) query.set("subjectId", options.subjectId);
      if (options.deadLettersOnly) query.set("deadLettersOnly", "true");
      if (options.limit) query.set("limit", String(options.limit));
      return list<NotificationDeliveryStatus>(await request<unknown>(`/notification-deliveries${query.size ? `?${query}` : ""}`), ["deliveries", "data"]);
    },
  retryNotificationDelivery: async (id: string) => entity(await request<NotificationDeliveryStatus | { delivery: NotificationDeliveryStatus }>(`/notification-deliveries/${encodeURIComponent(id)}/retry`, { method: "POST" }), "delivery"),
  actionPlaybooks: async (metric?: string) => list<ActionPlaybook>(await request<unknown>(`/action-playbooks${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`), ["playbooks", "data"]),
  alertActionPlaybooks: async (alertId: string) => list<ActionPlaybook>(await request<unknown>(`/alerts/${encodeURIComponent(alertId)}/action-playbooks`), ["playbooks", "data"]),
  actionRuns: async (
      options: { active?: boolean; houseId?: string; sensorId?: string; alertEventId?: string; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (options.active) query.set("active", "true");
      if (options.houseId) query.set("houseId", options.houseId);
      if (options.sensorId) query.set("sensorId", options.sensorId);
      if (options.alertEventId) query.set("alertEventId", options.alertEventId);
      if (options.limit) query.set("limit", String(options.limit));
      return list<ActionRun>(await request<unknown>(
        `/action-runs${query.size ? `?${query}` : ""}`,
        signal ? { signal } : undefined,
      ), ["runs", "data"]);
    },
  startActionRun: async (input: ActionRunStartInput) => entity(await request<ActionRun | { run: ActionRun }>("/action-runs", { method: "POST", body: JSON.stringify(input) }), "run"),
  completeActionRun: async (id: string) => entity(await request<ActionRun | { run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/complete`, { method: "POST" }), "run"),
  cancelActionRun: async (id: string, note?: string) => entity(await request<ActionRun | { run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ note: note ?? null }) }), "run"),
  observations: async (houseId: string) => list<ManualObservation>(await request<unknown>(`/observations?houseId=${encodeURIComponent(houseId)}`), ["observations", "data"]),
  createObservation: async (observation: ManualObservationInput) => observationResponse(await request<ManualObservation | { observation: ManualObservation }>("/observations", { method: "POST", body: JSON.stringify(observation) })),
  updateObservation: async (id: string, patch: ManualObservationPatch) => observationResponse(await request<ManualObservation | { observation: ManualObservation }>(`/observations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })),
  observationRevisions: async (id: string) => list<ObservationRevision>(await request<unknown>(`/observations/${encodeURIComponent(id)}/revisions`), ["revisions", "data"]),
  maintenanceTasks: async (filters: MaintenanceTaskFilters = {}) => {
      const query = new URLSearchParams();
      if (filters.propertyId) query.set("propertyId", filters.propertyId);
      if (filters.houseId) query.set("houseId", filters.houseId);
      if (filters.areaId) query.set("areaId", filters.areaId);
      if (filters.equipmentId) query.set("equipmentId", filters.equipmentId);
      const suffix = query.size ? `?${query.toString()}` : "";
      return completeCollection<MaintenanceTask>(`/maintenance-tasks${suffix}`, ["maintenanceTasks", "data"]);
    },
  createMaintenanceTask: (input: MaintenanceTaskInput) => request<MaintenanceTask>("/maintenance-tasks", { method: "POST", body: JSON.stringify(input) }),
  maintenanceTask: (id: string) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`),
  updateMaintenanceTask: (id: string, patch: MaintenanceTaskPatch) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  maintenanceTaskRevisions: async (id: string) => list<MaintenanceTaskRevision>(await request<unknown>(`/maintenance-tasks/${encodeURIComponent(id)}/revisions`), ["revisions", "data"]),
  deleteMaintenanceTask: (id: string) => request<void>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  staticParameters: async (houseId: string) => list<StaticParameter>(await request<unknown>(`/static-parameters?houseId=${encodeURIComponent(houseId)}`), ["parameters", "staticParameters", "data"]),
  energyOptimization: async (propertyId: string, windowHours = 2) => entity(await request<EnergyOptimizationReport | { report: EnergyOptimizationReport }>(`/properties/${encodeURIComponent(propertyId)}/energy-optimization?windowHours=${encodeURIComponent(windowHours)}`), "report"),
  setupDoctor: async () => entity(await request<SetupDoctorReport | { report: SetupDoctorReport }>("/setup/doctor"), "report"),
  dataExportPreview: async (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => entity(await request<DataExportPreview | { preview: DataExportPreview }>(`/data-export/preview?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`), "preview"),
  dataExportUrl: (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => `${API_BASE}/data-export?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`,
  backupStatus: async () => entity(await request<BackupOperationStatus | { backup: BackupOperationStatus }>("/backups/status"), "backup"),
  requestBackup: async () => entity(await request<BackupOperationStatus | { backup: BackupOperationStatus }>("/backups", { method: "POST" }), "backup"),
  createStaticParameter: (parameter: Omit<StaticParameter, "id">) => request<StaticParameter>("/static-parameters", { method: "POST", body: JSON.stringify(parameter) }),
  integrations: (houseId?: string) => request<IntegrationStatus>(`/integrations/status${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`),
  discoverIntegrations: discoverIntegrationsInBackground,
  resumeIntegrationDiscovery,
  latestIntegrationDiscovery,
  discoverTelegram: (botToken: string, signal?: AbortSignal) => request<TelegramDiscoveryResult>("/integrations/telegram/discover", {
      method: "POST",
      body: JSON.stringify({ botToken }),
      ...(signal ? { signal } : {}),
    }),
  configureTelegram: (configuration: TelegramConfigInput) => request<{ ok: boolean; configured: boolean; integration: IntegrationStatus }>("/integrations/telegram/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  testTelegram: () => request<IntegrationTestResult>("/integrations/telegram/test", { method: "POST" }),
  disconnectTelegram: () => request<{ ok: boolean; integration: IntegrationStatus }>("/integrations/telegram/config", { method: "DELETE" }),
  appleNotesSetup: () => request<AppleNotesSetupMetadata>("/integrations/apple-notes/setup"),
  appleNotesGrants: async () => list<AppleNotesGrantSummary>(await request<unknown>("/integrations/apple-notes/grants"), ["grants", "data"]),
  createAppleNotesGrant: (input: { houseId: string; deviceLabel: string }) => request<AppleNotesGrantCreated>("/integrations/apple-notes/grants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeAppleNotesGrant: (id: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/apple-notes/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  searchLocations: async (query: string, language = "en", signal?: AbortSignal) => (
      await request<{ results: LocationSuggestion[] }>(`/locations/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}`, signal ? { signal } : undefined)
    ).results,
  coordinateDefaults: (latitude: number, longitude: number) => request<CoordinateDefaults>(
      `/locations/defaults?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
    ),
  configureHomeAssistant: (configuration: { houseId: string; url: string; token: string }) => request<{ ok: boolean; configured: boolean; houseId: string; integration: IntegrationStatus }>("/integrations/home-assistant/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  configureTpLink: (configuration: {
    houseId: string;
    connectionId?: string;
    host: string;
  } & (
    { username: string; password: string; credentialSourceConnectionId?: never }
    | { credentialSourceConnectionId: string; username?: never; password?: never }
  )) => request<{ ok: boolean; configured: boolean; created?: boolean; connectionId?: string; houseId?: string; deviceId?: string | null; sourceType?: "hub" | "energy-device" | null; sourceModel?: string | null; sourceAlias?: string | null; integration: IntegrationStatus }>("/integrations/tp-link/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  discoverGree: async (houseId: string) => list<GreeDiscoveredDevice>(
      await request<unknown>("/integrations/gree/discover", {
        method: "POST",
        body: JSON.stringify({ houseId }),
      }),
      ["devices", "data"],
    ),
  configureGree: (configuration: { houseId: string; mac: string }) => request<{
    ok: boolean;
    configured: boolean;
    connectionId: string;
    houseId: string;
    state: HeatPumpState;
    integration: IntegrationStatus;
  }>("/integrations/gree/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectHomeAssistant: (houseId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/home-assistant/config/${encodeURIComponent(houseId)}`, {
      method: "DELETE",
    }),
  disconnectTpLink: (connectionId: string) => request<{ ok: boolean; detachedSensorIds: string[]; integration: IntegrationStatus }>(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    }),
  disconnectGree: (connectionId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/gree/config/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    }),
  heatPumpStates: async (houseId?: string) => list<HeatPumpState>(
      await request<unknown>(`/heat-pumps${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`),
      ["states", "data"],
    ),
  heatPumpHistory: async (
    connectionId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.from) query.set("from", options.from);
    if (options.to) query.set("to", options.to);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return list<HeatPumpState>(
      await request<unknown>(`/heat-pumps/${encodeURIComponent(connectionId)}/history${suffix}`),
      ["states", "data"],
    );
  },
  moveHomeAssistant: (fromHouseId: string, houseId: string) => request<{ ok: boolean; fromHouseId: string; houseId: string; integration: IntegrationStatus }>(`/integrations/home-assistant/config/${encodeURIComponent(fromHouseId)}`, {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  moveTpLink: (connectionId: string, houseId: string) => request<{ ok: boolean; fromHouseId: string; houseId: string; detachedSensorIds: string[]; integration: IntegrationStatus }>(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  testHomeAssistant: (houseId?: string) => request<{ ok: boolean; message?: string }>(`/integrations/home-assistant/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, { method: "POST" }),
  testTpLink: (houseId?: string) => request<{ ok: boolean; message?: string }>(`/integrations/tp-link/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, { method: "POST" }),
  testHomeAssistantDraft: (configuration: { url: string; token: string }) => request<IntegrationTestResult>("/integrations/home-assistant/test-draft", {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  testTpLinkDraft: (configuration: { host: string; username: string; password: string }) => request<IntegrationTestResult>("/integrations/tp-link/test-draft", {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  tpLinkDevices: async (houseId?: string) => list<TpLinkDiscoveredDevice>(
      await request<unknown>(`/integrations/tp-link/devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`),
      ["devices", "data"],
    ),
  tpLinkHistoryExportJobs: () => request<TpLinkHistoryExportJobsResponse>("/integrations/tp-link/history-export/jobs"),
  createTpLinkHistoryExportCanary: (input: {
      sensorId: string;
      metric: "temperature" | "humidity";
      from: string;
      to: string;
    }) => request<{ job: TpLinkHistoryExportJob }>("/integrations/tp-link/history-export/canary", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  retryTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request<unknown>(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    },
  cancelTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request<unknown>(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  sensorDataGaps: async (houseId?: string, limit = 500): Promise<SensorDataGap[]> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (houseId) query.set("houseId", houseId);
      return list<SensorDataGap>(await request<unknown>(`/integrations/sensor-data-gaps?${query}`), ["gaps", "data"]);
    },
  scenarios: async () => list<MockScenario>(await request<unknown>("/mock/scenarios"), ["scenarios", "data"]),
  runScenario: (scenarioId: MockScenario["id"]) => request<{ ok: boolean }>("/mock/scenario", { method: "POST", body: JSON.stringify({ scenarioId }) }),
  measurementDefinitions: async () => (await requestV2<{ definitions: MeasurementDefinition[] }>("/measurement-definitions")).definitions,
  analyticsFindings: (houseId: string, signal?: AbortSignal) => requestV2<DailyAnalyticsFindingsResponse>(
      `/analytics/findings?houseId=${encodeURIComponent(houseId)}`,
      signal ? { signal } : undefined,
    ),
  analyticsCoverage: (input: AnalyticsCoverageRequest, signal?: AbortSignal) => requestV2<AnalyticsCoverageResponse>("/analytics/coverage", {
      method: "POST",
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    }),
  analyticsQuery: (input: AnalyticsQueryRequest, signal?: AbortSignal) => requestV2<AnalyticsQueryResponse>("/analytics/query", {
      method: "POST",
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    }),
};
