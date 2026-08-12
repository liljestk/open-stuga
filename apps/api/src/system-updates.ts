import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HostUpdatePhase,
  SystemUpdateApplicationProjection,
  SystemUpdateHostProjection,
  SystemUpdateOperationRequest,
  SystemUpdateWorkflowPhase,
  SystemUpdateWorkflowProjection,
} from "@climate-twin/contracts";
import {
  BRIDGE_REQUEST_SCHEMA,
  bridgeStatusFromJson,
  type HostBridgeStatus,
  parseSystemUpdateOperationRequest as parseOperationRequest,
  readSystemUpdateJson as readJson,
  UNIFIED_UPDATE_CAPABILITY,
  type UpdateAgentHeartbeat,
  updateAgentHeartbeatFromJson,
  type WorkflowStatusFile,
  workflowProjection,
  workflowStatusFromJson,
  WORKFLOW_REQUEST_SCHEMA,
  writeSystemUpdateJson as writeJson,
} from "./system-update-coordination.js";
import {
  fetchReleaseManifest,
  type ReleaseManifest,
  UPDATE_REQUEST_SCHEMA,
} from "./system-update-release-manifest.js";
import { canonicalSystemUpdateReason } from "./system-update-reasons.js";

const NEXT_WINDOW_CACHE_MS = 60_000;
const NEXT_WINDOW_SEARCH_MINUTES = 8 * 24 * 60;
const SYSTEM_UPDATE_PHASES = [
  "queued",
  "preparing",
  "backup",
  "pulling",
  "applying",
  "verifying",
  "complete",
  "failed",
  "rolling-back",
] as const;
const ACTIVE_PHASES = new Set<SystemUpdatePhase>([
  "queued",
  "preparing",
  "backup",
  "pulling",
  "applying",
  "verifying",
  "rolling-back",
]);
const ACTIVE_STORAGE_PHASES = new Set([
  "queued", "validating", "backing-up", "quiescing", "copying", "applying", "verifying", "rolling-back", "manual-intervention",
]);
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type SystemUpdateDay = typeof DAY_NAMES[number];
export type SystemUpdateMode = "manual" | "automatic";
export type SystemUpdatePhase = typeof SYSTEM_UPDATE_PHASES[number];

export interface SystemUpdateSettings {
  mode: SystemUpdateMode;
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
  phase: SystemUpdatePhase;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  phaseStartedAt: string;
  detail: string | null;
  previousVersion: string;
  activity: SystemUpdateActivity[];
}

export interface SystemUpdateActivity {
  phase: SystemUpdatePhase;
  at: string;
  detail: string;
}

interface ReleaseCache {
  checkedAt: string;
  releases: SystemRelease[];
  error: string | null;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  prerelease?: unknown;
  draft?: unknown;
}

export interface SystemUpdateStatus {
  schema: "stugu-system-updates/v2";
  revision: number;
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
    reason: string;
    detail?: string | null;
  };
  operation: SystemUpdateOperation | null;
  application: SystemUpdateApplicationProjection;
  host: SystemUpdateHostProjection;
  workflow: SystemUpdateWorkflowProjection | null;
}

interface SystemUpdateServiceOptions {
  currentVersion: string;
  repository: string;
  imagePrefix: string;
  operationsDirectory?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  dateTimeFormatFactory?: (timezone: string) => ZonedDateTimeFormatter;
}

type ZonedDateTimeFormatter = Pick<Intl.DateTimeFormat, "formatToParts">;

interface ZonedDateParts {
  day: SystemUpdateDay;
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  second: number;
}

interface NextWindowCache {
  computedAtMs: number;
  expiresAtMs: number;
  value: string | null;
  valueMs: number | null;
}

const DEFAULT_SETTINGS: SystemUpdateSettings = {
  mode: "manual",
  includePrereleases: false,
  checkIntervalHours: 24,
  updateTime: "03:00",
  updateDays: ["sun"],
  timezone: "UTC",
};

function parseVersion(value: string): [number, number, number, string | null] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
}

export function compareSystemVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3].localeCompare(b[3], undefined, { numeric: true });
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59;
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizedSettings(value: unknown): SystemUpdateSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS, updateDays: [...DEFAULT_SETTINGS.updateDays] };
  const input = value as Partial<SystemUpdateSettings>;
  const updateDays = Array.isArray(input.updateDays)
    ? [...new Set(input.updateDays.filter((day): day is SystemUpdateDay => DAY_NAMES.includes(day as SystemUpdateDay)))]
    : [];
  return {
    mode: input.mode === "automatic" ? "automatic" : "manual",
    includePrereleases: input.includePrereleases === true,
    checkIntervalHours: [6, 12, 24, 168].includes(Number(input.checkIntervalHours))
      ? input.checkIntervalHours as SystemUpdateSettings["checkIntervalHours"]
      : DEFAULT_SETTINGS.checkIntervalHours,
    updateTime: validTime(input.updateTime) ? input.updateTime : DEFAULT_SETTINGS.updateTime,
    updateDays: updateDays.length ? updateDays : [...DEFAULT_SETTINGS.updateDays],
    timezone: validTimezone(input.timezone) ? input.timezone : DEFAULT_SETTINGS.timezone,
  };
}

