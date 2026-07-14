import type {
  AlertEvent,
  AlertRule,
  ForecastPoint,
  House,
  HouseLocation,
  HouseMapPlacement,
  HouseWeather,
  IntegrationStatus,
  ManualObservation,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  MockScenario,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
  ThermalSimulationResult,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";

/** Independent, nullable updates for a house's real-world placement. */
export interface HouseGeoreferencePatch {
  location?: HouseLocation | null;
  mapPlacement?: HouseMapPlacement | null;
  orientationDegrees?: number | null;
}

export type CreateHouseInput = Pick<House, "name" | "timezone" | "floors">
  & Partial<Pick<House, "location" | "mapPlacement" | "orientationDegrees">>;
export type HousePatch = Partial<Pick<House, "name" | "timezone" | "floors">> & HouseGeoreferencePatch;
export type CreateSensorInput = Omit<Sensor, "id">;
export type SensorPatch = Partial<Omit<Sensor, "id" | "tpLinkDeviceId">> & { tpLinkDeviceId?: string | null };

export interface HistoricalImportResult {
  submitted: number;
  accepted: number;
  ignoredDuplicates: number;
}

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface TpLinkDiscoveredHub {
  host: string;
  model: "H100" | "H200";
  alias: string | null;
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredHub[];
  warnings: string[];
}

export interface LocationSuggestion {
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

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "/api/v1";
export const API_V2_BASE = API_BASE.replace(/\/v1$/, "/v2");
const SAFE_API_PATH = /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})+$/;

function assertSafeApiPath(path: string): void {
  const pathname = path.split("?", 1).at(0) ?? "";
  const containsTraversal = pathname
    .split("/")
    .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (!SAFE_API_PATH.test(path) || containsTraversal) {
    throw new TypeError("Invalid API request path");
  }
}

async function requestFrom<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  assertSafeApiPath(path);
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    const apiError = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
    const code = typeof apiError?.code === "string" ? apiError.code : null;
    const message = typeof apiError?.message === "string" && apiError.message.trim()
      ? apiError.message
      : `Request failed with HTTP ${response.status}`;
    throw new ApiRequestError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const request = <T,>(path: string, options?: RequestInit) => requestFrom<T>(API_BASE, path, options);
const requestV2 = <T,>(path: string, options?: RequestInit) => requestFrom<T>(API_V2_BASE, path, options);

function list<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

