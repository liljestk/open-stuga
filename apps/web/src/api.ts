import type {
  AlertEvent,
  AlertRule,
  ForecastPoint,
  House,
  HouseLocation,
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
} from "@climate-twin/contracts";

/** Independent, nullable updates for a house's real-world placement. */
export interface HouseGeoreferencePatch {
  location?: HouseLocation | null;
  orientationDegrees?: number | null;
}

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "/api/v1";
export const API_V2_BASE = API_BASE.replace(/\/v1$/, "/v2");

async function requestFrom<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

export const api = {
  houses: async () => list<House>(await request<unknown>("/houses"), ["houses", "data"]),
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
  updateSensor: (sensorId: string, sensor: Partial<Sensor>) => request<Sensor>(`/sensors/${encodeURIComponent(sensorId)}`, { method: "PUT", body: JSON.stringify(sensor) }),
  alertRules: async () => list<AlertRule>(await request<unknown>("/alert-rules"), ["rules", "alertRules", "data"]),
  createAlertRule: (rule: Omit<AlertRule, "id">) => request<AlertRule>("/alert-rules", { method: "POST", body: JSON.stringify(rule) }),
  alerts: async () => list<AlertEvent>(await request<unknown>("/alerts"), ["alerts", "events", "data"]),
  acknowledgeAlert: (id: string) => request<AlertEvent>(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
  observations: async (houseId: string) => list<ManualObservation>(await request<unknown>(`/observations?houseId=${encodeURIComponent(houseId)}`), ["observations", "data"]),
  createObservation: (observation: Omit<ManualObservation, "id" | "createdAt">) => request<ManualObservation>("/observations", { method: "POST", body: JSON.stringify(observation) }),
  staticParameters: async (houseId: string) => list<StaticParameter>(await request<unknown>(`/static-parameters?houseId=${encodeURIComponent(houseId)}`), ["parameters", "staticParameters", "data"]),
  createStaticParameter: (parameter: Omit<StaticParameter, "id">) => request<StaticParameter>("/static-parameters", { method: "POST", body: JSON.stringify(parameter) }),
  integrations: () => request<IntegrationStatus>("/integrations/status"),
  testHomeAssistant: () => request<{ ok: boolean; message?: string }>("/integrations/home-assistant/test", { method: "POST" }),
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
  measurementForecast: async (sensorId: string, metric: string, hours = 12) => (
    await requestV2<{ forecast: MeasurementForecastPoint[] }>(
      `/measurements/forecast?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`,
    )
  ).forecast,
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
