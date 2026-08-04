import { randomUUID } from "node:crypto";

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";

import { join } from "node:path";

import {
  bounded,
  compose,
  currentReleaseEnvironment,
  readJson,
  RELEASE_MANIFEST_SCHEMA,
  removeFileDurable,
  UPDATE_REQUEST_SCHEMA,
  validatedRequest,
  writeTextDurableAtomic,
} from "./configuration-request.mjs";
import { activeServices, exactApiVersion } from "./services-cloudflare.mjs";

export const SYSTEM_WORKFLOW_REQUEST_SCHEMA = "stugu-system-update-workflow-request/v1";
export const SYSTEM_WORKFLOW_JOURNAL_SCHEMA = "stugu-system-update-workflow-journal/v1";
export const SYSTEM_WORKFLOW_STATUS_SCHEMA = "stugu-system-update-workflow-status/v1";
export const HOST_BRIDGE_REQUEST_SCHEMA = "stugu-host-update-bridge-request/v1";
export const HOST_BRIDGE_STATUS_SCHEMA = "stugu-host-update-bridge-status/v1";

export const SYSTEM_WORKFLOW_INBOX = "system-workflow-requests";
export const SYSTEM_WORKFLOW_JOURNAL = "system-update-workflow-journal.json";
export const SYSTEM_WORKFLOW_STATUS = "workflow-status.json";

const MAX_WORKFLOW_BYTES = 64 * 1024;
const MAX_BRIDGE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const REQUEST_NAME = /^request-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/u;

