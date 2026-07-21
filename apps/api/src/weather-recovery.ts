import type {
  House,
  HouseWeather,
  WeatherComponentName,
  WeatherOutageComponent,
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

const WEATHER_COMPONENTS: readonly WeatherComponentName[] = [
  "observation", "forecast", "short-range", "warnings",
];
const BACKFILL_CHUNK_MS = 24 * 3_600_000;
const HISTORICAL_SCAN_WINDOW_MS = 30 * 24 * 3_600_000;
const HISTORICAL_GAP_LIMIT = 100;

export interface WeatherRecoveryOptions {
  historicalScanWindowMs?: number;
  historicalGapLimit?: number;
  onRecovered?: () => void | Promise<void>;
}

function historicalObservationGapMs(provider: WeatherProviderName): number {
  // FMI surface observations are normally ten-minute data, so a twenty-minute
  // interval already represents a missing observation. Open-Meteo's historical
  // current-weather series is hourly.
  return provider === "fmi" ? 15 * 60_000 : 2 * 60 * 60_000;
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The weather provider request failed";
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
  readonly #generation = new Map<string, number>();
  #stopped = false;
  readonly #historicalScanWindowMs: number;
  readonly #historicalGapLimit: number;
  readonly #onRecovered: (() => void | Promise<void>) | undefined;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly provider: WeatherProvider,
    options: WeatherRecoveryOptions = {},
  ) {
    this.#historicalScanWindowMs = Math.max(
      60_000,
      options.historicalScanWindowMs ?? HISTORICAL_SCAN_WINDOW_MS,
    );
    this.#historicalGapLimit = Math.max(1, Math.min(500, options.historicalGapLimit ?? HISTORICAL_GAP_LIMIT));
    this.#onRecovered = options.onRecovered;
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

    if (!unavailable.has("observation")) {
      this.#discoverHistoricalObservationGaps(house, weather);
      this.#scheduleBackfill(house, weather.provider);
    }
  }

  status(house: House): WeatherRecoveryStatus {
    const locationKey = outdoorLocationKey(house.location);
    const outages = house.location ? this.database.listWeatherOutages(house.id, locationKey) : [];
    const active = outages.filter((outage) => outage.endedAt === null);
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
        ? active.map((outage) => outage.startedAt).sort()[0] ?? null
        : null,
      affectedComponents,
      lastError: active[0]?.lastError ?? null,
      lastRecoveredAt: outages
        .filter((outage) => outage.backfillState === "complete" || outage.backfillState === "partial")
        .map((outage) => outage.lastAttemptAt)
        .filter((value): value is string => Boolean(value))
        .sort()
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
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return this.drain();
    this.#stopped = true;
    for (const houseId of this.#inFlight.keys()) this.invalidate(houseId);
    await this.drain();
  }

  #scheduleBackfill(house: House, provider: WeatherProviderName): void {
    if (this.#stopped || this.#inFlight.has(house.id)) return;
    const generation = this.#generation.get(house.id) ?? 0;
    const pending = this.#runBackfill(structuredClone(house), provider, generation)
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight.get(house.id) === pending) this.#inFlight.delete(house.id);
      });
    this.#inFlight.set(house.id, pending);
  }

  async #runBackfill(house: House, provider: WeatherProviderName, generation: number): Promise<void> {
    if (!house.location) return;
    const locationKey = outdoorLocationKey(house.location);
    const outages = this.database.listWeatherOutages(house.id, locationKey, 500)
      .filter((outage) => outage.provider === provider
        && outage.endedAt !== null
        && (outage.component === "service" || outage.component === "observation")
        && ["pending", "running", "failed", "partial"].includes(outage.backfillState));
    for (const outage of outages.reverse()) {
      if (!this.#isCurrent(house, generation)) return;
      await this.#backfillOutage(house, outage, generation);
    }
  }

  async #backfillOutage(house: House, outage: WeatherOutageRecord, generation: number): Promise<void> {
    const attemptedAt = new Date().toISOString();
    if (!this.provider.fetchObservationHistory || !outage.backfillFrom || !outage.backfillTo) {
      this.database.updateWeatherOutageBackfill(
        outage.id,
        "not-supported",
        0,
        attemptedAt,
        "Historical observations are not available from this provider",
      );
      return;
    }
    this.database.updateWeatherOutageBackfill(outage.id, "running", 0, attemptedAt, null);
    const startMs = Date.parse(outage.backfillFrom);
    const endMs = Date.parse(outage.backfillTo);
    const locationKey = outdoorLocationKey(house.location);
    let recoveredPoints = 0;
    let failedChunks = 0;
    let lastError: string | null = null;
    const persistedTimestamps = new Set(
      this.database.outdoorTemperatureHistory(
        house.id,
        locationKey,
        outage.backfillFrom,
        outage.backfillTo,
        100_000,
      ).filter((sample) => sample.source.startsWith(`${outage.provider}-`))
        .map((sample) => sample.timestamp),
    );

    for (let cursor = startMs; cursor < endMs; cursor += BACKFILL_CHUNK_MS) {
      const chunkEnd = Math.min(endMs, cursor + BACKFILL_CHUNK_MS);
      try {
        const history = await this.provider.fetchObservationHistory(
          house.id,
          house.location!,
          new Date(cursor).toISOString(),
          new Date(chunkEnd).toISOString(),
        );
        if (!this.#isCurrent(house, generation)) return;
        recoveredPoints += this.#persistHistory(house, history, persistedTimestamps);
      } catch (error) {
        failedChunks += 1;
        lastError = message(error);
      }
    }

    const state = failedChunks === 0 ? "complete" : recoveredPoints > 0 ? "partial" : "failed";
    this.database.updateWeatherOutageBackfill(outage.id, state, recoveredPoints, new Date().toISOString(), lastError);
    if (recoveredPoints > 0) await this.#onRecovered?.();
  }

  #discoverHistoricalObservationGaps(house: House, weather: HouseWeather): void {
    if (!house.location) return;
    const currentTimestamp = weather.current?.timestamp;
    const toMs = currentTimestamp && Number.isFinite(Date.parse(currentTimestamp))
      ? Date.parse(currentTimestamp)
      : Date.parse(weather.fetchedAt);
    if (!Number.isFinite(toMs)) return;
    const locationKey = outdoorLocationKey(house.location);
    const from = new Date(toMs - this.#historicalScanWindowMs).toISOString();
    const to = new Date(toMs).toISOString();
    const thresholdMs = historicalObservationGapMs(weather.provider);
    const gaps = this.database.outdoorTemperatureGaps(
      house.id,
      locationKey,
      weather.provider,
      from,
      to,
      thresholdMs,
      this.#historicalGapLimit,
    );
    for (const gap of gaps) {
      this.database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        weather.provider,
        gap.startedAt,
        gap.endedAt,
        weather.fetchedAt,
      );
    }
    const latest = this.database.latestOutdoorTemperatureTimestamp(house.id, locationKey, weather.provider);
    if (latest && toMs - Date.parse(latest) >= thresholdMs) {
      this.database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        weather.provider,
        latest,
        to,
        weather.fetchedAt,
      );
    }
  }

  #persistHistory(house: House, history: WeatherObservationHistory, persistedTimestamps: Set<string>): number {
    const locationKey = outdoorLocationKey(house.location);
    let persisted = 0;
    for (const observation of history.observations) {
      if (!Number.isFinite(observation.temperatureC) || persistedTimestamps.has(observation.timestamp)) continue;
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
      });
      persistedTimestamps.add(observation.timestamp);
      persisted += 1;
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
