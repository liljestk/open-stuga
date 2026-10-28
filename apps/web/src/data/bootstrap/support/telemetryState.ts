import { errorMessage } from "../../../api/support/request-error";
import type {
  ConnectionState,
  House,
  IntegrationStatus,
  ManualObservation,
  MaintenanceTask,
  MeasurementSample,
  MockScenario,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
} from "@climate-twin/contracts";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { api } from "../../../api";
import { nextMockReading, type ClimateState, type TimeRange } from "../../../domain";
import { appendHistory, readingSamples, upsertLatest } from "../../../measurements";

export type ClientDataMode = IntegrationStatus["mock"]["mode"] | "unknown";

export type BootstrapStatus = "loading" | "setup-required" | "login-required" | "ready" | "empty" | "unavailable" | "incompatible";

export type SeriesLoadStatus = "idle" | "loading" | "ready" | "error";

export interface SeriesLoadState {
  status: SeriesLoadStatus;
  error: string | null;
  /** HTTP status when the history request failed with a structured API error. */
  errorStatus?: number | null;
  forecastError: string | null;
  requestedFrom: string;
  requestedTo: string;
  loadedFrom: string | null;
  loadedTo: string | null;
  partial: boolean;
  /**
   * True only when the server reported cutting the response. `partial` also
   * covers series whose recorded data simply starts inside the window, so it
   * cannot distinguish a young sensor from dropped coverage.
   */
  truncated: boolean;
}

export interface HistoricalSeriesWindow {
  from: string;
  to: string;
  /** Null keeps every recorded sample; otherwise the server returns one median value per bucket. */
  bucketSeconds: number | null;
}

export const MAX_SERIES_SAMPLES = 50_000;

export const LIVE_SERIES_SAMPLES = 500;

export const HEARTBEAT_POLL_MIN_INTERVAL_MS = 60_000;

export const STREAM_BOOTSTRAP_WAIT_MS = 1_500;

export function seriesStateKey(sensorId: string, metric: string): string {
  return `${sensorId}\u0000${metric}`;
}

export type LoadedTelemetryState = Pick<
  ClimateState,
  "latestMeasurements" | "measurementHistory" | "measurementForecasts" | "readings"
>;

export type BufferedLiveTelemetry =
  | { type: "reading"; data: Reading }
  | { type: "measurement"; data: MeasurementSample };

export type BufferedHouseMutation =
  | { resource: "sensor"; action: "upsert"; houseId: string; value: Sensor }
  | { resource: "sensor"; action: "delete"; houseId: string; id: string }
  | { resource: "observation"; action: "upsert"; houseId: string; value: ManualObservation }
  | { resource: "observation"; action: "replace"; houseId: string; values: ManualObservation[] }
  | { resource: "maintenance"; action: "upsert"; houseId: string | null; value: MaintenanceTask }
  | { resource: "maintenance"; action: "delete"; houseId: string | null; id: string }
  | { resource: "maintenance"; action: "replace"; houseId: string | null; values: MaintenanceTask[] }
  | { resource: "static"; action: "upsert"; houseId: string; value: StaticParameter }
  | { resource: "static"; action: "delete"; houseId: string; id: string };

export type HouseMutationBuffer = Map<string, BufferedHouseMutation>;

export type HouseInventoryMutation =
  | { action: "upsert"; value: House }
  | { action: "delete"; id: string };

export const LIVE_TELEMETRY_BUFFER_LIMIT = 2_000;

export type StreamConnections = {
  legacy: ConnectionState;
  measurements: ConnectionState;
};

export type SeriesCommit = { version: number };

export type BufferedSeriesTelemetry = {
  sensorId: string;
  metric: string;
  samples: Map<string, MeasurementSample>;
  readings: Map<string, Reading>;
};

export function aggregateConnection({ legacy, measurements }: StreamConnections): ConnectionState {
  if (legacy === "live" && measurements === "live") return "live";
  if (legacy === "offline" && measurements === "offline") return "offline";
  return "reconnecting";
}

export function bufferLiveTelemetry(buffer: Map<string, BufferedLiveTelemetry>, event: BufferedLiveTelemetry): void {
  const metric = event.type === "measurement" ? event.data.metric : "reading";
  const key = `${event.type}\u0000${event.data.sensorId}\u0000${metric}\u0000${event.data.timestamp}`;
  buffer.delete(key);
  buffer.set(key, event);
  if (buffer.size > LIVE_TELEMETRY_BUFFER_LIMIT) buffer.delete(buffer.keys().next().value!);
}

