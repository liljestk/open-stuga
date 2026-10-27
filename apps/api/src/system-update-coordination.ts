import { SYSTEM_UPDATE_WORKFLOW_PHASES } from "@climate-twin/contracts";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type {
  HostUpdatePhase,
  SystemUpdateOperationRequest,
  SystemUpdateWorkflowPhase,
  SystemUpdateWorkflowProjection,
  SystemUpdateWorkflowStep,
  SystemUpdateWorkflowStepState,
} from "@climate-twin/contracts";
import { COMPOSE_CONTRACT, UPDATE_AGENT_CONTRACT } from "./system-update-release-manifest.js";

const MAX_JSON_BYTES = 256 * 1024;
const BRIDGE_MAX_AGE_MS = 2 * 60_000;
const AGENT_MAX_AGE_MS = 2 * 60_000;
const WORKFLOW_STATUS_SCHEMA = "stugu-system-update-workflow-status/v1";
const BRIDGE_STATUS_SCHEMA = "stugu-host-update-bridge-status/v1";

export const UNIFIED_UPDATE_CAPABILITY = "unified-host-update-v1";
export const WORKFLOW_REQUEST_SCHEMA = "stugu-system-update-workflow-request/v1";
export const BRIDGE_REQUEST_SCHEMA = "stugu-host-update-bridge-request/v1";

export interface UpdateAgentHeartbeat {
  schema: "stugu-update-agent/v1";
  runtime: "docker" | "raspberry-pi";
  updatedAt: string;
  agentVersion: string;
  updateAgentContract: number | null;
  composeContract: number | null;
  ready: boolean;
  detail: string | null;
  systemUpdateReason: string | null;
  capabilities: string[];
  compatible: boolean;
}

export interface HostBridgeStatus {
  available: boolean;
  currentGeneration: number;
  updatedAt: string;
  requestId: string | null;
  workflowId: string | null;
  intentId: string | null;
  requestOperation: "check" | "stage" | "activate" | "cancel" | null;
  phase: HostUpdatePhase;
  detail: string | null;
  operationId: string | null;
  targetVersion: string | null;
  targetGeneration: number | null;
  targetSlot: string | null;
  manifestSha256: string | null;
  error: { code: string; message: string } | null;
}

type WorkflowBackupPhase = "pending" | "creating" | "verified" | "failed";

export interface WorkflowStatusFile {
  revision: number;
  id: string;
  phase: SystemUpdateWorkflowPhase;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  detail: string;
  backup: {
    phase: WorkflowBackupPhase;
    verified: boolean;
    completedAt: string | null;
  };
  host: {
    targetVersion: string;
    targetGeneration: number;
    manifestSha256: string;
    operationId: string | null;
    phase: string;
  } | null;
  app: {
    targetVersion: string;
    operationId: string;
    phase: string;
  } | null;
  cancellationEligible: boolean;
  recoveryRequired: boolean;
  error: { code: string; message: string } | null;
}

