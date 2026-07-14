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
  WeatherStation,
  WeatherWarning,
  WeatherWarningSeverity,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "./version.js";

const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";
const FMI_WARNING_FEED = "https://alerts.fmi.fi/cap/feed/atom_en-GB.xml";
const FORECAST_QUERY = "fmi::forecast::edited::weather::scandinavia::point::timevaluepair";
const SHORT_RANGE_QUERY = "fmi::forecast::harmonie::surface::point::timevaluepair";
const OBSERVATION_QUERY = "fmi::observations::weather::timevaluepair";
const ATTRIBUTION = "Finnish Meteorological Institute open data (CC BY 4.0)";
const FORECAST_PARAMETERS = [
  "Pressure", "Temperature", "DewPoint", "Humidity", "WindDirection", "WindSpeedMS",
  "Precipitation1h", "PrecipitationForm", "TotalCloudCover", "PoP", "ProbabilityThunderstorm",
  "LowCloudCover", "MediumCloudCover", "HighCloudCover", "RadiationGlobal", "FogIntensity",
  "WeatherSymbol3", "FrostProbability", "SevereFrostProbability", "HourlyMaximumWindSpeed",
  "HourlyMaximumGust", "PotentialPrecipitationForm",
] as const;
const SHORT_RANGE_PARAMETERS = ["RadiationGlobal", "Visibility", "WindGust"] as const;
const OBSERVATION_PARAMETERS = [
  "t2m", "rh", "td", "ws_10min", "wg_10min", "wd_10min", "r_1h", "ri_10min",
  "snow_aws", "p_sea", "vis", "n_man", "wawa",
] as const;
const OBSERVATION_MAX_AGE_MS = 90 * 60_000;
const OBSERVATION_MAX_PARAMETER_SKEW_MS = 30 * 60_000;
const OBSERVATION_FUTURE_TOLERANCE_MS = 15 * 60_000;
const DEFAULT_STALE_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
// This is deliberately a broad superset of Finnish territory. Points outside
// it are certainly outside FMI's national CAP-warning coverage; points inside
// remain `unknown` unless an alert geometry explicitly contains the point.
const FMI_WARNING_COVERAGE_ENVELOPE = {
  minimumLatitude: 59,
  maximumLatitude: 71,
  minimumLongitude: 18,
  maximumLongitude: 33,
} as const;

type XmlObject = Record<string, unknown>;

