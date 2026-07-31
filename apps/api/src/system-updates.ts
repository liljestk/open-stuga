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
import {
  COMPOSE_CONTRACT,
  fetchReleaseManifest,
  type ReleaseManifest,
  UPDATE_AGENT_CONTRACT,
  UPDATE_REQUEST_SCHEMA,
} from "./system-update-release-manifest.js";

const MAX_JSON_BYTES = 256 * 1024;
const AGENT_MAX_AGE_MS = 2 * 60_000;
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

interface UpdateAgentHeartbeat {
  schema: "stugu-update-agent/v1";
  runtime: "docker" | "raspberry-pi";
  updatedAt: string;
  agentVersion: string;
  updateAgentContract: number | null;
  composeContract: number | null;
  ready: boolean;
  systemUpdateReason: "appliance-upgrade-required" | null;
  compatible: boolean;
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
    reason:
      | "ready"
      | "agent-not-connected"
      | "agent-upgrade-required"
      | "appliance-upgrade-required"
      | "not-configured";
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
    const capabilityReason = !this.#directory
      ? "not-configured"
      : !heartbeat
        ? "agent-not-connected"
        : !heartbeat.compatible
          ? "agent-upgrade-required"
          : heartbeat.systemUpdateReason ?? "ready";
    return {
      currentVersion: this.#currentVersion,
      latestVersion: latestRelease?.version ?? null,
      updateAvailable: Boolean(latestRelease && compareSystemVersions(latestRelease.version, this.#currentVersion) > 0),
      latestRelease,
      releases: releases.slice(0, 10),
      lastCheckedAt: this.#cache.checkedAt || null,
      checkError: this.#cache.error,
      settings: { ...this.#settings, updateDays: [...this.#settings.updateDays] },
      nextUpdateWindowAt: this.#settings.mode === "automatic" ? this.#nextUpdateWindow(this.#now()) : null,
      capability: {
        available: capabilityReason === "ready",
        runtime: heartbeat?.runtime ?? null,
        agentLastSeenAt: heartbeat?.updatedAt ?? null,
        reason: capabilityReason,
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
    this.#nextWindowCache = null;
    if (this.#directory) writeJson(join(this.#directory, "settings.json"), this.#settings);
    return this.status();
  }

  async queueLatest(): Promise<SystemUpdateStatus> {
    if (!this.#cache.checkedAt) await this.check();
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
    const manifest = await this.#releaseManifest(release);

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
    writeJson(join(this.#directory, "status.json"), operation);
    writeJson(join(this.#directory, `request-${requestedAt.replaceAll(":", "-")}-${id}.json`), {
      schema: UPDATE_REQUEST_SCHEMA,
      ...operation,
      repository: this.#repository,
      releaseManifestSchema: manifest.schema,
      compatibility: manifest.compatibility,
      images: manifest.images,
    });
    return this.status();
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
    const value = readJson(join(this.#directory, "agent-status.json"));
    if (!value || typeof value !== "object") return null;
    const heartbeat = value as Record<string, unknown>;
    if (
      heartbeat.schema !== "stugu-update-agent/v1"
      || (heartbeat.runtime !== "docker" && heartbeat.runtime !== "raspberry-pi")
      || typeof heartbeat.updatedAt !== "string"
      || typeof heartbeat.agentVersion !== "string"
      || heartbeat.ready !== true
    ) return null;
    const timestamp = Date.parse(heartbeat.updatedAt);
    const age = this.#now().getTime() - timestamp;
    if (!Number.isFinite(timestamp) || age > AGENT_MAX_AGE_MS || age < -AGENT_MAX_AGE_MS) return null;
    const compatible = heartbeat.updateAgentContract === UPDATE_AGENT_CONTRACT
      && heartbeat.composeContract === COMPOSE_CONTRACT;
    return {
      schema: "stugu-update-agent/v1",
      runtime: heartbeat.runtime,
      updatedAt: heartbeat.updatedAt,
      agentVersion: heartbeat.agentVersion,
      updateAgentContract: typeof heartbeat.updateAgentContract === "number"
        ? heartbeat.updateAgentContract
        : null,
      composeContract: typeof heartbeat.composeContract === "number"
        ? heartbeat.composeContract
        : null,
      ready: true,
      systemUpdateReason: compatible
        && heartbeat.systemUpdateReason === "appliance-upgrade-required"
        ? heartbeat.systemUpdateReason
        : null,
      compatible,
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