const PHASES = new Set([
  "preparing",
  "backup-active",
  "backup-complete",
  "host-stage-queueing",
  "host-stage-requested",
  "host-staging",
  "awaiting-restart",
  "restarting",
  "host-verifying",
  "host-complete",
  "application-queueing",
  "application-queued",
  "application-updating",
  "application-failed",
  "complete",
  "failed",
  "cancelled",
  "returned",
  "recovery-needed",
]);
const HOST_ACTIVE_PHASES = new Set([
  "checking",
  "downloading",
  "installing",
  "ready-to-restart",
  "restarting",
  "verifying",
  "recovery-needed",
]);
const APP_ACTIVE_PHASES = new Set([
  "queued",
  "preparing",
  "backup",
  "pulling",
  "applying",
  "verifying",
  "rolling-back",
]);
const TERMINAL_PHASES = new Set(["complete", "failed", "cancelled", "returned"]);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label} must be a canonical lower-case UUID`);
  }
  return value;
}

function stableErrorCode(value, fallback) {
  const normalized = typeof value === "string"
    ? value.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_").slice(0, 80)
    : "";
  return /^[A-Z0-9_]{1,80}$/u.test(normalized) ? normalized : fallback;
}

function workflowDetail(value) {
  return bounded(String(value)).slice(-2_000);
}

function workflowErrorMessage(value) {
  return bounded(String(value)).slice(-500);
}

function projectionTimestamp(value, fallback) {
  if (typeof value !== "string" || value.length > 40 || !value.endsWith("Z")) return fallback;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function requestedAt(value) {
  if (typeof value !== "string" || value.length > 40 || !value.endsWith("Z")) {
    throw new Error("requestedAt must be a bounded UTC timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("requestedAt must be a bounded UTC timestamp");
  return new Date(milliseconds).toISOString();
}

function validatedHostTarget(value) {
  if (!exactKeys(value, ["version", "generation", "manifestSha256"])) {
    throw new Error("Host target must contain one exact signed target identity");
  }
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new Error("Host target version is invalid");
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("Host target generation is invalid");
  }
  if (typeof value.manifestSha256 !== "string" || !DIGEST.test(value.manifestSha256)) {
    throw new Error("Host target manifest digest is invalid");
  }
  return {
    version: value.version,
    generation: value.generation,
    manifestSha256: value.manifestSha256,
  };
}

function validatedAppRequest(value, config) {
  const request = validatedRequest(value, config);
  return {
    schema: UPDATE_REQUEST_SCHEMA,
    ...request,
    repository: config.repository,
    releaseManifestSchema: RELEASE_MANIFEST_SCHEMA,
  };
}

export function validatedSystemWorkflowRequest(value, config, filename = null) {
  if (!value || typeof value !== "object" || value.schema !== SYSTEM_WORKFLOW_REQUEST_SCHEMA) {
    throw new Error("Unsupported system update workflow request");
  }
  const action = value.action;
  const keys = action === "update-everything"
    ? ["schema", "id", "action", "requestedAt", "app", "host"]
    : action === "retry-application"
      ? ["schema", "id", "action", "requestedAt", "workflowId"]
      : [];
  if (keys.length === 0 || !exactKeys(value, keys)) {
    throw new Error("System update workflow request fields are unsupported");
  }
  const id = canonicalUuid(value.id, "id");
  if (filename) {
    const match = REQUEST_NAME.exec(filename);
    if (!match || match[1] !== id) throw new Error("Workflow request filename does not match its id");
  }
  const normalized = {
    schema: SYSTEM_WORKFLOW_REQUEST_SCHEMA,
    id,
    action,
    requestedAt: requestedAt(value.requestedAt),
  };
  if (action === "retry-application") {
    return {
      ...normalized,
      workflowId: canonicalUuid(value.workflowId, "workflowId"),
    };
  }
  if (config.runtime !== "raspberry-pi") {
    throw new Error("Unified host updates are supported only on a Raspberry Pi appliance");
  }
  return {
    ...normalized,
    app: value.app === null ? null : validatedAppRequest(value.app, config),
    host: validatedHostTarget(value.host),
  };
}

export function systemWorkflowPaths(config) {
  const hostBridge = join(config.operationsDirectory, "host-bridge");
  return {
    inbox: join(config.operationsDirectory, SYSTEM_WORKFLOW_INBOX),
    journal: join(config.operationsDirectory, SYSTEM_WORKFLOW_JOURNAL),
    status: join(config.operationsDirectory, SYSTEM_WORKFLOW_STATUS),
    bridgeRequests: join(hostBridge, "requests"),
    bridgeStatus: join(hostBridge, "status", "status.json"),
  };
}

function boundedJson(path, maximum) {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) return null;
  return readJson(path);
}

function durableJson(path, value, mode = 0o640) {
  writeTextDurableAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function readBridgeStatus(config) {
  const value = boundedJson(systemWorkflowPaths(config).bridgeStatus, MAX_BRIDGE_BYTES);
  if (!value || value.schema !== HOST_BRIDGE_STATUS_SCHEMA) return null;
  return value;
}

function oldestInboxRequest(config) {
  const { inbox } = systemWorkflowPaths(config);
  if (!existsSync(inbox)) return null;
  const metadata = lstatSync(inbox);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The system workflow inbox is invalid");
  }
  const candidates = readdirSync(inbox)
    .filter((name) => REQUEST_NAME.test(name))
    .map((name) => {
      const path = join(inbox, name);
      const value = boundedJson(path, MAX_WORKFLOW_BYTES);
      return { name, path, value, time: Date.parse(value?.requestedAt ?? "") };
    })
    .sort((left, right) => (
      (Number.isFinite(left.time) ? left.time : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(right.time) ? right.time : Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name)
    ));
  return candidates[0] ?? null;
}

function workflowActivity(journal, phase, detail, at) {
  return [...(journal?.activity ?? []), { phase, at, detail }].slice(-50);
}

function backupProjection(journal) {
  if (journal.backupReceipt) {
    return {
      phase: "verified",
      verified: true,
      completedAt: journal.backupReceipt.verifiedAt,
      receipt: journal.backupReceipt,
    };
  }
  return {
    phase: journal.phase === "backup-active" ? "creating"
      : journal.phase === "failed" ? "failed" : "pending",
    verified: false,
    completedAt: null,
    receipt: null,
  };
}

function hostProjection(journal, bridge = null) {
  const durablePhase = {
    preparing: "pending",
    "backup-active": "pending",
    "backup-complete": "pending",
    "host-stage-queueing": "checking",
    "host-stage-requested": "checking",
    "host-staging": "installing",
    "awaiting-restart": "ready-to-restart",
    restarting: "restarting",
    "host-verifying": "verifying",
    "host-complete": "complete",
    "application-queueing": "complete",
    "application-queued": "complete",
    "application-updating": "complete",
    "application-failed": "complete",
    complete: "complete",
    failed: "failed",
    cancelled: "cancelled",
    returned: "returned",
    "recovery-needed": "recovery-needed",
  }[journal.phase] ?? journal.phase;
  return {
    targetVersion: journal.request.host.version,
    targetGeneration: journal.request.host.generation,
    manifestSha256: journal.request.host.manifestSha256,
    operationId: journal.hostOperationId ?? null,
    phase: String(bridge?.phase ?? durablePhase).slice(0, 80),
  };
}

function appProjection(journal, appStatus = null) {
  if (!journal.request.app) return null;
  return {
    targetVersion: journal.request.app.version,
    operationId: journal.request.app.id,
    phase: appStatus?.phase ?? (
      journal.phase.startsWith("application-") ? journal.phase : "pending"
    ),
  };
}

function workflowProjection(journal, { bridge = null, appStatus = null } = {}) {
  return {
    schema: SYSTEM_WORKFLOW_STATUS_SCHEMA,
    revision: journal.revision,
    id: journal.id,
    action: "update-everything",
    phase: journal.phase,
    requestedAt: journal.request.requestedAt,
    startedAt: journal.startedAt,
    updatedAt: journal.updatedAt,
    completedAt: journal.completedAt ?? null,
    detail: journal.detail,
    backup: backupProjection(journal),
    host: hostProjection(journal, bridge),
    app: appProjection(journal, appStatus),
    cancellationEligible: journal.phase === "awaiting-restart",
    recoveryRequired: journal.phase === "recovery-needed",
    error: journal.error ?? null,
  };
}

function persistJournal(config, journal, context = {}) {
  const paths = systemWorkflowPaths(config);
  durableJson(paths.journal, journal, 0o600);
  durableJson(paths.status, workflowProjection(journal, context));
  return journal;
}

function transition(config, journal, phase, detail, values = {}, context = {}) {
  const at = new Date().toISOString();
  const normalizedDetail = workflowDetail(detail);
  const normalizedValues = values.error
    ? {
        ...values,
        error: {
          code: stableErrorCode(values.error.code, "WORKFLOW_FAILED"),
          message: workflowErrorMessage(values.error.message),
        },
      }
    : values;
  const next = {
    ...journal,
    ...normalizedValues,
    phase,
    detail: normalizedDetail,
    revision: journal.revision + 1,
    updatedAt: at,
    completedAt: TERMINAL_PHASES.has(phase) ? at : null,
    activity: workflowActivity(journal, phase, normalizedDetail, at),
  };
  return persistJournal(config, next, context);
}

function validJournal(value, config) {
  const keys = [
    "schema",
    "revision",
    "id",
    "request",
    "requestFile",
    "phase",
    "detail",
    "startedAt",
    "updatedAt",
    "completedAt",
    "backupReceipt",
    "bridgeRequestId",
    "bridgeRequestFile",
    "bridgeRequestedAt",
    "hostOperationId",
    "appRequestFile",
    "error",
    "activity",
  ];
  if (!exactKeys(value, keys)
    || value.schema !== SYSTEM_WORKFLOW_JOURNAL_SCHEMA
    || !PHASES.has(value.phase)) {
    throw new Error("The system update workflow journal is invalid");
  }
  canonicalUuid(value.id, "workflow journal id");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.id !== value.request?.id
    || typeof value.detail !== "string" || value.detail.length > 2_000
    || !Number.isFinite(Date.parse(value.startedAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.completedAt !== null && !Number.isFinite(Date.parse(value.completedAt)))) {
    throw new Error("The system update workflow journal identity is invalid");
  }
  const request = validatedSystemWorkflowRequest(value.request, config);
  if (request.action !== "update-everything") throw new Error("The workflow journal action is invalid");
  if (typeof value.requestFile !== "string" || value.requestFile !== `request-${request.id}.json`) {
    throw new Error("The workflow journal request filename is invalid");
  }
  if (value.backupReceipt !== null && (
    !exactKeys(value.backupReceipt, ["manifestSha256", "verifiedAt"])
    || !DIGEST.test(value.backupReceipt.manifestSha256)
    || !Number.isFinite(Date.parse(value.backupReceipt.verifiedAt))
  )) throw new Error("The workflow journal backup receipt is invalid");
  for (const [idField, fileField] of [
    ["bridgeRequestId", "bridgeRequestFile"],
  ]) {
    if ((value[idField] === null) !== (value[fileField] === null)) {
      throw new Error("The workflow journal bridge intent is incomplete");
    }
    if (value[idField] !== null) {
      canonicalUuid(value[idField], idField);
      if (value[fileField] !== `request-${value[idField]}.json`) {
        throw new Error("The workflow journal bridge filename is invalid");
      }
    }
  }
  if ((value.bridgeRequestId === null) !== (value.bridgeRequestedAt === null)
    || (value.bridgeRequestedAt !== null && !Number.isFinite(Date.parse(value.bridgeRequestedAt)))) {
    throw new Error("The workflow journal bridge timestamp is invalid");
  }
  if (value.hostOperationId !== null) canonicalUuid(value.hostOperationId, "hostOperationId");
  if (value.appRequestFile !== null
    && value.appRequestFile !== `request-${request.app?.id}.json`) {
    throw new Error("The workflow journal application filename is invalid");
  }
  if (value.error !== null && (
    !exactKeys(value.error, ["code", "message"])
    || typeof value.error.code !== "string" || !/^[A-Z0-9_]{1,80}$/u.test(value.error.code)
    || typeof value.error.message !== "string" || value.error.message.length > 500
  )) throw new Error("The workflow journal error is invalid");
  if (!Array.isArray(value.activity) || value.activity.length < 1 || value.activity.length > 50
    || value.activity.some((entry) => !exactKeys(entry, ["phase", "at", "detail"])
      || !PHASES.has(entry.phase)
      || !Number.isFinite(Date.parse(entry.at))
      || typeof entry.detail !== "string" || entry.detail.length > 2_000)) {
    throw new Error("The workflow journal activity is invalid");
  }
  const afterBackup = !["preparing", "backup-active", "failed", "recovery-needed"].includes(value.phase);
  if (afterBackup && value.backupReceipt === null) {
    throw new Error("The workflow journal has no verified backup receipt");
  }
  const afterStageQueue = ![
    "preparing",
    "backup-active",
    "backup-complete",
    "failed",
    "recovery-needed",
  ].includes(value.phase);
  if (afterStageQueue && value.bridgeRequestId === null) {
    throw new Error("The workflow journal has no native staging intent");
  }
  if (value.phase.startsWith("application-") && (!request.app || value.appRequestFile === null)) {
    throw new Error("The workflow journal application operation is incomplete");
  }
  if (TERMINAL_PHASES.has(value.phase) !== (value.completedAt !== null)) {
    throw new Error("The workflow journal completion state is invalid");
  }
  return { ...value, request };
}

export function readSystemWorkflowJournal(config) {
  const path = systemWorkflowPaths(config).journal;
  if (!existsSync(path)) return null;
  const raw = boundedJson(path, MAX_WORKFLOW_BYTES);
  if (!raw) throw new Error("The system update workflow journal is unreadable, malformed, or oversized");
  return validJournal(raw, config);
}

function initialJournal(request, requestFile) {
  const at = new Date().toISOString();
  const detail = "Preparing the unified update and its safety checks";
  return {
    schema: SYSTEM_WORKFLOW_JOURNAL_SCHEMA,
    revision: 0,
    id: request.id,
    request,
    requestFile,
    phase: "preparing",
    detail,
    startedAt: at,
    updatedAt: at,
    completedAt: null,
    backupReceipt: null,
    bridgeRequestId: null,
    bridgeRequestFile: null,
    bridgeRequestedAt: null,
    hostOperationId: null,
    appRequestFile: null,
    error: null,
    activity: [{ phase: "preparing", at, detail }],
  };
}

function parseBackupReceipt(output) {
  const digest = output.match(/^Manifest SHA-256:\s*([0-9a-f]{64})\s*$/mu)?.[1];
  if (!digest) throw new Error("Verified backup did not return its manifest receipt");
  return { manifestSha256: digest, verifiedAt: new Date().toISOString() };
}

function bridgeReadyForWorkflow(config) {
  const value = readBridgeStatus(config);
  if (!value || value.available !== true) {
    throw new Error("The native host update bridge is unavailable; no update was started");
  }
  if (value.error && typeof value.error === "object") {
    throw new Error(`The native host update bridge is not ready: ${String(value.error.message ?? "unknown error")}`);
  }
  if (HOST_ACTIVE_PHASES.has(value.phase)) {
    throw new Error("Another native host update is active; no update was started");
  }
  return value;
}

function otherMutationPending(config) {
  const names = readdirSync(config.operationsDirectory);
  return existsSync(join(config.operationsDirectory, "update-journal.json"))
    || existsSync(join(config.operationsDirectory, "storage-journal.json"))
    || names.some((name) => /^(?:request-|cloudflare-request-|source-profile-request-|storage-request-).*\.json$/u.test(name));
}

function removeWorkflowRequest(config, journal) {
  removeFileDurable(join(systemWorkflowPaths(config).inbox, journal.requestFile));
}

function finishWorkflow(config, journal) {
  removeWorkflowRequest(config, journal);
  removeFileDurable(systemWorkflowPaths(config).journal);
}

function writeFailedRequestStatus(config, raw, detail) {
  const at = new Date().toISOString();
  const safeDetail = workflowDetail(detail);
  const id = typeof raw?.id === "string" && UUID.test(raw.id) ? raw.id : randomUUID();
  durableJson(systemWorkflowPaths(config).status, {
    schema: SYSTEM_WORKFLOW_STATUS_SCHEMA,
    revision: 0,
    id,
    action: "update-everything",
    phase: "failed",
    requestedAt: projectionTimestamp(raw?.requestedAt, at),
    startedAt: at,
    updatedAt: at,
    completedAt: at,
    detail: safeDetail,
    backup: { phase: "failed", verified: false, completedAt: null, receipt: null },
    host: null,
    app: null,
    cancellationEligible: false,
    recoveryRequired: false,
    error: { code: "WORKFLOW_REQUEST_INVALID", message: workflowErrorMessage(detail) },
  });
}

function writeJournalRecoveryStatus(config, raw, detail) {
  const paths = systemWorkflowPaths(config);
  const previous = boundedJson(paths.status, MAX_WORKFLOW_BYTES);
  if (previous?.schema === SYSTEM_WORKFLOW_STATUS_SCHEMA
    && previous.phase === "recovery-needed"
    && previous.error?.code === "WORKFLOW_JOURNAL_INVALID") return;
  const at = new Date().toISOString();
  const safeDetail = workflowDetail(detail);
  const request = raw?.request;
  const id = typeof raw?.id === "string" && UUID.test(raw.id)
    ? raw.id
    : typeof request?.id === "string" && UUID.test(request.id) ? request.id : randomUUID();
  const revision = Number.isSafeInteger(previous?.revision) && previous.revision >= 0
    ? previous.revision + 1 : 0;
  const host = request?.host
    && typeof request.host === "object"
    && typeof request.host.version === "string"
    && VERSION.test(request.host.version)
    && Number.isSafeInteger(request.host.generation)
    && request.host.generation > 0
    && typeof request.host.manifestSha256 === "string"
    && DIGEST.test(request.host.manifestSha256)
    ? {
        targetVersion: request.host.version,
        targetGeneration: request.host.generation,
        manifestSha256: request.host.manifestSha256,
        operationId: null,
        phase: "recovery-needed",
      }
    : null;
  durableJson(paths.status, {
    schema: SYSTEM_WORKFLOW_STATUS_SCHEMA,
    revision,
    id,
    action: "update-everything",
    phase: "recovery-needed",
    requestedAt: projectionTimestamp(request?.requestedAt, at),
    startedAt: projectionTimestamp(raw?.startedAt, at),
    updatedAt: at,
    completedAt: null,
    detail: safeDetail,
    backup: { phase: "failed", verified: false, completedAt: null, receipt: null },
    host,
    app: null,
    cancellationEligible: false,
    recoveryRequired: true,
    error: { code: "WORKFLOW_JOURNAL_INVALID", message: workflowErrorMessage(detail) },
  });
}

export function pendingSystemWorkflowRequest(config) {
  if (existsSync(systemWorkflowPaths(config).journal)) return null;
  return oldestInboxRequest(config);
}

export async function prepareSystemWorkflow(config, pending, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const raw = pending?.value ?? null;
  let request;
  try {
    request = validatedSystemWorkflowRequest(raw, config, pending?.name);
    if (request.action !== "update-everything") {
      throw new Error("Application retry is valid only for its existing failed workflow");
    }
  } catch (error) {
    const detail = error instanceof Error ? bounded(error.message) : "Invalid workflow request";
    writeFailedRequestStatus(config, raw, detail);
    if (pending?.path) removeFileDurable(pending.path);
    return null;
  }

  let journal = initialJournal(request, pending.name);
  try {
    if (otherMutationPending(config)) {
      throw new Error("Another system mutation is queued or active; no update was started");
    }
    bridgeReadyForWorkflow(config);
    const current = currentReleaseEnvironment(config);
    await activeServices(config, composeCommand);
    const runningVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (runningVersion !== current.version) {
      throw new Error(
        `The running application reports ${runningVersion || "unknown"}, but the immutable release state reports ${current.version}`,
      );
    }
    if (request.app && current.version !== request.app.previousVersion) {
      throw new Error(
        `Application ${request.app.previousVersion} was expected, but the installed release is ${current.version}`,
      );
    }
    journal = persistJournal(config, journal);
    // The journal now owns the complete immutable request. Removing the inbox
    // copy prevents it from being confused with a later application retry.
    removeWorkflowRequest(config, journal);
    journal = transition(
      config,
      journal,
      "backup-active",
      "Creating and verifying the pre-update backup",
    );
    const output = await composeCommand(
      config,
      ["--profile", "maintenance", "run", "--rm", "--no-deps", "stugu-backup"],
    );
    const backupReceipt = parseBackupReceipt(output);
    journal = transition(
      config,
      journal,
      "backup-complete",
      "Verified backup complete; the host update can now be staged",
      { backupReceipt },
    );
    return journal;
  } catch (error) {
    const detail = error instanceof Error ? bounded(error.message) : "Workflow preparation failed";
    if (journal.phase === "backup-active"
      && (error?.code === "COMMAND_TIMEOUT" || error?.processTreeTerminated === false)) {
      return transition(
        config,
        journal,
        "recovery-needed",
        `${detail} Confirm the backup process is idle before recovering this workflow.`,
        { error: { code: "BACKUP_STATE_UNCERTAIN", message: detail } },
      );
    }
    if (existsSync(systemWorkflowPaths(config).journal)) {
      journal = transition(
        config,
        journal,
        "failed",
        detail,
        { error: { code: "WORKFLOW_PREPARATION_FAILED", message: detail } },
      );
      finishWorkflow(config, journal);
    } else {
      writeFailedRequestStatus(config, raw, detail);
      removeFileDurable(pending.path);
    }
    return null;
  }
}

function bridgeStageRequest(journal) {
  return {
    schema: HOST_BRIDGE_REQUEST_SCHEMA,
    id: journal.bridgeRequestId,
    requestedAt: journal.bridgeRequestedAt,
    operation: "stage",
    workflowId: journal.id,
    channel: "stable",
    expectedVersion: journal.request.host.version,
    expectedGeneration: journal.request.host.generation,
    expectedManifestSha256: journal.request.host.manifestSha256,
  };
}

function ensureSafeDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is unavailable`);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} is invalid`);
}

function assertBridgeDirectories(config) {
  const paths = systemWorkflowPaths(config);
  ensureSafeDirectory(config.operationsDirectory, "The update operations directory");
  ensureSafeDirectory(join(config.operationsDirectory, "host-bridge"), "The native host update bridge directory");
  ensureSafeDirectory(paths.bridgeRequests, "The native host update bridge inbox");
}

function exactExistingFile(path, expected, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_WORKFLOW_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  if (readFileSync(path, "utf8") !== expected) {
    throw new Error(`${label} does not match this workflow`);
  }
}

function enqueueBridgeStage(config, journal) {
  const paths = systemWorkflowPaths(config);
  if (existsSync(join(config.operationsDirectory, "agent.lock"))) return journal;
  let next = journal;
  if (next.phase === "backup-complete") {
    const bridgeRequestId = randomUUID();
    const bridgeRequestedAt = new Date().toISOString();
    next = transition(
      config,
      next,
      "host-stage-queueing",
      "Handing the exact signed host target to the native updater",
      {
        bridgeRequestId,
        bridgeRequestFile: `request-${bridgeRequestId}.json`,
        bridgeRequestedAt,
      },
    );
  }
  assertBridgeDirectories(config);
  const requestPath = join(paths.bridgeRequests, next.bridgeRequestFile);
  const expected = `${JSON.stringify(bridgeStageRequest(next), null, 2)}\n`;
  if (existsSync(requestPath)) {
    exactExistingFile(requestPath, expected, "The durable host staging intent");
  } else {
    writeTextDurableAtomic(requestPath, expected, 0o640);
  }
  return transition(
    config,
    next,
    "host-stage-requested",
    "Waiting for the native updater to stage the signed host release",
  );
}

function bridgeMatches(journal, bridge) {
  if (!bridge || bridge.workflowId !== journal.id || bridge.intentId !== journal.id) return false;
  const target = journal.request.host;
  return bridge.targetVersion === target.version
    && bridge.targetGeneration === target.generation
    && bridge.manifestSha256 === target.manifestSha256;
}

function hostFailure(config, journal, phase, code, message, bridge) {
  const next = transition(
    config,
    journal,
    phase,
    message,
    { error: { code, message } },
    { bridge },
  );
  if (TERMINAL_PHASES.has(phase)) finishWorkflow(config, next);
  return next;
}

function observeHost(config, journal) {
  const bridge = readBridgeStatus(config);
  if (!bridge) return journal;
  const matching = bridgeMatches(journal, bridge);
  const stageRequestExists = journal.bridgeRequestFile
    && existsSync(join(systemWorkflowPaths(config).bridgeRequests, journal.bridgeRequestFile));
  if (!matching) {
    if (stageRequestExists || bridge.error?.code === "HOST_UPDATER_OFFLINE") return journal;
    return hostFailure(
      config,
      journal,
      "recovery-needed",
      "HOST_STATUS_IDENTITY_LOST",
      "The native updater no longer reports the exact staged workflow identity",
      bridge,
    );
  }
  if (["ready-to-restart", "restarting", "verifying", "complete", "cancelled", "returned"]
    .includes(bridge.phase)
    && !(typeof bridge.operationId === "string" && UUID.test(bridge.operationId))) {
    return hostFailure(
      config,
      journal,
      "recovery-needed",
      "HOST_OPERATION_IDENTITY_LOST",
      "The native updater did not report the exact staged operation identity",
      bridge,
    );
  }
  if (bridge.phase === "complete" && bridge.currentGeneration !== journal.request.host.generation) {
    return hostFailure(
      config,
      journal,
      "recovery-needed",
      "HOST_GENERATION_MISMATCH",
      "The running host generation does not match the completed signed target",
      bridge,
    );
  }
  const operationId = typeof bridge.operationId === "string" && UUID.test(bridge.operationId)
    ? bridge.operationId : journal.hostOperationId;
  if (bridge.error && bridge.error.code !== "HOST_UPDATER_OFFLINE") {
    const message = bounded(String(bridge.error.message ?? "The native host update failed"));
    return hostFailure(
      config,
      journal,
      bridge.phase === "recovery-needed" ? "recovery-needed" : "failed",
      stableErrorCode(bridge.error.code, "HOST_UPDATE_FAILED"),
      message,
      bridge,
    );
  }
  const mapped = {
    checking: ["host-staging", "Checking the exact signed host target"],
    downloading: ["host-staging", "Downloading the signed host release"],
    installing: ["host-staging", "Installing the signed release into the inactive host slot"],
    "ready-to-restart": ["awaiting-restart", "Host release staged; explicit restart confirmation is required"],
    restarting: ["restarting", "Restarting into the staged host slot"],
    verifying: ["host-verifying", "Verifying trial boots and host probation after restart"],
  }[bridge.phase];
  if (mapped) {
    if (journal.phase !== mapped[0] || operationId !== journal.hostOperationId) {
      return transition(config, journal, mapped[0], mapped[1], { hostOperationId: operationId }, { bridge });
    }
    return journal;
  }
  if (bridge.phase === "complete") {
    return transition(
      config,
      journal,
      "host-complete",
      "The host release passed probation",
      { hostOperationId: operationId, error: null },
      { bridge },
    );
  }
  if (bridge.phase === "cancelled") {
    return hostFailure(config, journal, "cancelled", "HOST_UPDATE_CANCELLED", "Host update cancelled", bridge);
  }
  if (bridge.phase === "returned") {
    return hostFailure(
      config,
      journal,
      "returned",
      "HOST_UPDATE_RETURNED",
      "The host returned to its previous A/B slot; the application update was not started",
      bridge,
    );
  }
  if (bridge.phase === "recovery-needed") {
    return hostFailure(
      config,
      journal,
      "recovery-needed",
      "HOST_RECOVERY_NEEDED",
      bounded(String(bridge.detail ?? "The host update requires recovery")),
      bridge,
    );
  }
  if (bridge.phase === "failed") {
    return hostFailure(
      config,
      journal,
      "failed",
      stableErrorCode(bridge.errorCode, "HOST_UPDATE_FAILED"),
      bounded(String(bridge.detail ?? "The host update failed")),
      bridge,
    );
  }
  return journal;
}

function appRequestPath(config, journal) {
  return join(config.operationsDirectory, journal.appRequestFile);
}

function enqueueApplication(config, journal) {
  if (!journal.request.app) {
    const complete = transition(config, journal, "complete", "Host update complete; no application update was needed");
    finishWorkflow(config, complete);
    return complete;
  }
  let next = journal;
  if (next.phase === "host-complete") {
    next = transition(
      config,
      next,
      "application-queueing",
      `Queuing application ${next.request.app.version}`,
      { appRequestFile: `request-${next.request.app.id}.json` },
    );
  }
  const path = appRequestPath(config, next);
  const expected = `${JSON.stringify(next.request.app, null, 2)}\n`;
  if (existsSync(path)) {
    exactExistingFile(path, expected, "The durable application request");
  } else {
    writeTextDurableAtomic(path, expected, 0o640);
  }
  return transition(
    config,
    next,
    "application-queued",
    `Application ${next.request.app.version} is queued after the verified host update`,
  );
}

function readApplicationStatus(config, journal) {
  const status = boundedJson(join(config.operationsDirectory, "status.json"), MAX_WORKFLOW_BYTES);
  return status?.id === journal.request.app?.id ? status : null;
}

function consumeApplicationRetry(config, journal) {
  const pending = oldestInboxRequest(config);
  if (!pending) return journal;
  let retry;
  try {
    retry = validatedSystemWorkflowRequest(pending.value, config, pending.name);
  } catch (error) {
    removeFileDurable(pending.path);
    return transition(
      config,
      journal,
      "application-failed",
      journal.detail,
      {
        error: {
          code: "APPLICATION_RETRY_INVALID",
          message: error instanceof Error ? bounded(error.message) : "Application retry is invalid",
        },
      },
    );
  }
  if (retry.action !== "retry-application" || retry.workflowId !== journal.id) {
    removeFileDurable(pending.path);
    return transition(
      config,
      journal,
      "application-failed",
      journal.detail,
      {
        error: {
          code: "APPLICATION_RETRY_MISMATCH",
          message: "Application retry does not match the completed host workflow and signed app target",
        },
      },
    );
  }
  const retryApp = validatedAppRequest({
    ...journal.request.app,
    id: retry.id,
    requestedAt: retry.requestedAt,
  }, config);
  const next = transition(
    config,
    journal,
    "host-complete",
    "Application retry accepted for the same signed target",
    {
      request: { ...journal.request, app: retryApp },
      appRequestFile: null,
      error: null,
    },
  );
  removeFileDurable(pending.path);
  return enqueueApplication(config, next);
}

function observeApplication(config, journal) {
  if (journal.phase === "application-failed") return consumeApplicationRetry(config, journal);
  const status = readApplicationStatus(config, journal);
  if (!status) return journal;
  if (status.phase === "complete") {
    const complete = transition(
      config,
      journal,
      "complete",
      `Host and application ${journal.request.app.version} are healthy`,
      { error: null },
      { appStatus: status },
    );
    finishWorkflow(config, complete);
    return complete;
  }
  if (status.phase === "failed") {
    if (existsSync(join(config.operationsDirectory, "update-journal.json"))) {
      return transition(
        config,
        journal,
        "recovery-needed",
        bounded(String(status.detail ?? "Application recovery requires operator review")),
        {
          error: {
            code: "APPLICATION_RECOVERY_NEEDED",
            message: bounded(String(status.detail ?? "Application recovery requires operator review")),
          },
        },
        { appStatus: status },
      );
    }
    return transition(
      config,
      journal,
      "application-failed",
      bounded(String(status.detail ?? "The application update failed after the host update")),
      {
        error: {
          code: "APPLICATION_UPDATE_FAILED",
          message: bounded(String(status.detail ?? "Application update failed")),
        },
      },
      { appStatus: status },
    );
  }
  if (APP_ACTIVE_PHASES.has(status.phase) && journal.phase !== "application-updating") {
    return transition(
      config,
      journal,
      "application-updating",
      bounded(String(status.detail ?? `Updating application ${journal.request.app.version}`)),
      {},
      { appStatus: status },
    );
  }
  return journal;
}

export function systemWorkflowApplicationWork(config) {
  let journal;
  try {
    journal = readSystemWorkflowJournal(config);
  } catch {
    return null;
  }
  if (!journal || !["application-queued", "application-updating"].includes(journal.phase)) return null;
  if (existsSync(join(config.operationsDirectory, "update-journal.json"))) {
    return { kind: "update", path: null };
  }
  const path = appRequestPath(config, journal);
  return existsSync(path) ? { kind: "update", path } : null;
}

export function systemWorkflowBlocksMutations(config) {
  return existsSync(systemWorkflowPaths(config).journal);
}

export function systemWorkflowNeedsStageEnqueue(config) {
  try {
    const journal = readSystemWorkflowJournal(config);
    return Boolean(journal && ["backup-complete", "host-stage-queueing"].includes(journal.phase));
  } catch {
    return false;
  }
}

export async function advanceSystemWorkflow(config) {
  let journal;
  try {
    journal = readSystemWorkflowJournal(config);
  } catch (error) {
    const raw = boundedJson(systemWorkflowPaths(config).journal, MAX_WORKFLOW_BYTES);
    writeJournalRecoveryStatus(
      config,
      raw,
      error instanceof Error ? bounded(error.message) : "Workflow journal is invalid",
    );
    return null;
  }
  if (!journal) return null;
  try {
    if (journal.phase === "backup-active") {
      return transition(
        config,
        journal,
        "recovery-needed",
        "The agent restarted while backup completion was uncertain; confirm backup activity is idle before recovery",
        {
          error: {
            code: "BACKUP_STATE_UNCERTAIN",
            message: "Backup completion could not be proven after the agent restart",
          },
        },
      );
    }
    if (["backup-complete", "host-stage-queueing"].includes(journal.phase)) {
      journal = enqueueBridgeStage(config, journal);
    }
    if ([
      "host-stage-requested",
      "host-staging",
      "awaiting-restart",
      "restarting",
      "host-verifying",
    ].includes(journal.phase)) {
      journal = observeHost(config, journal);
    }
    if (["host-complete", "application-queueing"].includes(journal.phase)) {
      journal = enqueueApplication(config, journal);
    }
    if (["application-queued", "application-updating", "application-failed"].includes(journal.phase)) {
      journal = observeApplication(config, journal);
    }
    return journal;
  } catch (error) {
    const detail = error instanceof Error ? bounded(error.message) : "Workflow state transition failed";
    return transition(
      config,
      journal,
      "recovery-needed",
      detail,
      { error: { code: "WORKFLOW_REPLAY_FAILED", message: detail } },
    );
  }
}