export function bufferSeriesValue<T>(buffer: Map<string, T>, timestamp: string, value: T): void {
  buffer.delete(timestamp);
  buffer.set(timestamp, value);
  if (buffer.size > MAX_SERIES_SAMPLES) buffer.delete(buffer.keys().next().value!);
}

export function houseMutationKey(mutation: BufferedHouseMutation): string {
  if (mutation.resource === "static") {
    if (mutation.action === "delete") return `static\u0000${mutation.houseId}\u0000id\u0000${mutation.id}`;
    const value = mutation.value;
    return `static\u0000${mutation.houseId}\u0000${value.scopeType}\u0000${value.scopeId}\u0000${value.key}`;
  }
  if (mutation.action === "replace") return `${mutation.resource}\u0000${mutation.houseId}\u0000replace`;
  const id = mutation.action === "upsert" ? mutation.value.id : mutation.id;
  return `${mutation.resource}\u0000${mutation.houseId}\u0000${id}`;
}

export function replayHouseInventory(houses: House[], mutations: Map<string, HouseInventoryMutation>): House[] {
  let result = houses;
  for (const mutation of mutations.values()) {
    result = mutation.action === "delete"
      ? result.filter((house) => house.id !== mutation.id)
      : [...result.filter((house) => house.id !== mutation.value.id), mutation.value];
  }
  return result;
}

export function withoutSensorIds<T>(records: Record<string, T>, sensorIds: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([sensorId]) => !sensorIds.has(sensorId)));
}

export function replaceHouseSensors(current: Sensor[], houseId: string, loaded: Sensor[]): Sensor[] {
  const loadedIds = new Set(loaded.map((sensor) => sensor.id));
  return [
    ...current.filter((sensor) => sensor.houseId !== houseId && !loadedIds.has(sensor.id)),
    ...loaded,
  ];
}

export function sensorsFromSnapshots(snapshots: SensorSnapshot[]): Sensor[] {
  return snapshots.map(({ reading: _reading, ...sensor }) => sensor);
}

export function isDemoSource(source: string): boolean {
  return source === "mock" || source === "replay";
}

export function isRemoteSharedDemoTelemetry(
  current: Pick<ClimateState, "houses" | "sensors">,
  sensorId: string,
  source: string,
): boolean {
  if (!isDemoSource(source)) return false;
  const sensor = current.sensors.find((candidate) => candidate.id === sensorId);
  const house = sensor
    ? current.houses.find((candidate) => candidate.id === sensor.houseId)
    : null;
  return Boolean(house && !hasLocalHouseAuthority(house));
}

/** Removes demo values already held in browser memory when the API enters real-data mode. */
export function withoutDemoTelemetry(current: ClimateState, clearAlerts = false): ClimateState {
  const readings = Object.fromEntries(Object.entries(current.readings).filter(([, reading]) => !isDemoSource(reading.source)));
  const latestMeasurements = Object.fromEntries(Object.entries(current.latestMeasurements).flatMap(([sensorId, values]) => {
    const retained = Object.fromEntries(Object.entries(values).filter(([, sample]) => !isDemoSource(sample.source)));
    return Object.keys(retained).length ? [[sensorId, retained]] : [];
  }));
  const measurementHistory = Object.fromEntries(Object.entries(current.measurementHistory).flatMap(([sensorId, byMetric]) => {
    const retained = Object.fromEntries(Object.entries(byMetric).flatMap(([metric, samples]) => {
      const realSamples = samples.filter((sample) => !isDemoSource(sample.source));
      return realSamples.length ? [[metric, realSamples]] : [];
    }));
    return Object.keys(retained).length ? [[sensorId, retained]] : [];
  }));
  return {
    ...current,
    readings,
    latestMeasurements,
    measurementHistory,
    // Forecast contracts do not carry provenance. Drop cached forecasts at the
    // boundary rather than risk retaining values derived from demo history.
    measurementForecasts: {},
    ...(clearAlerts ? { alerts: [] } : {}),
  };
}

