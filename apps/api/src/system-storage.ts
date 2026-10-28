import { HttpError } from "./http-error.js";
import type { SystemStorageLocation, SystemStorageOperation, SystemStorageOperationPhase, SystemStorageSettings, SystemStorageStatus } from "@climate-twin/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_JSON_BYTES = 256 * 1024;
const AGENT_MAX_AGE_MS = 2 * 60_000;
const UPDATE_AGENT_CONTRACT = 3;
const COMPOSE_CONTRACT = 2;
const ACTIVE_PHASES = new Set<SystemStorageOperationPhase>([
  "queued",
  "validating",
  "backing-up",
  "quiescing",
  "copying",
  "applying",
  "verifying",
  "rolling-back",
]);
const SYSTEM_UPDATE_ACTIVE_PHASES = new Set([
  "queued", "preparing", "backup", "pulling", "applying", "verifying", "rolling-back",
]);

export interface SystemStorageChangeInput {
  settings: SystemStorageSettings;
  expectedRevision: string;
  confirmation: "APPLY_STORAGE" | "MOVE_STORAGE";
}

interface SystemStorageServiceOptions {
  operationsDirectory?: string | null;
  now?: () => Date;
}

interface AgentHeartbeat {
  runtime: "docker" | "raspberry-pi";
  updatedAt: string;
  compatible: boolean;
  storageCapable: boolean;
}

interface AgentStorageDocument {
  settings: SystemStorageSettings;
  revision: string;
  allowedRoots: string[];
  configurationError: string | null;
  updatedAt: string;
  operation: SystemStorageOperation | null;
}

const DEFAULT_SETTINGS: SystemStorageSettings = {
  timeseries: { kind: "managed", path: null },
  backups: { kind: "managed", path: null },
};

function cloneSettings(settings: SystemStorageSettings): SystemStorageSettings {
  return {
    timeseries: { ...settings.timeseries },
    backups: { ...settings.backups },
  };
}

export function systemStorageRevision(settings: SystemStorageSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function hostAbsolutePath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(value);
}

function validHostPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 4
    && value.length <= 500
    && value === value.trim()
    && hostAbsolutePath(value)
    && !/[\u0000-\u001f\u007f\s`$"'{}#=]/u.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
    && value !== "/"
    && !/^[A-Za-z]:[\\/]?$/u.test(value);
}

function normalizedLocation(value: unknown, purpose: "timeseries" | "backups"): SystemStorageLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `${purpose} storage must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "kind" && key !== "path")) {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `${purpose} storage contains an unsupported field`);
  }
  if (input.kind === "managed") {
    if (input.path !== null) throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `managed ${purpose} storage must not include a path`);
    return { kind: "managed", path: null };
  }
  if (input.kind !== "local-path" && input.kind !== "nas-path") {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `${purpose} storage kind is invalid`);
  }
  if (purpose === "timeseries" && input.kind === "nas-path") {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "TimescaleDB cannot use NAS or another network filesystem");
  }
  if (!validHostPath(input.path)) {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `${purpose} storage path must be a safe absolute host path`);
  }
  return { kind: input.kind, path: input.path };
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function pathWithinAllowedRoots(value: string, roots: string[]): boolean {
  const candidate = comparablePath(value);
  return roots.some((root) => candidate.startsWith(`${comparablePath(root)}/`));
}