async function updateHouseGeoreference(houseId: string, patch: HouseGeoreferencePatch): Promise<House> {
  const response = await request<House | { house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return "house" in response ? response.house : response;
}

function sensorResponse(value: Sensor | { sensor: Sensor }): Sensor {
  return "sensor" in value ? value.sensor : value;
}

function houseResponse(value: House | { house: House }): House {
  return "house" in value ? value.house : value;
}

export const api = {
  houses: async () => list<House>(await request<unknown>("/houses"), ["houses", "data"]),
  createHouse: async (house: CreateHouseInput) => houseResponse(await request<House | { house: House }>("/houses", {
    method: "POST",
    body: JSON.stringify(house),
  })),
  updateHouse: async (houseId: string, patch: HousePatch) => houseResponse(await request<House | { house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })),
  deleteHouse: (houseId: string) => request<void>(`/houses/${encodeURIComponent(houseId)}`, { method: "DELETE" }),
  sensors: async (houseId: string) => list<Sensor>(await request<unknown>(`/sensors?houseId=${encodeURIComponent(houseId)}`), ["sensors", "data"]),
  snapshot: async (houseId: string) => list<SensorSnapshot>(await request<unknown>(`/snapshot?houseId=${encodeURIComponent(houseId)}`), ["snapshot", "sensors", "data"]),
  readings: async (sensorId: string, from: string, to: string, limit = 500) => list<Reading>(
    await request<unknown>(`/readings?sensorId=${encodeURIComponent(sensorId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),
    ["readings", "data"],
  ),
  forecast: async (sensorId: string, horizonMinutes = 360) => list<ForecastPoint>(
    await request<unknown>(`/forecast?sensorId=${encodeURIComponent(sensorId)}&horizonMinutes=${horizonMinutes}`),
    ["forecast", "points", "data"],
  ),
  updateHouseGeoreference,
  updateHouseLocation: (houseId: string, location: HouseLocation | null) => updateHouseGeoreference(houseId, { location }),
  houseWeather: async (houseId: string, hours = 48) => {
    const response = await request<HouseWeather | { weather: HouseWeather }>(
      `/houses/${encodeURIComponent(houseId)}/weather?hours=${hours}`,
    );
    return "weather" in response ? response.weather : response;
  },
  updateFloor: (houseId: string, floorId: string, floor: House["floors"][number]) => request<House["floors"][number]>(`/houses/${encodeURIComponent(houseId)}/floors/${encodeURIComponent(floorId)}`, { method: "PUT", body: JSON.stringify(floor) }),
  createSensor: async (sensor: CreateSensorInput) => sensorResponse(await request<Sensor | { sensor: Sensor }>("/sensors", {
    method: "POST",
    body: JSON.stringify(sensor),
  })),
  updateSensor: async (sensorId: string, sensor: SensorPatch) => sensorResponse(await request<Sensor | { sensor: Sensor }>(`/sensors/${encodeURIComponent(sensorId)}`, {
    method: "PATCH",
    body: JSON.stringify(sensor),
  })),
  alertRules: async () => list<AlertRule>(await request<unknown>("/alert-rules"), ["rules", "alertRules", "data"]),
  createAlertRule: (rule: Omit<AlertRule, "id">) => request<AlertRule>("/alert-rules", { method: "POST", body: JSON.stringify(rule) }),
  alerts: async () => list<AlertEvent>(await request<unknown>("/alerts"), ["alerts", "events", "data"]),
  acknowledgeAlert: (id: string) => request<AlertEvent>(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
  observations: async (houseId: string) => list<ManualObservation>(await request<unknown>(`/observations?houseId=${encodeURIComponent(houseId)}`), ["observations", "data"]),
  createObservation: (observation: Omit<ManualObservation, "id" | "createdAt">) => request<ManualObservation>("/observations", { method: "POST", body: JSON.stringify(observation) }),
  staticParameters: async (houseId: string) => list<StaticParameter>(await request<unknown>(`/static-parameters?houseId=${encodeURIComponent(houseId)}`), ["parameters", "staticParameters", "data"]),
  createStaticParameter: (parameter: Omit<StaticParameter, "id">) => request<StaticParameter>("/static-parameters", { method: "POST", body: JSON.stringify(parameter) }),
  integrations: () => request<IntegrationStatus>("/integrations/status"),
  discoverIntegrations: () => request<IntegrationDiscoveryResult>("/integrations/discover", { method: "POST" }),
  searchLocations: async (query: string, language = "en") => (
    await request<{ results: LocationSuggestion[] }>(`/locations/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}`)
  ).results,
  coordinateDefaults: (latitude: number, longitude: number) => request<CoordinateDefaults>(
    `/locations/defaults?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
  ),
  configureHomeAssistant: (configuration: { url: string; token: string }) => request<{ ok: boolean; configured: boolean; integration: IntegrationStatus }>("/integrations/home-assistant/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  configureTpLink: (configuration: { host: string; username: string; password: string }) => request<{ ok: boolean; configured: boolean; integration: IntegrationStatus }>("/integrations/tp-link/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  testHomeAssistant: () => request<{ ok: boolean; message?: string }>("/integrations/home-assistant/test", { method: "POST" }),
  testTpLink: () => request<{ ok: boolean; message?: string }>("/integrations/tp-link/test", { method: "POST" }),
  tpLinkDevices: async () => list<TpLinkDiscoveredDevice>(
    await request<unknown>("/integrations/tp-link/devices"),
    ["devices", "data"],
  ),
  scenarios: async () => list<MockScenario>(await request<unknown>("/mock/scenarios"), ["scenarios", "data"]),
  runScenario: (scenarioId: MockScenario["id"]) => request<{ ok: boolean }>("/mock/scenario", { method: "POST", body: JSON.stringify({ scenarioId }) }),
  measurementDefinitions: async () => (await requestV2<{ definitions: MeasurementDefinition[] }>("/measurement-definitions")).definitions,
  measurementSnapshot: async (houseId: string) => (await requestV2<{ snapshot: { sensorId: string; measurements: Record<string, MeasurementSample> }[] }>(
    `/measurements/snapshot?houseId=${encodeURIComponent(houseId)}`,
  )).snapshot,
  measurementHistory: async (sensorId: string, metric: string, from: string, to: string, limit = 500) => (
    await requestV2<{ samples: MeasurementSample[] }>(
      `/measurements/history?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`,
    )
  ).samples,
  importHistoricalMeasurements: async (
    samples: MeasurementSample[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<HistoricalImportResult> => {
    let accepted = 0;
    let ignoredDuplicates = 0;
    for (let offset = 0; offset < samples.length; offset += 1_000) {
      const batch = samples.slice(offset, offset + 1_000);
      const result = await requestV2<{ accepted: number; ignoredDuplicates: number }>("/measurements/import", {
        method: "POST",
        body: JSON.stringify({ samples: batch }),
      });
      accepted += result.accepted;
      ignoredDuplicates += result.ignoredDuplicates;
      onProgress?.(Math.min(offset + batch.length, samples.length), samples.length);
    }
    return { submitted: samples.length, accepted, ignoredDuplicates };
  },
  measurementForecast: async (sensorId: string, metric: string, hours = 12) => (
    await requestV2<{ forecast: MeasurementForecastPoint[] }>(
      `/measurements/forecast?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`,
    )
  ).forecast,
  thermalSimulation: async (
    houseId: string,
    options: {
      sensorId: string;
      from: string;
      to: string;
      horizonHours: number;
      scenarioOutdoorTemperatureC?: number;
    },
  ) => {
    const query = new URLSearchParams({
      sensorId: options.sensorId,
      from: options.from,
      to: options.to,
      horizonHours: String(options.horizonHours),
    });
    if (options.scenarioOutdoorTemperatureC !== undefined) {
      query.set("scenarioOutdoorTemperatureC", String(options.scenarioOutdoorTemperatureC));
    }
    return (await request<{ simulation: ThermalSimulationResult }>(
      `/houses/${encodeURIComponent(houseId)}/thermal-simulation?${query.toString()}`,
    )).simulation;
  },
};

export function subscribeToMeasurementEvents(
  onSample: (sample: MeasurementSample) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(`${API_V2_BASE}/measurements/events`);
  const consume = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as MeasurementSample | { data?: MeasurementSample };
      const sample = "data" in parsed && parsed.data ? parsed.data : parsed as MeasurementSample;
      if (sample && typeof sample.sensorId === "string" && typeof sample.metric === "string" && Number.isFinite(sample.value)) onSample(sample);
    } catch {
      // A malformed sample is ignored; the stream remains connected.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  source.onmessage = consume;
  source.addEventListener("measurement", (message) => consume(message as MessageEvent<string>));
  return () => source.close();
}

export function subscribeToEvents(
  onEvent: (event: TelemetryEvent) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(`${API_BASE}/events`);
  const consume = (message: MessageEvent<string>, forcedType?: TelemetryEvent["type"]) => {
    try {
      const parsed = JSON.parse(message.data) as TelemetryEvent | TelemetryEvent["data"];
      if (parsed && typeof parsed === "object" && "type" in parsed && "data" in parsed) onEvent(parsed as TelemetryEvent);
      else if (forcedType) onEvent({ type: forcedType, data: parsed as TelemetryEvent["data"] });
    } catch {
      // A malformed event is ignored; the stream remains connected.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  source.onmessage = (message) => consume(message);
  (["reading", "alert", "integration", "heartbeat"] as const).forEach((type) => {
    source.addEventListener(type, (message) => consume(message as MessageEvent<string>, type));
  });
  return () => source.close();
}