export function readSystemUpdateJson(path: string, maximum = MAX_JSON_BYTES): unknown {
  let descriptor: number | null = null;
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_JSON_BYTES) return null;
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) return null;
    descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW : 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximum) return null;
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximum) return null;
    return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function writeSystemUpdateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  renameSync(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function nonemptyBoundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 40
    && value.endsWith("Z")
    && Number.isFinite(Date.parse(value));
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function positiveGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonnegativeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validReleaseVersion(value: unknown): value is string {
  return typeof value === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
}

const HOST_UPDATE_PHASES = new Set<HostUpdatePhase>([
  "unavailable", "idle", "checking", "current", "available", "downloading", "installing",
  "ready-to-restart", "restarting", "verifying", "complete", "cancelled", "failed", "returned",
  "recovery-needed",
]);

const WORKFLOW_PHASES: ReadonlySet<string> = new Set(SYSTEM_UPDATE_WORKFLOW_PHASES);

const APPLICATION_PHASES = new Set([
  "pending", "queued", "preparing", "backup", "pulling", "applying", "verifying", "complete",
  "failed", "rolling-back", "application-queueing", "application-queued", "application-updating",
  "application-failed",
]);

export function updateAgentHeartbeatFromJson(value: unknown, nowMs: number): UpdateAgentHeartbeat | null {
  if (!isRecord(value)
    || value.schema !== "stugu-update-agent/v1"
    || (value.runtime !== "docker" && value.runtime !== "raspberry-pi")
    || !validTimestamp(value.updatedAt)
    || nonemptyBoundedString(value.agentVersion, 100) === null
    || typeof value.ready !== "boolean"
    || (value.detail !== null && value.detail !== undefined && boundedString(value.detail, 500) === null)
    || (value.systemUpdateReason !== null
      && value.systemUpdateReason !== undefined
      && nonemptyBoundedString(value.systemUpdateReason, 80) === null)
    || (value.capabilities !== undefined && (!Array.isArray(value.capabilities)
      || value.capabilities.length > 32
      || value.capabilities.some((capability) => nonemptyBoundedString(capability, 80) === null)))) return null;
  const timestamp = Date.parse(value.updatedAt);
  const age = nowMs - timestamp;
  if (!Number.isFinite(timestamp) || age > AGENT_MAX_AGE_MS || age < -AGENT_MAX_AGE_MS) return null;
  const compatible = value.updateAgentContract === UPDATE_AGENT_CONTRACT
    && value.composeContract === COMPOSE_CONTRACT;
  return {
    schema: "stugu-update-agent/v1",
    runtime: value.runtime,
    updatedAt: value.updatedAt,
    agentVersion: value.agentVersion as string,
    updateAgentContract: typeof value.updateAgentContract === "number" ? value.updateAgentContract : null,
    composeContract: typeof value.composeContract === "number" ? value.composeContract : null,
    ready: value.ready,
    detail: boundedString(value.detail, 500),
    systemUpdateReason: boundedString(value.systemUpdateReason, 80),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities as string[] : [],
    compatible,
  };
}

export function bridgeStatusFromJson(value: unknown, nowMs: number): HostBridgeStatus | null {
  if (!isRecord(value)
    || value.schema !== BRIDGE_STATUS_SCHEMA
    || typeof value.available !== "boolean"
    || !positiveGeneration(value.currentGeneration)
    || !validTimestamp(value.updatedAt)) return null;
  const age = nowMs - Date.parse(value.updatedAt);
  if (age > BRIDGE_MAX_AGE_MS || age < -BRIDGE_MAX_AGE_MS) return null;
  const parsedPhase = typeof value.phase === "string" && HOST_UPDATE_PHASES.has(value.phase as HostUpdatePhase)
    ? value.phase as HostUpdatePhase
    : null;
  if ((value.available && parsedPhase === null)
    || (value.phase !== null && value.phase !== undefined && parsedPhase === null)) return null;
  const phase = parsedPhase ?? "unavailable";
  if (value.error !== null && value.error !== undefined && (!isRecord(value.error)
    || nonemptyBoundedString(value.error.code, 80) === null
    || nonemptyBoundedString(value.error.message, 500) === null)) return null;
  const error = isRecord(value.error)
    ? { code: value.error.code as string, message: value.error.message as string }
    : null;
  if ((value.requestId !== null && value.requestId !== undefined && !canonicalUuid(value.requestId))
    || (value.workflowId !== null && value.workflowId !== undefined && !canonicalUuid(value.workflowId))
    || (value.intentId !== null && value.intentId !== undefined && !canonicalUuid(value.intentId))
    || (value.operationId !== null && value.operationId !== undefined && !canonicalUuid(value.operationId))
    || (value.targetVersion !== null && value.targetVersion !== undefined && !validReleaseVersion(value.targetVersion))
    || (value.targetGeneration !== null && value.targetGeneration !== undefined && !positiveGeneration(value.targetGeneration))
    || (value.manifestSha256 !== null && value.manifestSha256 !== undefined && !validDigest(value.manifestSha256))
    || (value.targetSlot !== null && value.targetSlot !== undefined && boundedString(value.targetSlot, 40) === null)) return null;
  const requestOperation = ["check", "stage", "activate", "cancel"].includes(String(value.requestOperation))
    ? value.requestOperation as HostBridgeStatus["requestOperation"]
    : null;
  if (value.requestOperation !== null && value.requestOperation !== undefined && requestOperation === null) return null;
  const targetBoundPhase = [
    "available", "downloading", "installing", "ready-to-restart", "restarting", "verifying", "complete",
  ].includes(phase);
  // Generation 14 completed successfully before the native coordinator added
  // targetVersion to its terminal status. Accept only that non-actionable,
  // exact-current completion shape; every stage or activation state remains
  // fully identity-bound and a mismatched completed generation still fails closed.
  const legacyCompletedCurrent = phase === "complete"
    && (value.targetVersion === null || value.targetVersion === undefined)
    && positiveGeneration(value.targetGeneration)
    && value.targetGeneration === value.currentGeneration
    && validDigest(value.manifestSha256);
  if (targetBoundPhase && ((!validReleaseVersion(value.targetVersion) && !legacyCompletedCurrent)
    || !positiveGeneration(value.targetGeneration)
    || !validDigest(value.manifestSha256))) return null;
  if (["ready-to-restart", "restarting", "verifying", "complete"].includes(phase)
    && !canonicalUuid(value.operationId)) return null;
  return {
    available: value.available,
    currentGeneration: value.currentGeneration,
    updatedAt: value.updatedAt,
    requestId: canonicalUuid(value.requestId) ? value.requestId : null,
    workflowId: canonicalUuid(value.workflowId) ? value.workflowId : null,
    intentId: canonicalUuid(value.intentId) ? value.intentId : null,
    requestOperation,
    phase,
    detail: boundedString(value.detail, 500),
    operationId: canonicalUuid(value.operationId) ? value.operationId : null,
    targetVersion: validReleaseVersion(value.targetVersion) ? value.targetVersion : null,
    targetGeneration: positiveGeneration(value.targetGeneration) ? value.targetGeneration : null,
    targetSlot: boundedString(value.targetSlot, 40),
    manifestSha256: validDigest(value.manifestSha256) ? value.manifestSha256 : null,
    error,
  };
}

export function workflowStatusFromJson(value: unknown): WorkflowStatusFile | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema", "revision", "id", "action", "phase", "requestedAt", "startedAt", "updatedAt",
    "completedAt", "detail", "backup", "host", "app", "cancellationEligible", "recoveryRequired", "error",
  ])) return null;
  if (value.schema !== WORKFLOW_STATUS_SCHEMA
    || !nonnegativeRevision(value.revision)
    || !canonicalUuid(value.id)
    || value.action !== "update-everything"
    || typeof value.phase !== "string"
    || !WORKFLOW_PHASES.has(value.phase as SystemUpdateWorkflowPhase)
    || !validTimestamp(value.requestedAt)
    || !(value.startedAt === null || validTimestamp(value.startedAt))
    || !validTimestamp(value.updatedAt)
    || !(value.completedAt === null || validTimestamp(value.completedAt))
    || boundedString(value.detail, 2_000) === null
    || typeof value.cancellationEligible !== "boolean"
    || typeof value.recoveryRequired !== "boolean") return null;

  const backup = value.backup;
  if (!isRecord(backup) || !hasExactKeys(backup, ["phase", "verified", "completedAt", "receipt"])
    || !["pending", "creating", "verified", "failed"].includes(String(backup.phase))
    || typeof backup.verified !== "boolean"
    || !(backup.completedAt === null || validTimestamp(backup.completedAt))) return null;
  if (backup.receipt !== null && (!isRecord(backup.receipt)
    || !hasExactKeys(backup.receipt, ["manifestSha256", "verifiedAt"])
    || !validDigest(backup.receipt.manifestSha256)
    || !validTimestamp(backup.receipt.verifiedAt))) return null;

  const host = value.host;
  if (host === null) {
    if (value.phase !== "failed" && value.phase !== "recovery-needed") return null;
  } else if (!isRecord(host) || !hasExactKeys(host, [
    "targetVersion", "targetGeneration", "manifestSha256", "operationId", "phase",
  ])
    || !validReleaseVersion(host.targetVersion)
    || !positiveGeneration(host.targetGeneration)
    || !validDigest(host.manifestSha256)
    || !(host.operationId === null || canonicalUuid(host.operationId))
    || nonemptyBoundedString(host.phase, 80) === null
    || (!HOST_UPDATE_PHASES.has(host.phase as HostUpdatePhase)
      && !WORKFLOW_PHASES.has(host.phase as SystemUpdateWorkflowPhase))) return null;

  let app: WorkflowStatusFile["app"] = null;
  if (value.app !== null) {
    if (!isRecord(value.app) || !hasExactKeys(value.app, ["targetVersion", "operationId", "phase"])
      || !validReleaseVersion(value.app.targetVersion)
      || !canonicalUuid(value.app.operationId)
      || nonemptyBoundedString(value.app.phase, 80) === null
      || !APPLICATION_PHASES.has(value.app.phase as string)) return null;
    app = {
      targetVersion: value.app.targetVersion,
      operationId: value.app.operationId,
      phase: value.app.phase as string,
    };
  }

  let error: WorkflowStatusFile["error"] = null;
  if (value.error !== null) {
    if (!isRecord(value.error) || !hasExactKeys(value.error, ["code", "message"])
      || nonemptyBoundedString(value.error.code, 80) === null
      || nonemptyBoundedString(value.error.message, 500) === null) return null;
    error = { code: value.error.code, message: value.error.message } as { code: string; message: string };
  }

  return {
    revision: value.revision,
    id: value.id,
    phase: value.phase as SystemUpdateWorkflowPhase,
    requestedAt: value.requestedAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
    detail: value.detail as string,
    backup: {
      phase: backup.phase as WorkflowBackupPhase,
      verified: backup.verified,
      completedAt: backup.completedAt as string | null,
    },
    host: host === null ? null : {
      targetVersion: host.targetVersion as string,
      targetGeneration: host.targetGeneration as number,
      manifestSha256: host.manifestSha256 as string,
      operationId: host.operationId as string | null,
      phase: host.phase as string,
    },
    app,
    cancellationEligible: value.cancellationEligible,
    recoveryRequired: value.recoveryRequired,
    error,
  };
}