export function normalizedSystemStorageSettings(value: unknown): SystemStorageSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "Storage settings must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "timeseries" && key !== "backups")) {
    throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "Storage settings contain an unsupported field");
  }
  const settings = {
    timeseries: normalizedLocation(input.timeseries, "timeseries"),
    backups: normalizedLocation(input.backups, "backups"),
  };
  if (settings.timeseries.path && settings.backups.path) {
    const timeseries = comparablePath(settings.timeseries.path);
    const backups = comparablePath(settings.backups.path);
    if (timeseries === backups
      || timeseries.startsWith(`${backups}/`)
      || backups.startsWith(`${timeseries}/`)) {
      throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "Telemetry and recovery sets must use separate directories");
    }
  }
  return settings;
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_JSON_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o640);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(dirname(path), "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function validOperation(value: unknown): SystemStorageOperation | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<SystemStorageOperation>;
  let previous: SystemStorageSettings;
  let target: SystemStorageSettings;
  try {
    previous = normalizedSystemStorageSettings(input.previous);
    target = normalizedSystemStorageSettings(input.target);
  } catch {
    return null;
  }
  if (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/iu.test(input.id)
    || typeof input.phase !== "string"
    || ![...ACTIVE_PHASES, "complete", "failed", "manual-intervention"].includes(input.phase as SystemStorageOperationPhase)
    || typeof input.requestedAt !== "string" || !Number.isFinite(Date.parse(input.requestedAt))
    || typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) return null;
  return {
    id: input.id,
    phase: input.phase as SystemStorageOperationPhase,
    requestedAt: input.requestedAt,
    startedAt: typeof input.startedAt === "string" ? input.startedAt : null,
    completedAt: typeof input.completedAt === "string" ? input.completedAt : null,
    updatedAt: input.updatedAt,
    detail: typeof input.detail === "string" ? input.detail.slice(0, 2_000) : null,
    previous,
    target,
  };
}

export class SystemStorageError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "SystemStorageError";
  }
}

export class SystemStorageService {
  readonly #directory: string | null;
  readonly #now: () => Date;

