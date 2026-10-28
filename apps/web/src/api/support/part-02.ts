import type { StugubyAuthorityTransfer, StugubyHomeProjection, StugubyPropertyAdoption, SystemUpdateOperationRequest, SystemUpdateStatus } from "@climate-twin/contracts";
import type {
  StugubyDeletionReceipt,
  StugubyPropertyConflict,
  StugubyRemoteResource,
  StugubyShareGrant,
  StugubySharedProperty,
  StugubySummary,
} from "@climate-twin/stuguby-protocol";
import type { StugubyLocalInvitation, StugubyLocalMember } from "./part-01";

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

export type SystemUpdateBlockReason =
  | "agent-offline"
  | "agent-not-connected"
  | "agent-upgrade-required"
  | "host-updater-offline"
  | "host-updater-upgrade-required"
  | "platform-managed-externally"
  | "factory-transition-required"
  | "appliance-upgrade-required"
  | "cli-transition-required"
  | "hardware-unqualified"
  | "mutation-busy"
  | "recovery-required"
  | "backup-unavailable"
  | "off-device-backup-required"
  | "metadata-unavailable"
  | "feed-trust-stale"
  | "trust-verification-failed"
  | "verification-failed"
  | "status-stale"
  | "not-configured";

export type SystemUpdateLiveStatus = Pick<
  SystemUpdateStatus,
  "currentVersion" | "latestVersion" | "updateAvailable" | "capability" | "operation"
> & Partial<Pick<SystemUpdateStatus, "schema" | "revision" | "application" | "host" | "workflow">>;

export type SystemUpdateOperationInput = SystemUpdateOperationRequest;

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "/api/v1";

export const API_V2_BASE = API_BASE.replace(/\/v1$/, "/v2");

export const API_REQUEST_TIMEOUT_MS = 30_000;

export const INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS = 90_000;

export const STREAM_STABILITY_DELAY_MS = 750;

export const COLLECTION_PAGE_SIZE = 500;

export const SAFE_API_PATH = /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})+$/;

export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const apiClientState = { csrfToken: null as string | null };

const activeRequestControllers = new Set<AbortController>();

export let apiRequestGeneration = 0;

/** Track an in-flight request so a session change can abort it; call the result once it settles. */
export function trackApiRequestController(controller: AbortController): () => void {
  activeRequestControllers.add(controller);
  return () => activeRequestControllers.delete(controller);
}

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

export function assertSafeApiPath(path: string): void {
  const pathname = path.split("?", 1).at(0) ?? "";
  const containsTraversal = pathname
    .split("/")
    .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (!SAFE_API_PATH.test(path) || containsTraversal) {
    throw new TypeError("Invalid API request path");
  }
}