function releaseFromGitHub(value: GitHubRelease): SystemRelease | null {
  const tagName = typeof value.tag_name === "string" ? value.tag_name.trim() : "";
  const parsed = parseVersion(tagName);
  const publishedAt = typeof value.published_at === "string" && Number.isFinite(Date.parse(value.published_at))
    ? new Date(value.published_at).toISOString()
    : null;
  const url = typeof value.html_url === "string" ? value.html_url : "";
  if (!tagName.startsWith("v") || !parsed || !publishedAt || !url.startsWith("https://github.com/") || value.draft === true) return null;
  const version = tagName.replace(/^v/, "");
  return {
    version,
    tagName,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 300) : tagName,
    notes: typeof value.body === "string" ? value.body.slice(0, 64 * 1024) : "",
    publishedAt,
    url,
    prerelease: value.prerelease === true || parsed[3] !== null,
  };
}

function createZonedDateTimeFormatter(timezone: string): ZonedDateTimeFormatter {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function localDateParts(date: Date, formatter: ZonedDateTimeFormatter): ZonedDateParts {
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    day: part("weekday").toLowerCase().slice(0, 3) as SystemUpdateDay,
    year: Number(part("year")),
    month: Number(part("month")),
    date: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
  };
}

function matchingInstants(
  localYear: number,
  localMonth: number,
  localDate: number,
  targetHour: number,
  targetMinute: number,
  formatter: ZonedDateTimeFormatter,
): number[] {
  const localWallTime = Date.UTC(localYear, localMonth - 1, localDate, targetHour, targetMinute);
  const offsets = new Set<number>();
  for (const delta of [-36 * 60 * 60_000, 0, 36 * 60 * 60_000]) {
    const probe = localWallTime + delta;
    const local = localDateParts(new Date(probe), formatter);
    offsets.add(
      Date.UTC(local.year, local.month - 1, local.date, local.hour, local.minute, local.second) - probe,
    );
  }

  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = localWallTime - offset;
    const local = localDateParts(new Date(candidate), formatter);
    if (
      local.year === localYear
      && local.month === localMonth
      && local.date === localDate
      && local.hour === targetHour
      && local.minute === targetMinute
    ) {
      matches.push(candidate);
    }
  }
  return [...new Set(matches)].sort((left, right) => left - right);
}

function nextWindow(
  settings: SystemUpdateSettings,
  now: Date,
  formatter: ZonedDateTimeFormatter,
): string | null {
  const [targetHour, targetMinute] = settings.updateTime.split(":").map(Number);
  const nowMs = now.getTime();
  const roundedNowMs = nowMs - (nowMs % 60_000);
  const horizonMs = roundedNowMs + NEXT_WINDOW_SEARCH_MINUTES * 60_000;
  const localNow = localDateParts(now, formatter);

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const localCalendarDay = new Date(Date.UTC(
      localNow.year,
      localNow.month - 1,
      localNow.date + dayOffset,
    ));
    const localDay = DAY_NAMES[localCalendarDay.getUTCDay()]!;
    if (!settings.updateDays.includes(localDay)) continue;
    const candidates = matchingInstants(
      localCalendarDay.getUTCFullYear(),
      localCalendarDay.getUTCMonth() + 1,
      localCalendarDay.getUTCDate(),
      targetHour!,
      targetMinute!,
      formatter,
    );
    for (const candidate of candidates) {
      if (candidate > nowMs && candidate <= horizonMs) return new Date(candidate).toISOString();
    }
  }
  return null;
}

function operationFromJson(value: unknown): SystemUpdateOperation | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<SystemUpdateOperation>;
  if (
    typeof input.id !== "string"
    || typeof input.version !== "string"
    || typeof input.tagName !== "string"
    || typeof input.requestedAt !== "string"
    || typeof input.previousVersion !== "string"
    || typeof input.phase !== "string"
    || !SYSTEM_UPDATE_PHASES.includes(input.phase as SystemUpdatePhase)
  ) return null;
  const phase = input.phase as SystemUpdatePhase;
  const detail = typeof input.detail === "string" ? input.detail.slice(0, 2_000) : null;
  const updatedAt = typeof input.updatedAt === "string"
    ? input.updatedAt
    : typeof input.completedAt === "string"
      ? input.completedAt
      : typeof input.startedAt === "string"
        ? input.startedAt
        : input.requestedAt;
  const phaseStartedAt = typeof input.phaseStartedAt === "string" ? input.phaseStartedAt : updatedAt;
  const activity = Array.isArray(input.activity)
    ? input.activity.slice(-50).flatMap((entry): SystemUpdateActivity[] => {
      if (
        !entry
        || typeof entry !== "object"
        || typeof entry.phase !== "string"
        || !SYSTEM_UPDATE_PHASES.includes(entry.phase as SystemUpdatePhase)
        || typeof entry.at !== "string"
        || typeof entry.detail !== "string"
      ) return [];
      return [{
        phase: entry.phase as SystemUpdatePhase,
        at: entry.at,
        detail: entry.detail.slice(0, 2_000),
      }];
    })
    : [];
  return {
    id: input.id,
    version: input.version,
    tagName: input.tagName,
    phase,
    requestedAt: input.requestedAt,
    startedAt: typeof input.startedAt === "string" ? input.startedAt : null,
    completedAt: typeof input.completedAt === "string" ? input.completedAt : null,
    updatedAt,
    phaseStartedAt,
    detail,
    previousVersion: input.previousVersion,
    activity: activity.length > 0
      ? activity
      : [{ phase, at: phaseStartedAt, detail: detail ?? phase }],
  };
}

