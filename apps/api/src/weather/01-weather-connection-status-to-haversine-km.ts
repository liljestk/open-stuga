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

export type WeatherConnectionStatus = NonNullable<IntegrationStatus["weather"]["connections"]>[number];

export const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";

export const FMI_WARNING_FEED = "https://alerts.fmi.fi/cap/feed/atom_en-GB.xml";

export const FORECAST_QUERY = "fmi::forecast::edited::weather::scandinavia::point::timevaluepair";

export const SHORT_RANGE_QUERY = "fmi::forecast::harmonie::surface::point::timevaluepair";

export const OBSERVATION_QUERY = "fmi::observations::weather::timevaluepair";

export const ATTRIBUTION = "Finnish Meteorological Institute open data (CC BY 4.0)";

export const FORECAST_PARAMETERS = [
  "Pressure", "Temperature", "DewPoint", "Humidity", "WindDirection", "WindSpeedMS",
  "Precipitation1h", "PrecipitationForm", "TotalCloudCover", "PoP", "ProbabilityThunderstorm",
  "LowCloudCover", "MediumCloudCover", "HighCloudCover", "RadiationGlobal", "FogIntensity",
  "WeatherSymbol3", "FrostProbability", "SevereFrostProbability", "HourlyMaximumWindSpeed",
  "HourlyMaximumGust", "PotentialPrecipitationForm",
] as const;

export const SHORT_RANGE_PARAMETERS = ["RadiationGlobal", "Visibility", "WindGust"] as const;

export const OBSERVATION_PARAMETERS = [
  "t2m", "rh", "td", "ws_10min", "wg_10min", "wd_10min", "r_1h", "ri_10min",
  "snow_aws", "p_sea", "vis", "n_man", "wawa",
] as const;

export const OBSERVATION_MAX_AGE_MS = 90 * 60_000;

export const OBSERVATION_MAX_PARAMETER_SKEW_MS = 30 * 60_000;

export const OBSERVATION_FUTURE_TOLERANCE_MS = 15 * 60_000;

export const DEFAULT_STALE_MAX_AGE_MS = 60 * 60_000;

export const DEFAULT_MAX_CACHE_ENTRIES = 128;

export // This is deliberately a broad superset of Finnish territory. Points outside
// it are certainly outside FMI's national CAP-warning coverage; points inside
// remain `unknown` unless an alert geometry explicitly contains the point.
const FMI_WARNING_COVERAGE_ENVELOPE = {
  minimumLatitude: 59,
  maximumLatitude: 71,
  minimumLongitude: 18,
  maximumLongitude: 33,
} as const;

export type XmlObject = Record<string, unknown>;

export interface FmiTimeValue {
  timestamp: string;
  value: number;
}

export interface FmiTimeSeries {
  parameter: string;
  resultTime: string | null;
  location: {
    id: string | null;
    name: string;
    latitude: number;
    longitude: number;
  } | null;
  values: FmiTimeValue[];
}

export interface ParsedWarningArea {
  description: string;
  polygons: Array<Array<[number, number]>>;
  circles: Array<{ latitude: number; longitude: number; radiusKm: number }>;
}

export interface ParsedCapWarning {
  warning: WeatherWarning;
  areas: ParsedWarningArea[];
}

