import { XMLParser } from "fast-xml-parser";
import type {
  House,
  HouseLocation,
  HouseWeather,
  IntegrationStatus,
  OutdoorConditions,
  WeatherComponentCoverage,
  WeatherComponentStatus,
  WeatherComponentStatuses,
  WeatherRecoveryStatus,
  WeatherStation,
  WeatherWarning,
  WeatherWarningSeverity,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "../version.js";
import { ATTRIBUTION, DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_STALE_MAX_AGE_MS, FMI_WARNING_FEED, FMI_WFS_URL, FORECAST_PARAMETERS, FORECAST_QUERY, OBSERVATION_PARAMETERS, OBSERVATION_QUERY, ParsedCapWarning, SHORT_RANGE_PARAMETERS, SHORT_RANGE_QUERY, WeatherConnectionStatus, WeatherObservationHistory, WeatherProvider, WeatherRecoveryLifecycle, WeatherRequestSupersededError, WeatherUnavailableError, componentStatus, fmiWarningCoverage, forecastFromSeries, mergeForecasts, parseFmiTimeSeries } from "./01-weather-connection-status-to-haversine-km.js";
import { FmiWeatherProviderOptions, currentObservation, historicalObservations, parseCapFeed, readTextWithByteLimit, warningAreaMatches, warningIsUnexpired } from "./02-current-observation-to-fmi-weather-provider-options.js";

export class FmiWeatherProvider implements WeatherProvider {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #warningCache: { expiresAt: number; records: ParsedCapWarning[] } | null = null;

  constructor(options: FmiWeatherProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#now = options.now ?? (() => new Date());
  }

  async #xml(url: string, maximumBytes: number): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { Accept: "application/xml,text/xml;q=0.9", "User-Agent": `Climate-Twin/${SYSTEM_VERSION} FMI weather adapter` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new WeatherUnavailableError("FMI request failed");
    }
    if (!response.ok) throw new WeatherUnavailableError(`FMI returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new WeatherUnavailableError("FMI response exceeded the configured size limit");
    }
    try {
      return await readTextWithByteLimit(response, maximumBytes);
    } catch (error) {
      if (error instanceof WeatherUnavailableError) throw error;
      throw new WeatherUnavailableError("FMI response could not be read");
    }
  }

  #forecastUrl(
    location: HouseLocation,
    hours: number,
    now: Date,
    storedQuery = FORECAST_QUERY,
    parameters: readonly string[] = FORECAST_PARAMETERS,
  ): string {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + hours * 3_600_000);
    const query = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature", storedquery_id: storedQuery,
      latlon: `${location.latitude},${location.longitude}`, timestep: "60",
      starttime: start.toISOString(), endtime: end.toISOString(), parameters: parameters.join(","),
    });
    return `${FMI_WFS_URL}?${query}`;
  }

  #observationUrl(location: HouseLocation, start: Date, end: Date, radiusKm: number): string {
    const latitudeRadius = radiusKm / 111;
    const longitudeRadius = Math.min(5, radiusKm / (111 * Math.max(0.15, Math.cos(location.latitude * Math.PI / 180))));
    const bbox = [
      location.longitude - longitudeRadius, location.latitude - latitudeRadius,
      location.longitude + longitudeRadius, location.latitude + latitudeRadius,
    ].join(",") + ",EPSG:4326";
    const query = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature", storedquery_id: OBSERVATION_QUERY,
      bbox, maxlocations: "20", timestep: "10", starttime: start.toISOString(), endtime: end.toISOString(),
      parameters: OBSERVATION_PARAMETERS.join(","),
    });
    return `${FMI_WFS_URL}?${query}`;
  }

  async #observations(location: HouseLocation, now: Date): Promise<ReturnType<typeof currentObservation>> {
    const start = new Date(now.getTime() - 3 * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    for (const radiusKm of [40, 120]) {
      const xml = await this.#xml(this.#observationUrl(location, start, now, radiusKm), 8 * 1024 * 1024);
      const parsed = currentObservation(parseFmiTimeSeries(xml), location, now);
      if (parsed.current) return parsed;
    }
    throw new WeatherUnavailableError("No recent FMI observation station data was found nearby");
  }

  async fetchObservationHistory(
    houseId: string,
    location: HouseLocation,
    from: string,
    to: string,
  ): Promise<WeatherObservationHistory> {
    const start = new Date(from);
    const end = new Date(to);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new WeatherUnavailableError("The FMI observation backfill range is invalid");
    }
    if (end.getTime() - start.getTime() > 24 * 3_600_000) {
      throw new WeatherUnavailableError("FMI observation backfill requests are limited to 24-hour chunks");
    }
    for (const radiusKm of [40, 120]) {
      const xml = await this.#xml(this.#observationUrl(location, start, end, radiusKm), 16 * 1024 * 1024);
      const parsed = historicalObservations(parseFmiTimeSeries(xml), location);
      if (parsed.observations.length > 0) {
        return {
          houseId,
          location,
          provider: "fmi",
          attribution: ATTRIBUTION,
          fetchedAt: this.#now().toISOString(),
          station: parsed.station,
          observations: parsed.observations.filter((point) => point.timestamp >= from && point.timestamp <= to),
        };
      }
    }
    throw new WeatherUnavailableError("No FMI observations were available for the outage window");
  }

  async #warnings(location: HouseLocation): Promise<WeatherWarning[]> {
    const now = this.#now().getTime();
    if (!this.#warningCache || this.#warningCache.expiresAt <= now) {
      const xml = await this.#xml(FMI_WARNING_FEED, 10 * 1024 * 1024);
      this.#warningCache = { records: parseCapFeed(xml), expiresAt: now + 10 * 60_000 };
    }
    const unique = new Map<string, WeatherWarning>();
    for (const item of this.#warningCache.records) {
      if (warningIsUnexpired(item.warning, now)
        && item.areas.some((area) => warningAreaMatches(location, area))
        && !unique.has(item.warning.id)) {
        unique.set(item.warning.id, item.warning);
      }
    }
    return [...unique.values()];
  }

  async fetch(houseId: string, location: HouseLocation, hours: number): Promise<HouseWeather> {
    const now = this.#now();
    const fetchedAt = now.toISOString();
    const declaredWarningCoverage = fmiWarningCoverage(location);
    const [forecastResult, shortRangeResult, observationResult, warningResult] = await Promise.allSettled([
      this.#xml(this.#forecastUrl(location, hours, now), 8 * 1024 * 1024).then(parseFmiTimeSeries).then(forecastFromSeries),
      this.#xml(
        this.#forecastUrl(location, Math.min(hours, 66), now, SHORT_RANGE_QUERY, SHORT_RANGE_PARAMETERS),
        4 * 1024 * 1024,
      ).then(parseFmiTimeSeries).then(forecastFromSeries),
      this.#observations(location, now),
      declaredWarningCoverage === "outside-coverage" ? Promise.resolve([]) : this.#warnings(location),
    ]);
    const cutoff = now.getTime();
    const officialForecast = forecastResult.status === "fulfilled"
      ? forecastResult.value.forecast.filter((point) => Date.parse(point.timestamp) >= cutoff)
      : [];
    const shortRangeForecast = shortRangeResult.status === "fulfilled"
      ? shortRangeResult.value.forecast.filter((point) => Date.parse(point.timestamp) >= cutoff)
      : [];
    const unavailable: HouseWeather["unavailable"] = [];
    if (officialForecast.length === 0) unavailable.push("forecast");
    if (shortRangeForecast.length === 0) unavailable.push("short-range");
    if (observationResult.status === "rejected" || !observationResult.value.current) unavailable.push("observation");
    if (warningResult.status === "rejected" || declaredWarningCoverage === "outside-coverage") unavailable.push("warnings");
    if (unavailable.includes("forecast") && unavailable.includes("observation") && unavailable.includes("warnings")) {
      throw new WeatherUnavailableError();
    }
    const warnings = warningResult.status === "fulfilled" ? warningResult.value : [];
    const warningCoverage: WeatherComponentCoverage = declaredWarningCoverage === "outside-coverage"
      ? "outside-coverage"
      : declaredWarningCoverage === "covered" || warnings.length > 0 ? "covered" : "unknown";
    const componentStatusByName: WeatherComponentStatuses = {
      observation: componentStatus(
        OBSERVATION_QUERY,
        fetchedAt,
        observationResult.status === "fulfilled" && observationResult.value.current ? "available" : "unavailable",
      ),
      forecast: componentStatus(FORECAST_QUERY, fetchedAt, officialForecast.length > 0 ? "available" : "unavailable"),
      "short-range": componentStatus(SHORT_RANGE_QUERY, fetchedAt, shortRangeForecast.length > 0 ? "available" : "unavailable"),
      warnings: componentStatus(
        FMI_WARNING_FEED,
        fetchedAt,
        declaredWarningCoverage === "outside-coverage"
          ? "not-applicable"
          : warningResult.status === "fulfilled" ? "available" : "unavailable",
        warningCoverage,
        warningResult.status === "fulfilled" && warningCoverage === "covered",
      ),
    };
    return {
      houseId,
      location,
      provider: "fmi",
      attribution: ATTRIBUTION,
      fetchedAt,
      forecastIssuedAt: forecastResult.status === "fulfilled" ? forecastResult.value.issuedAt : null,
      stale: false,
      current: observationResult.status === "fulfilled" ? observationResult.value.current : null,
      observationStation: observationResult.status === "fulfilled" ? observationResult.value.station : null,
      forecast: mergeForecasts(officialForecast, shortRangeForecast),
      warnings,
      unavailable,
      componentStatus: componentStatusByName,
    };
  }
}

export interface WeatherCacheEntry {
  houseId: string;
  cachedAt: number;
  expiresAt: number;
  retryAt?: number;
  weather: HouseWeather;
}

export interface WeatherInFlightEntry {
  houseId: string;
  generation: number;
  promise: Promise<HouseWeather>;
}

export class WeatherService {
  readonly #cache = new Map<string, WeatherCacheEntry>();
  readonly #inFlight = new Map<string, WeatherInFlightEntry>();
  readonly #houseGeneration = new Map<string, number>();

  constructor(
    private readonly provider: WeatherProvider,
    private readonly status: IntegrationStatus["weather"],
    private readonly onStatusChange: () => void,
    private readonly cacheTtlMs = 10 * 60_000,
    private readonly staleMaxAgeMs = DEFAULT_STALE_MAX_AGE_MS,
    private readonly maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
    private readonly recovery?: WeatherRecoveryLifecycle,
  ) {}

  invalidate(houseId: string): void {
    this.#houseGeneration.set(houseId, this.#generation(houseId) + 1);
    for (const [key, entry] of this.#cache) {
      if (entry.houseId === houseId) this.#cache.delete(key);
    }
    for (const [key, entry] of this.#inFlight) {
      if (entry.houseId === houseId) this.#inFlight.delete(key);
    }
    this.recovery?.invalidate?.(houseId);
    const connection = this.status.connections?.find((candidate) => candidate.houseId === houseId);
    if (connection && (connection.lastSuccessAt !== null || connection.error !== null)) {
      connection.lastSuccessAt = null;
      connection.error = null;
      this.onStatusChange();
    }
  }

  async get(house: House, hours: number): Promise<HouseWeather> {
    if (!house.location) throw new WeatherUnavailableError("Set the house location before requesting weather");
    const key = `${house.id}:${house.location.latitude.toFixed(6)}:${house.location.longitude.toFixed(6)}:${hours}`;
    const generation = this.#generation(house.id);
    const now = Date.now();
    const cached = this.#cache.get(key);
    if (cached && (cached.expiresAt > now || (cached.retryAt ?? 0) > now)) {
      this.#touch(key, cached);
      return this.#withRecovery(house, this.#forCurrentTime(cached.weather, now, cached.expiresAt <= now));
    }
    const pending = this.#inFlight.get(key);
    if (pending?.generation === generation) return pending.promise;
    const refresh = this.#refresh(house, hours, key, generation, cached);
    this.#inFlight.set(key, { houseId: house.id, generation, promise: refresh });
    try {
      return await refresh;
    } finally {
      if (this.#inFlight.get(key)?.promise === refresh) this.#inFlight.delete(key);
    }
  }

  async #refresh(
    house: House,
    hours: number,
    key: string,
    generation: number,
    cached?: WeatherCacheEntry,
  ): Promise<HouseWeather> {
    try {
      const fetched = await this.provider.fetch(house.id, house.location as HouseLocation, hours);
      this.#assertCurrent(house.id, generation);
      this.recovery?.recordSuccess(house, fetched);
      const cachedAt = Date.now();
      const weather = this.#withRecovery(house, this.#forCurrentTime(fetched, cachedAt, false));
      this.#touch(key, { houseId: house.id, cachedAt, weather, expiresAt: cachedAt + this.cacheTtlMs });
      this.#trimCache();
      this.status.provider = weather.provider;
      this.status.lastSuccessAt = weather.fetchedAt;
      this.status.error = null;
      const connection = this.#connectionStatus(house);
      connection.provider = weather.provider;
      connection.lastSuccessAt = weather.fetchedAt;
      connection.error = null;
      this.onStatusChange();
      return weather;
    } catch (error) {
      this.#assertCurrent(house.id, generation);
      if (error instanceof WeatherRequestSupersededError) throw error;
      try {
        this.recovery?.recordFailure(house, error, new Date(Date.now()).toISOString());
      } catch {
        // Outage bookkeeping must never replace the provider error seen by the caller.
      }
      this.status.error = error instanceof Error ? error.message : "Weather provider request failed";
      const connection = this.#connectionStatus(house);
      connection.error = this.status.error;
      this.onStatusChange();
      const now = Date.now();
      if (cached && now - cached.cachedAt <= this.staleMaxAgeMs) {
        const weather = this.#forCurrentTime(cached.weather, now, true);
        cached.weather = this.#forCurrentTime(cached.weather, now, false);
        // Keep the original freshness timestamp while preventing every caller
        // from hammering an unavailable provider during the stale fallback.
        cached.retryAt = now + Math.min(this.cacheTtlMs, 60_000);
        this.#touch(key, cached);
        return this.#withRecovery(house, weather);
      }
      if (cached) this.#cache.delete(key);
      throw error;
    }
  }

  #connectionStatus(house: House): WeatherConnectionStatus {
    const connections = this.status.connections ?? (this.status.connections = []);
    let connection = connections.find((candidate) => candidate.houseId === house.id);
    if (!connection) {
      connection = {
        houseId: house.id,
        configured: house.location !== undefined,
        provider: this.status.provider,
        lastSuccessAt: null,
        error: null,
      };
      connections.push(connection);
    } else {
      connection.configured = house.location !== undefined;
    }
    return connection;
  }

  #forCurrentTime(weather: HouseWeather, nowMs: number, stale: boolean): HouseWeather {
    const forecast = weather.forecast.filter((point) => {
      const timestamp = Date.parse(point.timestamp);
      return Number.isFinite(timestamp) && timestamp >= nowMs;
    });
    const warnings = weather.warnings.filter((warning) => warningIsUnexpired(warning, nowMs));
    const statuses = weather.componentStatus ? {
      observation: { ...weather.componentStatus.observation, stale },
      forecast: {
        ...weather.componentStatus.forecast,
        stale,
        ...(forecast.length === 0 ? { availability: "unavailable" as const } : {}),
      },
      "short-range": { ...weather.componentStatus["short-range"], stale },
      warnings: {
        ...weather.componentStatus.warnings,
        stale,
        ...(stale ? { emptyResultIsAuthoritative: false } : {}),
      },
    } : undefined;
    const statusesUnchanged = !statuses || Object.values(statuses).every((status) => status.stale === weather.stale);
    if (weather.stale === stale && forecast.length === weather.forecast.length
      && warnings.length === weather.warnings.length && statusesUnchanged) {
      return weather;
    }
    return { ...weather, stale, forecast, warnings, ...(statuses ? { componentStatus: statuses } : {}) };
  }

  recoveryStatus(house: House): WeatherRecoveryStatus | null {
    return this.recovery?.status(house) ?? null;
  }

  #withRecovery(house: House, weather: HouseWeather): HouseWeather {
    const recovery = this.recovery?.status(house);
    return recovery ? { ...weather, recovery } : weather;
  }

  #generation(houseId: string): number {
    return this.#houseGeneration.get(houseId) ?? 0;
  }

  #assertCurrent(houseId: string, generation: number): void {
    if (this.#generation(houseId) !== generation) throw new WeatherRequestSupersededError();
  }

  #touch(key: string, entry: WeatherCacheEntry): void {
    this.#cache.delete(key);
    this.#cache.set(key, entry);
  }

  #trimCache(): void {
    while (this.#cache.size > Math.max(1, this.maxCacheEntries)) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }
}
