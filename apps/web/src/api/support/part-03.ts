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
import { recordApiError } from "../../bugReportDiagnostics";
import { API_RUNTIME_VERSION_HEADER, assertApiRuntimeVersion } from "../../apiRuntimeVersion";
import type { HouseGeoreferencePatch } from "./part-01";
import { API_BASE, API_REQUEST_TIMEOUT_MS, API_V2_BASE, ApiRequestError, COLLECTION_PAGE_SIZE, SAFE_HTTP_METHODS, activeRequestControllers, apiClientState, apiRequestGeneration, assertSafeApiPath, authorizationChange, notifyAuthorizationChange } from "./part-02";
import type { SystemUpdateLiveStatus } from "./part-02";

export async function requestFrom<T>(
  base: string,
  path: string,
  options?: RequestInit,
  timeoutMs = API_REQUEST_TIMEOUT_MS,
): Promise<T> {
  assertSafeApiPath(path);
  const requestGeneration = apiRequestGeneration;
  const controller = new AbortController();
  const callerSignal = options?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("The API request timed out", "TimeoutError"));
  }, timeoutMs);
  activeRequestControllers.add(controller);

  try {
    const headers = new Headers(options?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (options?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const method = (options?.method ?? "GET").toUpperCase();
    if (!SAFE_HTTP_METHODS.has(method) && apiClientState.csrfToken) headers.set("X-CSRF-Token", apiClientState.csrfToken);
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
    assertCurrentGeneration();
    const responseHeadersAvailable = typeof response.headers?.get === "function";
    const runtimeVersion = responseHeadersAvailable
      ? response.headers.get(API_RUNTIME_VERSION_HEADER)
      : null;
    const apiVersionReported = responseHeadersAvailable && response.headers.get("x-api-version") !== null;
    assertApiRuntimeVersion(runtimeVersion, apiVersionReported);
    if (!response.ok) {
      if (response.status === 401) apiClientState.csrfToken = null;
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
      recordApiError(response.status, code, message);
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

export const request = <T,>(path: string, options?: RequestInit, timeoutMs?: number) => requestFrom<T>(API_BASE, path, options, timeoutMs);

export const requestV2 = <T,>(path: string, options?: RequestInit, timeoutMs?: number) => requestFrom<T>(API_V2_BASE, path, options, timeoutMs);

function objectList<T extends object>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API response: ${label} must be an array`);
  if (value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`Invalid API response: ${label} contains a non-object item`);
  }
  return value as T[];
}

export function list<T extends object>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return objectList<T>(value, "collection");
  if (value && typeof value === "object") {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (candidate !== undefined) return objectList<T>(candidate, key);
    }
  }
  throw new Error(`Invalid API response: expected an array in ${keys.join(", ")}`);
}

export function collectionPagePath(path: string, offset: number): string {
  if (offset === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}limit=${COLLECTION_PAGE_SIZE}&offset=${offset}`;
}

export async function completeCollection<T extends { id: string }>(path: string, keys: string[]): Promise<T[]> {
  const result: T[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  while (true) {
    const page = list<T>(await request<unknown>(collectionPagePath(path, offset)), keys);
    let added = 0;
    for (const item of page) {
      if (typeof item.id !== "string" || !item.id) {
        throw new Error(`Invalid API response: collection item for ${path} has no id`);
      }
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

export function entity<T>(value: T | Record<string, T>, key: string): T {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, T>)[key]!
    : value as T;
}

export function spatialConfigurationResponse(value: unknown): SpatialLayerConfigurationResponse {
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

export function memberSummary(value: TenantMemberSummary): TenantMemberSummary {
  return { ...value, email: value.email.trim().toLowerCase(), grants: Array.isArray(value.grants) ? value.grants : [] };
}

export function rememberSession(session: AppSession & { systemVersion?: unknown }): AppSession {
  assertApiRuntimeVersion(typeof session.systemVersion === "string" ? session.systemVersion : null, true);
  apiClientState.csrfToken = session.authenticated && typeof session.csrfToken === "string" && session.csrfToken
    ? session.csrfToken
    : null;
  return { ...session, availableTenants: [session.tenant] };
}

export async function completeAuthentication(promise: Promise<AppSession>): Promise<AppSession> {
  const session = rememberSession(await promise);
  publishAuthEpoch();
  return session;
}

export async function updateHouseGeoreference(houseId: string, patch: HouseGeoreferencePatch): Promise<House> {
  const response = await request<House | { house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return "house" in response ? response.house : response;
}

export function sensorResponse(value: Sensor | { sensor: Sensor }): Sensor {
  return "sensor" in value ? value.sensor : value;
}

export function houseResponse(value: House | { house: House }): House {
  return "house" in value ? value.house : value;
}

export function observationResponse(value: ManualObservation | { observation: ManualObservation }): ManualObservation {
  return "observation" in value ? value.observation : value;
}

const systemUpdateWorkflowPhases = new Set<string>([
  "preparing", "backup-active", "backup-complete", "host-stage-requested", "host-stage-queueing",
  "host-staging", "awaiting-restart", "restarting", "host-verifying", "host-complete",
  "application-queueing", "application-queued", "application-updating", "application-failed",
  "complete", "failed", "cancelled", "returned", "recovery-needed",
  // Pre-v2 development aliases remain readable during a rolling local upgrade.
  "queued", "backing-up", "staging-host", "activating-host", "verifying-host",
  "updating-application", "verifying-application", "rolling-back-application", "host-returned",
]);

export function subscribeToSystemUpdateEvents(
  onStatus: (status: SystemUpdateLiveStatus) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(`${API_BASE}/system/updates/events`, { withCredentials: true });
  const consume = (message: MessageEvent<string>) => {
    try {
      const status = JSON.parse(message.data) as SystemUpdateLiveStatus;
      if (
        !status
        || typeof status !== "object"
        || typeof status.currentVersion !== "string"
        || (status.latestVersion !== null && typeof status.latestVersion !== "string")
        || typeof status.updateAvailable !== "boolean"
        || !status.capability
        || typeof status.capability !== "object"
        || (status.schema !== undefined && status.schema !== "stugu-system-updates/v2")
        || (status.revision !== undefined && (!Number.isSafeInteger(status.revision) || status.revision < 0))
        || (status.operation !== null && typeof status.operation !== "object")
        || (status.application !== undefined && (status.application === null || typeof status.application !== "object"))
        || (status.host !== undefined && status.host !== null && typeof status.host !== "object")
        || (status.workflow !== undefined && status.workflow !== null && typeof status.workflow !== "object")
      ) return;
      if (status.workflow && (
        typeof status.workflow.id !== "string"
        || !Number.isSafeInteger(status.workflow.revision)
        || typeof status.workflow.phase !== "string"
        || !systemUpdateWorkflowPhases.has(status.workflow.phase)
        || !status.workflow.targets
        || typeof status.workflow.targets !== "object"
      )) return;
      const ready = status.host?.readyToRestart;
      if (ready && (
        typeof ready.operationId !== "string"
        || typeof ready.targetVersion !== "string"
        || !Number.isSafeInteger(ready.targetGeneration)
        || ready.targetGeneration < 0
        || typeof ready.targetDigest !== "string"
      )) return;
      onStatus(status);
    } catch {
      // Keep the last validated update state while the server reconnects.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  source.onmessage = consume;
  source.addEventListener("system-update", (message) => consume(message as MessageEvent<string>));
  source.addEventListener("authorization", (message) => {
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => source.close();
}

export const TRACKING_EVENT_TYPES: readonly TrackingEvent["type"][] = [
  "equipment.position.updated",
  "equipment.zone.changed",
  "equipment.movement.started",
  "equipment.movement.stopped",
  "equipment.property.exited",
  "equipment.property.entered",
  "endpoint.battery.low",
  "endpoint.not_seen",
  "gateway.online",
  "gateway.offline",
  "member.location.updated",
  "member.location.stopped",
];

export function subscribeToTrackingEvents(
  propertyId: string,
  onRefresh: (event: TrackingEvent | null) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(
    `${API_BASE}/properties/${encodeURIComponent(propertyId)}/tracking-stream`,
    { withCredentials: true },
  );
  const consume = (message: MessageEvent<string>) => {
    try {
      const event = JSON.parse(message.data) as TrackingEvent;
      if (
        !event
        || event.propertyId !== propertyId
        || !TRACKING_EVENT_TYPES.includes(event.type)
        || !Number.isSafeInteger(event.sequence)
      ) return;
      onRefresh(event);
    } catch {
      // Preserve the last complete map snapshot when an event is malformed.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  TRACKING_EVENT_TYPES.forEach((type) => {
    source.addEventListener(type, (message) => consume(message as MessageEvent<string>));
  });
  source.addEventListener("ready", () => onState("live"));
  source.addEventListener("snapshot-required", () => onRefresh(null));
  source.addEventListener("authorization", (message) => {
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => source.close();
}
