import { SYSTEM_VERSION } from "./version.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface DiscoveredLocation {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  source: "open-meteo-geocoding";
  confidence: "high" | "medium";
}

export interface CoordinateDefaults {
  timezone: string;
  source: "open-meteo-coordinate";
}

interface OpenMeteoPlace {
  id?: unknown;
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timezone?: unknown;
  country_code?: unknown;
  country?: unknown;
  admin1?: unknown;
  population?: unknown;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isIanaTimezone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizedPlace(value: OpenMeteoPlace): DiscoveredLocation | null {
  const name = string(value.name);
  const latitude = finite(value.latitude);
  const longitude = finite(value.longitude);
  const timezone = string(value.timezone);
  if (!name || latitude === null || longitude === null || !timezone || !isIanaTimezone(timezone)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const country = string(value.country);
  const region = string(value.admin1);
  const parts = [name, region, country].filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index);
  const population = finite(value.population) ?? 0;
  return {
    id: String(value.id ?? `${latitude},${longitude}`),
    name,
    label: parts.join(", "),
    latitude,
    longitude,
    timezone,
    countryCode: string(value.country_code),
    country,
    region,
    source: "open-meteo-geocoding",
    confidence: population >= 10_000 ? "high" : "medium",
  };
}

async function limitedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Location service returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Location response was too large");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Location response was too large");
    }
    chunks.push(value);
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("Location service returned invalid JSON");
  }
}

export interface LocationDiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Explicit, user-triggered worldwide place and timezone discovery. */
export class LocationDiscoveryService {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: LocationDiscoveryOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 7_000;
  }

  async search(query: string, language = "en", count = 6): Promise<DiscoveredLocation[]> {
    const name = query.trim();
    if (name.length < 2 || name.length > 120) return [];
    const parameters = new URLSearchParams({
      name,
      count: String(Math.min(10, Math.max(1, count))),
      language: /^[a-z]{2}$/i.test(language) ? language.toLowerCase() : "en",
      format: "json",
    });
    const response = await this.#fetch(`${GEOCODING_URL}?${parameters}`, {
      headers: { Accept: "application/json", "User-Agent": `Stuga/${SYSTEM_VERSION} location discovery` },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const payload = await limitedJson(response) as { results?: unknown } | null;
    if (!Array.isArray(payload?.results)) return [];
    return payload.results
      .map((candidate) => candidate && typeof candidate === "object" ? normalizedPlace(candidate as OpenMeteoPlace) : null)
      .filter((candidate): candidate is DiscoveredLocation => candidate !== null);
  }

  async defaultsForCoordinates(latitude: number, longitude: number): Promise<CoordinateDefaults> {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error("Coordinates are outside the valid WGS84 range");
    }
    const parameters = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone: "auto",
      forecast_hours: "1",
    });
    const response = await this.#fetch(`${FORECAST_URL}?${parameters}`, {
      headers: { Accept: "application/json", "User-Agent": `Stuga/${SYSTEM_VERSION} timezone discovery` },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const payload = await limitedJson(response) as { timezone?: unknown } | null;
    const timezone = string(payload?.timezone);
    if (!timezone || !isIanaTimezone(timezone)) throw new Error("No valid timezone was returned for these coordinates");
    return { timezone, source: "open-meteo-coordinate" };
  }
}

