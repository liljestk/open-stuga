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
  TenantMemberSummary,
  TenantInvitationCreated,
  TelemetryEvent,
  TelegramConfigInput,
  TelegramDiscoveryResult,
  ThermalIsolationResult,
  ThermalSimulationResult,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import type {
  StugbyDatasetGrant,
  StugbyDeletionReceipt,
  StugbyGrantAudience,
  StugbyInvitation,
  StugbyMember,
  StugbyMemberState,
  StugbyNodeIdentity,
  StugbyRemoteResource,
  StugbyRole,
  StugbyShareGrant,
  StugbySharedProperty,
  StugbySummary,
} from "@climate-twin/stugby-protocol";
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
} from "./spatialLayers";
import { publishAuthEpoch } from "./authEpoch";

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
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredSource[];
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

export interface StugbyListResponse {
  identity: StugbyNodeIdentity;
  publicOrigin: string | null;
  stugbys: StugbySummary[];
}

export interface StugbyInvitationCreated extends StugbyInvitation {
  joinSecret: string;
  joinUrl: string;
}

export interface StugbyLocalPublicationCatalog {
  house: { localHouseId: string; publicationId: string; name: string };
  sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
}

export interface StugbyDetailResponse {
  stugby: StugbySummary;
  members: StugbyMember[];
  invitations: StugbyInvitation[];
  grants: StugbyShareGrant[];
  sharedProperty: StugbySharedProperty | null;
  remoteResources: StugbyRemoteResource[];
  deletionReceipts: StugbyDeletionReceipt[];
  audit: Array<{
    id: number;
    eventType: string;
    actorNodeId: string | null;
    subjectId: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface StugbyRemoteTelemetrySample {
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
  phase: "queued" | "backup" | "pulling" | "applying" | "verifying" | "complete" | "failed" | "rolling-back";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  detail: string | null;
  previousVersion: string;
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

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "/api/v1";
export const API_V2_BASE = API_BASE.replace(/\/v1$/, "/v2");
export const API_REQUEST_TIMEOUT_MS = 30_000;
export const STREAM_STABILITY_DELAY_MS = 750;
export const COLLECTION_PAGE_SIZE = 500;
const SAFE_API_PATH = /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})+$/;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let csrfToken: string | null = null;
const activeRequestControllers = new Set<AbortController>();
let apiRequestGeneration = 0;
export type ApiAuthorizationChange = "changed" | "expired";
const authorizationListeners = new Set<(change: ApiAuthorizationChange) => void>();

export function subscribeToApiAuthorizationChanges(listener: (change: ApiAuthorizationChange) => void): () => void {
  authorizationListeners.add(listener);
  return () => authorizationListeners.delete(listener);
}

function notifyAuthorizationChange(change: ApiAuthorizationChange): void {
  // A session/authorization transition makes the old synchronizer token
  // untrustworthy. The next authenticated /session response supplies a fresh
  // token; unsafe mutations are never retried automatically.
  csrfToken = null;
  for (const listener of authorizationListeners) listener(change);
}

function authorizationChange(message: MessageEvent<string>): ApiAuthorizationChange {
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

function isPollingHeartbeat(value: unknown): value is {
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

function assertSafeApiPath(path: string): void {
  const pathname = path.split("?", 1).at(0) ?? "";
  const containsTraversal = pathname
    .split("/")
    .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (!SAFE_API_PATH.test(path) || containsTraversal) {
    throw new TypeError("Invalid API request path");
  }
}

async function requestFrom<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  assertSafeApiPath(path);
  const requestGeneration = apiRequestGeneration;
  const controller = new AbortController();
  const callerSignal = options?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("The API request timed out", "TimeoutError"));
  }, API_REQUEST_TIMEOUT_MS);
  activeRequestControllers.add(controller);

  try {
    const headers = new Headers(options?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (options?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const method = (options?.method ?? "GET").toUpperCase();
    if (!SAFE_HTTP_METHODS.has(method) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
    else headers.delete("X-CSRF-Token");
    const response = await fetch(`${base}${path}`, {
      ...options,
      credentials: "include",
      signal: controller.signal,
      headers,
    });
    const assertCurrentGeneration = () => {
      if (requestGeneration !== apiRequestGeneration || controller.signal.aborted) {
        throw new DOMException("The authenticated session changed", "AbortError");
      }
    };
    if (!response.ok) {
      if (response.status === 401) csrfToken = null;
      let payload: unknown;
      try { payload = await response.json(); } catch { payload = null; }
      assertCurrentGeneration();
      const apiError = payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
        : undefined;
      const code = typeof apiError?.code === "string" ? apiError.code : null;
      const message = typeof apiError?.message === "string" && apiError.message.trim()
        ? apiError.message
        : `Request failed with HTTP ${response.status}`;
      if (response.status === 401 && path !== "/session" && !path.startsWith("/auth/")) notifyAuthorizationChange("expired");
      else if (response.status === 403 && code === "CSRF_TOKEN_INVALID") notifyAuthorizationChange("changed");
      throw new ApiRequestError(response.status, code, message, apiError?.details);
    }
    if (response.status === 204) {
      assertCurrentGeneration();
      return undefined as T;
    }
    const payload = await response.json() as T;
    assertCurrentGeneration();
    return payload;
  } finally {
    activeRequestControllers.delete(controller);
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

const request = <T,>(path: string, options?: RequestInit) => requestFrom<T>(API_BASE, path, options);
const requestV2 = <T,>(path: string, options?: RequestInit) => requestFrom<T>(API_V2_BASE, path, options);

function list<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

function collectionPagePath(path: string, offset: number): string {
  if (offset === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}limit=${COLLECTION_PAGE_SIZE}&offset=${offset}`;
}

async function completeCollection<T extends { id: string }>(path: string, keys: string[]): Promise<T[]> {
  const result: T[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  while (true) {
    const page = list<T>(await request<unknown>(collectionPagePath(path, offset)), keys);
    let added = 0;
    for (const item of page) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      result.push(item);
      added += 1;
    }
    if (page.length < COLLECTION_PAGE_SIZE) return result;
    if (added === 0) throw new Error(`Collection pagination did not advance for ${path}`);
    offset += page.length;
    if (offset > 1_000_000) throw new Error(`Collection pagination exceeded the supported offset for ${path}`);
  }
}

function entity<T>(value: T | Record<string, T>, key: string): T {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, T>)[key]!
    : value as T;
}

function spatialConfigurationResponse(value: unknown): SpatialLayerConfigurationResponse {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawConfiguration = payload.configuration && typeof payload.configuration === "object"
    ? payload.configuration as Record<string, unknown>
    : {};
  const rawAssignments = Array.isArray(payload.assignments) ? payload.assignments : [];
  const version = typeof rawConfiguration.version === "number" && Number.isInteger(rawConfiguration.version)
    ? rawConfiguration.version
    : typeof payload.version === "number" && Number.isInteger(payload.version) ? payload.version : 0;
  const rawTopology = payload.topology && typeof payload.topology === "object"
    ? payload.topology
    : rawConfiguration.topology && typeof rawConfiguration.topology === "object" ? rawConfiguration.topology : null;
  const topology = rawTopology as SpatialTopology | null;
  return {
    configuration: {
      version,
      enabled: rawConfiguration.enabled !== false,
      config: rawConfiguration.config && typeof rawConfiguration.config === "object" && !Array.isArray(rawConfiguration.config)
        ? rawConfiguration.config as Record<string, unknown>
        : {},
      ...(topology ? { topology } : {}),
      ...(typeof rawConfiguration.updatedAt === "string" ? { updatedAt: rawConfiguration.updatedAt } : {}),
    },
    assignments: rawAssignments.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const assignment = item as Record<string, unknown>;
      if (typeof assignment.engineId !== "string" || typeof assignment.engineVersion !== "string") return [];
      return [{
        engineId: assignment.engineId,
        engineVersion: assignment.engineVersion,
        enabled: assignment.enabled !== false,
        layerIds: Array.isArray(assignment.layerIds) ? assignment.layerIds.filter((id): id is string => typeof id === "string") : [],
      }];
    }),
    ...(topology ? { topology } : {}),
  };
}

function memberSummary(value: TenantMemberSummary): TenantMemberSummary {
  return { ...value, email: value.email.trim().toLowerCase(), grants: Array.isArray(value.grants) ? value.grants : [] };
}

function rememberSession(session: AppSession): AppSession {
  csrfToken = session.authenticated && typeof session.csrfToken === "string" && session.csrfToken
    ? session.csrfToken
    : null;
  return { ...session, availableTenants: [session.tenant] };
}

async function completeAuthentication(promise: Promise<AppSession>): Promise<AppSession> {
  const session = rememberSession(await promise);
  publishAuthEpoch();
  return session;
}

async function updateHouseGeoreference(houseId: string, patch: HouseGeoreferencePatch): Promise<House> {
  const response = await request<House | { house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return "house" in response ? response.house : response;
}

function sensorResponse(value: Sensor | { sensor: Sensor }): Sensor {
  return "sensor" in value ? value.sensor : value;
}

function houseResponse(value: House | { house: House }): House {
  return "house" in value ? value.house : value;
}

function observationResponse(value: ManualObservation | { observation: ManualObservation }): ManualObservation {
  return "observation" in value ? value.observation : value;
}

export const api = {
  session: async () => rememberSession(await request<AppSession>("/session")),
  systemUpdateStatus: () => request<SystemUpdateStatus>("/system/updates"),
  checkSystemUpdates: () => request<SystemUpdateStatus>("/system/updates/check", { method: "POST" }),
  updateSystemUpdateSettings: (settings: SystemUpdateSettings) => request<SystemUpdateStatus>("/system/updates/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
  }),
  installLatestSystemUpdate: () => request<SystemUpdateStatus>("/system/updates/install", { method: "POST" }),
  setupOwner: (input: LocalOwnerSetupInput) => completeAuthentication(request<AppSession>("/auth/setup", {
    method: "POST",
    body: JSON.stringify(input),
  })),
  login: (input: LocalLoginInput) => completeAuthentication(request<AppSession>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  })),
  registerInvitation: (input: LocalInvitationRegistrationInput) => completeAuthentication(request<AppSession>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  })),
  logout: async () => {
    let completed = false;
    try {
      await request<void>("/auth/logout", { method: "POST" });
      completed = true;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
      completed = true;
    } finally {
      csrfToken = null;
    }
    if (completed) publishAuthEpoch();
  },
  stugbys: () => request<StugbyListResponse>("/stugbys"),
  stugby: (id: string) => request<StugbyDetailResponse>(`/stugbys/${encodeURIComponent(id)}`),
  createStugby: (input: { name: string; description?: string | null }) => request<StugbySummary>("/stugbys", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  joinStugby: (input: { coordinatorUrl: string; invitationId: string; joinSecret: string }) => request<StugbySummary>("/stugbys/join", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  createStugbyInvitation: (id: string, input: { role: Exclude<StugbyRole, "steward">; expiresAt?: string }) => request<StugbyInvitationCreated>(
    `/stugbys/${encodeURIComponent(id)}/invitations`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  revokeStugbyInvitation: (id: string, invitationId: string) => request<void>(
    `/stugbys/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: "DELETE" },
  ),
  updateStugbyMember: (id: string, nodeId: string, input: { role: StugbyRole; state: StugbyMemberState }) => request<StugbyMember>(
    `/stugbys/${encodeURIComponent(id)}/members/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  updateStugbyProperty: (id: string, baseRevision: number, property: Pick<StugbySharedProperty,
    "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"
  >) => request<StugbySharedProperty>(`/stugbys/${encodeURIComponent(id)}/property`, {
    method: "PUT",
    body: JSON.stringify({ baseRevision, property }),
  }),
  createStugbyGrant: (id: string, input: {
    localHouseId: string;
    audience: StugbyGrantAudience;
    datasets: StugbyDatasetGrant[];
    expiresAt?: string | null;
  }) => request<StugbyShareGrant>(`/stugbys/${encodeURIComponent(id)}/grants`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  stugbyPublications: (id: string, houseId: string) => request<StugbyLocalPublicationCatalog>(
    `/stugbys/${encodeURIComponent(id)}/publications/${encodeURIComponent(houseId)}`,
  ),
  updateStugbyGrant: (id: string, grantId: string, input: {
    baseRevision: number;
    audience: StugbyGrantAudience;
    datasets: StugbyDatasetGrant[];
    expiresAt: string | null;
  }) => request<StugbyShareGrant>(`/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  revokeStugbyGrant: (id: string, grantId: string) => request<StugbyShareGrant>(
    `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  ),
  republishStugbyGrant: (id: string, grantId: string) => request<{ queued: boolean }>(
    `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/republish`,
    { method: "POST" },
  ),
  syncStugby: (id: string) => request<StugbySummary>(`/stugbys/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  stugbyTelemetry: (id: string, limit = 250) => request<{ samples: StugbyRemoteTelemetrySample[] }>(
    `/stugbys/${encodeURIComponent(id)}/telemetry?limit=${encodeURIComponent(String(limit))}`,
  ),
  properties: () => completeCollection<Property>("/properties", ["properties", "data"]),
  createProperty: async (input: PropertyCreateInput) => entity<Property>(await request<Property | { property: Property }>("/properties", {
    method: "POST",
    body: JSON.stringify(input),
  }), "property"),
  updateProperty: async (id: string, patch: PropertyPatch) => entity<Property>(await request<Property | { property: Property }>(`/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }), "property"),
  deleteProperty: (id: string) => request<void>(`/properties/${encodeURIComponent(id)}`, { method: "DELETE" }),
  propertyElectricity: (propertyId: string) => request<{
    config: PropertyElectricityConfig;
    current: PropertyElectricityPricePoint | null;
    prices: PropertyElectricityPricePoint[];
  }>(`/properties/${encodeURIComponent(propertyId)}/electricity`),
  houseElectricityPrice: (houseId: string, from?: string, to?: string, signal?: AbortSignal) => request<{
    current: HomeElectricityPricePoint | null;
    prices?: HomeElectricityPricePoint[];
  }>(`/houses/${encodeURIComponent(houseId)}/electricity-price${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`, signal ? { signal } : {}),
  houseEnergyCost: async (houseId: string, sensorId: string, from: string, to: string, signal?: AbortSignal) => entity<HomeEnergyCost>(await request<HomeEnergyCost | { cost: HomeEnergyCost }>(
    `/houses/${encodeURIComponent(houseId)}/energy-cost?${new URLSearchParams({ sensorId, from, to })}`,
    signal ? { signal } : {},
  ), "cost"),
  configurePropertyElectricity: (propertyId: string, configuration: PropertyElectricityConfigInput) => request<{ config: PropertyElectricityConfig }>(
    `/properties/${encodeURIComponent(propertyId)}/electricity/config`,
    { method: "PUT", body: JSON.stringify(configuration) },
  ),
  refreshPropertyElectricity: (propertyId: string) => request<{
    config: PropertyElectricityConfig;
    current: PropertyElectricityPricePoint | null;
    prices: PropertyElectricityPricePoint[];
  }>(`/properties/${encodeURIComponent(propertyId)}/electricity/refresh`, { method: "POST" }),
  propertyAreas: (propertyId?: string) => completeCollection<PropertyArea>(propertyId
    ? `/property-areas?propertyId=${encodeURIComponent(propertyId)}`
    : "/property-areas", ["areas", "propertyAreas", "data"]),
  createPropertyArea: async (input: PropertyAreaInput) => entity<PropertyArea>(await request<PropertyArea | { area: PropertyArea }>("/property-areas", {
    method: "POST",
    body: JSON.stringify(input),
  }), "area"),
  updatePropertyArea: async (id: string, patch: PropertyAreaPatch) => entity<PropertyArea>(await request<PropertyArea | { area: PropertyArea }>(`/property-areas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }), "area"),
  deletePropertyArea: (id: string) => request<void>(`/property-areas/${encodeURIComponent(id)}`, { method: "DELETE" }),
  areaEquipment: (propertyId?: string) => completeCollection<AreaEquipment>(propertyId
    ? `/area-equipment?propertyId=${encodeURIComponent(propertyId)}`
    : "/area-equipment", ["equipment", "areaEquipment", "data"]),
  createAreaEquipment: async (input: AreaEquipmentInput) => entity<AreaEquipment>(await request<AreaEquipment | { equipment: AreaEquipment }>("/area-equipment", {
    method: "POST",
    body: JSON.stringify(input),
  }), "equipment"),
  updateAreaEquipment: async (id: string, patch: AreaEquipmentPatch) => entity<AreaEquipment>(await request<AreaEquipment | { equipment: AreaEquipment }>(`/area-equipment/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }), "equipment"),
  deleteAreaEquipment: (id: string) => request<void>(`/area-equipment/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
  sensors: async (houseId: string) => list<Sensor>(await request<unknown>(`/sensors?houseId=${encodeURIComponent(houseId)}`), ["sensors", "data"]),
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
  discoverIntegrations: (houseId?: string, tpLinkCredentials?: { username: string; password: string }) => request<IntegrationDiscoveryResult>("/integrations/discover", {
    method: "POST",
    ...(houseId || tpLinkCredentials ? { body: JSON.stringify({
      ...(houseId ? { houseId } : {}),
      ...(tpLinkCredentials ? {
        tpLinkUsername: tpLinkCredentials.username,
        tpLinkPassword: tpLinkCredentials.password,
      } : {}),
    }) } : {}),
  }),
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
  configureTpLink: (configuration: { houseId: string; connectionId?: string; host: string; username: string; password: string }) => request<{ ok: boolean; configured: boolean; connectionId?: string; houseId?: string; integration: IntegrationStatus }>("/integrations/tp-link/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectHomeAssistant: (houseId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/home-assistant/config/${encodeURIComponent(houseId)}`, {
    method: "DELETE",
  }),
  disconnectTpLink: (connectionId: string) => request<{ ok: boolean; detachedSensorIds: string[]; integration: IntegrationStatus }>(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
  }),
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
  measurementSnapshot: async (houseId: string) => (await requestV2<{ snapshot: { sensorId: string; measurements: Record<string, MeasurementSample> }[] }>(
    `/measurements/snapshot?houseId=${encodeURIComponent(houseId)}`,
  )).snapshot,
  measurementHistoryPage: async (
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
  },
  measurementHistory: async (sensorId: string, metric: string, from: string, to: string, limit = 500, signal?: AbortSignal) => (
    await api.measurementHistoryPage(sensorId, metric, from, to, limit, undefined, signal)
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
