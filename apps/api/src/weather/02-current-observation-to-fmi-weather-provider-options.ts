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
import { FmiTimeSeries, OBSERVATION_FUTURE_TOLERANCE_MS, OBSERVATION_MAX_AGE_MS, OBSERVATION_MAX_PARAMETER_SKEW_MS, ParsedCapWarning, ParsedWarningArea, WeatherUnavailableError, XmlObject, applyObservationValue, asArray, haversineKm, nestedObject, xmlObject, xmlText } from "./01-weather-connection-status-to-haversine-km.js";

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

/** Select one nearby station and retain its complete canonical time series. */
export function historicalObservations(
  series: FmiTimeSeries[],
  houseLocation: HouseLocation,
): { observations: OutdoorConditions[]; station: WeatherStation | null } {
  const groups = new Map<string, FmiTimeSeries[]>();
  for (const item of series) {
    if (!item.location || item.values.length === 0) continue;
    const key = item.location.id ?? `${item.location.latitude.toFixed(5)},${item.location.longitude.toFixed(5)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const selected = [...groups.values()]
    .map((items) => {
      const location = items[0]?.location;
      const temperatureCount = items
        .filter((item) => item.parameter === "t2m")
        .reduce((count, item) => count + item.values.length, 0);
      return location && temperatureCount > 0
        ? { items, location, distanceKm: haversineKm(houseLocation, location) }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.distanceKm - right.distanceKm)[0];
  if (!selected) return { observations: [], station: null };

  const byTimestamp = new Map<string, OutdoorConditions>();
  for (const item of selected.items) {
    for (const entry of item.values) {
      const point = byTimestamp.get(entry.timestamp) ?? { timestamp: entry.timestamp };
      applyObservationValue(point, item.parameter, entry.value);
      byTimestamp.set(entry.timestamp, point);
    }
  }
  const observations = [...byTimestamp.values()]
    .filter((point) => point.temperatureC !== undefined)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return {
    observations,
    station: {
      id: selected.location.id,
      name: selected.location.name,
      latitude: selected.location.latitude,
      longitude: selected.location.longitude,
      distanceKm: Number(selected.distanceKm.toFixed(1)),
    },
  };
}

export function parsePolygon(value: unknown): Array<[number, number]> {
  return (xmlText(value)?.split(/\s+/) ?? []).flatMap((pair) => {
    const [latitude, longitude] = pair.split(",").map(Number);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [[longitude as number, latitude as number] as [number, number]]
      : [];
  });
}

export function parseCircle(value: unknown): ParsedWarningArea["circles"][number] | null {
  const [coordinate, radiusText] = xmlText(value)?.split(/\s+/) ?? [];
  const [latitude, longitude] = coordinate?.split(",").map(Number) ?? [];
  const radiusKm = Number(radiusText);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Number.isFinite(radiusKm)
    ? { latitude: latitude as number, longitude: longitude as number, radiusKm }
    : null;
}

export function pointInPolygon(location: HouseLocation, polygon: Array<[number, number]>): boolean {
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

export function warningAreaMatches(location: HouseLocation, area: ParsedWarningArea): boolean {
  if (area.polygons.some((polygon) => polygon.length >= 3 && pointInPolygon(location, polygon))) return true;
  return area.circles.some((circle) => haversineKm(location, circle) <= circle.radiusKm);
}

export function capSeverity(value: string | null): WeatherWarningSeverity {
  const normalized = value?.toLowerCase();
  return normalized === "minor" || normalized === "moderate" || normalized === "severe" || normalized === "extreme"
    ? normalized
    : "unknown";
}

export function normalizedDateTime(value: unknown): string | null {
  const text = xmlText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function safeWebUrl(value: unknown): string | null {
  const text = xmlText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseCapFeed(xml: string): ParsedCapWarning[] {
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

export function warningIsUnexpired(warning: WeatherWarning, nowMs: number): boolean {
  if (!warning.expiresAt) return true;
  const expiresAt = Date.parse(warning.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

/** Reads a decoded response stream without ever accepting more than the limit. */
export async function readTextWithByteLimit(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
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
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export interface FmiWeatherProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}
