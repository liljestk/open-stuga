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
} from "../../spatialLayers";
import { publishAuthEpoch } from "../../authEpoch";
import { API_BASE, API_V2_BASE, STREAM_STABILITY_DELAY_MS, authorizationChange, isPollingHeartbeat, notifyAuthorizationChange } from "./part-02";

export function subscribeToSpatialLayerEvents(
  requestedScope: string | { kind: "house" | "property"; id: string },
  onSnapshot: (event: SpatialLayerSnapshotEvent) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const scope = typeof requestedScope === "string" ? { kind: "house" as const, id: requestedScope } : requestedScope;
  const query = new URLSearchParams({ scopeKind: scope.kind, scopeId: scope.id });
  const source = new EventSource(`${API_BASE}/layers/events?${query.toString()}`, { withCredentials: true });
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const consume = (message: MessageEvent<string>) => {
    try {
      const event = spatialLayerSnapshotEvent(JSON.parse(message.data) as unknown);
      if (event && event.scope.kind === scope.kind && event.scope.id === scope.id) onSnapshot(event);
    } catch {
      // Experimental engines may be upgraded independently. Ignore malformed
      // notifications and retain the last validated snapshot.
    }
  };
  source.onopen = () => {
    onOpen?.();
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      onState("live");
    }, STREAM_STABILITY_DELAY_MS);
  };
  source.onerror = () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    onState("reconnecting");
  };
  source.onmessage = consume;
  source.addEventListener("spatial-layer-snapshot", (message) => consume(message as MessageEvent<string>));
  source.addEventListener("authorization", (message) => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    source.close();
  };
}

export function subscribeToMeasurementEvents(
  onSample: (sample: MeasurementSample) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const source = new EventSource(`${API_V2_BASE}/measurements/events`, { withCredentials: true });
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const consume = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as MeasurementSample | { data?: MeasurementSample };
      const sample = "data" in parsed && parsed.data ? parsed.data : parsed as MeasurementSample;
      if (sample && typeof sample.sensorId === "string" && typeof sample.metric === "string" && Number.isFinite(sample.value)) onSample(sample);
    } catch {
      // A malformed sample is ignored; the stream remains connected.
    }
  };
  const consumeHeartbeat = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as unknown;
      if (!isPollingHeartbeat(parsed)) return;
      if (stabilityTimer !== null) clearTimeout(stabilityTimer);
      stabilityTimer = null;
      onState("reconnecting");
    } catch {
      // A malformed heartbeat is ignored; EventSource will still report disconnects.
    }
  };
  source.onopen = () => {
    onOpen?.();
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      onState("live");
    }, STREAM_STABILITY_DELAY_MS);
  };
  source.onerror = () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    onState("reconnecting");
  };
  source.onmessage = consume;
  source.addEventListener("measurement", (message) => consume(message as MessageEvent<string>));
  source.addEventListener("heartbeat", (message) => consumeHeartbeat(message as MessageEvent<string>));
  source.addEventListener("authorization", (message) => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    source.close();
  };
}

export function subscribeToEvents(
  onEvent: (event: TelemetryEvent) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const source = new EventSource(`${API_BASE}/events`, { withCredentials: true });
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const consume = (message: MessageEvent<string>, forcedType?: TelemetryEvent["type"]) => {
    try {
      const parsed = JSON.parse(message.data) as TelemetryEvent | TelemetryEvent["data"];
      const payload = parsed && typeof parsed === "object" && "type" in parsed && "data" in parsed
        ? parsed.data
        : parsed;
      if (forcedType === "heartbeat" && isPollingHeartbeat(payload)) {
        if (stabilityTimer !== null) clearTimeout(stabilityTimer);
        stabilityTimer = null;
        onState("reconnecting");
      }
      if (parsed && typeof parsed === "object" && "type" in parsed && "data" in parsed) onEvent(parsed as TelemetryEvent);
      else if (forcedType) onEvent({ type: forcedType, data: parsed as TelemetryEvent["data"] } as TelemetryEvent);
    } catch {
      // A malformed event is ignored; the stream remains connected.
    }
  };
  source.onopen = () => {
    onOpen?.();
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      onState("live");
    }, STREAM_STABILITY_DELAY_MS);
  };
  source.onerror = () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    onState("reconnecting");
  };
  source.onmessage = (message) => consume(message);
  (["reading", "alert", "integration", "weather", "mutation", "heartbeat"] as const).forEach((type) => {
    source.addEventListener(type, (message) => consume(message as MessageEvent<string>, type));
  });
  source.addEventListener("authorization", (message) => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    source.close();
  };
}
