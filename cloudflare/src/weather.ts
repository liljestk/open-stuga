import type { House, HouseWeather, OutdoorConditions } from "../../packages/contracts/src/index.js";
import { HttpError, isObject } from "./http.js";

const PROVIDER_TIMEOUT_MS = 10_000;

async function providerJson(url: string, code: string, message: string, headers?: HeadersInit): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) throw new HttpError(503, code, message);
    return await response.json<unknown>();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, code, message);
  }
}

function numberAt(values: unknown, index: number): number | undefined {
  return Array.isArray(values) && typeof values[index] === "number" && Number.isFinite(values[index])
    ? values[index] as number
    : undefined;
}

function stringAt(values: unknown, index: number): string | null {
  return Array.isArray(values) && typeof values[index] === "string" ? values[index] as string : null;
}

function conditionAt(hourly: Record<string, unknown>, index: number): OutdoorConditions | null {
  const timestamp = stringAt(hourly.time, index);
  if (!timestamp) return null;
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) return null;
  return {
    timestamp: new Date(epoch).toISOString(),
    ...(numberAt(hourly.temperature_2m, index) !== undefined ? { temperatureC: numberAt(hourly.temperature_2m, index) } : {}),
    ...(numberAt(hourly.relative_humidity_2m, index) !== undefined ? { relativeHumidityPercent: numberAt(hourly.relative_humidity_2m, index) } : {}),
    ...(numberAt(hourly.dew_point_2m, index) !== undefined ? { dewPointC: numberAt(hourly.dew_point_2m, index) } : {}),
    ...(numberAt(hourly.surface_pressure, index) !== undefined ? { pressureHpa: numberAt(hourly.surface_pressure, index) } : {}),
    ...(numberAt(hourly.wind_speed_10m, index) !== undefined ? { windSpeedMps: numberAt(hourly.wind_speed_10m, index)! / 3.6 } : {}),
    ...(numberAt(hourly.wind_direction_10m, index) !== undefined ? { windDirectionDegrees: numberAt(hourly.wind_direction_10m, index) } : {}),
    ...(numberAt(hourly.wind_gusts_10m, index) !== undefined ? { windGustMps: numberAt(hourly.wind_gusts_10m, index)! / 3.6 } : {}),
    ...(numberAt(hourly.precipitation, index) !== undefined ? { precipitation1hMm: numberAt(hourly.precipitation, index) } : {}),
    ...(numberAt(hourly.precipitation_probability, index) !== undefined ? { precipitationProbabilityPercent: numberAt(hourly.precipitation_probability, index) } : {}),
    ...(numberAt(hourly.cloud_cover, index) !== undefined ? { cloudCoverPercent: numberAt(hourly.cloud_cover, index) } : {}),
    ...(numberAt(hourly.visibility, index) !== undefined ? { visibilityMeters: numberAt(hourly.visibility, index) } : {}),
    ...(numberAt(hourly.weather_code, index) !== undefined ? { weatherSymbolCode: numberAt(hourly.weather_code, index) } : {}),
  };
}

export async function fetchHouseWeather(house: House, hours: number): Promise<HouseWeather> {
  if (!house.location) throw new HttpError(409, "HOUSE_LOCATION_REQUIRED", "Set the house location before requesting weather");
  const parameters = new URLSearchParams({
    latitude: String(house.location.latitude),
    longitude: String(house.location.longitude),
    timezone: "UTC",
    forecast_hours: String(Math.min(240, Math.max(1, hours))),
    hourly: [
      "temperature_2m", "relative_humidity_2m", "dew_point_2m", "surface_pressure",
      "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation",
      "precipitation_probability", "cloud_cover", "visibility", "weather_code",
    ].join(","),
  });
  const payload = await providerJson(
    `https://api.open-meteo.com/v1/forecast?${parameters}`,
    "WEATHER_UNAVAILABLE",
    "Weather provider is temporarily unavailable",
    { "user-agent": "Open-Stuga/0.2 hosted-weather" },
  );
  if (!isObject(payload) || !isObject(payload.hourly)) throw new HttpError(503, "WEATHER_UNAVAILABLE", "Weather provider returned an invalid response");
  const hourly = payload.hourly;
  const count = Array.isArray(hourly.time) ? Math.min(hourly.time.length, hours) : 0;
  const forecast = Array.from({ length: count }, (_, index) => conditionAt(hourly, index)).filter((item): item is OutdoorConditions => item !== null);
  const fetchedAt = new Date().toISOString();
  return {
    houseId: house.id,
    location: house.location,
    provider: "open-meteo",
    attribution: "Weather data by Open-Meteo",
    fetchedAt,
    forecastIssuedAt: null,
    stale: false,
    current: forecast[0] ?? null,
    observationStation: null,
    forecast,
    warnings: [],
    unavailable: ["observation", "short-range", "warnings"],
    componentStatus: {
      observation: { provider: "open-meteo", product: "forecast", attribution: "Weather data by Open-Meteo", availability: "unavailable", coverage: "unknown", emptyResultIsAuthoritative: false, fetchedAt, stale: false },
      forecast: { provider: "open-meteo", product: "forecast", attribution: "Weather data by Open-Meteo", availability: "available", coverage: "covered", emptyResultIsAuthoritative: true, fetchedAt, stale: false },
      "short-range": { provider: "open-meteo", product: "forecast", attribution: "Weather data by Open-Meteo", availability: "unavailable", coverage: "unknown", emptyResultIsAuthoritative: false, fetchedAt, stale: false },
      warnings: { provider: "open-meteo", product: "not-provided", attribution: "Weather data by Open-Meteo", availability: "unavailable", coverage: "unknown", emptyResultIsAuthoritative: false, fetchedAt, stale: false },
    },
  };
}

export async function searchLocations(query: string, language: string) {
  if (query.length < 2 || query.length > 120) throw new HttpError(400, "INVALID_LOCATION_QUERY", "q must contain between 2 and 120 characters");
  const params = new URLSearchParams({ name: query, count: "10", language: language.slice(0, 8), format: "json" });
  const payload = await providerJson(
    `https://geocoding-api.open-meteo.com/v1/search?${params}`,
    "LOCATION_DISCOVERY_UNAVAILABLE",
    "Location search is temporarily unavailable",
  );
  const results = isObject(payload) && Array.isArray(payload.results) ? payload.results : [];
  return results.filter(isObject).flatMap((result) => {
    if (typeof result.id !== "number" || typeof result.name !== "string" || typeof result.latitude !== "number"
      || typeof result.longitude !== "number" || typeof result.timezone !== "string") return [];
    const region = typeof result.admin1 === "string" ? result.admin1 : null;
    const country = typeof result.country === "string" ? result.country : null;
    return [{
      id: String(result.id),
      name: result.name,
      label: [result.name, region, country].filter(Boolean).join(", "),
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone,
      countryCode: typeof result.country_code === "string" ? result.country_code : null,
      country,
      region,
      source: "open-meteo-geocoding" as const,
      confidence: "medium" as const,
    }];
  });
}

export async function coordinateDefaults(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new HttpError(422, "INVALID_COORDINATES", "Coordinates must be valid WGS84 latitude and longitude");
  }
  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), timezone: "auto", forecast_days: "1" });
  const payload = await providerJson(
    `https://api.open-meteo.com/v1/forecast?${params}`,
    "LOCATION_DISCOVERY_UNAVAILABLE",
    "Timezone discovery is temporarily unavailable",
  );
  if (!isObject(payload) || typeof payload.timezone !== "string") throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Timezone discovery returned an invalid response");
  return { timezone: payload.timezone, source: "open-meteo-coordinate" as const };
}
