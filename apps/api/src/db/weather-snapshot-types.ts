import type { HouseWeather } from "@climate-twin/contracts";

export const CANONICAL_WEATHER_HOURS = 48;
export const MAX_WEATHER_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const INVALID_WEATHER_SNAPSHOT_ERROR = "The stored weather snapshot is invalid; waiting for a fresh background update";
const MAX_CANONICAL_FORECAST_POINTS = 192;
const MAX_CANONICAL_WARNINGS = 64;
const WEATHER_COMPONENTS = ["observation", "forecast", "short-range", "warnings"] as const;

export interface StoredWeatherSnapshot {
  houseId: string;
  locationKey: string;
  weather: HouseWeather | null;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WeatherSnapshotRow {
  house_id: string;
  location_key: string;
  weather_json: string | null;
  last_attempt_at: string;
  last_success_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function conditions(value: unknown): boolean {
  return record(value) && timestamp(value.timestamp);
}

function warning(value: unknown): boolean {
  return record(value)
    && typeof value.id === "string"
    && (value.expiresAt === null || timestamp(value.expiresAt));
}

function componentStatuses(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return WEATHER_COMPONENTS.every((component) => {
    const status = value[component];
    return record(status)
      && (status.provider === "fmi" || status.provider === "open-meteo")
      && typeof status.stale === "boolean"
      && timestamp(status.fetchedAt);
  });
}

function houseWeather(value: unknown, houseId: string): value is HouseWeather {
  if (!record(value) || value.houseId !== houseId || !record(value.location)) return false;
  const latitude = value.location.latitude;
  const longitude = value.location.longitude;
  return typeof latitude === "number" && Number.isFinite(latitude)
    && typeof longitude === "number" && Number.isFinite(longitude)
    && (value.provider === "fmi" || value.provider === "open-meteo")
    && typeof value.attribution === "string"
    && timestamp(value.fetchedAt)
    && (value.forecastIssuedAt === null || timestamp(value.forecastIssuedAt))
    && typeof value.stale === "boolean"
    && (value.current === null || conditions(value.current))
    && (value.observationStation === null || record(value.observationStation))
    && Array.isArray(value.forecast)
    && value.forecast.length <= MAX_CANONICAL_FORECAST_POINTS
    && value.forecast.every(conditions)
    && Array.isArray(value.warnings)
    && value.warnings.length <= MAX_CANONICAL_WARNINGS
    && value.warnings.every(warning)
    && Array.isArray(value.unavailable)
    && value.unavailable.length <= WEATHER_COMPONENTS.length
    && value.unavailable.every((component) => WEATHER_COMPONENTS.includes(component as never))
    && componentStatuses(value.componentStatus);
}

export function canonicalWeatherSnapshot(weather: HouseWeather): HouseWeather {
  const fetchedAt = Date.parse(weather.fetchedAt);
  const from = Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
  const to = from + CANONICAL_WEATHER_HOURS * 3_600_000;
  const forecast = [...new Map(weather.forecast
    .filter((point) => {
      const timestamp = Date.parse(point.timestamp);
      return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
    })
    .map((point) => [point.timestamp, point] as const)).values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(0, MAX_CANONICAL_FORECAST_POINTS);
  const canonical: HouseWeather = {
    ...weather,
    stale: false,
    forecast,
    warnings: weather.warnings.slice(0, MAX_CANONICAL_WARNINGS),
  };
  delete canonical.recovery;
  return canonical;
}

export function storedWeatherSnapshotFromRow(row: WeatherSnapshotRow): StoredWeatherSnapshot {
  let weather: HouseWeather | null = null;
  let invalid = false;
  if (row.weather_json) {
    try {
      const parsed: unknown = JSON.parse(row.weather_json);
      if (houseWeather(parsed, row.house_id)) weather = parsed;
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return {
    houseId: row.house_id,
    locationKey: row.location_key,
    weather,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastError: invalid ? INVALID_WEATHER_SNAPSHOT_ERROR : row.last_error,
    updatedAt: row.updated_at,
  };
}

export function weatherSnapshotError(error: unknown): string {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : typeof error === "string" && error.trim() ? error.trim() : "Weather provider request failed";
  return message.slice(0, 1000);
}
