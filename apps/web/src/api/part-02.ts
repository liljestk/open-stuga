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



export const apiPart02 = {
  deleteAreaEquipment: (id: string) => request<void>(`/area-equipment/${encodeURIComponent(id)}`, { method: "DELETE" }),
  equipmentAttachments: async (equipmentId: string) => list<EquipmentAttachment>(
      await request<unknown>(`/area-equipment/${encodeURIComponent(equipmentId)}/attachments`),
      ["attachments", "data"],
    ),
  uploadEquipmentAttachment: async (equipmentId: string, input: EquipmentAttachmentUploadInput) => entity<EquipmentAttachment>(
      await request<EquipmentAttachment | { attachment: EquipmentAttachment }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/attachments`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      "attachment",
    ),
  equipmentAttachmentUrl: (equipmentId: string, attachmentId: string) => (
      `${API_BASE}/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`
    ),
  deleteEquipmentAttachment: (equipmentId: string, attachmentId: string) => request<void>(
      `/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    ),
  equipmentLinks: async (equipmentId: string) => list<EquipmentLink>(
      await request<unknown>(`/area-equipment/${encodeURIComponent(equipmentId)}/links`),
      ["links", "data"],
    ),
  createEquipmentLink: async (equipmentId: string, input: EquipmentLinkInput) => entity<EquipmentLink>(
      await request<EquipmentLink | { link: EquipmentLink }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/links`,
        { method: "POST", body: JSON.stringify(input) },
      ),
      "link",
    ),
  updateEquipmentLink: async (equipmentId: string, linkId: string, patch: EquipmentLinkPatch) => entity<EquipmentLink>(
      await request<EquipmentLink | { link: EquipmentLink }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
      "link",
    ),
  deleteEquipmentLink: (equipmentId: string, linkId: string) => request<void>(
      `/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`,
      { method: "DELETE" },
    ),
  trackedEquipment: async (propertyId: string) => list<TrackedEquipmentState>(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/tracked-equipment`),
      ["equipment", "data"],
    ),
  trackingCapabilities: () => request<TrackingCapabilities>("/tracking/capabilities"),
  trackingProfiles: () => request<TrackingProfileManifest>("/tracking/profiles"),
  trackingEndpoints: async (propertyId: string) => list<TrackingEndpoint>(
      await request<unknown>(`/tracking/endpoints?propertyId=${encodeURIComponent(propertyId)}`),
      ["endpoints", "data"],
    ),
  enrollTrackingEndpoint: async (input: TrackingEndpointEnrollmentInput) => entity<TrackingEndpoint>(
    await request<TrackingEndpoint | { endpoint: TrackingEndpoint }>(
      "/tracking/endpoints",
      { method: "POST", body: JSON.stringify(input) },
    ),
    "endpoint",
  ),
  bindTrackingEndpoint: async (
    equipmentId: string,
    endpointId: string,
    observerId?: string,
  ) => entity<EquipmentTrackingBinding>(
      await request<EquipmentTrackingBinding | { binding: EquipmentTrackingBinding }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`,
        {
          method: "POST",
          body: JSON.stringify({ endpointId, ...(observerId ? { observerId } : {}) }),
        },
      ),
      "binding",
    ),
  unbindTrackingEndpoint: async (equipmentId: string) => (
      await request<{ binding: EquipmentTrackingBinding | null }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`,
        { method: "DELETE" },
      )
    ).binding,
  trackingMapSnapshot: (propertyId: string) => request<TrackingMapSnapshot>(
      `/properties/${encodeURIComponent(propertyId)}/tracking-map-snapshot`,
    ),
  propertyNotes: (propertyId?: string) => completeCollection<PropertyNote>(propertyId
      ? `/property-notes?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-notes", ["notes", "propertyNotes", "data"]),
  createPropertyNote: async (input: PropertyNoteInput) => entity<PropertyNote>(await request<PropertyNote | { note: PropertyNote }>("/property-notes", {
      method: "POST",
      body: JSON.stringify(input),
    }), "note"),
  updatePropertyNote: async (id: string, patch: PropertyNotePatch) => entity<PropertyNote>(await request<PropertyNote | { note: PropertyNote }>(`/property-notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }), "note"),
  deletePropertyNote: (id: string) => request<void>(`/property-notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  tenantMembers: async (): Promise<TenantMembersResponse> => {
      const response = await request<Partial<TenantMembersResponse>>("/tenant/members");
      return {
        members: Array.isArray(response.members) ? response.members.map(memberSummary) : [],
        invitations: Array.isArray(response.invitations) ? response.invitations.map(memberSummary) : [],
      };
    },
  inviteGuest: async (email: string): Promise<TenantInvitationCreated> => {
      const response = await request<TenantInvitationCreated>("/tenant/members", {
        method: "POST",
        body: JSON.stringify({ email, role: "guest" }),
      });
      return { ...response, invitation: memberSummary(response.invitation) };
    },
  updateMemberAccess: async (email: string, grants: GuestAccessGrant[]) => {
      const response = await request<TenantMemberSummary | { member: TenantMemberSummary }>(`/tenant/members/${encodeURIComponent(email)}/access`, {
        method: "PUT",
        body: JSON.stringify({ grants }),
      });
      return memberSummary(entity(response, "member"));
    },
  removeTenantMember: (email: string) => request<void>(`/tenant/members/${encodeURIComponent(email.trim().toLowerCase())}`, { method: "DELETE" }),
  houses: async () => list<House>(await request<unknown>("/houses"), ["houses", "data"]),
  createHouse: async (house: CreateHouseInput) => houseResponse(await request<House | { house: House }>("/houses", {
      method: "POST",
      body: JSON.stringify(house),
    })),
  updateHouse: async (houseId: string, patch: HousePatch) => houseResponse(await request<House | { house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })),
  deleteHouse: (houseId: string) => request<void>(`/houses/${encodeURIComponent(houseId)}`, { method: "DELETE" }),
  openingStates: (houseId: string, at?: string, signal?: AbortSignal) => request<{ snapshot: OpeningStateSnapshot; observations: OpeningStateObservation[] }>(
      `/houses/${encodeURIComponent(houseId)}/opening-states${at ? `?at=${encodeURIComponent(at)}` : ""}`,
      signal ? { signal } : undefined,
    ),
  openingStateHistory: async (
      houseId: string,
      from: string,
      to: string,
      limit = 10_000,
      signal?: AbortSignal,
    ): Promise<OpeningStateObservation[]> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await request<{
        snapshot: OpeningStateSnapshot;
        observations: OpeningStateObservation[];
        history?: OpeningStateObservation[];
      }>(`/houses/${encodeURIComponent(houseId)}/opening-states?${query}`, signal ? { signal } : undefined);
      return result.history ?? [];
    },
  recordOpeningState: async (houseId: string, observation: Omit<OpeningStateObservationInput, "observedAt"> & { observedAt?: string }) => {
      const response = await request<OpeningStateObservation | { observation: OpeningStateObservation }>(`/houses/${encodeURIComponent(houseId)}/opening-states`, { method: "POST", body: JSON.stringify(observation) });
      return "observation" in response ? response.observation : response;
    },
  sensors: async (houseId?: string) => list<Sensor>(await request<unknown>(
      houseId === undefined ? "/sensors" : `/sensors?houseId=${encodeURIComponent(houseId)}`,
    ), ["sensors", "data"]),
  snapshot: async (houseId: string) => list<SensorSnapshot>(await request<unknown>(`/snapshot?houseId=${encodeURIComponent(houseId)}`), ["snapshot", "sensors", "data"]),
  readings: async (sensorId: string, from: string, to: string, limit = 500) => list<Reading>(
      await request<unknown>(`/readings?sensorId=${encodeURIComponent(sensorId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),
      ["readings", "data"],
    ),
  forecast: async (sensorId: string, horizonMinutes = 360) => list<ForecastPoint>(
      await request<unknown>(`/forecast?sensorId=${encodeURIComponent(sensorId)}&horizonMinutes=${horizonMinutes}`),
      ["forecast", "points", "data"],
    ),
  updateHouseGeoreference,
  updateHouseLocation: (houseId: string, location: HouseLocation | null) => updateHouseGeoreference(houseId, { location }),
  houseWeather: async (houseId: string, hours = 48, signal?: AbortSignal) => {
      const response = await request<HouseWeather | { weather: HouseWeather }>(
        `/houses/${encodeURIComponent(houseId)}/weather?hours=${hours}`,
        signal ? { signal } : undefined,
      );
      return "weather" in response ? response.weather : response;
    },
  outdoorTemperatureHistory: async (
      houseId: string,
      from: string,
      to: string,
      limit = 20_000,
      signal?: AbortSignal,
    ): Promise<OutdoorTemperatureHistoryPage> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await requestV2<Partial<Omit<OutdoorTemperatureHistoryPage, "samples">> & {
        samples: OutdoorTemperatureSample[];
      }>(`/houses/${encodeURIComponent(houseId)}/outdoor-temperature/history?${query}`, signal ? { signal } : undefined);
      return {
        samples: result.samples,
        from: result.from ?? from,
        to: result.to ?? to,
        truncated: result.truncated ?? result.samples.length >= limit,
      };
    },
  updateFloor: (houseId: string, floorId: string, floor: House["floors"][number]) => request<House["floors"][number]>(`/houses/${encodeURIComponent(houseId)}/floors/${encodeURIComponent(floorId)}`, { method: "PUT", body: JSON.stringify(floor) }),
  createSensor: async (sensor: CreateSensorInput) => sensorResponse(await request<Sensor | { sensor: Sensor }>("/sensors", {
      method: "POST",
      body: JSON.stringify(sensor),
    })),
  updateSensor: async (sensorId: string, sensor: SensorPatch) => sensorResponse(await request<Sensor | { sensor: Sensor }>(`/sensors/${encodeURIComponent(sensorId)}`, {
      method: "PATCH",
      body: JSON.stringify(sensor),
    })),
  deleteSensor: (sensorId: string) => request<void>(`/sensors/${encodeURIComponent(sensorId)}`, { method: "DELETE" }),
  sensorLabel: async (sensorId: string) => entity(await request<SensorLabelDescriptor | { label: SensorLabelDescriptor }>(`/sensors/${encodeURIComponent(sensorId)}/label`), "label"),
  bulkSensorMappings: (houseId: string, mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>) => request<{ sensors: Sensor[] }>("/setup/bulk-sensor-mappings", {
      method: "POST",
      body: JSON.stringify({ houseId, mappings }),
    }),
  alertRules: async () => list<AlertRule>(await request<unknown>("/alert-rules"), ["rules", "alertRules", "data"]),
  createAlertRule: (rule: Omit<AlertRule, "id">) => request<AlertRule>("/alert-rules", { method: "POST", body: JSON.stringify(rule) }),
};