function workflowStepState(
  workflow: WorkflowStatusFile,
  id: SystemUpdateWorkflowStep["id"],
): SystemUpdateWorkflowStepState {
  const phase = workflow.phase;
  if (id === "backup") {
    if (workflow.backup.phase === "creating") return "active";
    if (workflow.backup.phase === "verified") return "complete";
    if (workflow.backup.phase === "failed") return "failed";
    return phase === "cancelled" ? "skipped" : "pending";
  }
  if (id === "stage-host") {
    if (["host-stage-requested", "host-stage-queueing", "host-staging"].includes(phase)) return "active";
    if (["awaiting-restart", "restarting", "host-verifying", "host-complete", "application-queueing", "application-queued", "application-updating", "application-failed", "complete"].includes(phase)) return "complete";
    if (["failed", "returned", "recovery-needed"].includes(phase) && workflow.backup.verified) return "failed";
    return phase === "cancelled" ? "skipped" : "pending";
  }
  if (id === "restart-host") {
    if (phase === "awaiting-restart") return "waiting";
    if (phase === "restarting") return "active";
    if (["host-verifying", "host-complete", "application-queueing", "application-queued", "application-updating", "application-failed", "complete"].includes(phase)) return "complete";
    if (phase === "returned") return "rolled-back";
    if (["failed", "recovery-needed"].includes(phase) && workflow.host?.operationId) return "failed";
    return phase === "cancelled" ? "skipped" : "pending";
  }
  if (id === "verify-host") {
    if (phase === "host-verifying") return "active";
    if (["host-complete", "application-queueing", "application-queued", "application-updating", "application-failed", "complete"].includes(phase)) return "complete";
    if (phase === "returned") return "rolled-back";
    if (phase === "recovery-needed") return "failed";
    return phase === "cancelled" ? "skipped" : "pending";
  }
  const appPhase = workflow.app?.phase ?? null;
  if (id === "update-application") {
    if (workflow.app === null && phase === "complete") return "skipped";
    if (appPhase === "complete" || appPhase === "verifying" || phase === "complete") return "complete";
    if (appPhase === "failed" || phase === "application-failed") return "failed";
    if (appPhase === "rolling-back") return "rolled-back";
    if (["application-queueing", "application-queued", "application-updating"].includes(phase)) return "active";
    return ["cancelled", "returned", "recovery-needed"].includes(phase) ? "skipped" : "pending";
  }
  if (workflow.app === null && phase === "complete") return "skipped";
  if (appPhase === "verifying") return "active";
  if (appPhase === "complete" || phase === "complete") return "complete";
  if (appPhase === "failed" || phase === "application-failed") return "failed";
  if (appPhase === "rolling-back") return "rolled-back";
  if (phase === "application-updating") return "waiting";
  return ["cancelled", "returned", "recovery-needed"].includes(phase) ? "skipped" : "pending";
}