  constructor(options: SystemStorageServiceOptions) {
    this.#directory = options.operationsDirectory ?? null;
    this.#now = options.now ?? (() => new Date());
    if (this.#directory) mkdirSync(this.#directory, { recursive: true });
  }

  status(): SystemStorageStatus {
    const heartbeat = this.#heartbeat();
    const document = this.#document();
    const reason = !this.#directory
      ? "not-configured"
      : !heartbeat
        ? "agent-not-connected"
        : !heartbeat.compatible || !heartbeat.storageCapable
          ? "agent-upgrade-required"
          : !document
            ? "configuration-unavailable"
            : document.configurationError
              ? "configuration-invalid"
              : "ready";
    const settings = document?.settings ?? cloneSettings(DEFAULT_SETTINGS);
    return {
      settings: cloneSettings(settings),
      revision: document?.revision ?? systemStorageRevision(settings),
      allowedRoots: [...(document?.allowedRoots ?? [])],
      capability: {
        available: reason === "ready",
        runtime: heartbeat?.runtime ?? null,
        agentLastSeenAt: heartbeat?.updatedAt ?? null,
        reason,
        detail: document?.configurationError ?? null,
      },
      operation: document?.operation ?? null,
    };
  }

  queue(input: unknown): SystemStorageStatus {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "Storage change must be an object");
    }
    const body = input as Partial<SystemStorageChangeInput>;
    const keys = Object.keys(body);
    if (keys.some((key) => !["settings", "expectedRevision", "confirmation"].includes(key))) {
      throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", "Storage change contains an unsupported field");
    }
    const target = normalizedSystemStorageSettings(body.settings);
    const current = this.status();
    if (!current.capability.available || !this.#directory) {
      throw new SystemStorageError(503, "STORAGE_AGENT_UNAVAILABLE", "The compatible host storage agent is not connected");
    }
    for (const [purpose, location] of Object.entries(target)) {
      if (location.path && !pathWithinAllowedRoots(location.path, current.allowedRoots)) {
        throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `${purpose} storage path is outside the configured host storage roots`);
      }
    }
    if (body.expectedRevision !== current.revision) {
      throw new SystemStorageError(409, "STORAGE_SETTINGS_STALE", "Storage settings changed; reload before trying again");
    }
    const timeseriesChanged = JSON.stringify(target.timeseries) !== JSON.stringify(current.settings.timeseries);
    const backupsChanged = JSON.stringify(target.backups) !== JSON.stringify(current.settings.backups);
    if (!timeseriesChanged && !backupsChanged) return current;
    const expectedConfirmation = timeseriesChanged ? "MOVE_STORAGE" : "APPLY_STORAGE";
    if (body.confirmation !== expectedConfirmation) {
      throw new SystemStorageError(400, "INVALID_STORAGE_SETTINGS", `confirmation must be ${expectedConfirmation}`);
    }
    if (current.operation && (ACTIVE_PHASES.has(current.operation.phase)
      || current.operation.phase === "manual-intervention")) {
      throw new SystemStorageError(409, "STORAGE_CHANGE_IN_PROGRESS", "Another storage change is already in progress");
    }
    if (existsSync(join(this.#directory, "storage-journal.json"))
      || readdirSync(this.#directory).some((name) => /^storage-request-.*\.json$/u.test(name))) {
      throw new SystemStorageError(409, "STORAGE_CHANGE_IN_PROGRESS", "Another storage change is already queued or in progress");
    }
    const update = readJson(join(this.#directory, "status.json")) as { phase?: unknown } | null;
    if (typeof update?.phase === "string" && SYSTEM_UPDATE_ACTIVE_PHASES.has(update.phase)) {
      throw new SystemStorageError(409, "SYSTEM_MAINTENANCE_IN_PROGRESS", "A system update is already in progress");
    }
    const requestedAt = this.#now().toISOString();
    const id = randomUUID();
    const operation: SystemStorageOperation = {
      id,
      phase: "queued",
      requestedAt,
      startedAt: null,
      completedAt: null,
      updatedAt: requestedAt,
      detail: "Waiting for the external host agent",
      previous: cloneSettings(current.settings),
      target: cloneSettings(target),
    };
    // Queue the durable request before publishing its optimistic status. If
    // power fails between these writes, the host agent can still complete it.
    writeJson(join(this.#directory, `storage-request-${id}.json`), {
      schema: "stugu-storage-request/v1",
      id,
      requestedAt,
      expectedRevision: current.revision,
      previous: current.settings,
      target,
    });
    writeJson(join(this.#directory, "storage-status.json"), {
      schema: "stugu-storage-status/v1",
      settings: current.settings,
      revision: current.revision,
      allowedRoots: current.allowedRoots,
      configurationError: null,
      updatedAt: requestedAt,
      operation,
    });
    return this.status();
  }

  #heartbeat(): AgentHeartbeat | null {
    if (!this.#directory) return null;
    const input = readJson(join(this.#directory, "agent-status.json")) as Record<string, unknown> | null;
    if (!input || input.schema !== "stugu-update-agent/v1"
      || (input.runtime !== "docker" && input.runtime !== "raspberry-pi")
      || input.ready !== true || typeof input.updatedAt !== "string") return null;
    const timestamp = Date.parse(input.updatedAt);
    const age = this.#now().getTime() - timestamp;
    if (!Number.isFinite(timestamp) || age > AGENT_MAX_AGE_MS || age < -AGENT_MAX_AGE_MS) return null;
    const capabilities = Array.isArray(input.capabilities)
      ? input.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    return {
      runtime: input.runtime,
      updatedAt: input.updatedAt,
      compatible: input.updateAgentContract === UPDATE_AGENT_CONTRACT && input.composeContract === COMPOSE_CONTRACT,
      storageCapable: capabilities.includes("storage-settings"),
    };
  }

  #document(): AgentStorageDocument | null {
    if (!this.#directory) return null;
    const input = readJson(join(this.#directory, "storage-status.json")) as Record<string, unknown> | null;
    if (!input || input.schema !== "stugu-storage-status/v1" || typeof input.updatedAt !== "string") return null;
    try {
      const settings = normalizedSystemStorageSettings(input.settings);
      const revision = systemStorageRevision(settings);
      if (input.revision !== revision) return null;
      return {
        settings,
        revision,
        allowedRoots: Array.isArray(input.allowedRoots)
          ? input.allowedRoots.filter((value): value is string => validHostPath(value)).slice(0, 32)
          : [],
        configurationError: typeof input.configurationError === "string" ? input.configurationError.slice(0, 2_000) : null,
        updatedAt: input.updatedAt,
        operation: validOperation(input.operation),
      };
    } catch {
      return null;
    }
  }
}