export interface WeatherProvider {
  fetch(houseId: string, location: HouseLocation, hours: number): Promise<HouseWeather>;
  /** Historical observed/modelled conditions used only to repair a recorded outage window. */
  fetchObservationHistory?(
    houseId: string,
    location: HouseLocation,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<WeatherObservationHistory>;
}

export interface WeatherObservationHistory {
  houseId: string;
  location: HouseLocation;
  provider: HouseWeather["provider"];
  attribution: string;
  fetchedAt: string;
  station: WeatherStation | null;
  observations: OutdoorConditions[];
}

export interface WeatherRecoveryLifecycle {
  recordFailure(house: House, error: unknown, detectedAt: string): void;
  recordSuccess(house: House, weather: HouseWeather): void;
  status(house: House): WeatherRecoveryStatus;
  invalidate?(houseId: string): void;
}

export class WeatherUnavailableError extends Error {
  constructor(message = "Weather data is temporarily unavailable") {
    super(message);
  }
}

/** An invalidated house snapshot must never update cache, status, or history. */
export class WeatherRequestSupersededError extends Error {
  constructor(message = "House metadata changed while weather was loading; request weather again") {
    super(message);
  }
}

export function fmiWarningCoverage(location: HouseLocation): WeatherComponentCoverage {
  if (location.countryCode) return location.countryCode.toUpperCase() === "FI" ? "covered" : "outside-coverage";
  const insideEnvelope = location.latitude >= FMI_WARNING_COVERAGE_ENVELOPE.minimumLatitude
    && location.latitude <= FMI_WARNING_COVERAGE_ENVELOPE.maximumLatitude
    && location.longitude >= FMI_WARNING_COVERAGE_ENVELOPE.minimumLongitude
    && location.longitude <= FMI_WARNING_COVERAGE_ENVELOPE.maximumLongitude;
  return insideEnvelope ? "unknown" : "outside-coverage";
}

export function componentStatus(
  product: string,
  fetchedAt: string,
  availability: WeatherComponentStatus["availability"],
  coverage: WeatherComponentCoverage = "unknown",
  emptyResultIsAuthoritative = false,
): WeatherComponentStatus {
  return {
    provider: "fmi",
    product,
    attribution: ATTRIBUTION,
    availability,
    coverage,
    emptyResultIsAuthoritative,
    fetchedAt,
    stale: false,
  };
}

export function xmlObject(value: unknown): XmlObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as XmlObject : null;
}

export function xmlText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const object = xmlObject(value);
  const text = object?.["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text).trim() : null;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function finiteNumber(value: unknown): number | null {
  const text = xmlText(value);
  if (text === null || text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePosition(value: unknown): { latitude: number; longitude: number } | null {
  const coordinates = xmlText(value)?.split(/\s+/).map(Number) ?? [];
  const latitude = coordinates[0];
  const longitude = coordinates[1];
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude: latitude as number, longitude: longitude as number }
    : null;
}

export function nestedObject(root: XmlObject | null, ...keys: string[]): XmlObject | null {
  let current = root;
  for (const key of keys) current = xmlObject(current?.[key]);
  return current;
}

export function parameterFromHref(value: unknown): string | null {
  const href = xmlText(xmlObject(value)?.["@href"]);
  if (!href) return null;
  try {
    return new URL(href).searchParams.get("param");
  } catch {
    return /[?&]param=([^&]+)/.exec(href)?.[1] ?? null;
  }
}

export function observationPoint(observation: XmlObject): XmlObject | null {
  const feature = nestedObject(observation, "featureOfInterest", "SF_SpatialSamplingFeature");
  const shape = xmlObject(feature?.shape);
  const direct = xmlObject(shape?.Point);
  if (direct) return direct;
  return nestedObject(shape, "MultiPoint", "pointMembers", "Point");
}

export function observationLocation(observation: XmlObject): FmiTimeSeries["location"] {
  const point = observationPoint(observation);
  const position = parsePosition(point?.pos);
  if (!position) return null;
  const location = nestedObject(
    nestedObject(observation, "featureOfInterest", "SF_SpatialSamplingFeature"),
    "sampledFeature", "LocationCollection", "member", "Location",
  );
  return {
    id: xmlText(location?.identifier),
    name: xmlText(point?.name) ?? xmlText(location?.name) ?? "FMI observation station",
    ...position,
  };
}

/** Parses FMI WFS timevaluepair responses while retaining station/grid provenance. */
export function parseFmiTimeSeries(xml: string): FmiTimeSeries[] {
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    trimValues: true,
  });
  const document = xmlObject(parser.parse(xml));
  const collection = xmlObject(document?.FeatureCollection);
  const exception = xmlObject(document?.ExceptionReport);
  if (exception) {
    const message = xmlText(nestedObject(exception, "Exception", "ExceptionText")) ?? "FMI returned an exception";
    throw new WeatherUnavailableError(message);
  }
  const result: FmiTimeSeries[] = [];
  for (const memberValue of asArray(collection?.member)) {
    const member = xmlObject(memberValue);
    const observation = xmlObject(member?.PointTimeSeriesObservation);
    if (!observation) continue;
    const parameter = parameterFromHref(observation.observedProperty);
    if (!parameter) continue;
    const timeseries = nestedObject(observation, "result", "MeasurementTimeseries");
    const values: FmiTimeValue[] = [];
    for (const pointValue of asArray(timeseries?.point)) {
      const tvp = nestedObject(xmlObject(pointValue), "MeasurementTVP");
      const timestamp = xmlText(tvp?.time);
      const value = finiteNumber(tvp?.value);
      if (timestamp && Number.isFinite(Date.parse(timestamp)) && value !== null) values.push({ timestamp, value });
    }
    const resultTime = xmlText(nestedObject(observation, "resultTime", "TimeInstant")?.timePosition);
    result.push({ parameter, resultTime, location: observationLocation(observation), values });
  }
  return result;
}