export function advanceMockTelemetry(
  current: ClimateState,
  scenario: MockScenario["id"],
  tick: number,
): ClimateState {
  if (!current.integration.mock.enabled || current.integration.mock.mode === "real") return current;
  const sharedHouseIds = new Set(current.houses
    .filter((house) => !hasLocalHouseAuthority(house))
    .map((house) => house.id));
  const sharedSensorIds = new Set(current.sensors
    .filter((sensor) => sharedHouseIds.has(sensor.houseId))
    .map((sensor) => sensor.id));
  const readings = Object.fromEntries(Object.entries(current.readings)
    .filter(([sensorId, reading]) => !sharedSensorIds.has(sensorId) || !isDemoSource(reading.source)));
  let latestMeasurements = Object.fromEntries(Object.entries(current.latestMeasurements)
    .flatMap(([sensorId, values]) => {
      const retained = sharedSensorIds.has(sensorId)
        ? Object.fromEntries(Object.entries(values).filter(([, sample]) => !isDemoSource(sample.source)))
        : values;
      return Object.keys(retained).length ? [[sensorId, retained]] : [];
    }));
  let measurementHistory = Object.fromEntries(Object.entries(current.measurementHistory)
    .flatMap(([sensorId, byMetric]) => {
      const retained = sharedSensorIds.has(sensorId)
        ? Object.fromEntries(Object.entries(byMetric).flatMap(([metric, samples]) => {
            const realSamples = samples.filter((sample) => !isDemoSource(sample.source));
            return realSamples.length ? [[metric, realSamples]] : [];
          }))
        : byMetric;
      return Object.keys(retained).length ? [[sensorId, retained]] : [];
    }));
  for (const sensor of current.sensors) {
    if (sharedSensorIds.has(sensor.id)) continue;
    const previous = readings[sensor.id];
    if (!previous) continue;
    const next = nextMockReading(sensor, previous, scenario, tick);
    readings[sensor.id] = next;
    const samples = readingSamples(next, current.measurementDefinitions);
    latestMeasurements = upsertLatest(latestMeasurements, samples);
    measurementHistory = appendHistory(measurementHistory, samples, LIVE_SERIES_SAMPLES);
  }
  return {
    ...current,
    readings,
    latestMeasurements,
    measurementHistory,
    measurementForecasts: withoutSensorIds(current.measurementForecasts, sharedSensorIds),
  };
}

export function seriesLimit(range: TimeRange): number {
  if (range === "6h") return 5_000;
  if (range === "24h") return 20_000;
  return MAX_SERIES_SAMPLES;
}

export function seriesBucketSeconds(range: TimeRange, metric?: string): number | undefined {
  // Every range is bucketed so the server covers the whole window with a
  // bounded number of samples. A raw 6h read of a 2-second poller holds more
  // rows than the raw page limit and would silently lose its oldest hours;
  // 15-second buckets are still finer than anything a 6h chart can render.
  if (range === "6h") return 15;
  if (range === "24h") return 60;
  if (range === "7d") return 60;
  if (range === "30d") return 5 * 60;
  if (range === "90d") return 15 * 60;
  // Power-derived energy holds a value for at most 15 minutes. Coarser
  // samples would undercount even continuous yearly histories.
  return metric === "power" ? 15 * 60 : 60 * 60;
}

export async function optionalForecast<T>(request: Promise<T[]>): Promise<{ value: T[] | null; error: string | null }> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error, "Forecast data is temporarily unavailable") };
  }
}

export async function canonicalSeries(
  sensorId: string,
  metric: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
  signal?: AbortSignal,
) {
  const bucketSeconds = seriesBucketSeconds(range, metric);
  // Counter deltas and held power need a predecessor at the left edge.
  const historyFrom = metric === "energy" || metric === "power"
    ? new Date(Date.parse(from) - 15 * 60_000).toISOString() : from;
  const historyRequest = signal
    ? api.measurementHistoryPage(sensorId, metric, historyFrom, to, seriesLimit(range), bucketSeconds, signal)
    : api.measurementHistoryPage(sensorId, metric, historyFrom, to, seriesLimit(range), bucketSeconds);
  const [history, forecast] = await Promise.all([
    historyRequest,
    forecastSupported
      ? optionalForecast(api.measurementForecast(sensorId, metric, 12, signal))
      : Promise.resolve({ value: [], error: null }),
  ]);
  return { samples: history.samples, history, forecast };
}