export class SystemUpdateService {
  readonly #currentVersion: string;
  readonly #repository: string;
  readonly #imagePrefix: string;
  readonly #directory: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #dateTimeFormatFactory: (timezone: string) => ZonedDateTimeFormatter;
  readonly #dateTimeFormats = new Map<string, ZonedDateTimeFormatter>();
  #settings: SystemUpdateSettings;
  #cache: ReleaseCache = { checkedAt: "", releases: [], error: null };
  #nextWindowCache: NextWindowCache | null = null;
  #checkPromise: Promise<SystemUpdateStatus> | null = null;
  #queuePromise: Promise<SystemUpdateStatus> | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  #pendingWorkflowRequest: { workflowId: string; revision: number; isNew: boolean } | null = null;
  #pendingBridgeRequestId: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SystemUpdateServiceOptions) {
    this.#currentVersion = options.currentVersion;
    this.#repository = options.repository;
    this.#imagePrefix = options.imagePrefix.replace(/-$/, "");
    this.#directory = options.operationsDirectory ?? null;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#dateTimeFormatFactory = options.dateTimeFormatFactory ?? createZonedDateTimeFormatter;
    if (this.#directory) {
      mkdirSync(this.#directory, { recursive: true });
      this.#settings = normalizedSettings(readJson(join(this.#directory, "settings.json")));
      const cached = readJson(join(this.#directory, "release-cache.json")) as Partial<ReleaseCache> | null;
      if (cached && typeof cached.checkedAt === "string" && Array.isArray(cached.releases)) {
        this.#cache = {
          checkedAt: cached.checkedAt,
          releases: cached.releases.map((release) => releaseFromGitHub({
            tag_name: release?.tagName,
            name: release?.name,
            body: release?.notes,
            html_url: release?.url,
            published_at: release?.publishedAt,
            prerelease: release?.prerelease,
          })).filter((release): release is SystemRelease => Boolean(release)),
          error: typeof cached.error === "string" ? cached.error : null,
        };
      }
    } else {
      this.#settings = normalizedSettings(null);
    }
  }

  start(): void {
    if (this.#timer) return;
    void this.#tick().catch(() => undefined);
    this.#timer = setInterval(() => void this.#tick().catch(() => undefined), 60_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async check(): Promise<SystemUpdateStatus> {
    if (this.#checkPromise) return this.#checkPromise;
    this.#checkPromise = this.#performCheckAndHost();
    try {
      return await this.#checkPromise;
    } finally {
      this.#checkPromise = null;
    }
  }

  status(): SystemUpdateStatus {
    const releases = this.#eligibleReleases();
    const latestRelease = releases[0] ?? null;
    const heartbeat = this.#heartbeat();
    const operation = this.#operation();
    const workflowFile = this.#workflowStatus();
    if (workflowFile && this.#pendingWorkflowRequest
      && workflowFile.id === this.#pendingWorkflowRequest.workflowId
      && (this.#pendingWorkflowRequest.isNew || workflowFile.revision > this.#pendingWorkflowRequest.revision)) {
      this.#pendingWorkflowRequest = null;
    }
    const workflow = workflowFile ? workflowProjection(workflowFile) : null;
    if (workflow) workflow.reason = canonicalSystemUpdateReason(workflow.reason);
    const bridge = this.#bridgeStatus();
    if (bridge?.requestId === this.#pendingBridgeRequestId) this.#pendingBridgeRequestId = null;
    const host = this.#hostProjection(heartbeat, bridge);
    const capabilityReason = !this.#directory
      ? "not-configured"
      : !heartbeat
        ? "agent-not-connected"
        : !heartbeat.compatible
          ? "agent-upgrade-required"
          : heartbeat.systemUpdateReason ?? (heartbeat.ready ? "ready" : "agent-not-ready");
    const capability = {
      available: capabilityReason === "ready",
      runtime: heartbeat?.runtime ?? null,
      agentLastSeenAt: heartbeat?.updatedAt ?? null,
      reason: capabilityReason,
      ...(heartbeat?.detail ? { detail: heartbeat.detail } : {}),
    };
    const updateAvailable = Boolean(latestRelease && compareSystemVersions(latestRelease.version, this.#currentVersion) > 0);
    const application: SystemUpdateApplicationProjection = {
      currentVersion: this.#currentVersion,
      latestVersion: latestRelease?.version ?? null,
      updateAvailable,
      capability,
      operation,
    };
    return {
      schema: "stugu-system-updates/v2",
      revision: workflow?.revision ?? 0,
      currentVersion: this.#currentVersion,
      latestVersion: latestRelease?.version ?? null,
      updateAvailable,
      latestRelease,
      releases: releases.slice(0, 10),
      lastCheckedAt: this.#cache.checkedAt || null,
      checkError: this.#cache.error,
      settings: { ...this.#settings, updateDays: [...this.#settings.updateDays] },
      nextUpdateWindowAt: this.#settings.mode === "automatic" ? this.#nextUpdateWindow(this.#now()) : null,
      capability,
      operation,
      application,
      host,
      workflow,
    };
  }

  updateSettings(patch: unknown): SystemUpdateStatus {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Update settings must be an object");
    const candidate = { ...this.#settings, ...(patch as Partial<SystemUpdateSettings>) };
    const normalized = normalizedSettings(candidate);
    if (candidate.mode !== normalized.mode) throw new TypeError("mode must be manual or automatic");
    if (candidate.includePrereleases !== normalized.includePrereleases) throw new TypeError("includePrereleases must be boolean");
    if (candidate.checkIntervalHours !== normalized.checkIntervalHours) throw new TypeError("checkIntervalHours must be 6, 12, 24, or 168");
    if (candidate.updateTime !== normalized.updateTime) throw new TypeError("updateTime must use HH:mm");
    if (!Array.isArray(candidate.updateDays) || candidate.updateDays.length !== normalized.updateDays.length) {
      throw new TypeError("updateDays must contain one or more unique weekday names");
    }
    if (candidate.timezone !== normalized.timezone) throw new TypeError("timezone must be a valid IANA time zone");
    this.#settings = normalized;
    this.#nextWindowCache = null;
    if (this.#directory) writeJson(join(this.#directory, "settings.json"), this.#settings);
    return this.status();
  }

  async queueLatest(): Promise<SystemUpdateStatus> {
    if (this.#queuePromise) return this.#queuePromise;
    const run = this.#serializeMutation(() => this.#queueLatest());
    this.#queuePromise = run;
    try {
      return await run;
    } finally {
      if (this.#queuePromise === run) this.#queuePromise = null;
    }
  }

  async #queueLatest(): Promise<SystemUpdateStatus> {
    this.#assertAppOnlyInstallMayQueue();
    if (!this.#cache.checkedAt) await this.#performCheck();
    const status = this.status();
    const release = status.latestRelease;
    if (!release || !status.updateAvailable) throw new SystemUpdateError(409, "NO_UPDATE_AVAILABLE", "The current version is already up to date");
    if (!status.capability.available || !this.#directory) {
      if (status.capability.reason === "agent-upgrade-required") {
        throw new SystemUpdateError(
          503,
          "UPDATE_AGENT_UPGRADE_REQUIRED",
          "The connected update agent uses the legacy request contract and must be upgraded first",
        );
      }
      if (status.capability.reason === "appliance-upgrade-required") {
        throw new SystemUpdateError(
          503,
          "APPLIANCE_UPGRADE_REQUIRED",
          "This Raspberry Pi requires a verified factory-image transition before another container update",
        );
      }
      throw new SystemUpdateError(503, "UPDATE_AGENT_UNAVAILABLE", "The external update agent is not connected");
    }
    if (status.operation && ACTIVE_PHASES.has(status.operation.phase)) {
      if (status.operation.version === release.version) return status;
      throw new SystemUpdateError(409, "UPDATE_IN_PROGRESS", "Another system update is already in progress");
    }
    const storage = this.#directory
      ? readJson(join(this.#directory, "storage-status.json")) as { operation?: { phase?: unknown } } | null
      : null;
    if (typeof storage?.operation?.phase === "string" && ACTIVE_STORAGE_PHASES.has(storage.operation.phase)) {
      throw new SystemUpdateError(409, "SYSTEM_MAINTENANCE_IN_PROGRESS", "A storage change is already in progress");
    }
    const manifest = await this.#releaseManifest(release);
    this.#assertAppOnlyInstallMayQueue();
    const currentOperation = this.#operation();
    if (currentOperation && ACTIVE_PHASES.has(currentOperation.phase)) {
      if (currentOperation.version === release.version) return this.status();
      throw new SystemUpdateError(409, "UPDATE_IN_PROGRESS", "Another system update is already in progress");
    }
    if (this.#storageOperationActive()) {
      throw new SystemUpdateError(409, "SYSTEM_MAINTENANCE_IN_PROGRESS", "A storage change is already in progress");
    }

    const requestedAt = this.#now().toISOString();
    const id = randomUUID();
    const operation = this.#queuedApplicationOperation(release, requestedAt, id);
    writeJson(join(this.#directory, "status.json"), operation);
    writeJson(
      join(this.#directory, `request-${requestedAt.replaceAll(":", "-")}-${id}.json`),
      this.#applicationRequest(operation, manifest),
    );
    return this.status();
  }

  requestOperation(input: unknown): Promise<SystemUpdateStatus> {
    const request = parseOperationRequest(input);
    return this.#serializeMutation(() => this.#performOperation(request));
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertAppOnlyInstallMayQueue(): void {
    const workflow = this.#workflowStatus();
    if (this.#pendingWorkflowRequest
      || (workflow && workflow.phase !== "complete" && workflow.phase !== "cancelled")) {
      throw new SystemUpdateError(
        409,
        "SYSTEM_UPDATE_IN_PROGRESS",
        "A unified system update must finish before an app-only update can be queued",
      );
    }
  }

  #queuedApplicationOperation(release: SystemRelease, requestedAt: string, id: string): SystemUpdateOperation {
    return {
      id,
      version: release.version,
      tagName: release.tagName,
      phase: "queued",
      requestedAt,
      startedAt: null,
      completedAt: null,
      updatedAt: requestedAt,
      phaseStartedAt: requestedAt,
      detail: "Waiting for the external update agent",
      previousVersion: this.#currentVersion,
      activity: [{
        phase: "queued",
        at: requestedAt,
        detail: "Update requested; waiting for the external update agent",
      }],
    };
  }

  #applicationRequest(operation: SystemUpdateOperation, manifest: ReleaseManifest): Record<string, unknown> {
    return {
      schema: UPDATE_REQUEST_SCHEMA,
      ...operation,
      repository: this.#repository,
      releaseManifestSchema: manifest.schema,
      compatibility: manifest.compatibility,
      images: manifest.images,
    };
  }

  async #performOperation(request: SystemUpdateOperationRequest): Promise<SystemUpdateStatus> {
    const workflow = this.#workflowStatus();
    const revision = workflow?.revision ?? 0;
    if (request.expectedRevision !== revision) {
      throw new SystemUpdateError(
        409,
        "SYSTEM_UPDATE_REVISION_CONFLICT",
        `System update state changed; expected revision ${request.expectedRevision}, current revision is ${revision}`,
      );
    }
    if (this.#pendingWorkflowRequest) {
      throw new SystemUpdateError(409, "SYSTEM_UPDATE_REQUEST_PENDING", "A system update request is awaiting agent acceptance");
    }

    if (request.action === "update-everything") {
      return this.#requestUpdateEverything(request.expectedRevision, workflow);
    }
    if (!workflow || workflow.id !== request.workflowId) {
      throw new SystemUpdateError(409, "SYSTEM_UPDATE_WORKFLOW_MISMATCH", "The requested workflow is no longer current");
    }
    if (request.action === "retry-application") {
      return this.#requestApplicationRetry(request, workflow);
    }
    return this.#requestHostMutation(request, workflow);
  }

  async #requestUpdateEverything(
    expectedRevision: number,
    existingWorkflow: WorkflowStatusFile | null,
  ): Promise<SystemUpdateStatus> {
    const terminal = new Set<SystemUpdateWorkflowPhase>(["complete", "failed", "cancelled", "returned", "recovery-needed"]);
    if (existingWorkflow && !terminal.has(existingWorkflow.phase)) {
      throw new SystemUpdateError(409, "SYSTEM_UPDATE_IN_PROGRESS", "A unified system update is already in progress");
    }
    this.#requireUnifiedCapability(true);
    if (!this.#directory) {
      throw new SystemUpdateError(503, "SYSTEM_UPDATE_NOT_CONFIGURED", "System updates are not configured");
    }
    const applicationOperation = this.#operation();
    if (applicationOperation && ACTIVE_PHASES.has(applicationOperation.phase)) {
      throw new SystemUpdateError(409, "UPDATE_IN_PROGRESS", "An application update is already in progress");
    }
    if (this.#storageOperationActive()) {
      throw new SystemUpdateError(409, "SYSTEM_MAINTENANCE_IN_PROGRESS", "A storage change is already in progress");
    }
    if (!this.#cache.checkedAt) await this.#performCheck();

    const bridge = this.#requireBridgeStatus();
    if (
      bridge.phase !== "available"
      || !bridge.targetVersion
      || !bridge.targetGeneration
      || !bridge.manifestSha256
      || bridge.targetGeneration <= bridge.currentGeneration
    ) {
      throw new SystemUpdateError(409, "NO_HOST_UPDATE_AVAILABLE", "No verified host update is ready to stage");
    }
    const targetRelease = this.#eligibleReleases().find((release) => release.version === bridge.targetVersion) ?? null;
    const comparison = compareSystemVersions(bridge.targetVersion, this.#currentVersion);
    if (comparison < 0) {
      throw new SystemUpdateError(409, "INCOMPATIBLE_UPDATE_TARGET", "The host target is older than the running application");
    }
    if (comparison > 0 && !targetRelease) {
      throw new SystemUpdateError(409, "APPLICATION_RELEASE_NOT_FOUND", "The host target has no matching eligible application release");
    }
    const manifest = targetRelease && comparison > 0 ? await this.#releaseManifest(targetRelease) : null;

    const currentWorkflow = this.#workflowStatus();
    if ((currentWorkflow?.revision ?? 0) !== expectedRevision || currentWorkflow?.id !== existingWorkflow?.id) {
      throw new SystemUpdateError(409, "SYSTEM_UPDATE_REVISION_CONFLICT", "System update state changed while binding release targets");
    }
    const currentBridge = this.#requireBridgeStatus();
    if (
      currentBridge.phase !== "available"
      || currentBridge.targetVersion !== bridge.targetVersion
      || currentBridge.targetGeneration !== bridge.targetGeneration
      || currentBridge.manifestSha256 !== bridge.manifestSha256
    ) {
      throw new SystemUpdateError(409, "HOST_UPDATE_TARGET_CHANGED", "The verified host update target changed while the request was prepared");
    }
    this.#requireUnifiedCapability(true);
    if (this.#storageOperationActive()) {
      throw new SystemUpdateError(409, "SYSTEM_MAINTENANCE_IN_PROGRESS", "The update agent became busy while the request was prepared");
    }
    if (this.#pendingWorkflowRequest) {
      throw new SystemUpdateError(409, "SYSTEM_UPDATE_REQUEST_PENDING", "A system update request is awaiting agent acceptance");
    }
    const currentApplicationOperation = this.#operation();
    if (currentApplicationOperation && ACTIVE_PHASES.has(currentApplicationOperation.phase)) {
      throw new SystemUpdateError(409, "UPDATE_IN_PROGRESS", "An application update became active while release targets were bound");
    }

    const requestedAt = this.#now().toISOString();
    const workflowId = randomUUID();
    const app = targetRelease && manifest
      ? this.#applicationRequest(
        this.#queuedApplicationOperation(targetRelease, requestedAt, randomUUID()),
        manifest,
      )
      : null;
    const inbox = join(this.#directory, "system-workflow-requests");
    mkdirSync(inbox, { recursive: true });
    writeJson(join(inbox, `request-${workflowId}.json`), {
      schema: WORKFLOW_REQUEST_SCHEMA,
      id: workflowId,
      action: "update-everything",
      requestedAt,
      app,
      host: {
        version: bridge.targetVersion,
        generation: bridge.targetGeneration,
        manifestSha256: bridge.manifestSha256,
      },
    });
    this.#pendingWorkflowRequest = { workflowId, revision: expectedRevision, isNew: true };
    return this.status();
  }

  #requestApplicationRetry(
    request: Extract<SystemUpdateOperationRequest, { action: "retry-application" }>,
    workflow: WorkflowStatusFile,
  ): SystemUpdateStatus {
    const heartbeat = this.#requireUnifiedCapability(false);
    if (!heartbeat.ready && heartbeat.systemUpdateReason !== "system-update-workflow-active") {
      throw new SystemUpdateError(
        409,
        "UPDATE_AGENT_BUSY",
        heartbeat.detail ?? heartbeat.systemUpdateReason ?? "The update agent is busy",
      );
    }
    if (!this.#directory) {
      throw new SystemUpdateError(503, "SYSTEM_UPDATE_NOT_CONFIGURED", "System updates are not configured");
    }
    if (workflow.phase !== "application-failed" || workflow.host?.phase !== "complete" || !workflow.app) {
      throw new SystemUpdateError(
        409,
        "APPLICATION_RETRY_UNAVAILABLE",
        "Application retry is available only after a completed host update and a failed application update",
      );
    }
    const id = randomUUID();
    const inbox = join(this.#directory, "system-workflow-requests");
    mkdirSync(inbox, { recursive: true });
    writeJson(join(inbox, `request-${id}.json`), {
      schema: WORKFLOW_REQUEST_SCHEMA,
      id,
      action: "retry-application",
      requestedAt: this.#now().toISOString(),
      workflowId: request.workflowId,
    });
    this.#pendingWorkflowRequest = {
      workflowId: workflow.id,
      revision: workflow.revision,
      isNew: false,
    };
    return this.status();
  }

  #requestHostMutation(
    request: Extract<SystemUpdateOperationRequest, { action: "activate-host" | "cancel-host" }>,
    workflow: WorkflowStatusFile,
  ): SystemUpdateStatus {
    this.#requireUnifiedCapability(false);
    if (this.#pendingBridgeRequestId) {
      throw new SystemUpdateError(409, "HOST_UPDATE_REQUEST_PENDING", "A host update action is awaiting bridge acceptance");
    }
    const bridge = this.#requireBridgeStatus();
    const exactBinding = workflow.host !== null
      && workflow.host.operationId === request.hostOperationId
      && workflow.host.targetVersion === request.targetVersion
      && workflow.host.targetGeneration === request.targetGeneration
      && workflow.host.manifestSha256 === request.targetDigest
      && bridge.operationId === request.hostOperationId
      && bridge.targetVersion === request.targetVersion
      && bridge.targetGeneration === request.targetGeneration
      && bridge.manifestSha256 === request.targetDigest;
    if (!exactBinding) {
      throw new SystemUpdateError(409, "HOST_UPDATE_BINDING_MISMATCH", "Host operation identity no longer matches the workflow");
    }
    if (request.action === "activate-host" && (workflow.phase !== "awaiting-restart" || bridge.phase !== "ready-to-restart")) {
      throw new SystemUpdateError(409, "HOST_UPDATE_NOT_READY", "The bound host update is not ready to restart and install");
    }
    if (request.action === "cancel-host" && !workflow.cancellationEligible) {
      throw new SystemUpdateError(409, "HOST_UPDATE_NOT_CANCELLABLE", "The bound host update can no longer be cancelled safely");
    }
    if (!this.#directory) {
      throw new SystemUpdateError(503, "SYSTEM_UPDATE_NOT_CONFIGURED", "System updates are not configured");
    }
    const id = randomUUID();
    const requests = join(this.#directory, "host-bridge", "requests");
    mkdirSync(requests, { recursive: true });
    writeJson(join(requests, `request-${id}.json`), {
      schema: BRIDGE_REQUEST_SCHEMA,
      id,
      requestedAt: this.#now().toISOString(),
      operation: request.action === "activate-host" ? "activate" : "cancel",
      workflowId: request.workflowId,
      ...(request.action === "activate-host" ? { confirmation: "RESTART_AND_INSTALL" } : {}),
      expectedOperationId: request.hostOperationId,
      expectedVersion: request.targetVersion,
      expectedGeneration: request.targetGeneration,
      expectedManifestSha256: request.targetDigest,
    });
    this.#pendingBridgeRequestId = id;
    return this.status();
  }

  #requireUnifiedCapability(requireReady: boolean): UpdateAgentHeartbeat {
    const heartbeat = this.#heartbeat();
    if (!heartbeat) {
      throw new SystemUpdateError(503, "UPDATE_AGENT_UNAVAILABLE", "The external update agent is not connected");
    }
    if (heartbeat.runtime !== "raspberry-pi") {
      throw new SystemUpdateError(409, "HOST_UPDATE_UNSUPPORTED", "Host updates are available only on Stugu Raspberry Pi appliances");
    }
    if (!heartbeat.compatible || !heartbeat.capabilities.includes(UNIFIED_UPDATE_CAPABILITY)) {
      if (heartbeat.systemUpdateReason === "appliance-upgrade-required") {
        throw new SystemUpdateError(503, "FACTORY_TRANSITION_REQUIRED", "This appliance must complete its verified factory transition first");
      }
      throw new SystemUpdateError(503, "UPDATE_AGENT_UPGRADE_REQUIRED", "The update agent must be upgraded before unified updates are available");
    }
    if (requireReady && !heartbeat.ready) {
      throw new SystemUpdateError(
        409,
        "UPDATE_AGENT_BUSY",
        heartbeat.detail ?? heartbeat.systemUpdateReason ?? "The update agent is busy",
      );
    }
    return heartbeat;
  }

  #requireBridgeStatus(): HostBridgeStatus {
    const bridge = this.#bridgeStatus();
    if (!bridge) {
      throw new SystemUpdateError(503, "HOST_UPDATE_BRIDGE_UNAVAILABLE", "The host update bridge is not connected");
    }
    if (!bridge.available) {
      throw new SystemUpdateError(
        503,
        bridge.error?.code ?? "HOST_UPDATER_OFFLINE",
        bridge.error?.message ?? "The native host updater is unavailable",
      );
    }
    return bridge;
  }

  #storageOperationActive(): boolean {
    if (!this.#directory) return false;
    const storage = readJson(join(this.#directory, "storage-status.json")) as { operation?: { phase?: unknown } } | null;
    return typeof storage?.operation?.phase === "string" && ACTIVE_STORAGE_PHASES.has(storage.operation.phase);
  }

  async #releaseManifest(release: SystemRelease): Promise<ReleaseManifest> {
    try {
      return await fetchReleaseManifest({
        fetchImpl: this.#fetch,
        currentVersion: this.#currentVersion,
        repository: this.#repository,
        imagePrefix: this.#imagePrefix,
        release,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "release manifest validation failed";
      throw new SystemUpdateError(
        502,
        "RELEASE_MANIFEST_INVALID",
        `The release has no compatible immutable update manifest: ${detail}`,
      );
    }
  }

  async #performCheckAndHost(): Promise<SystemUpdateStatus> {
    await this.#performCheck();
    this.#queueHostCheckIfSafe();
    return this.status();
  }

  #queueHostCheckIfSafe(): void {
    if (!this.#directory || this.#pendingBridgeRequestId) return;
    const heartbeat = this.#heartbeat();
    if (!heartbeat
      || heartbeat.runtime !== "raspberry-pi"
      || !heartbeat.compatible
      || !heartbeat.ready
      || !heartbeat.capabilities.includes(UNIFIED_UPDATE_CAPABILITY)) return;
    const workflow = this.#workflowStatus();
    const terminal = new Set<SystemUpdateWorkflowPhase>(["complete", "failed", "cancelled", "returned", "recovery-needed"]);
    if (workflow && !terminal.has(workflow.phase)) return;
    const applicationOperation = this.#operation();
    if (applicationOperation && ACTIVE_PHASES.has(applicationOperation.phase)) return;
    const bridge = this.#bridgeStatus();
    if (!bridge?.available || !new Set<HostUpdatePhase>([
      "idle", "current", "available", "complete", "cancelled", "failed",
    ]).has(bridge.phase)) return;
    const id = randomUUID();
    const requests = join(this.#directory, "host-bridge", "requests");
    mkdirSync(requests, { recursive: true });
    writeJson(join(requests, `request-${id}.json`), {
      schema: BRIDGE_REQUEST_SCHEMA,
      id,
      requestedAt: this.#now().toISOString(),
      operation: "check",
    });
    this.#pendingBridgeRequestId = id;
  }

  async #performCheck(): Promise<SystemUpdateStatus> {
    const checkedAt = this.#now().toISOString();
    try {
      const response = await this.#fetch(`https://api.github.com/repos/${this.#repository}/releases?per_page=20`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Stugu/${this.#currentVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error("GitHub Releases returned an invalid response");
      const releases = payload
        .map((release) => releaseFromGitHub(release as GitHubRelease))
        .filter((release): release is SystemRelease => Boolean(release))
        .sort((left, right) => compareSystemVersions(right.version, left.version));
      this.#cache = { checkedAt, releases, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Release check failed";
      this.#cache = { ...this.#cache, checkedAt, error: message.slice(0, 500) };
    }
    if (this.#directory) writeJson(join(this.#directory, "release-cache.json"), this.#cache);
    return this.status();
  }

  #eligibleReleases(): SystemRelease[] {
    return this.#cache.releases
      .filter((release) => this.#settings.includePrereleases || !release.prerelease)
      .sort((left, right) => compareSystemVersions(right.version, left.version));
  }

  #heartbeat(): UpdateAgentHeartbeat | null {
    if (!this.#directory) return null;
    return updateAgentHeartbeatFromJson(
      readJson(join(this.#directory, "agent-status.json"), 16 * 1024),
      this.#now().getTime(),
    );
  }

  #bridgeStatus(): HostBridgeStatus | null {
    if (!this.#directory) return null;
    return bridgeStatusFromJson(
      readJson(join(this.#directory, "host-bridge", "status", "status.json"), 16 * 1024),
      this.#now().getTime(),
    );
  }

  #workflowStatus(): WorkflowStatusFile | null {
    if (!this.#directory) return null;
    return workflowStatusFromJson(readJson(join(this.#directory, "workflow-status.json"), 64 * 1024));
  }

  #hostProjection(
    heartbeat: UpdateAgentHeartbeat | null,
    bridge: HostBridgeStatus | null,
  ): SystemUpdateHostProjection {
    const unavailable = (
      reason: string,
      detail: string | null,
      updatedAt: string | null = null,
    ): SystemUpdateHostProjection => ({
      supported: false,
      phase: "unavailable",
      reason,
      detail,
      currentVersion: null,
      currentGeneration: bridge?.currentGeneration ?? null,
      activeSlot: null,
      updateAvailable: false,
      targetVersion: null,
      targetGeneration: null,
      targetDigest: null,
      updatedAt,
      readyToRestart: null,
    });
    if (!this.#directory) return unavailable("not-configured", "System updates are not configured");
    if (!heartbeat) return unavailable("agent-not-connected", "The update agent is not connected");
    if (heartbeat.runtime !== "raspberry-pi") {
      return unavailable("not-raspberry-pi", "Host updates are available only on Stugu Raspberry Pi appliances", heartbeat.updatedAt);
    }
    if (!heartbeat.compatible || !heartbeat.capabilities.includes(UNIFIED_UPDATE_CAPABILITY)) {
      const factoryTransition = heartbeat.systemUpdateReason === "appliance-upgrade-required";
      return unavailable(
        factoryTransition ? "factory-transition-required" : "agent-upgrade-required",
        heartbeat.detail ?? (factoryTransition
          ? "This appliance must complete its verified factory transition first"
          : "The update agent must be upgraded before unified updates are available"),
        heartbeat.updatedAt,
      );
    }
    if (!bridge) return unavailable("bridge-not-connected", "The host update bridge is not connected", heartbeat.updatedAt);
    const readyToRestart = bridge.phase === "ready-to-restart"
      && bridge.operationId
      && bridge.targetVersion
      && bridge.targetGeneration
      && bridge.manifestSha256
      ? {
        operationId: bridge.operationId,
        targetVersion: bridge.targetVersion,
        targetGeneration: bridge.targetGeneration,
        targetDigest: bridge.manifestSha256,
        ...(bridge.targetSlot ? { targetSlot: bridge.targetSlot } : {}),
      }
      : null;
    return {
      supported: true,
      phase: bridge.available ? bridge.phase : "unavailable",
      reason: canonicalSystemUpdateReason(
        bridge.error?.code ?? (bridge.available ? null : "HOST_UPDATER_OFFLINE"),
      ),
      detail: bridge.error?.message ?? bridge.detail,
      currentVersion: null,
      currentGeneration: bridge.currentGeneration,
      activeSlot: null,
      updateAvailable: bridge.phase === "available"
        && bridge.targetGeneration !== null
        && bridge.targetGeneration > bridge.currentGeneration,
      targetVersion: bridge.targetVersion,
      targetGeneration: bridge.targetGeneration,
      targetDigest: bridge.manifestSha256,
      updatedAt: bridge.updatedAt,
      readyToRestart,
    };
  }

  #operation(): SystemUpdateOperation | null {
    return this.#directory ? operationFromJson(readJson(join(this.#directory, "status.json"))) : null;
  }

  #formatter(timezone: string): ZonedDateTimeFormatter {
    const cached = this.#dateTimeFormats.get(timezone);
    if (cached) return cached;
    const formatter = this.#dateTimeFormatFactory(timezone);
    this.#dateTimeFormats.set(timezone, formatter);
    return formatter;
  }

  #nextUpdateWindow(now: Date): string | null {
    const nowMs = now.getTime();
    const cached = this.#nextWindowCache;
    if (
      cached
      && nowMs >= cached.computedAtMs
      && nowMs < cached.expiresAtMs
      && (cached.valueMs === null || cached.valueMs > nowMs)
    ) {
      return cached.value;
    }
    const value = nextWindow(this.#settings, now, this.#formatter(this.#settings.timezone));
    this.#nextWindowCache = {
      computedAtMs: nowMs,
      expiresAtMs: nowMs + NEXT_WINDOW_CACHE_MS,
      value,
      valueMs: value === null ? null : Date.parse(value),
    };
    return value;
  }

  async #tick(): Promise<void> {
    const now = this.#now();
    const checkedAt = Date.parse(this.#cache.checkedAt);
    if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt >= this.#settings.checkIntervalHours * 60 * 60_000) {
      await this.check();
    }
    if (this.#settings.mode !== "automatic") return;
    const [hour, minute] = this.#settings.updateTime.split(":").map(Number);
    const local = localDateParts(now, this.#formatter(this.#settings.timezone));
    if (!this.#settings.updateDays.includes(local.day) || local.hour !== hour || local.minute !== minute) return;
    try {
      await this.queueLatest();
    } catch {
      // Manual status remains authoritative; the next configured window retries.
    }
  }
}

export class SystemUpdateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SystemUpdateError";
  }
}

export const systemUpdateDays = DAY_NAMES;
