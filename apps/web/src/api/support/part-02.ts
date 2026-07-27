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
import type { StugubyLocalInvitation, StugubyLocalMember, StugubyPropertyAdoption } from "./part-01";

export interface StugubyHomeProjection {
  stugubyId: string;
  authorityNodeId: string;
  publicationId: string;
  localHouseId: string;
  editPolicy: "read-only" | "editable";
  recoveryMode: "none" | "full";
  recoveryState: "not-enabled" | "syncing" | "ready" | "incomplete";
  designatedSuccessorNodeId: string | null;
  recoverySyncedThrough: string | null;
  authorityEpoch: number;
  detachedAt: string | null;
  updatedAt: string;
}

export interface StugubyAuthorityTransfer {
  id: string;
  stugubyId: string;
  scope: "property" | "home";
  resourceId: string;
  fromNodeId: string;
  toNodeId: string;
  fromEpoch: number;
  toEpoch: number;
  status: "prepared" | "completed" | "cancelled";
  snapshotHash: string;
  requestedAt: string;
  completedAt: string | null;
}

export interface StugubyDetailResponse {
  stuguby: StugubySummary;
  members: StugubyLocalMember[];
  invitations: StugubyLocalInvitation[];
  grants: StugubyShareGrant[];
  sharedProperty: StugubySharedProperty | null;
  propertyAdoption: StugubyPropertyAdoption | null;
  propertyConflicts: StugubyPropertyConflict[];
  propertyCommandCounts: { pending: number; conflicts: number };
  homeCommandCounts: { pending: number; conflicts: number };
  homeProjections: StugubyHomeProjection[];
  authorityTransfers: StugubyAuthorityTransfer[];
  remoteResources: StugubyRemoteResource[];
  deletionReceipts: StugubyDeletionReceipt[];
  audit: Array<{
    id: number;
    eventType: string;
    actorNodeId: string | null;
    subjectId: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface StugubyRemoteTelemetrySample {
  authorityNodeId: string;
  publicationId: string;
  sensorPublicationId: string;
  metricId: string;
  timestamp: string;
  value: number;
  quality: string;
  correctionOf: string | null;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type SystemUpdateDay = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface SystemUpdateSettings {
  mode: "manual" | "automatic";
  includePrereleases: boolean;
  checkIntervalHours: 6 | 12 | 24 | 168;
  updateTime: string;
  updateDays: SystemUpdateDay[];
  timezone: string;
}

export interface SystemRelease {
  version: string;
  tagName: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
}

export interface SystemUpdateOperation {
  id: string;
  version: string;
  tagName: string;
  phase: "queued" | "preparing" | "backup" | "pulling" | "applying" | "verifying" | "complete" | "failed" | "rolling-back";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  phaseStartedAt: string;
  detail: string | null;
  previousVersion: string;
  activity: Array<{
    phase: SystemUpdateOperation["phase"];
    at: string;
    detail: string;
  }>;
}

export interface SystemUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  latestRelease: SystemRelease | null;
  releases: SystemRelease[];
  lastCheckedAt: string | null;
  checkError: string | null;
  settings: SystemUpdateSettings;
  nextUpdateWindowAt: string | null;
  capability: {
    available: boolean;
    runtime: "docker" | "raspberry-pi" | null;
    agentLastSeenAt: string | null;
    reason: "ready" | "agent-not-connected" | "not-configured";
  };
  operation: SystemUpdateOperation | null;
}

export type SystemUpdateLiveStatus = Pick<
  SystemUpdateStatus,
  "currentVersion" | "latestVersion" | "updateAvailable" | "capability" | "operation"
>;

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "/api/v1";

export const API_V2_BASE = API_BASE.replace(/\/v1$/, "/v2");

export const API_REQUEST_TIMEOUT_MS = 30_000;

export const STREAM_STABILITY_DELAY_MS = 750;

export const COLLECTION_PAGE_SIZE = 500;

export const SAFE_API_PATH = /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})+$/;

export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const apiClientState = { csrfToken: null as string | null };

export const activeRequestControllers = new Set<AbortController>();

export let apiRequestGeneration = 0;

export type ApiAuthorizationChange = "changed" | "expired";

export const authorizationListeners = new Set<(change: ApiAuthorizationChange) => void>();

export function subscribeToApiAuthorizationChanges(listener: (change: ApiAuthorizationChange) => void): () => void {
  authorizationListeners.add(listener);
  return () => authorizationListeners.delete(listener);
}

export function notifyAuthorizationChange(change: ApiAuthorizationChange): void {
  // A session/authorization transition makes the old synchronizer token
  // untrustworthy. The next authenticated /session response supplies a fresh
  // token; unsafe mutations are never retried automatically.
  apiClientState.csrfToken = null;
  for (const listener of authorizationListeners) listener(change);
}

export function authorizationChange(message: MessageEvent<string>): ApiAuthorizationChange {
  try {
    const parsed = JSON.parse(message.data) as unknown;
    const payload = parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data?: unknown }).data
      : parsed;
    const status = payload && typeof payload === "object" && "status" in payload
      ? (payload as { status?: unknown }).status
      : null;
    if (status === "expired" || status === "changed") return status;
    const reason = payload && typeof payload === "object" && "reason" in payload
      ? String((payload as { reason?: unknown }).reason).toLowerCase()
      : "";
    return reason.includes("expired") || reason.includes("revoked") ? "expired" : "changed";
  } catch {
    return "changed";
  }
}

/** Abort requests that belong to a session whose authorization just changed. */
export function cancelPendingApiRequests(): void {
  apiRequestGeneration += 1;
  for (const controller of activeRequestControllers) {
    controller.abort(new DOMException("The authenticated session changed", "AbortError"));
  }
  activeRequestControllers.clear();
}

export function isPollingHeartbeat(value: unknown): value is {
  mode: "polling" | "polling-compatibility";
  pollAfterMs?: number;
  reconnectAfterMs?: number;
} {
  if (!value || typeof value !== "object") return false;
  const heartbeat = value as { mode?: unknown; continuous?: unknown; finite?: unknown };
  return heartbeat.mode === "polling"
    || heartbeat.mode === "polling-compatibility"
    || heartbeat.continuous === false
    || heartbeat.finite === true;
}

export function assertSafeApiPath(path: string): void {
  const pathname = path.split("?", 1).at(0) ?? "";
  const containsTraversal = pathname
    .split("/")
    .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (!SAFE_API_PATH.test(path) || containsTraversal) {
    throw new TypeError("Invalid API request path");
  }
}