export function normalizePrecipitation(value: number): number {
  return Math.max(0, value);
}

export function applyForecastValue(target: OutdoorConditions, parameter: string, value: number): void {
  switch (parameter) {
    case "Pressure": target.pressureHpa = value; break;
    case "Temperature": target.temperatureC = value; break;
    case "DewPoint": target.dewPointC = value; break;
    case "Humidity": target.relativeHumidityPercent = value; break;
    case "WindDirection": target.windDirectionDegrees = value; break;
    case "WindSpeedMS": target.windSpeedMps = value; break;
    case "WindGust": target.windGustMps = value; break;
    case "Precipitation1h": target.precipitation1hMm = normalizePrecipitation(value); break;
    case "PrecipitationForm": target.precipitationFormCode = value; break;
    case "PotentialPrecipitationForm": target.potentialPrecipitationFormCode = value; break;
    case "TotalCloudCover": target.cloudCoverPercent = value; break;
    case "LowCloudCover": target.lowCloudCoverPercent = value; break;
    case "MediumCloudCover": target.mediumCloudCoverPercent = value; break;
    case "HighCloudCover": target.highCloudCoverPercent = value; break;
    case "PoP": target.precipitationProbabilityPercent = value; break;
    case "ProbabilityThunderstorm": target.thunderstormProbabilityPercent = value; break;
    case "RadiationGlobal": target.globalRadiationWm2 = value; break;
    case "Visibility": target.visibilityMeters = value; break;
    case "FogIntensity": target.fogIntensity = value; break;
    case "WeatherSymbol3": target.weatherSymbolCode = value; break;
    case "FrostProbability": target.frostProbabilityPercent = value; break;
    case "SevereFrostProbability": target.severeFrostProbabilityPercent = value; break;
    case "HourlyMaximumWindSpeed": target.maximumWindSpeedMps = value; break;
    case "HourlyMaximumGust": target.maximumWindGustMps = value; break;
  }
}

export function applyObservationValue(target: OutdoorConditions, parameter: string, value: number): void {
  switch (parameter) {
    case "t2m": target.temperatureC = value; break;
    case "td": target.dewPointC = value; break;
    case "rh": target.relativeHumidityPercent = value; break;
    case "p_sea": target.pressureHpa = value; break;
    case "wd_10min": target.windDirectionDegrees = value; break;
    case "ws_10min": target.windSpeedMps = value; break;
    case "wg_10min": target.windGustMps = value; break;
    case "r_1h": target.precipitation1hMm = normalizePrecipitation(value); break;
    case "ri_10min": target.precipitationIntensityMmPerHour = normalizePrecipitation(value); break;
    case "snow_aws": if (value >= 0) target.snowDepthCm = value; break;
    case "vis": target.visibilityMeters = value; break;
    case "n_man": if (value >= 0 && value <= 8) target.cloudCoverPercent = value * 12.5; break;
    case "wawa": target.presentWeatherCode = value; break;
  }
}

export function forecastFromSeries(series: FmiTimeSeries[]): { forecast: OutdoorConditions[]; issuedAt: string | null } {
  const byTimestamp = new Map<string, OutdoorConditions>();
  for (const item of series) {
    for (const entry of item.values) {
      const point = byTimestamp.get(entry.timestamp) ?? { timestamp: entry.timestamp };
      applyForecastValue(point, item.parameter, entry.value);
      byTimestamp.set(entry.timestamp, point);
    }
  }
  const issued = series
    .flatMap((item) => item.resultTime ? [item.resultTime] : [])
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
  return { forecast: [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), issuedAt: issued };
}

export function mergeForecasts(primary: OutdoorConditions[], supplemental: OutdoorConditions[]): OutdoorConditions[] {
  const merged = new Map(supplemental.map((point) => [point.timestamp, point]));
  for (const point of primary) {
    const supplementalPoint = merged.get(point.timestamp);
    merged.set(point.timestamp, supplementalPoint ? { ...supplementalPoint, ...point } : point);
  }
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function haversineKm(first: HouseLocation, second: HouseLocation): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
