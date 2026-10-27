import type {
  House,
  HouseWeather,
  WeatherComponentName,
  WeatherProviderName,
  WeatherRecoveryStatus,
} from "@climate-twin/contracts";
import { ClimateDatabase, outdoorLocationKey, type WeatherOutageRecord } from "./db.js";
import { prefersFmi } from "./open-meteo.js";
import type {
  WeatherObservationHistory,
  WeatherProvider,
  WeatherRecoveryLifecycle,
} from "./weather.js";
import type { HybridTelemetryReader } from "./timeseries/read-facade.js";
import { compareCodeUnits } from "./text-order.js";

const WEATHER_COMPONENTS: readonly WeatherComponentName[] = [
  "observation", "forecast", "short-range", "warnings",
];
const BACKFILL_CHUNK_MS = 24 * 3_600_000;
const HISTORICAL_SCAN_WINDOW_MS = 24 * 3_600_000;
const HISTORICAL_DISCOVERY_INTERVAL_MS = 6 * 3_600_000;
const HISTORICAL_DISCOVERY_READ_LIMIT = 2_000;
const HISTORICAL_GAP_LIMIT = 100;
const BACKFILL_CHUNKS_PER_CYCLE = 1;
const BACKFILL_POINTS_PER_CYCLE = 768;
const BACKFILL_WALL_TIME_MS = 20_000;
const BACKFILL_RESCHEDULE_MS = 60_000;

export interface WeatherRecoveryOptions {
  historicalScanWindowMs?: number;
  historicalGapLimit?: number;
  onRecovered?: () => void | Promise<void>;
  telemetryReader?: HybridTelemetryReader;
  now?: () => number;
  backfillChunkBudget?: number;
  backfillPointBudget?: number;
  backfillWallTimeMs?: number;
  backfillRescheduleMs?: number;
}

interface HistoricalDiscoveryCheckpoint {
  lastAttemptMs: number;
  throughMs: number | null;
}

interface HistoricalDiscoveryTask {
  key: string;
  house: House;
  weather: HouseWeather;
  generation: number;
  attemptedAtMs: number;
  fromMs: number;
  toMs: number;
}

interface ActiveHistoricalDiscovery {
  key: string;
  houseId: string;
  controller: AbortController;
}

interface BackfillCycleBudget {
  chunksUsed: number;
  pointsUsed: number;
}

interface StoredBackfillCursor {
  houseId: string;
  locationKey: string;
  provider: WeatherProviderName;
  from: string;
  to: string;
  cursor: string;
}