interface FmiTimeValue {
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

interface ParsedWarningArea {
  description: string;
  polygons: Array<Array<[number, number]>>;
  circles: Array<{ latitude: number; longitude: number; radiusKm: number }>;
}

interface ParsedCapWarning {
  warning: WeatherWarning;
  areas: ParsedWarningArea[];
}

export interface WeatherProvider {
  fetch(houseId: string, location: HouseLocation, hours: number): Promise<HouseWeather>;
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

function componentStatus(
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

function xmlObject(value: unknown): XmlObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as XmlObject : null;
}

function xmlText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const object = xmlObject(value);
  const text = object?.["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text).trim() : null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(xmlText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePosition(value: unknown): { latitude: number; longitude: number } | null {
  const coordinates = xmlText(value)?.split(/\s+/).map(Number) ?? [];
  const latitude = coordinates[0];
  const longitude = coordinates[1];
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude: latitude as number, longitude: longitude as number }
    : null;
}

function nestedObject(root: XmlObject | null, ...keys: string[]): XmlObject | null {
  let current = root;
  for (const key of keys) current = xmlObject(current?.[key]);
  return current;
}

function parameterFromHref(value: unknown): string | null {
  const href = xmlText(xmlObject(value)?.["@href"]);
  if (!href) return null;
  try {
    return new URL(href).searchParams.get("param");
  } catch {
    return /[?&]param=([^&]+)/.exec(href)?.[1] ?? null;
  }
}

function observationPoint(observation: XmlObject): XmlObject | null {
  const feature = nestedObject(observation, "featureOfInterest", "SF_SpatialSamplingFeature");
  const shape = xmlObject(feature?.shape);
  const direct = xmlObject(shape?.Point);
  if (direct) return direct;
  return nestedObject(shape, "MultiPoint", "pointMembers", "Point");
}

function observationLocation(observation: XmlObject): FmiTimeSeries["location"] {
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

function normalizePrecipitation(value: number): number {
  return Math.max(0, value);
}

function applyForecastValue(target: OutdoorConditions, parameter: string, value: number): void {
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

function applyObservationValue(target: OutdoorConditions, parameter: string, value: number): void {
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

function forecastFromSeries(series: FmiTimeSeries[]): { forecast: OutdoorConditions[]; issuedAt: string | null } {
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

function mergeForecasts(primary: OutdoorConditions[], supplemental: OutdoorConditions[]): OutdoorConditions[] {
  const merged = new Map(supplemental.map((point) => [point.timestamp, point]));
  for (const point of primary) {
    const supplementalPoint = merged.get(point.timestamp);
    merged.set(point.timestamp, supplementalPoint ? { ...supplementalPoint, ...point } : point);
  }
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function haversineKm(first: HouseLocation, second: HouseLocation): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Selects the nearest station with a recent temperature and co-timed values. */
export function currentObservation(
  series: FmiTimeSeries[],
  houseLocation: HouseLocation,
  now = new Date(),
): { current: OutdoorConditions | null; station: WeatherStation | null } {
  const nowMs = now.getTime();
  const groups = new Map<string, FmiTimeSeries[]>();
  for (const item of series) {
    if (!item.location || item.values.length === 0) continue;
    const key = item.location.id ?? `${item.location.latitude.toFixed(5)},${item.location.longitude.toFixed(5)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ranked = [...groups.entries()].map(([key, items]) => {
    const location = items[0]?.location;
    const temperature = items
      .filter((item) => item.parameter === "t2m")
      .flatMap((item) => item.values)
      .filter((entry) => {
        const timestamp = Date.parse(entry.timestamp);
        return timestamp >= nowMs - OBSERVATION_MAX_AGE_MS
          && timestamp <= nowMs + OBSERVATION_FUTURE_TOLERANCE_MS;
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    return location && temperature
      ? { key, items, location, temperature, distanceKm: haversineKm(houseLocation, location) }
      : null;
  }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const selected = ranked[0];
  if (!selected) return { current: null, station: null };
  const anchorMs = Date.parse(selected.temperature.timestamp);
  const current: OutdoorConditions = { timestamp: selected.temperature.timestamp };
  for (const item of selected.items) {
    const closest = item.values.map((entry) => ({ entry, timestamp: Date.parse(entry.timestamp) }))
      .filter(({ timestamp }) => timestamp <= nowMs + OBSERVATION_FUTURE_TOLERANCE_MS
        && Math.abs(timestamp - anchorMs) <= OBSERVATION_MAX_PARAMETER_SKEW_MS)
      .sort((a, b) => Math.abs(a.timestamp - anchorMs) - Math.abs(b.timestamp - anchorMs)
        || b.timestamp - a.timestamp)[0]?.entry;
    if (closest) applyObservationValue(current, item.parameter, closest.value);
  }
  if (current.temperatureC === undefined) return { current: null, station: null };
  return {
    current,
    station: {
      id: selected.location.id,
      name: selected.location.name,
      latitude: selected.location.latitude,
      longitude: selected.location.longitude,
      distanceKm: Number(selected.distanceKm.toFixed(1)),
    },
  };
}

function parsePolygon(value: unknown): Array<[number, number]> {
  return (xmlText(value)?.split(/\s+/) ?? []).flatMap((pair) => {
    const [latitude, longitude] = pair.split(",").map(Number);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [[longitude as number, latitude as number] as [number, number]]
      : [];
  });
}

function parseCircle(value: unknown): ParsedWarningArea["circles"][number] | null {
  const [coordinate, radiusText] = xmlText(value)?.split(/\s+/) ?? [];
  const [latitude, longitude] = coordinate?.split(",").map(Number) ?? [];
  const radiusKm = Number(radiusText);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Number.isFinite(radiusKm)
    ? { latitude: latitude as number, longitude: longitude as number, radiusKm }
    : null;
}

function pointInPolygon(location: HouseLocation, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (!currentPoint || !previousPoint) continue;
    const [currentX, currentY] = currentPoint;
    const [previousX, previousY] = previousPoint;
    const crosses = (currentY > location.latitude) !== (previousY > location.latitude)
      && location.longitude < (previousX - currentX) * (location.latitude - currentY)
        / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function warningAreaMatches(location: HouseLocation, area: ParsedWarningArea): boolean {
  if (area.polygons.some((polygon) => polygon.length >= 3 && pointInPolygon(location, polygon))) return true;
  return area.circles.some((circle) => haversineKm(location, circle) <= circle.radiusKm);
}

function capSeverity(value: string | null): WeatherWarningSeverity {
  const normalized = value?.toLowerCase();
  return normalized === "minor" || normalized === "moderate" || normalized === "severe" || normalized === "extreme"
    ? normalized
    : "unknown";
}

function normalizedDateTime(value: unknown): string | null {
  const text = xmlText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeWebUrl(value: unknown): string | null {
  const text = xmlText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseCapFeed(xml: string): ParsedCapWarning[] {
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    trimValues: true,
  });
  const document = xmlObject(parser.parse(xml));
  const feed = xmlObject(document?.feed);
  const parsed: ParsedCapWarning[] = [];
  for (const entryValue of asArray(feed?.entry)) {
    const entry = xmlObject(entryValue);
    const alert = nestedObject(entry, "content", "alert");
    if (!alert || xmlText(alert.status) !== "Actual" || xmlText(alert.msgType) === "Cancel") continue;
    const infos = asArray(alert.info).map(xmlObject).filter((item): item is XmlObject => item !== null);
    const info = infos.find((item) => xmlText(item.language)?.toLowerCase() === "en-gb") ?? infos[0];
    if (!info) continue;
    const areas = asArray(info.area).map(xmlObject).filter((item): item is XmlObject => item !== null).map((area) => ({
      description: xmlText(area.areaDesc) ?? "Warning area",
      polygons: asArray(area.polygon).map(parsePolygon).filter((polygon) => polygon.length >= 3),
      circles: asArray(area.circle).map(parseCircle).filter((circle): circle is NonNullable<typeof circle> => circle !== null),
    }));
    const id = xmlText(alert.identifier) ?? xmlText(entry?.id);
    if (!id || areas.length === 0) continue;
    parsed.push({
      warning: {
        id,
        event: xmlText(info.event) ?? "Weather warning",
        headline: xmlText(info.headline) ?? xmlText(info.event) ?? "Weather warning",
        description: xmlText(info.description) ?? "",
        severity: capSeverity(xmlText(info.severity)),
        urgency: xmlText(info.urgency) ?? "Unknown",
        certainty: xmlText(info.certainty) ?? "Unknown",
        effectiveAt: normalizedDateTime(info.effective),
        onsetAt: normalizedDateTime(info.onset),
        expiresAt: normalizedDateTime(info.expires),
        areas: areas.map((area) => area.description),
        web: safeWebUrl(info.web),
      },
      areas,
    });
  }
  return parsed;
}

/** Selects unexpired FMI CAP warnings whose polygon or circle contains the house. */
export function parseCapWarnings(xml: string, location: HouseLocation, now = new Date()): WeatherWarning[] {
  const unique = new Map<string, WeatherWarning>();
  for (const item of parseCapFeed(xml)) {
    if (warningIsUnexpired(item.warning, now.getTime())
      && item.areas.some((area) => warningAreaMatches(location, area))
      && !unique.has(item.warning.id)) {
      unique.set(item.warning.id, item.warning);
    }
  }
  return [...unique.values()];
}

function warningIsUnexpired(warning: WeatherWarning, nowMs: number): boolean {
  if (!warning.expiresAt) return true;
  const expiresAt = Date.parse(warning.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

/** Reads a decoded response stream without ever accepting more than the limit. */
export async function readTextWithByteLimit(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new WeatherUnavailableError("FMI response exceeded the configured size limit");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export interface FmiWeatherProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

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

  #observationUrl(location: HouseLocation, now: Date, radiusKm: number): string {
    const start = new Date(now.getTime() - 3 * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    const latitudeRadius = radiusKm / 111;
    const longitudeRadius = Math.min(5, radiusKm / (111 * Math.max(0.15, Math.cos(location.latitude * Math.PI / 180))));
    const bbox = [
      location.longitude - longitudeRadius, location.latitude - latitudeRadius,
      location.longitude + longitudeRadius, location.latitude + latitudeRadius,
    ].join(",") + ",EPSG:4326";
    const query = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature", storedquery_id: OBSERVATION_QUERY,
      bbox, maxlocations: "20", timestep: "10", starttime: start.toISOString(), endtime: now.toISOString(),
      parameters: OBSERVATION_PARAMETERS.join(","),
    });
    return `${FMI_WFS_URL}?${query}`;
  }

  async #observations(location: HouseLocation, now: Date): Promise<ReturnType<typeof currentObservation>> {
    for (const radiusKm of [40, 120]) {
      const xml = await this.#xml(this.#observationUrl(location, now, radiusKm), 8 * 1024 * 1024);
      const parsed = currentObservation(parseFmiTimeSeries(xml), location, now);
      if (parsed.current) return parsed;
    }
    throw new WeatherUnavailableError("No recent FMI observation station data was found nearby");
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

interface WeatherCacheEntry {
  houseId: string;
  cachedAt: number;
  expiresAt: number;
  weather: HouseWeather;
}

interface WeatherInFlightEntry {
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
  ) {}

  invalidate(houseId: string): void {
    this.#houseGeneration.set(houseId, this.#generation(houseId) + 1);
    for (const [key, entry] of this.#cache) {
      if (entry.houseId === houseId) this.#cache.delete(key);
    }
    for (const [key, entry] of this.#inFlight) {
      if (entry.houseId === houseId) this.#inFlight.delete(key);
    }
  }

  async get(house: House, hours: number): Promise<HouseWeather> {
    if (!house.location) throw new WeatherUnavailableError("Set the house location before requesting weather");
    const key = `${house.id}:${house.location.latitude.toFixed(6)}:${house.location.longitude.toFixed(6)}:${hours}`;
    const generation = this.#generation(house.id);
    const now = Date.now();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.#touch(key, cached);
      return this.#forCurrentTime(cached.weather, now, false);
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
      const cachedAt = Date.now();
      const weather = this.#forCurrentTime(fetched, cachedAt, false);
      this.#touch(key, { houseId: house.id, cachedAt, weather, expiresAt: cachedAt + this.cacheTtlMs });
      this.#trimCache();
      this.status.provider = weather.provider;
      this.status.lastSuccessAt = weather.fetchedAt;
      this.status.error = null;
      this.onStatusChange();
      return weather;
    } catch (error) {
      this.#assertCurrent(house.id, generation);
      if (error instanceof WeatherRequestSupersededError) throw error;
      this.status.error = error instanceof Error ? error.message : "Weather provider request failed";
      this.onStatusChange();
      const now = Date.now();
      if (cached && now - cached.cachedAt <= this.staleMaxAgeMs) {
        const weather = this.#forCurrentTime(cached.weather, now, true);
        cached.weather = this.#forCurrentTime(cached.weather, now, false);
        this.#touch(key, cached);
        return weather;
      }
      if (cached) this.#cache.delete(key);
      throw error;
    }
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