export function workflowProjection(workflow: WorkflowStatusFile): SystemUpdateWorkflowProjection {
  const ids: SystemUpdateWorkflowStep["id"][] = [
    "backup", "stage-host", "restart-host", "verify-host", "update-application", "verify-application",
  ];
  return {
    id: workflow.id,
    revision: workflow.revision,
    action: "update-everything",
    phase: workflow.phase,
    requestedAt: workflow.requestedAt,
    updatedAt: workflow.updatedAt,
    completedAt: workflow.completedAt,
    detail: workflow.detail,
    hostOperationId: workflow.host?.operationId ?? null,
    targets: {
      applicationVersion: workflow.app?.targetVersion ?? null,
      hostVersion: workflow.host?.targetVersion ?? null,
      hostGeneration: workflow.host?.targetGeneration ?? null,
      hostDigest: workflow.host?.manifestSha256 ?? null,
    },
    steps: ids.map((id) => ({ id, state: workflowStepState(workflow, id) })),
    canCancel: workflow.cancellationEligible,
    recoveryRequired: workflow.recoveryRequired,
    reason: workflow.error?.code ?? null,
  };
}

export function parseSystemUpdateOperationRequest(value: unknown): SystemUpdateOperationRequest {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new TypeError("System update operation must be an object with an action");
  }
  if (!nonnegativeRevision(value.expectedRevision)) {
    throw new TypeError("expectedRevision must be a nonnegative integer");
  }
  if (value.action === "update-everything") {
    if (!hasExactKeys(value, ["action", "expectedRevision"])) {
      throw new TypeError("update-everything contains unsupported fields");
    }
    return { action: value.action, expectedRevision: value.expectedRevision };
  }
  if (value.action === "retry-application") {
    if (!hasExactKeys(value, ["action", "expectedRevision", "workflowId"]) || !canonicalUuid(value.workflowId)) {
      throw new TypeError("retry-application requires an exact workflowId binding");
    }
    return { action: value.action, expectedRevision: value.expectedRevision, workflowId: value.workflowId };
  }
  if (value.action !== "activate-host" && value.action !== "cancel-host") {
    throw new TypeError("Unsupported system update action");
  }
  const expectedKeys = [
    "action", "expectedRevision", "workflowId", "hostOperationId", "targetVersion",
    "targetGeneration", "targetDigest", ...(value.action === "activate-host" ? ["confirmation"] : []),
  ];
  if (!hasExactKeys(value, expectedKeys)
    || !canonicalUuid(value.workflowId)
    || !canonicalUuid(value.hostOperationId)
    || !validReleaseVersion(value.targetVersion)
    || !positiveGeneration(value.targetGeneration)
    || !validDigest(value.targetDigest)) {
    throw new TypeError(`${value.action} requires exact host identity bindings`);
  }
  if (value.action === "activate-host") {
    if (value.confirmation !== "RESTART_AND_INSTALL") {
      throw new TypeError("activate-host requires RESTART_AND_INSTALL confirmation");
    }
    return {
      action: value.action,
      expectedRevision: value.expectedRevision,
      workflowId: value.workflowId,
      hostOperationId: value.hostOperationId,
      targetVersion: value.targetVersion,
      targetGeneration: value.targetGeneration,
      targetDigest: value.targetDigest,
      confirmation: value.confirmation,
    };
  }
  return {
    action: value.action,
    expectedRevision: value.expectedRevision,
    workflowId: value.workflowId,
    hostOperationId: value.hostOperationId,
    targetVersion: value.targetVersion,
    targetGeneration: value.targetGeneration,
    targetDigest: value.targetDigest,
  };
}
