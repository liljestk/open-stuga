import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_JSON_BYTES = 256 * 1024;
const AGENT_MAX_AGE_MS = 2 * 60_000;
const ACTIVE_PHASES = new Set(["queued", "backup", "pulling", "applying", "verifying", "rolling-back"]);
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type SystemUpdateDay = typeof DAY_NAMES[number];
export type SystemUpdateMode = "manual" | "automatic";

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
  phase: "queued" | "backup" | "pulling" | "applying" | "verifying" | "complete" | "failed" | "rolling-back";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  detail: string | null;
  previousVersion: string;
}

interface UpdateAgentHeartbeat {
  schema: "stuga-update-agent/v1";
  runtime: "docker" | "raspberry-pi";
  updatedAt: string;
  agentVersion: string;
  ready: boolean;
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

interface SystemUpdateServiceOptions {
  currentVersion: string;
  repository: string;
  imagePrefix: string;
  operationsDirectory?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
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

function readJson(path: string): unknown {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_JSON_BYTES) return null;
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  renameSync(temporary, path);
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

function localDateParts(date: Date, timezone: string): {
  day: SystemUpdateDay;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    day: part("weekday").toLowerCase().slice(0, 3) as SystemUpdateDay,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

function nextWindow(settings: SystemUpdateSettings, now: Date): string | null {
  const [targetHour, targetMinute] = settings.updateTime.split(":").map(Number);
  const rounded = new Date(now);
  rounded.setUTCSeconds(0, 0);
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const candidate = new Date(rounded.getTime() + offset * 60_000);
    if (candidate <= now) continue;
    const local = localDateParts(candidate, settings.timezone);
    if (settings.updateDays.includes(local.day) && local.hour === targetHour && local.minute === targetMinute) {
      return candidate.toISOString();
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
    || !["queued", "backup", "pulling", "applying", "verifying", "complete", "failed", "rolling-back"].includes(input.phase)
  ) return null;
  return {
    id: input.id,
    version: input.version,
    tagName: input.tagName,
    phase: input.phase as SystemUpdateOperation["phase"],
    requestedAt: input.requestedAt,
    startedAt: typeof input.startedAt === "string" ? input.startedAt : null,
    completedAt: typeof input.completedAt === "string" ? input.completedAt : null,
    detail: typeof input.detail === "string" ? input.detail.slice(0, 2_000) : null,
    previousVersion: input.previousVersion,
  };
}

export class SystemUpdateService {
  readonly #currentVersion: string;
  readonly #repository: string;
  readonly #imagePrefix: string;
  readonly #directory: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #settings: SystemUpdateSettings;
  #cache: ReleaseCache = { checkedAt: "", releases: [], error: null };
  #checkPromise: Promise<SystemUpdateStatus> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SystemUpdateServiceOptions) {
    this.#currentVersion = options.currentVersion;
    this.#repository = options.repository;
    this.#imagePrefix = options.imagePrefix.replace(/-$/, "");
    this.#directory = options.operationsDirectory ?? null;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
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
    this.#checkPromise = this.#performCheck();
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
    return {
      currentVersion: this.#currentVersion,
      latestVersion: latestRelease?.version ?? null,
      updateAvailable: Boolean(latestRelease && compareSystemVersions(latestRelease.version, this.#currentVersion) > 0),
      latestRelease,
      releases: releases.slice(0, 10),
      lastCheckedAt: this.#cache.checkedAt || null,
      checkError: this.#cache.error,
      settings: { ...this.#settings, updateDays: [...this.#settings.updateDays] },
      nextUpdateWindowAt: this.#settings.mode === "automatic" ? nextWindow(this.#settings, this.#now()) : null,
      capability: {
        available: Boolean(heartbeat),
        runtime: heartbeat?.runtime ?? null,
        agentLastSeenAt: heartbeat?.updatedAt ?? null,
        reason: !this.#directory ? "not-configured" : heartbeat ? "ready" : "agent-not-connected",
      },
      operation,
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
    if (this.#directory) writeJson(join(this.#directory, "settings.json"), this.#settings);
    return this.status();
  }

  async queueLatest(): Promise<SystemUpdateStatus> {
    if (!this.#cache.checkedAt) await this.check();
    const status = this.status();
    const release = status.latestRelease;
    if (!release || !status.updateAvailable) throw new SystemUpdateError(409, "NO_UPDATE_AVAILABLE", "The current version is already up to date");
    if (!status.capability.available || !this.#directory) {
      throw new SystemUpdateError(503, "UPDATE_AGENT_UNAVAILABLE", "The external update agent is not connected");
    }
    if (status.operation && ACTIVE_PHASES.has(status.operation.phase)) {
      if (status.operation.version === release.version) return status;
      throw new SystemUpdateError(409, "UPDATE_IN_PROGRESS", "Another system update is already in progress");
    }

    const requestedAt = this.#now().toISOString();
    const id = randomUUID();
    const operation: SystemUpdateOperation = {
      id,
      version: release.version,
      tagName: release.tagName,
      phase: "queued",
      requestedAt,
      startedAt: null,
      completedAt: null,
      detail: "Waiting for the external update agent",
      previousVersion: this.#currentVersion,
    };
    writeJson(join(this.#directory, "status.json"), operation);
    writeJson(join(this.#directory, `request-${requestedAt.replaceAll(":", "-")}-${id}.json`), {
      schema: "stuga-system-update-request/v1",
      ...operation,
      repository: this.#repository,
      images: {
        api: `${this.#imagePrefix}-api:${release.tagName}`,
        web: `${this.#imagePrefix}-web:${release.tagName}`,
        backup: `${this.#imagePrefix}-backup:${release.tagName}`,
        tapo: `${this.#imagePrefix}-tapo-export-runner:${release.tagName}`,
        updateAgent: `${this.#imagePrefix}-update-agent:${release.tagName}`,
      },
    });
    return this.status();
  }

  async #performCheck(): Promise<SystemUpdateStatus> {
    const checkedAt = this.#now().toISOString();
    try {
      const response = await this.#fetch(`https://api.github.com/repos/${this.#repository}/releases?per_page=20`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Stuga/${this.#currentVersion}`,
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
    const value = readJson(join(this.#directory, "agent-status.json"));
    if (!value || typeof value !== "object") return null;
    const heartbeat = value as Partial<UpdateAgentHeartbeat>;
    if (
      heartbeat.schema !== "stuga-update-agent/v1"
      || (heartbeat.runtime !== "docker" && heartbeat.runtime !== "raspberry-pi")
      || typeof heartbeat.updatedAt !== "string"
      || typeof heartbeat.agentVersion !== "string"
      || heartbeat.ready !== true
    ) return null;
    const timestamp = Date.parse(heartbeat.updatedAt);
    const age = this.#now().getTime() - timestamp;
    if (!Number.isFinite(timestamp) || age > AGENT_MAX_AGE_MS || age < -AGENT_MAX_AGE_MS) return null;
    return heartbeat as UpdateAgentHeartbeat;
  }

  #operation(): SystemUpdateOperation | null {
    return this.#directory ? operationFromJson(readJson(join(this.#directory, "status.json"))) : null;
  }

  async #tick(): Promise<void> {
    const now = this.#now();
    const checkedAt = Date.parse(this.#cache.checkedAt);
    if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt >= this.#settings.checkIntervalHours * 60 * 60_000) {
      await this.check();
    }
    if (this.#settings.mode !== "automatic") return;
    const [hour, minute] = this.#settings.updateTime.split(":").map(Number);
    const local = localDateParts(now, this.#settings.timezone);
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