class WeatherBackfillBudgetExceededError extends Error {
  constructor() {
    super("Weather backfill paused at its wall-time budget");
    this.name = "WeatherBackfillBudgetExceededError";
  }
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function historicalObservationGapMs(provider: WeatherProviderName): number {
  // FMI surface observations are normally ten-minute data. Tolerate ordinary
  // 10–20 minute station spacing and recover only after two observations are
  // effectively missing. Open-Meteo's historical current series is hourly.
  return provider === "fmi" ? 25 * 60_000 : 2 * 60 * 60_000;
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The weather provider request failed";
}

function backfillAttemptedAt(outage: WeatherOutageRecord, nowMs: number): string {
  const previousMs = outage.lastAttemptAt ? Date.parse(outage.lastAttemptAt) : Number.NaN;
  return new Date(Math.max(nowMs, Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

function providerFor(house: House): WeatherProviderName {
  return house.location && !prefersFmi(house.location) ? "open-meteo" : "fmi";
}

function unavailableComponents(weather: HouseWeather): WeatherComponentName[] {
  return WEATHER_COMPONENTS.filter((component) => {
    const status = weather.componentStatus?.[component];
    if (status) return status.availability === "unavailable";
    return weather.unavailable.includes(component);
  });
}

function backfillRank(state: WeatherRecoveryStatus["observationBackfill"]["state"]): number {
  return {
    running: 7,
    pending: 6,
    failed: 5,
    partial: 4,
    complete: 3,
    "not-supported": 2,
    "not-needed": 1,
  }[state];
}

/**
 * Persists provider failures and repairs observation gaps after recovery.
 * Forecast and warning outages remain in the ledger, but are never recreated
 * from newer data because that would misrepresent what was issued at the time.
 */
export class WeatherRecoveryCoordinator implements WeatherRecoveryLifecycle {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #backfillControllers = new Map<string, AbortController>();
  readonly #backfillFollowup = new Map<string, { house: House; provider: WeatherProviderName }>();
  readonly #backfillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #generation = new Map<string, number>();
  readonly #discoveryQueue = new Map<string, HistoricalDiscoveryTask>();
  readonly #discoveryCheckpoints = new Map<string, HistoricalDiscoveryCheckpoint | null>();
  #discoveryRunner: Promise<void> | null = null;
  #activeDiscovery: ActiveHistoricalDiscovery | null = null;
  #backfillTail: Promise<void> = Promise.resolve();
  #stopped = false;
  readonly #historicalScanWindowMs: number;
  readonly #historicalGapLimit: number;
  readonly #onRecovered: (() => void | Promise<void>) | undefined;
  readonly #telemetryReader: HybridTelemetryReader | undefined;
  readonly #now: () => number;
  readonly #backfillChunkBudget: number;
  readonly #backfillPointBudget: number;
  readonly #backfillWallTimeMs: number;
  readonly #backfillRescheduleMs: number;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly provider: WeatherProvider,
    options: WeatherRecoveryOptions = {},
  ) {
    this.#historicalScanWindowMs = Math.max(
      60_000,
      Math.min(HISTORICAL_SCAN_WINDOW_MS, options.historicalScanWindowMs ?? HISTORICAL_SCAN_WINDOW_MS),
    );
    this.#historicalGapLimit = Math.max(1, Math.min(500, options.historicalGapLimit ?? HISTORICAL_GAP_LIMIT));
    this.#onRecovered = options.onRecovered;
    this.#telemetryReader = options.telemetryReader;
    this.#now = options.now ?? Date.now;
    this.#backfillChunkBudget = boundedInteger(
      options.backfillChunkBudget ?? BACKFILL_CHUNKS_PER_CYCLE,
      BACKFILL_CHUNKS_PER_CYCLE,
      1,
      8,
    );
    this.#backfillPointBudget = boundedInteger(
      options.backfillPointBudget ?? BACKFILL_POINTS_PER_CYCLE,
      BACKFILL_POINTS_PER_CYCLE,
      4,
      4_096,
    );
    this.#backfillWallTimeMs = boundedInteger(
      options.backfillWallTimeMs ?? BACKFILL_WALL_TIME_MS,
      BACKFILL_WALL_TIME_MS,
      10,
      60_000,
    );
    this.#backfillRescheduleMs = boundedInteger(
      options.backfillRescheduleMs ?? BACKFILL_RESCHEDULE_MS,
      BACKFILL_RESCHEDULE_MS,
      1,
      60 * 60_000,
    );
  }

  recordFailure(house: House, error: unknown, detectedAt: string): void {
    if (this.#stopped || !house.location) return;
    this.database.noteWeatherOutage(
      house.id,
      outdoorLocationKey(house.location),
      providerFor(house),
      "service",
      message(error),
      detectedAt,
    );
  }

  recordSuccess(house: House, weather: HouseWeather): void {
    if (this.#stopped || !house.location || weather.stale) return;
    const locationKey = outdoorLocationKey(house.location);
    const unavailable = new Set(unavailableComponents(weather));
    this.database.resolveWeatherOutages(house.id, locationKey, weather.provider, ["service"], weather.fetchedAt);

    for (const component of WEATHER_COMPONENTS) {
      if (unavailable.has(component)) {
        this.database.noteWeatherOutage(
          house.id,
          locationKey,
          weather.provider,
          component,
          `${weather.componentStatus?.[component].product ?? component} was unavailable`,
          weather.fetchedAt,
        );
      } else {
        this.database.resolveWeatherOutages(house.id, locationKey, weather.provider, [component], weather.fetchedAt);
      }
    }

    if (!unavailable.has("observation")) this.#scheduleDiscovery(house, weather);
    // Explicitly recorded outages are never gated by the periodic discovery
    // checkpoint. A discovery that finds another gap requests one coalesced
    // follow-up after its scan completes.
    this.#scheduleBackfill(house, weather.provider);
  }

  status(house: House): WeatherRecoveryStatus {
    const locationKey = outdoorLocationKey(house.location);
    const recent = house.location ? this.database.listWeatherBackfillHistory(house.id, locationKey) : [];
    const active = house.location ? this.database.listActiveWeatherOutages(house.id, locationKey) : [];
    const pending = house.location
      ? this.database.listPendingWeatherBackfills(house.id, locationKey)
      : [];
    const outages = [...new Map([...recent, ...active, ...pending].map((outage) => [outage.id, outage])).values()];
    const recoverable = outages
      .filter((outage) => outage.component === "service" || outage.component === "observation")
      .sort((left, right) => backfillRank(right.backfillState) - backfillRank(left.backfillState)
        || right.startedAt.localeCompare(left.startedAt));
    const selected = recoverable[0] ?? null;
    const activeRecoverable = active.find((outage) => outage.component === "service" || outage.component === "observation");
    const backfill = activeRecoverable ?? selected;
    const state = activeRecoverable ? "pending" : backfill?.backfillState ?? "not-needed";
    const affectedComponents = [...new Set(active.map((outage) => outage.component))];
    return {
      active: active.length > 0,
      activeSince: active.length
        ? active.map((outage) => outage.startedAt).sort(compareCodeUnits)[0] ?? null
        : null,
      affectedComponents,
      lastError: active[0]?.lastError ?? null,
      lastRecoveredAt: outages
        .filter((outage) => outage.backfillState === "complete" || outage.backfillState === "partial")
        .map((outage) => outage.lastAttemptAt)
        .filter((value): value is string => Boolean(value))
        .sort(compareCodeUnits)
        .at(-1) ?? null,
      observationBackfill: {
        state,
        from: backfill?.backfillFrom ?? backfill?.startedAt ?? null,
        to: backfill?.backfillTo ?? null,
        recoveredPoints: backfill?.recoveredPoints ?? 0,
        lastAttemptAt: backfill?.lastAttemptAt ?? null,
        error: backfill?.backfillError ?? null,
      },
    };
  }

  invalidate(houseId: string): void {
    this.#generation.set(houseId, (this.#generation.get(houseId) ?? 0) + 1);
    this.#backfillControllers.get(houseId)?.abort(new Error("Weather recovery was superseded"));
    this.#backfillFollowup.delete(houseId);
    const backfillTimer = this.#backfillTimers.get(houseId);
    if (backfillTimer) clearTimeout(backfillTimer);
    this.#backfillTimers.delete(houseId);
    for (const [key, task] of this.#discoveryQueue) {
      if (task.house.id === houseId) this.#discoveryQueue.delete(key);
    }
    if (this.#activeDiscovery?.houseId === houseId) {
      this.#activeDiscovery.controller.abort(new Error("Weather recovery was superseded"));
    }
  }

  async drain(): Promise<void> {
    while (this.#discoveryRunner) {
      await Promise.allSettled([this.#discoveryRunner]);
    }
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight.values()]);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return this.drain();
    this.#stopped = true;
    this.#discoveryQueue.clear();
    this.#backfillFollowup.clear();
    for (const timer of this.#backfillTimers.values()) clearTimeout(timer);
    this.#backfillTimers.clear();
    this.#activeDiscovery?.controller.abort(new Error("Weather recovery stopped"));
    for (const houseId of this.#inFlight.keys()) this.invalidate(houseId);
    await this.drain();
  }

  #scheduleBackfill(
    house: House,
    provider: WeatherProviderName,
    options: { respectCooldown?: boolean } = {},
  ): void {
    if (this.#stopped) return;
    const delayed = this.#backfillTimers.get(house.id);
    if (delayed && options.respectCooldown) return;
    if (delayed) clearTimeout(delayed);
    this.#backfillTimers.delete(house.id);
    if (this.#inFlight.has(house.id)) {
      this.#backfillFollowup.set(house.id, { house: structuredClone(house), provider });
      return;
    }
    const generation = this.#generation.get(house.id) ?? 0;
    const controller = new AbortController();
    let needsReschedule = false;
    const pending = this.#backfillTail
      .catch(() => undefined)
      .then(async () => {
        needsReschedule = await this.#runBackfill(
          structuredClone(house),
          provider,
          generation,
          controller.signal,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight.get(house.id) === pending) this.#inFlight.delete(house.id);
        if (this.#backfillControllers.get(house.id) === controller) this.#backfillControllers.delete(house.id);
        const followup = this.#backfillFollowup.get(house.id);
        if (followup) {
          this.#backfillFollowup.delete(house.id);
          if (needsReschedule) this.#scheduleBackfillResumption(followup.house, followup.provider);
          else this.#scheduleBackfill(followup.house, followup.provider);
        } else if (needsReschedule) {
          this.#scheduleBackfillResumption(house, provider);
        }
      });
    this.#backfillTail = pending;
    this.#inFlight.set(house.id, pending);
    this.#backfillControllers.set(house.id, controller);
  }

  #scheduleBackfillResumption(house: House, provider: WeatherProviderName): void {
    if (this.#stopped || this.#backfillTimers.has(house.id)) return;
    const timer = setTimeout(() => {
      if (this.#backfillTimers.get(house.id) !== timer) return;
      this.#backfillTimers.delete(house.id);
      this.#scheduleBackfill(house, provider);
    }, this.#backfillRescheduleMs);
    timer.unref?.();
    this.#backfillTimers.set(house.id, timer);
  }

  async #runBackfill(
    house: House,
    provider: WeatherProviderName,
    generation: number,
    cancellationSignal: AbortSignal,
  ): Promise<boolean> {
    cancellationSignal.throwIfAborted();
    if (!house.location) return false;
    const budgetController = new AbortController();
    const budgetTimer = setTimeout(() => {
      budgetController.abort(new WeatherBackfillBudgetExceededError());
    }, this.#backfillWallTimeMs);
    budgetTimer.unref?.();
    const signal = AbortSignal.any([cancellationSignal, budgetController.signal]);
    const budget: BackfillCycleBudget = { chunksUsed: 0, pointsUsed: 0 };
    let currentOutage: WeatherOutageRecord | null = null;
    try {
      const locationKey = outdoorLocationKey(house.location);
      const outages = this.database.listPendingWeatherBackfills(house.id, locationKey, provider, 500);
      for (let index = 0; index < outages.length; index += 1) {
        signal.throwIfAborted();
        if (!this.#isCurrent(house, generation)) return false;
        if (budget.chunksUsed >= this.#backfillChunkBudget
          || budget.pointsUsed >= this.#backfillPointBudget) return true;
        currentOutage = outages[index] ?? null;
        if (!currentOutage) continue;
        const outcome = await this.#backfillOutage(house, currentOutage, generation, signal, budget);
        if (outcome === "failed") {
          return outages.slice(index + 1).some((candidate) => candidate.backfillState !== "failed");
        }
        if (outcome === "reschedule") return true;
        if (index < outages.length - 1 && (budget.chunksUsed >= this.#backfillChunkBudget
          || budget.pointsUsed >= this.#backfillPointBudget)) return true;
      }
      return false;
    } catch (error) {
      if (cancellationSignal.aborted) {
        if (currentOutage) this.#pauseBackfillOutage(house, currentOutage);
        cancellationSignal.throwIfAborted();
      }
      if (budgetController.signal.aborted) {
        if (currentOutage) this.#pauseBackfillOutage(house, currentOutage);
        return true;
      }
      throw error;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  async #backfillOutage(
    house: House,
    outage: WeatherOutageRecord,
    generation: number,
    signal: AbortSignal,
    budget: BackfillCycleBudget,
  ): Promise<"complete" | "reschedule" | "failed"> {
    signal.throwIfAborted();
    const attemptedAt = backfillAttemptedAt(outage, this.#now());
    if (budget.chunksUsed >= this.#backfillChunkBudget) return "reschedule";
    if (!this.provider.fetchObservationHistory || !outage.backfillFrom || !outage.backfillTo) {
      budget.chunksUsed += 1;
      this.database.transaction(() => {
        this.database.updateWeatherOutageBackfill(
          outage.id,
          "not-supported",
          outage.recoveredPoints,
          attemptedAt,
          "Historical observations are not available from this provider",
        );
        this.#deleteBackfillCursor(outage.id);
      });
      return "complete";
    }
    const startMs = Date.parse(outage.backfillFrom);
    const endMs = Date.parse(outage.backfillTo);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      budget.chunksUsed += 1;
      this.database.updateWeatherOutageBackfill(
        outage.id,
        "failed",
        outage.recoveredPoints,
        attemptedAt,
        "The persisted weather backfill range is invalid",
      );
      return "failed";
    }
    const cursor = this.#backfillCursor(outage);
    const cursorMs = Date.parse(cursor);
    if (cursorMs >= endMs) {
      budget.chunksUsed += 1;
      this.database.transaction(() => {
        this.database.updateWeatherOutageBackfill(
          outage.id,
          "complete",
          outage.recoveredPoints,
          attemptedAt,
          null,
        );
        this.#deleteBackfillCursor(outage.id);
      });
      return "complete";
    }
    const remainingPointBudget = this.#backfillPointBudget - budget.pointsUsed;
    if (remainingPointBudget < 4) return "reschedule";
    const chunkEndMs = Math.min(endMs, cursorMs + BACKFILL_CHUNK_MS);
    const chunkFrom = new Date(cursorMs).toISOString();
    const chunkTo = new Date(chunkEndMs).toISOString();
    budget.chunksUsed += 1;
    this.database.updateWeatherOutageBackfill(outage.id, "running", outage.recoveredPoints, attemptedAt, null);
    const locationKey = outdoorLocationKey(house.location);
    try {
      const existingLimit = Math.floor(remainingPointBudget / 2);
      const existing = this.#telemetryReader
        ? (await this.#telemetryReader.outdoorTemperatureHistory({
          houseId: house.id,
          locationKey,
          from: chunkFrom,
          to: chunkTo,
          limit: existingLimit,
          signal,
        })).records
        : this.database.outdoorTemperatureHistory(
          house.id,
          locationKey,
          chunkFrom,
          chunkTo,
          existingLimit,
        );
      budget.pointsUsed += existing.length;
      signal.throwIfAborted();
      const history = await this.provider.fetchObservationHistory(
        house.id,
        house.location!,
        chunkFrom,
        chunkTo,
        signal,
      );
      signal.throwIfAborted();
      if (!this.#isCurrent(house, generation)) {
        this.#pauseBackfillOutage(house, outage);
        return "failed";
      }
      const providerPointLimit = this.#backfillPointBudget - budget.pointsUsed;
      if (history.observations.length > providerPointLimit) {
        this.database.updateWeatherOutageBackfill(
          outage.id,
          outage.recoveredPoints > 0 ? "partial" : "failed",
          outage.recoveredPoints,
          attemptedAt,
          "The historical weather response exceeded the safe per-cycle point budget",
        );
        return "failed";
      }
      budget.pointsUsed += history.observations.length;
      const persistedTimestamps = new Set(existing
        .filter((sample) => sample.source.startsWith(`${outage.provider}-`))
        .map((sample) => sample.timestamp));
      const complete = chunkEndMs >= endMs;
      const recoveredPoints = this.database.transaction(() => {
        const persisted = this.#persistHistory(
          house,
          history,
          persistedTimestamps,
          signal,
          chunkFrom,
          chunkTo,
        );
        const totalRecoveredPoints = outage.recoveredPoints + persisted;
        if (complete) this.#deleteBackfillCursor(outage.id);
        else this.#saveBackfillCursor(outage, chunkTo);
        this.database.updateWeatherOutageBackfill(
          outage.id,
          complete ? "complete" : totalRecoveredPoints > 0 ? "partial" : "pending",
          totalRecoveredPoints,
          backfillAttemptedAt(outage, this.#now()),
          null,
        );
        return persisted;
      });
      if (recoveredPoints > 0) {
        try {
          void Promise.resolve(this.#onRecovered?.()).catch(() => undefined);
        } catch {
          // Archive reconciliation is a follow-on optimization; persisted
          // recovery progress remains authoritative if that wake-up fails.
        }
      }
      return complete ? "complete" : "reschedule";
    } catch (error) {
      signal.throwIfAborted();
      this.database.updateWeatherOutageBackfill(
        outage.id,
        outage.recoveredPoints > 0 ? "partial" : "failed",
        outage.recoveredPoints,
        attemptedAt,
        message(error),
      );
      return "failed";
    }
  }

  #backfillCursor(outage: WeatherOutageRecord): string {
    const fallback = outage.backfillFrom as string;
    const key = `weather-backfill-cursor-v1:${outage.id}`;
    try {
      const row = this.database.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      if (!row) return fallback;
      const parsed = JSON.parse(row.value) as Partial<StoredBackfillCursor>;
      const cursorMs = typeof parsed.cursor === "string" ? Date.parse(parsed.cursor) : Number.NaN;
      if (parsed.houseId === outage.houseId
        && parsed.locationKey === outage.locationKey
        && parsed.provider === outage.provider
        && parsed.from === outage.backfillFrom
        && parsed.to === outage.backfillTo
        && Number.isFinite(cursorMs)
        && cursorMs >= Date.parse(fallback)
        && cursorMs <= Date.parse(outage.backfillTo as string)) return parsed.cursor as string;
    } catch {
      // A corrupt cursor safely replays one bounded, idempotent chunk.
    }
    return fallback;
  }

  #saveBackfillCursor(outage: WeatherOutageRecord, cursor: string): void {
    const value: StoredBackfillCursor = {
      houseId: outage.houseId,
      locationKey: outage.locationKey,
      provider: outage.provider,
      from: outage.backfillFrom as string,
      to: outage.backfillTo as string,
      cursor,
    };
    this.database.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`weather-backfill-cursor-v1:${outage.id}`, JSON.stringify(value));
  }

  #deleteBackfillCursor(outageId: number): void {
    this.database.db.prepare("DELETE FROM metadata WHERE key = ?")
      .run(`weather-backfill-cursor-v1:${outageId}`);
  }

  #pauseBackfillOutage(house: House, outage: WeatherOutageRecord): void {
    if (!house.location) return;
    const current = this.database.listPendingWeatherBackfills(
      house.id,
      outdoorLocationKey(house.location),
      outage.provider,
      500,
    ).find((candidate) => candidate.id === outage.id) ?? outage;
    if (["complete", "not-supported"].includes(current.backfillState)) return;
    this.database.updateWeatherOutageBackfill(
      current.id,
      current.recoveredPoints > 0 ? "partial" : "pending",
      current.recoveredPoints,
      new Date(this.#now()).toISOString(),
      null,
    );
  }

  #scheduleDiscovery(house: House, weather: HouseWeather): void {
    if (this.#stopped || !house.location) return;
    const toMs = this.#weatherTimestamp(weather);
    if (toMs === null) return;
    const locationKey = outdoorLocationKey(house.location);
    const key = this.#discoveryKey(house.id, locationKey, weather.provider);
    if (this.#discoveryQueue.has(key) || this.#activeDiscovery?.key === key) return;
    const attemptedAtMs = this.#now();
    const checkpoint = this.#discoveryCheckpoint(key);
    if (checkpoint && attemptedAtMs - checkpoint.lastAttemptMs < HISTORICAL_DISCOVERY_INTERVAL_MS) return;
    if (checkpoint?.throughMs !== null && checkpoint?.throughMs !== undefined && toMs <= checkpoint.throughMs) return;
    const overlapMs = Math.min(
      this.#historicalScanWindowMs,
      historicalObservationGapMs(weather.provider) * 2,
    );
    const windowStartMs = toMs - this.#historicalScanWindowMs;
    const fromMs = checkpoint?.throughMs === null || checkpoint?.throughMs === undefined
      ? windowStartMs
      : Math.max(windowStartMs, checkpoint.throughMs - overlapMs);
    const task: HistoricalDiscoveryTask = {
      key,
      house: structuredClone(house),
      weather: structuredClone(weather),
      generation: this.#generation.get(house.id) ?? 0,
      attemptedAtMs,
      fromMs,
      toMs,
    };
    this.#saveDiscoveryCheckpoint(key, {
      lastAttemptMs: attemptedAtMs,
      throughMs: checkpoint?.throughMs ?? null,
    });
    this.#discoveryQueue.set(key, task);
    this.#ensureDiscoveryRunner();
  }

  #ensureDiscoveryRunner(): void {
    if (this.#stopped || this.#discoveryRunner) return;
    const runner = this.#runDiscoveryQueue()
      .catch(() => undefined)
      .finally(() => {
        if (this.#discoveryRunner === runner) this.#discoveryRunner = null;
        if (!this.#stopped && this.#discoveryQueue.size > 0) this.#ensureDiscoveryRunner();
      });
    this.#discoveryRunner = runner;
  }

  async #runDiscoveryQueue(): Promise<void> {
    while (!this.#stopped) {
      const next = this.#discoveryQueue.entries().next().value as [string, HistoricalDiscoveryTask] | undefined;
      if (!next) return;
      const [key, task] = next;
      this.#discoveryQueue.delete(key);
      if (!this.#isCurrent(task.house, task.generation)) continue;
      const controller = new AbortController();
      this.#activeDiscovery = { key, houseId: task.house.id, controller };
      try {
        const hasPendingBackfill = await this.#discoverHistoricalObservationGaps(task, controller.signal);
        controller.signal.throwIfAborted();
        if (!this.#isCurrent(task.house, task.generation)) continue;
        this.#saveDiscoveryCheckpoint(task.key, {
          lastAttemptMs: task.attemptedAtMs,
          throughMs: Math.max(this.#discoveryCheckpoint(task.key)?.throughMs ?? 0, task.toMs),
        });
        if (hasPendingBackfill) {
          this.#scheduleBackfill(task.house, task.weather.provider, { respectCooldown: true });
        }
      } catch {
        // Discovery is opportunistic; the persisted attempt checkpoint keeps a
        // failed archive read from becoming a high-frequency retry loop.
      } finally {
        if (this.#activeDiscovery?.controller === controller) this.#activeDiscovery = null;
      }
    }
  }

  async #discoverHistoricalObservationGaps(
    task: HistoricalDiscoveryTask,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { house, weather, generation, fromMs, toMs } = task;
    if (!house.location) return false;
    signal.throwIfAborted();
    if (!this.#isCurrent(house, generation)) return false;
    const locationKey = outdoorLocationKey(house.location);
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const thresholdMs = historicalObservationGapMs(weather.provider);
    const history = this.#telemetryReader
      ? (await this.#telemetryReader.outdoorTemperatureHistory({
        houseId: house.id,
        locationKey,
        from,
        to,
        limit: HISTORICAL_DISCOVERY_READ_LIMIT,
        signal,
      })).records
        .filter((sample) => sample.source.startsWith(`${weather.provider}-`))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      : null;
    signal.throwIfAborted();
    if (!this.#isCurrent(house, generation)) return false;
    const gaps = history
      ? history.slice(1).flatMap((sample, index) => {
        const previous = history[index]!;
        return Date.parse(sample.timestamp) - Date.parse(previous.timestamp) >= thresholdMs
          ? [{ startedAt: previous.timestamp, endedAt: sample.timestamp }]
          : [];
      }).slice(0, this.#historicalGapLimit)
      : this.database.outdoorTemperatureGaps(
        house.id,
        locationKey,
        weather.provider,
        from,
        to,
        thresholdMs,
        this.#historicalGapLimit,
      );
    let hasPendingBackfill = false;
    for (const gap of gaps) {
      signal.throwIfAborted();
      if (!this.#isCurrent(house, generation)) return false;
      const outage = this.database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        weather.provider,
        gap.startedAt,
        gap.endedAt,
        weather.fetchedAt,
      );
      hasPendingBackfill ||= ["pending", "running", "failed", "partial"].includes(outage.backfillState);
    }
    const latest = history?.at(-1)?.timestamp
      ?? this.database.latestOutdoorTemperatureTimestamp(house.id, locationKey, weather.provider);
    const latestMs = latest ? Date.parse(latest) : Number.NaN;
    if (latest && Number.isFinite(latestMs) && latestMs >= fromMs && latestMs <= toMs
      && toMs - latestMs >= thresholdMs) {
      signal.throwIfAborted();
      if (!this.#isCurrent(house, generation)) return false;
      const outage = this.database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        weather.provider,
        latest,
        to,
        weather.fetchedAt,
      );
      hasPendingBackfill ||= ["pending", "running", "failed", "partial"].includes(outage.backfillState);
    }
    return hasPendingBackfill;
  }

  #weatherTimestamp(weather: HouseWeather): number | null {
    const currentMs = weather.current?.timestamp ? Date.parse(weather.current.timestamp) : Number.NaN;
    if (Number.isFinite(currentMs)) return currentMs;
    const fetchedAtMs = Date.parse(weather.fetchedAt);
    return Number.isFinite(fetchedAtMs) ? fetchedAtMs : null;
  }

  #discoveryKey(houseId: string, locationKey: string, provider: WeatherProviderName): string {
    return `weather-gap-discovery-v1:${JSON.stringify([houseId, locationKey, provider])}`;
  }

  #discoveryCheckpoint(key: string): HistoricalDiscoveryCheckpoint | null {
    if (this.#discoveryCheckpoints.has(key)) return this.#discoveryCheckpoints.get(key) ?? null;
    let checkpoint: HistoricalDiscoveryCheckpoint | null = null;
    try {
      const row = this.database.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      const parsed = row ? JSON.parse(row.value) as Partial<HistoricalDiscoveryCheckpoint> : null;
      if (parsed && Number.isFinite(parsed.lastAttemptMs) && Number(parsed.lastAttemptMs) >= 0
        && (parsed.throughMs === null || (Number.isFinite(parsed.throughMs) && Number(parsed.throughMs) >= 0))) {
        checkpoint = {
          lastAttemptMs: Number(parsed.lastAttemptMs),
          throughMs: parsed.throughMs === null ? null : Number(parsed.throughMs),
        };
      }
    } catch {
      // A corrupt optional checkpoint degrades to one bounded discovery pass.
    }
    this.#discoveryCheckpoints.set(key, checkpoint);
    return checkpoint;
  }

  #saveDiscoveryCheckpoint(key: string, checkpoint: HistoricalDiscoveryCheckpoint): void {
    this.#discoveryCheckpoints.set(key, checkpoint);
    try {
      this.database.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, JSON.stringify(checkpoint));
    } catch {
      // The in-memory checkpoint still coalesces this process. A future process
      // performs at most one bounded 24-hour pass if persistence was unavailable.
    }
  }

  #persistHistory(
    house: House,
    history: WeatherObservationHistory,
    persistedTimestamps: Set<string>,
    signal?: AbortSignal,
    from?: string,
    to?: string,
  ): number {
    const locationKey = outdoorLocationKey(house.location);
    const fromMs = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
    const toMs = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
    let persisted = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    for (const observation of history.observations) {
      signal?.throwIfAborted();
      const observationMs = Date.parse(observation.timestamp);
      if (!Number.isFinite(observation.temperatureC)
        || !Number.isFinite(observationMs)
        || observationMs < fromMs
        || observationMs > toMs
        || persistedTimestamps.has(observation.timestamp)) continue;
      this.database.upsertCurrentOutdoorTemperatureSample({
        houseId: house.id,
        locationKey,
        timestamp: observation.timestamp,
        temperatureC: observation.temperatureC as number,
        source: history.provider === "fmi" ? "fmi-backfill" : "open-meteo-backfill",
        fetchedAt: history.fetchedAt,
        stationId: history.station?.id ?? null,
        stationName: history.station?.name ?? null,
        conditions: observation,
      }, { deferDerivedInvalidation: true });
      persistedTimestamps.add(observation.timestamp);
      persisted += 1;
      if (firstTimestamp === null || observation.timestamp < firstTimestamp) {
        firstTimestamp = observation.timestamp;
      }
      if (lastTimestamp === null || observation.timestamp > lastTimestamp) {
        lastTimestamp = observation.timestamp;
      }
    }
    if (firstTimestamp !== null && lastTimestamp !== null) {
      this.database.invalidateDerivedAnalyticsHistory(house.id, firstTimestamp, lastTimestamp);
    }
    return persisted;
  }

  #isCurrent(house: House, generation: number): boolean {
    if (this.#stopped) return false;
    if ((this.#generation.get(house.id) ?? 0) !== generation) return false;
    const current = this.database.getHouse(house.id);
    return Boolean(current?.location)
      && current?.updatedAt === house.updatedAt
      && outdoorLocationKey(current.location) === outdoorLocationKey(house.location);
  }
}
