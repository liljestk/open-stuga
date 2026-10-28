import { SYSTEM_UPDATE_WORKFLOW_PHASES } from "@climate-twin/contracts";
import type {
  AppSession,
  House,
  TenantMemberSummary,
  TrackingEvent,
} from "@climate-twin/contracts";
import { ResponseShapeError } from "@climate-twin/contracts";
import {
  type SpatialLayerConfigurationResponse,
  type SpatialTopology,
} from "../../spatialLayers";
import { publishAuthEpoch } from "../../authEpoch";
import { recordApiError } from "../../bugReportDiagnostics";
import { API_RUNTIME_VERSION_HEADER, assertApiRuntimeVersion } from "../../apiRuntimeVersion";
import type { HouseGeoreferencePatch } from "./part-01";
import { API_BASE, API_REQUEST_TIMEOUT_MS, API_V2_BASE, COLLECTION_PAGE_SIZE, SAFE_HTTP_METHODS, apiClientState, apiRequestGeneration, assertSafeApiPath, authorizationChange, notifyAuthorizationChange, trackApiRequestController } from "./part-02";
import { ApiRequestError } from "./request-error";
import { acquireApiRequestSlot, type ApiRequestInit } from "./requestScheduler";
import type { SystemUpdateLiveStatus } from "./part-02";

export async function requestFrom<T>(
  base: string,
  path: string,
  options?: ApiRequestInit,
  timeoutMs = API_REQUEST_TIMEOUT_MS,
): Promise<T> {
  assertSafeApiPath(path);
  const requestGeneration = apiRequestGeneration;
  const controller = new AbortController();
  const callerSignal = options?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const untrackController = trackApiRequestController(controller);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let releaseRequestSlot: (() => void) | null = null;

  try {
    const { schedulingClass: requestedSchedulingClass, ...requestOptions } = options ?? {};
    const method = (requestOptions.method ?? "GET").toUpperCase();
    const schedulingClass = requestedSchedulingClass
      ?? (!SAFE_HTTP_METHODS.has(method) || path === "/session" ? "interactive" : "background");
    releaseRequestSlot = await acquireApiRequestSlot(controller.signal, schedulingClass);
    timeout = globalThis.setTimeout(() => {
      controller.abort(new DOMException("The API request timed out", "TimeoutError"));
    }, timeoutMs);
    const headers = new Headers(requestOptions.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (requestOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!SAFE_HTTP_METHODS.has(method) && apiClientState.csrfToken) headers.set("X-CSRF-Token", apiClientState.csrfToken);
    else headers.delete("X-CSRF-Token");
    const response = await fetch(`${base}${path}`, {
      ...requestOptions,
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
    releaseRequestSlot?.();
    untrackController();
    if (timeout !== null) globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export const request = <T,>(path: string, options?: ApiRequestInit, timeoutMs?: number) => requestFrom<T>(API_BASE, path, options, timeoutMs);

export const requestV2 = <T,>(path: string, options?: ApiRequestInit, timeoutMs?: number) => requestFrom<T>(API_V2_BASE, path, options, timeoutMs);

function objectList<T extends object>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new ResponseShapeError(label, "expected an array");
  if (value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new ResponseShapeError(label, "contains a non-object item");
  }
  return value as T[];
}

/** The array an endpoint documents under `key`; any other body is a ResponseShapeError. */
export function list<T extends object>(value: unknown, key: string): T[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResponseShapeError(key, "expected an object");
  return objectList<T>((value as Record<string, unknown>)[key], key);
}

export function collectionPagePath(path: string, offset: number): string {
  if (offset === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}limit=${COLLECTION_PAGE_SIZE}&offset=${offset}`;
}

export async function completeCollection<T extends { id: string }>(path: string, key: string, options?: Pick<ApiRequestInit, "schedulingClass">): Promise<T[]> {
  const result: T[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  while (true) {
    const page = list<T>(await request<unknown>(collectionPagePath(path, offset), options), key);
    let added = 0;
    for (const item of page) {
      if (typeof item.id !== "string" || !item.id) {
        throw new ResponseShapeError(path, "collection item has no id");
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
  const response = await request<{ house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return response.house;
}

const systemUpdateWorkflowPhases: ReadonlySet<string> = new Set(SYSTEM_UPDATE_WORKFLOW_PHASES);

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
