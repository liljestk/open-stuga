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

/** Independent, nullable updates for a house's real-world placement. */
export interface HouseGeoreferencePatch {
  location?: HouseLocation | null;
  mapPlacement?: HouseMapPlacement | null;
  orientationDegrees?: number | null;
}

export type CreateHouseInput = Pick<House, "name" | "timezone" | "floors">
  & Partial<Pick<House, "propertyId" | "location" | "mapPlacement" | "orientationDegrees">>;

export type HousePatch = Partial<Pick<House, "propertyId" | "name" | "timezone" | "floors">> & HouseGeoreferencePatch;

export type CreateSensorInput = Omit<Sensor, "id">;

export type SensorPatch = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  tpLinkDeviceId?: string | null;
  tpLinkConnectionId?: string | null;
};

export interface MaintenanceTaskFilters {
  propertyId?: string;
  houseId?: string;
  areaId?: string;
  equipmentId?: string;
}

export interface HistoricalImportResult {
  submitted: number;
  accepted: number;
  ignoredDuplicates: number;
}

export interface SensorMeasurementPage {
  samples: MeasurementSample[];
  nextCursor: string | null;
}

export interface MeasurementHistoryPage {
  samples: MeasurementSample[];
  from: string;
  to: string;
  bucketSeconds: number | null;
  truncated: boolean;
}

export interface OutdoorTemperatureHistoryPage {
  samples: OutdoorTemperatureSample[];
  from: string;
  to: string;
  truncated: boolean;
}

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface TpLinkDiscoveredSource {
  host: string;
  model: string;
  alias: string | null;
  sourceType?: "hub" | "energy-device";
  deviceId?: string | null;
  configuredConnectionId?: string;
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredSource[];
  gree?: GreeDiscoveredDevice[];
  warnings: string[];
}

export type TpLinkHistoryExportProvider = "appium" | "private-cloud";

export type TpLinkHistoryExportJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting-email"
  | "needs-attention"
  | "completed"
  | "failed"
  | "cancelled";

export interface TpLinkHistoryExportJob {
  id: string;
  canary: boolean;
  provider: TpLinkHistoryExportProvider;
  sensorId: string;
  deviceId: string;
  deviceName: string;
  timeZone: string;
  metric: string;
  expectedRecipient: string | null;
  from: string;
  to: string;
  intervalMinutes: number;
  status: TpLinkHistoryExportJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  submittedAt: string | null;
  mailboxMessageId: string | null;
  sourceArtifactSha256: string | null;
  sourceArtifactBytes: number | null;
  parserVersion: string | null;
  sourceSchemaSignature: string | null;
  stagedSampleCount: number;
  consumedSampleCount: number;
  lastError: string | null;
  attentionReason: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TpLinkHistoryExportJobsResponse {
  enabled: boolean;
  automation: {
    operational: boolean;
    canaryPending: boolean;
    waitingEmails: number;
    maxPendingEmails: number;
    exportIntervalMinutes: 1 | 15 | 30 | 60 | 360 | 720 | 1440;
    canaryApprovalMaxAgeDays: number;
    mailbox: {
      lastSuccessfulPollAt: string | null;
      lastErrorAt: string | null;
      lastErrorCode: string | null;
      consecutiveFailures: number;
      budgetExhaustions: number;
    };
    lastWorkerSeenAt: string | null;
    deploymentFingerprintPrefix: string | null;
  };
  jobs: TpLinkHistoryExportJob[];
}

export interface LocationSuggestion {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  source: "open-meteo-geocoding";
  confidence: "high" | "medium";
}

export interface CoordinateDefaults {
  timezone: string;
  source: "open-meteo-coordinate";
}

export interface AppleNotesSetupMetadata {
  available?: boolean;
  snapshotPath?: string;
  capturePath?: string;
  limitations?: string[];
  steps?: string[];
}

export interface TenantMembersResponse {
  members: TenantMemberSummary[];
  invitations: TenantMemberSummary[];
}

export interface StugubyListResponse {
  identity: StugubyNodeIdentity;
  publicOrigin: string | null;
  suggestedPublicOrigin?: string | null;
  publicOriginConfigurable?: boolean;
  stugubys: StugubySummary[];
}

export interface StugubyLocalMember extends StugubyMember {
  localLabel: string | null;
}

export interface StugubyLocalInvitation extends StugubyInvitation {
  localLabel: string | null;
}

export type CloudflareSetupPhase =
  | "awaiting-approval"
  | "queued"
  | "provisioning"
  | "applying"
  | "verifying"
  | "complete"
  | "failed";

export interface CloudflareSetupOperation {
  id: string;
  mode: "remote-ui" | "stuguby-coordinator";
  hostname: string;
  phase: CloudflareSetupPhase;
  requestedAt: string;
  completedAt: string | null;
  detail: string | null;
}

export interface CloudflareSetupStatus {
  canConfigure: boolean;
  localConfigureUrl: string;
  capability: {
    available: boolean;
    agentLastSeenAt: string | null;
    reason: "ready" | "agent-not-connected" | "not-configured" | "agent-upgrade-required";
  };
  configuration: {
    configured: boolean;
    mode: "remote-ui" | "stuguby-coordinator" | null;
    hostname: string | null;
    suggestedZone: string | null;
    accountIdKnown: boolean;
    zoneIdKnown: boolean;
    oauthClientConfigured: boolean;
    runtimeTokenAvailable: boolean;
    ownerEmail: string | null;
  };
  operation: CloudflareSetupOperation | null;
}

export interface CloudflareSetupStartInput {
  mode: "remote-ui" | "stuguby-coordinator";
  hostname: string;
  zone: string;
  ownerEmail: string;
  accountId: string | null;
  zoneId: string | null;
  oauthClientToken: string | null;
  runtimeToken: string | null;
}

export interface CloudflareSetupStartResult {
  operation: CloudflareSetupOperation;
  authorizationUrl: string;
}

export interface StugubyInvitationCreated extends StugubyLocalInvitation {
  joinSecret: string;
  joinUrl: string;
}

export interface StugubyLocalPublicationCatalog {
  house: { localHouseId: string; publicationId: string; name: string };
  sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
}

export interface StugubyPropertyAdoption {
  stugubyId: string;
  localPropertyId: string;
  state: "adopted" | "detached";
  adoptedAt: string;
  detachedAt: string | null;
  lastMaterializedRevision: number;
}
