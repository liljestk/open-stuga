import { type House, ResponseShapeError } from "@climate-twin/contracts";
import type { SpatialLayerConfigurationResponse, SpatialTopology } from "../../spatial/layers";
import { recordApiError } from "../../bugReportDiagnostics";
import { API_RUNTIME_VERSION_HEADER, assertApiRuntimeVersion } from "../../apiRuntimeVersion";
import { ApiRequestError } from "./request-error";
import { acquireApiRequestSlot, type ApiRequestInit } from "./requestScheduler";
import { API_BASE, API_REQUEST_TIMEOUT_MS, API_V2_BASE, COLLECTION_PAGE_SIZE, SAFE_HTTP_METHODS, apiClientState, apiRequestGeneration, assertSafeApiPath, notifyAuthorizationChange, trackApiRequestController } from "./client-state";
import type { HouseGeoreferencePatch } from "./response-types";
import { houseShape } from "./entity-shapes";
import { arrayOf, fields, type ResponseShape } from "./response-shapes";

/** One API request: the parsed JSON body, or undefined for 204. Callers name the body's shape through request/requestV2. */
export async function requestFrom(base: string, path: string, options?: ApiRequestInit): Promise<unknown> {
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
    const { schedulingClass: requestedSchedulingClass, timeoutMs = API_REQUEST_TIMEOUT_MS, ...requestOptions } = options ?? {};
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
      return undefined;
    }
    const payload: unknown = await response.json();
    assertCurrentGeneration();
    return payload;
  } finally {
    releaseRequestSlot?.();
    untrackController();
    if (timeout !== null) globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

/** The endpoint a shape error names: the path without its query. */
const endpointOf = (path: string) => path.split("?")[0]!;

/** A v1 request whose body `shape` accepts; any other body is a ResponseShapeError. */
export async function request<T>(path: string, shape: ResponseShape<T>, options?: ApiRequestInit): Promise<T> {
  return shape(await requestFrom(API_BASE, path, options), endpointOf(path));
}

/** A v2 request whose body `shape` accepts; any other body is a ResponseShapeError. */
export async function requestV2<T>(path: string, shape: ResponseShape<T>, options?: ApiRequestInit): Promise<T> {
  return shape(await requestFrom(API_V2_BASE, path, options), endpointOf(path));
}

export function collectionPagePath(path: string, offset: number): string {
  if (offset === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}limit=${COLLECTION_PAGE_SIZE}&offset=${offset}`;
}

/** A paged collection: its items sit under `key` and each is parsed by `item`. */
export interface CollectionEnvelope<T extends { id: string }> extends Pick<ApiRequestInit, "schedulingClass"> {
  key: string;
  item: ResponseShape<T>;
}

export async function completeCollection<T extends { id: string }>(path: string, { key, item, ...options }: CollectionEnvelope<T>): Promise<T[]> {
  const result: T[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  while (true) {
    const page = (await request(collectionPagePath(path, offset), fields({ [key]: arrayOf(item) }), options))[key]!;
    let added = 0;
    for (const item of page) {
      if (!item.id) {
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

export async function updateHouseGeoreference(houseId: string, patch: HouseGeoreferencePatch): Promise<House> {
  const response = await request(`/houses/${encodeURIComponent(houseId)}`, fields({ house: houseShape }), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return response.house;
}
