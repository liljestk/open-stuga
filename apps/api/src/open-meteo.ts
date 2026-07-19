import type {
  HouseLocation,
  HouseWeather,
  OutdoorConditions,
  WeatherComponentAvailability,
  WeatherComponentCoverage,
  WeatherComponentStatus,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "./version.js";
import {
  WeatherUnavailableError,
  type WeatherObservationHistory,
  type WeatherProvider,
} from "./weather.js";

const API_URL = "https://api.open-meteo.com/v1/forecast";
const HISTORICAL_FORECAST_API_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CURRENT_VARIABLES = [
  "temperature_2m", "relative_humidity_2m", "dew_point_2m", "pressure_msl",
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation",
  "cloud_cover", "weather_code",
] as const;
const HOURLY_VARIABLES = [
  "temperature_2m", "relative_humidity_2m", "dew_point_2m", "pressure_msl",
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation",
  "precipitation_probability", "cloud_cover", "cloud_cover_low", "cloud_cover_mid",
  "cloud_cover_high", "visibility", "weather_code", "snow_depth", "shortwave_radiation",
] as const;

type OpenMeteoValues = Record<string, unknown> & { time?: unknown };

interface OpenMeteoResponse {
  current?: OpenMeteoValues;
  hourly?: OpenMeteoValues;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function setNumber(target: OutdoorConditions, key: keyof OutdoorConditions, value: unknown, scale = 1): void {
  const parsed = finite(value);
  if (parsed !== undefined) (target as unknown as Record<string, unknown>)[key] = parsed * scale;
}

export function openMeteoConditions(values: OpenMeteoValues, index?: number): OutdoorConditions | null {
  const item = (key: string): unknown => index === undefined
    ? values[key]
    : Array.isArray(values[key]) ? (values[key] as unknown[])[index] : undefined;
  const timestamp = utcTimestamp(index === undefined ? values.time : Array.isArray(values.time) ? values.time[index] : undefined);
  if (!timestamp) return null;
  const result: OutdoorConditions = { timestamp };
  setNumber(result, "temperatureC", item("temperature_2m"));
  setNumber(result, "relativeHumidityPercent", item("relative_humidity_2m"));
  setNumber(result, "dewPointC", item("dew_point_2m"));
  setNumber(result, "pressureHpa", item("pressure_msl"));
  setNumber(result, "windSpeedMps", item("wind_speed_10m"));
  setNumber(result, "windDirectionDegrees", item("wind_direction_10m"));
  setNumber(result, "windGustMps", item("wind_gusts_10m"));
  setNumber(result, "precipitation1hMm", item("precipitation"));
  setNumber(result, "precipitationProbabilityPercent", item("precipitation_probability"));
  setNumber(result, "cloudCoverPercent", item("cloud_cover"));
  setNumber(result, "lowCloudCoverPercent", item("cloud_cover_low"));
  setNumber(result, "mediumCloudCoverPercent", item("cloud_cover_mid"));
  setNumber(result, "highCloudCoverPercent", item("cloud_cover_high"));
  setNumber(result, "visibilityMeters", item("visibility"));
  setNumber(result, "presentWeatherCode", item("weather_code"));
  setNumber(result, "snowDepthCm", item("snow_depth"), 100);
  setNumber(result, "globalRadiationWm2", item("shortwave_radiation"));
  return result;
}

function component(
  product: string,
  fetchedAt: string,
  availability: WeatherComponentAvailability,
  coverage: WeatherComponentCoverage,
  emptyResultIsAuthoritative: boolean,
): WeatherComponentStatus {
  return {
    provider: "open-meteo",
    product,
    attribution: ATTRIBUTION,
    availability,
    coverage,
    emptyResultIsAuthoritative,
    fetchedAt,
    stale: false,
  };
}

async function jsonWithLimit(response: Response): Promise<OpenMeteoResponse> {
  if (!response.ok) throw new WeatherUnavailableError(`Open-Meteo returned HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new WeatherUnavailableError("Open-Meteo response exceeded the size limit");
  if (!response.body) throw new WeatherUnavailableError("Open-Meteo returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new WeatherUnavailableError("Open-Meteo response exceeded the size limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(combined)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as OpenMeteoResponse;
  } catch {
    throw new WeatherUnavailableError("Open-Meteo returned invalid JSON");
  }
}

export interface OpenMeteoWeatherProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Worldwide modelled current conditions and hourly forecast fallback. */
export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: OpenMeteoWeatherProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
    this.#now = options.now ?? (() => new Date());
  }

  async fetch(houseId: string, location: HouseLocation, hours: number): Promise<HouseWeather> {
    const parameters = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: CURRENT_VARIABLES.join(","),
      hourly: HOURLY_VARIABLES.join(","),
      // Open-Meteo starts forecast_hours at the current clock hour. Request
      // one guard point because that first point is already historical once
      // the request is made after HH:00, then trim to the requested horizon.
      forecast_hours: String(Math.max(1, Math.min(168, hours + 1))),
      timezone: "GMT",
      wind_speed_unit: "ms",
      temperature_unit: "celsius",
      precipitation_unit: "mm",
    });
    let response: Response;
    try {
      response = await this.#fetch(`${API_URL}?${parameters}`, {
        headers: { Accept: "application/json", "User-Agent": `Stuga/${SYSTEM_VERSION} Open-Meteo weather adapter` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new WeatherUnavailableError("Open-Meteo request failed");
    }
    const payload = await jsonWithLimit(response);
    const current = payload.current ? openMeteoConditions(payload.current) : null;
    const times = Array.isArray(payload.hourly?.time) ? payload.hourly.time : [];
    const cutoff = this.#now().getTime();
    const forecast = payload.hourly
      ? times.map((_, index) => openMeteoConditions(payload.hourly as OpenMeteoValues, index))
        .filter((point): point is OutdoorConditions => point !== null && Date.parse(point.timestamp) >= cutoff)
        .slice(0, hours)
      : [];
    if (!current && forecast.length === 0) throw new WeatherUnavailableError("Open-Meteo returned no usable weather values");
    const fetchedAt = this.#now().toISOString();
    return {
      houseId,
      location,
      provider: "open-meteo",
      attribution: ATTRIBUTION,
      fetchedAt,
      forecastIssuedAt: null,
      stale: false,
      current,
      observationStation: null,
      forecast,
      warnings: [],
      unavailable: [
        ...(current ? [] : ["observation" as const]),
        ...(forecast.length ? [] : ["forecast" as const]),
        "warnings" as const,
      ],
      componentStatus: {
        observation: component("best_match modelled current conditions", fetchedAt, current ? "available" : "unavailable", "covered", true),
        forecast: component("best_match hourly forecast", fetchedAt, forecast.length ? "available" : "unavailable", "covered", true),
        "short-range": component("best_match hourly forecast", fetchedAt, "not-applicable", "covered", true),
        warnings: component("official warnings are not provided", fetchedAt, "not-applicable", "outside-coverage", false),
      },
    };
  }

  async fetchObservationHistory(
    houseId: string,
    location: HouseLocation,
    from: string,
    to: string,
  ): Promise<WeatherObservationHistory> {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new WeatherUnavailableError("The Open-Meteo observation backfill range is invalid");
    }
    if (toMs - fromMs > 24 * 3_600_000) {
      throw new WeatherUnavailableError("Open-Meteo observation backfill requests are limited to 24-hour chunks");
    }
    const parameters = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      hourly: HOURLY_VARIABLES.join(","),
      start_date: new Date(fromMs).toISOString().slice(0, 10),
      end_date: new Date(toMs).toISOString().slice(0, 10),
      timezone: "GMT",
      wind_speed_unit: "ms",
      temperature_unit: "celsius",
      precipitation_unit: "mm",
    });
    let response: Response;
    try {
      response = await this.#fetch(`${HISTORICAL_FORECAST_API_URL}?${parameters}`, {
        headers: { Accept: "application/json", "User-Agent": `Stuga/${SYSTEM_VERSION} Open-Meteo weather recovery adapter` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new WeatherUnavailableError("Open-Meteo historical request failed");
    }
    const payload = await jsonWithLimit(response);
    const times = Array.isArray(payload.hourly?.time) ? payload.hourly.time : [];
    const observations = payload.hourly
      ? times.map((_, index) => openMeteoConditions(payload.hourly as OpenMeteoValues, index))
        .filter((point): point is OutdoorConditions => point !== null
          && Date.parse(point.timestamp) >= fromMs && Date.parse(point.timestamp) <= toMs)
      : [];
    if (observations.length === 0) {
      throw new WeatherUnavailableError("Open-Meteo returned no historical values for the outage window");
    }
    return {
      houseId,
      location,
      provider: "open-meteo",
      attribution: ATTRIBUTION,
      fetchedAt: this.#now().toISOString(),
      station: null,
      observations,
    };
  }
}

const FINLAND_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [18.8, 59.9], [21.2, 59.7], [24.8, 59.7], [27.9, 60.0], [31.6, 62.8],
  [30.5, 64.6], [29.5, 66.6], [28.5, 69.5], [27.4, 70.2], [25.4, 70.1],
  [23.8, 69.2], [21.2, 69.1], [20.4, 67.9], [22.0, 66.4], [23.8, 65.7],
  [22.0, 64.2], [21.0, 62.5], [21.5, 61.0], [18.8, 59.9],
];

function insideFinlandOutline(location: HouseLocation): boolean {
  let inside = false;
  for (let index = 0, previous = FINLAND_OUTLINE.length - 1; index < FINLAND_OUTLINE.length; previous = index, index += 1) {
    const [x, y] = FINLAND_OUTLINE[index]!;
    const [previousX, previousY] = FINLAND_OUTLINE[previous]!;
    const crosses = (y > location.latitude) !== (previousY > location.latitude)
      && location.longitude < (previousX - x) * (location.latitude - y) / (previousY - y) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** FMI is selected only for Finland, where official warning and observation components apply. */
export function prefersFmi(location: HouseLocation): boolean {
  if (location.countryCode) return location.countryCode.toUpperCase() === "FI";
  return insideFinlandOutline(location);
}

export class AutomaticWeatherProvider implements WeatherProvider {
  constructor(
    private readonly fmi: WeatherProvider,
    private readonly worldwide: WeatherProvider,
  ) {}

  fetch(houseId: string, location: HouseLocation, hours: number): Promise<HouseWeather> {
    return (prefersFmi(location) ? this.fmi : this.worldwide).fetch(houseId, location, hours);
  }

  fetchObservationHistory(
    houseId: string,
    location: HouseLocation,
    from: string,
    to: string,
  ): Promise<WeatherObservationHistory> {
    const provider = prefersFmi(location) ? this.fmi : this.worldwide;
    if (!provider.fetchObservationHistory) {
      return Promise.reject(new WeatherUnavailableError("This weather provider does not support observation backfill"));
    }
    return provider.fetchObservationHistory(houseId, location, from, to);
  }
}
