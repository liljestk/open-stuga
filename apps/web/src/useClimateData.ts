import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  AppSession,
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AlertRule,
  AlertRulePatch,
  ConnectionState,
  Floor,
  House,
  IntegrationStatus,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MaintenanceTask,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MeasurementSample,
  MockScenario,
  Point,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import {
  api,
  cancelPendingApiRequests,
  subscribeToApiAuthorizationChanges,
  subscribeToEvents,
  subscribeToMeasurementEvents,
  type CreateHouseInput,
  type CreateSensorInput,
  type HousePatch,
  type HouseGeoreferencePatch,
  type SensorPatch,
} from "./api";
import { subscribeToAuthEpoch } from "./authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, type ClimateState, type TimeRange } from "./domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "./measurements";
import { routeFromLocation } from "./routing";
import { publishHouseWeatherUpdate } from "./useHouseWeather";

export type DataMode = IntegrationStatus["mock"]["mode"] | "unknown";
export type BootstrapStatus = "loading" | "setup-required" | "login-required" | "ready" | "empty" | "unavailable";
export type SeriesLoadStatus = "idle" | "loading" | "ready" | "error";

export interface SeriesLoadState {
  status: SeriesLoadStatus;
  error: string | null;
  forecastError: string | null;
  requestedFrom: string;
  requestedTo: string;
  loadedFrom: string | null;
  loadedTo: string | null;
  partial: boolean;
}

export const MAX_SERIES_SAMPLES = 50_000;
export const HEARTBEAT_POLL_MIN_INTERVAL_MS = 60_000;
export const STREAM_BOOTSTRAP_WAIT_MS = 1_500;

export function seriesStateKey(sensorId: string, metric: string): string {
  return `${sensorId}\u0000${metric}`;
}

type LoadedTelemetryState = Pick<
  ClimateState,
  "latestMeasurements" | "measurementHistory" | "measurementForecasts" | "readings" | "history" | "forecasts"
>;

type BufferedLiveTelemetry =
  | { type: "reading"; data: Reading }
  | { type: "measurement"; data: MeasurementSample };

type BufferedHouseMutation =
  | { resource: "sensor"; action: "upsert"; houseId: string; value: Sensor }
  | { resource: "sensor"; action: "delete"; houseId: string; id: string }
  | { resource: "observation"; action: "upsert"; houseId: string; value: ManualObservation }
  | { resource: "observation"; action: "replace"; houseId: string; values: ManualObservation[] }
  | { resource: "maintenance"; action: "upsert"; houseId: string | null; value: MaintenanceTask }
  | { resource: "maintenance"; action: "delete"; houseId: string | null; id: string }
  | { resource: "maintenance"; action: "replace"; houseId: string | null; values: MaintenanceTask[] }
  | { resource: "static"; action: "upsert"; houseId: string; value: StaticParameter }
  | { resource: "static"; action: "delete"; houseId: string; id: string };

type HouseMutationBuffer = Map<string, BufferedHouseMutation>;

type HouseInventoryMutation =
  | { action: "upsert"; value: House }
  | { action: "delete"; id: string };

const LIVE_TELEMETRY_BUFFER_LIMIT = 2_000;

type StreamConnections = {
  legacy: ConnectionState;
  measurements: ConnectionState;
};

type SeriesCommit = { version: number; legacy: boolean };

type BufferedSeriesTelemetry = {
  sensorId: string;
  metric: string;
  samples: Map<string, MeasurementSample>;
  readings: Map<string, Reading>;
};

function aggregateConnection({ legacy, measurements }: StreamConnections): ConnectionState {
  if (legacy === "live" && measurements === "live") return "live";
  if (legacy === "offline" && measurements === "offline") return "offline";
  return "reconnecting";
}

function isPollingCompatibilityHeartbeat(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const heartbeat = data as { mode?: unknown; continuous?: unknown; finite?: unknown };
  return heartbeat.mode === "polling"
    || heartbeat.mode === "polling-compatibility"
    || heartbeat.continuous === false
    || heartbeat.finite === true;
}

function bufferLiveTelemetry(buffer: Map<string, BufferedLiveTelemetry>, event: BufferedLiveTelemetry): void {
  const metric = event.type === "measurement" ? event.data.metric : "reading";
  const key = `${event.type}\u0000${event.data.sensorId}\u0000${metric}\u0000${event.data.timestamp}`;
  buffer.delete(key);
  buffer.set(key, event);
  if (buffer.size > LIVE_TELEMETRY_BUFFER_LIMIT) buffer.delete(buffer.keys().next().value!);
}

function bufferSeriesValue<T>(buffer: Map<string, T>, timestamp: string, value: T): void {
  buffer.delete(timestamp);
  buffer.set(timestamp, value);
  if (buffer.size > MAX_SERIES_SAMPLES) buffer.delete(buffer.keys().next().value!);
}

function houseMutationKey(mutation: BufferedHouseMutation): string {
  if (mutation.resource === "static") {
    if (mutation.action === "delete") return `static\u0000${mutation.houseId}\u0000id\u0000${mutation.id}`;
    const value = mutation.value;
    return `static\u0000${mutation.houseId}\u0000${value.scopeType}\u0000${value.scopeId}\u0000${value.key}`;
  }
  if (mutation.action === "replace") return `${mutation.resource}\u0000${mutation.houseId}\u0000replace`;
  const id = mutation.action === "upsert" ? mutation.value.id : mutation.id;
  return `${mutation.resource}\u0000${mutation.houseId}\u0000${id}`;
}

function replayHouseInventory(houses: House[], mutations: Map<string, HouseInventoryMutation>): House[] {
  let result = houses;
  for (const mutation of mutations.values()) {
    result = mutation.action === "delete"
      ? result.filter((house) => house.id !== mutation.id)
      : [...result.filter((house) => house.id !== mutation.value.id), mutation.value];
  }
  return result;
}

function withoutSensorIds<T>(records: Record<string, T>, sensorIds: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([sensorId]) => !sensorIds.has(sensorId)));
}

function replaceHouseSensors(current: Sensor[], houseId: string, loaded: Sensor[]): Sensor[] {
  const loadedIds = new Set(loaded.map((sensor) => sensor.id));
  return [
    ...current.filter((sensor) => sensor.houseId !== houseId && !loadedIds.has(sensor.id)),
    ...loaded,
  ];
}

function sensorsFromSnapshots(snapshots: SensorSnapshot[]): Sensor[] {
  return snapshots.map(({ reading: _reading, ...sensor }) => sensor);
}

function isDemoSource(source: string): boolean {
  return source === "mock" || source === "replay";
}

/** Removes demo values already held in browser memory when the API enters real-data mode. */
export function withoutDemoTelemetry(current: ClimateState, clearAlerts = false): ClimateState {
  const readings = Object.fromEntries(Object.entries(current.readings).filter(([, reading]) => !isDemoSource(reading.source)));
  const history = Object.fromEntries(Object.entries(current.history).flatMap(([sensorId, values]) => {
    const retained = values.filter((reading) => !isDemoSource(reading.source));
    return retained.length ? [[sensorId, retained]] : [];
  }));
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
    history,
    latestMeasurements,
    measurementHistory,
    // Forecast contracts do not carry provenance. Drop cached forecasts at the
    // boundary rather than risk retaining values derived from demo history.
    forecasts: {},
    measurementForecasts: {},
    ...(clearAlerts ? { alerts: [] } : {}),
  };
}

function advanceMockTelemetry(
  current: ClimateState,
  scenario: MockScenario["id"],
  tick: number,
): ClimateState {
  if (!current.integration.mock.enabled || current.integration.mock.mode === "real") return current;
  const readings = { ...current.readings };
  const history = { ...current.history };
  let latestMeasurements = current.latestMeasurements;
  let measurementHistory = current.measurementHistory;
  for (const sensor of current.sensors) {
    const previous = readings[sensor.id];
    if (!previous) continue;
    const next = nextMockReading(sensor, previous, scenario, tick);
    readings[sensor.id] = next;
    history[sensor.id] = [...(history[sensor.id] ?? []), next].slice(-500);
    const samples = readingSamples(next, current.measurementDefinitions);
    latestMeasurements = upsertLatest(latestMeasurements, samples);
    measurementHistory = appendHistory(measurementHistory, samples, 500);
  }
  return { ...current, readings, history, latestMeasurements, measurementHistory };
}

function durationHours(range: TimeRange): number {
  if (range === "6h") return 6;
  if (range === "24h") return 24;
  return 24 * 7;
}

function seriesLimit(range: TimeRange): number {
  if (range === "6h") return 5_000;
  if (range === "24h") return 20_000;
  return MAX_SERIES_SAMPLES;
}

function seriesBucketSeconds(range: TimeRange): number | undefined {
  return range === "7d" ? 60 : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function optionalForecast<T>(request: Promise<T[]>): Promise<{ value: T[] | null; error: string | null }> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error, "Forecast data is temporarily unavailable") };
  }
}

async function canonicalSeries(
  sensorId: string,
  metric: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
) {
  const bucketSeconds = seriesBucketSeconds(range);
  const historyRequest = api.measurementHistoryPage(
    sensorId,
    metric,
    from,
    to,
    seriesLimit(range),
    bucketSeconds,
  );
  const [history, forecast] = await Promise.all([
    historyRequest,
    forecastSupported
      ? optionalForecast(api.measurementForecast(sensorId, metric, 12))
      : Promise.resolve({ value: [], error: null }),
  ]);
  return { samples: history.samples, history, forecast };
}

async function legacySeries(
  sensorId: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
) {
  const [history, forecasts] = await Promise.all([
    api.readings(sensorId, from, to, seriesLimit(range)),
    forecastSupported
      ? optionalForecast(api.forecast(sensorId, 360))
      : Promise.resolve({ value: [], error: null }),
  ]);
  return { history, forecasts };
}

function metricHistorySamples(
  history: ClimateState["history"][string],
  definitions: ClimateState["measurementDefinitions"],
  metric: string,
): MeasurementSample[] {
  const result: MeasurementSample[] = [];
  for (const reading of history) {
    result.push(...readingSamples(reading, definitions).filter((sample) => sample.metric === metric));
  }
  return result;
}

function metricForecastSamples(
  forecasts: ClimateState["forecasts"][string],
  definitions: ClimateState["measurementDefinitions"],
  metric: string,
): ReturnType<typeof legacyForecastSamples> {
  const result: ReturnType<typeof legacyForecastSamples> = [];
  for (const point of forecasts) {
    result.push(...legacyForecastSamples(point, definitions).filter((sample) => sample.metric === metric));
  }
  return result;
}

function replaceFloor(current: ClimateState, houseId: string, floor: Floor): ClimateState {
  const houses = current.houses.map((house) => {
    if (house.id !== houseId) return house;
    return {
      ...house,
      floors: house.floors.map((item) => item.id === floor.id ? floor : item),
      updatedAt: new Date().toISOString(),
    };
  });
  const floors = houses.find((house) => house.id === houseId)?.floors ?? [];
  return { ...current, houses, sensors: synchronizeSensorRoomLabels(current.sensors, houseId, floors) };
}

function synchronizeSensorRoomLabels(
  sensors: Sensor[],
  houseId: string,
  floors: Floor[],
): Sensor[] {
  const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
  return sensors.map((sensor) => {
    if (sensor.houseId !== houseId || sensor.roomId === null || sensor.roomId === undefined) return sensor;
    const room = floorsById.get(sensor.floorId)?.rooms.find((candidate) => candidate.id === sensor.roomId);
    return room && room.name !== sensor.room ? { ...sensor, room: room.name } : sensor;
  });
}

function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

const PORTFOLIO_LOAD_CONCURRENCY = 3;

async function loadPortfolioInBackground(
  houseIds: string[],
  load: (houseId: string) => Promise<void>,
  cancelled: () => boolean,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (!cancelled()) {
      const houseId = houseIds[nextIndex];
      nextIndex += 1;
      if (!houseId) return;
      try { await load(houseId); } catch { /* A secondary card can remain unavailable without blocking the active house. */ }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(PORTFOLIO_LOAD_CONCURRENCY, houseIds.length) },
    () => worker(),
  ));
}

export function replaceLoadedHouseTelemetry(
  current: ClimateState,
  houseId: string,
  loadedSensorIds: string[],
  loadedReadings: ClimateState["readings"],
  samples: MeasurementSample[],
): LoadedTelemetryState {
  const replacedSensorIds = new Set([
    ...current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id),
    ...loadedSensorIds,
    ...Object.keys(loadedReadings),
    ...samples.map((sample) => sample.sensorId),
  ]);
  const latestOutsideHouse = withoutSensorIds(current.latestMeasurements, replacedSensorIds);
  return {
    latestMeasurements: upsertLatest(latestOutsideHouse, samples),
    measurementHistory: withoutSensorIds(current.measurementHistory, replacedSensorIds),
    measurementForecasts: withoutSensorIds(current.measurementForecasts, replacedSensorIds),
    readings: { ...withoutSensorIds(current.readings, replacedSensorIds), ...loadedReadings },
    history: withoutSensorIds(current.history, replacedSensorIds),
    forecasts: withoutSensorIds(current.forecasts, replacedSensorIds),
  };
}

function replayBufferedLiveTelemetry(
  loaded: LoadedTelemetryState,
  buffered: Iterable<BufferedLiveTelemetry>,
  loadedSensorIds: Set<string>,
): LoadedTelemetryState {
  let latestMeasurements = loaded.latestMeasurements;
  let measurementHistory = loaded.measurementHistory;
  let readings = loaded.readings;
  let history = loaded.history;
  for (const event of buffered) {
    if (!loadedSensorIds.has(event.data.sensorId)) continue;
    if (event.type === "measurement") {
      latestMeasurements = upsertLatest(latestMeasurements, [event.data]);
      measurementHistory = appendHistory(measurementHistory, [event.data]);
      continue;
    }
    const reading = event.data;
    const existing = readings[reading.sensorId];
    const existingTime = existing ? Date.parse(existing.timestamp) : Number.NEGATIVE_INFINITY;
    const readingTime = Date.parse(reading.timestamp);
    if (!existing || !Number.isFinite(existingTime) || !Number.isFinite(readingTime) || readingTime >= existingTime) {
      readings = { ...readings, [reading.sensorId]: reading };
    }
    const previousHistory = history[reading.sensorId] ?? [];
    history = {
      ...history,
      [reading.sensorId]: [...previousHistory.filter((item) => item.timestamp !== reading.timestamp), reading]
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
        .slice(-MAX_SERIES_SAMPLES),
    };
  }
  return { ...loaded, latestMeasurements, measurementHistory, readings, history };
}

function replayHouseMutations<T extends {
  sensors: Sensor[];
  observations: ManualObservation[];
  maintenanceTasks: MaintenanceTask[];
  staticParameters: StaticParameter[];
}>(houseId: string | null, loaded: T, buffered: HouseMutationBuffer): T & { deletedSensorIds: Set<string> } {
  let sensors = loaded.sensors;
  let observations = loaded.observations;
  let maintenanceTasks = loaded.maintenanceTasks;
  let staticParameters = loaded.staticParameters;
  const deletedSensorIds = new Set<string>();
  for (const mutation of buffered.values()) {
    if (mutation.houseId !== houseId) continue;
    if (mutation.resource === "sensor") {
      if (mutation.action === "delete") {
        sensors = sensors.filter((sensor) => sensor.id !== mutation.id);
        observations = observations.map((observation) => observation.sensorId === mutation.id
          ? { ...observation, sensorId: null }
          : observation);
        staticParameters = staticParameters.filter((parameter) => !(
          parameter.scopeType === "sensor" && parameter.scopeId === mutation.id
        ));
        deletedSensorIds.add(mutation.id);
      } else {
        sensors = [...sensors.filter((sensor) => sensor.id !== mutation.value.id), mutation.value];
        deletedSensorIds.delete(mutation.value.id);
      }
    } else if (mutation.resource === "observation") {
      observations = mutation.action === "replace"
        ? mutation.values
        : [...observations.filter((item) => item.id !== mutation.value.id), mutation.value];
    } else if (mutation.resource === "maintenance") {
      maintenanceTasks = mutation.action === "replace"
        ? mutation.values
        : mutation.action === "delete"
        ? maintenanceTasks.filter((item) => item.id !== mutation.id)
        : [...maintenanceTasks.filter((item) => item.id !== mutation.value.id), mutation.value];
    } else {
      if (mutation.action === "delete") {
        staticParameters = staticParameters.filter((item) => item.id !== mutation.id);
      } else {
        const value = mutation.value;
        staticParameters = [
          ...staticParameters.filter((item) => !(item.scopeType === value.scopeType
            && item.scopeId === value.scopeId && item.key === value.key)),
          value,
        ];
      }
    }
  }
  return { ...loaded, sensors, observations, maintenanceTasks, staticParameters, deletedSensorIds };
}

function replayMaintenanceTaskMutation(
  id: string,
  loaded: MaintenanceTask | undefined,
  buffered: HouseMutationBuffer,
): MaintenanceTask | undefined {
  let task = loaded;
  for (const mutation of buffered.values()) {
    if (mutation.resource !== "maintenance") continue;
    if (mutation.action === "replace") {
      const replacement = mutation.values.find((item) => item.id === id);
      if (replacement) task = replacement;
    } else if (mutation.action === "upsert" && mutation.value.id === id) {
      task = mutation.value;
    } else if (mutation.action === "delete" && mutation.id === id) {
      task = undefined;
    }
  }
  return task;
}

function preserveSeriesCommittedDuringLoad(
  loaded: LoadedTelemetryState,
  current: ClimateState,
  loadedSensorIds: Set<string>,
  commits: Map<string, SeriesCommit>,
  loadStartVersion: number,
): LoadedTelemetryState {
  let measurementHistory = loaded.measurementHistory;
  let measurementForecasts = loaded.measurementForecasts;
  let history = loaded.history;
  let forecasts = loaded.forecasts;
  for (const [seriesKey, commit] of commits) {
    if (commit.version <= loadStartVersion) continue;
    const separator = seriesKey.indexOf("\u0000");
    if (separator < 0) continue;
    const sensorId = seriesKey.slice(0, separator);
    const metric = seriesKey.slice(separator + 1);
    if (!loadedSensorIds.has(sensorId)) continue;
    const committedHistory = current.measurementHistory[sensorId]?.[metric];
    if (committedHistory !== undefined) {
      const replayedHistory = measurementHistory[sensorId]?.[metric] ?? [];
      measurementHistory = {
        ...measurementHistory,
        [sensorId]: {
          ...measurementHistory[sensorId],
          [metric]: mergeMeasurementSeries(committedHistory, replayedHistory, MAX_SERIES_SAMPLES),
        },
      };
    }
    const committedForecast = current.measurementForecasts[sensorId]?.[metric];
    if (committedForecast !== undefined) {
      measurementForecasts = {
        ...measurementForecasts,
        [sensorId]: { ...measurementForecasts[sensorId], [metric]: committedForecast },
      };
    }
    if (commit.legacy) {
      if (current.history[sensorId] !== undefined) {
        history = {
          ...history,
          [sensorId]: mergeLegacySeries(current.history[sensorId], history[sensorId] ?? [], MAX_SERIES_SAMPLES),
        };
      }
      if (current.forecasts[sensorId] !== undefined) forecasts = { ...forecasts, [sensorId]: current.forecasts[sensorId] };
    }
  }
  return { ...loaded, measurementHistory, measurementForecasts, history, forecasts };
}

function preserveMutatedSensorTelemetry(
  loaded: LoadedTelemetryState,
  current: ClimateState,
  houseId: string,
  mutations: HouseMutationBuffer,
): LoadedTelemetryState {
  const sensorIds = new Set([...mutations.values()].flatMap((mutation) => (
    mutation.resource === "sensor" && mutation.action === "upsert" && mutation.houseId === houseId
      ? [mutation.value.id]
      : []
  )));
  let result = loaded;
  for (const sensorId of sensorIds) {
    const currentLatest = Object.values(current.latestMeasurements[sensorId] ?? {});
    const currentReading = current.readings[sensorId];
    const loadedReading = result.readings[sensorId];
    const useCurrentReading = currentReading && (!loadedReading
      || Date.parse(currentReading.timestamp) >= Date.parse(loadedReading.timestamp));
    const currentMeasurementHistory = current.measurementHistory[sensorId];
    let measurementHistory = result.measurementHistory;
    if (currentMeasurementHistory) {
      const mergedMetrics = { ...(measurementHistory[sensorId] ?? {}) };
      for (const [metric, samples] of Object.entries(currentMeasurementHistory)) {
        mergedMetrics[metric] = mergeMeasurementSeries(samples, mergedMetrics[metric] ?? [], MAX_SERIES_SAMPLES);
      }
      measurementHistory = { ...measurementHistory, [sensorId]: mergedMetrics };
    }
    result = {
      ...result,
      latestMeasurements: upsertLatest(result.latestMeasurements, currentLatest),
      measurementHistory,
      measurementForecasts: current.measurementForecasts[sensorId]
        ? { ...result.measurementForecasts, [sensorId]: current.measurementForecasts[sensorId] }
        : result.measurementForecasts,
      readings: useCurrentReading ? { ...result.readings, [sensorId]: currentReading } : result.readings,
      history: current.history[sensorId]
        ? {
            ...result.history,
            [sensorId]: mergeLegacySeries(current.history[sensorId], result.history[sensorId] ?? [], MAX_SERIES_SAMPLES),
          }
        : result.history,
      forecasts: current.forecasts[sensorId]
        ? { ...result.forecasts, [sensorId]: current.forecasts[sensorId] }
        : result.forecasts,
    };
  }
  return result;
}

function mergeMeasurementSeries(
  loaded: MeasurementSample[],
  live: Iterable<MeasurementSample>,
  limit: number,
): MeasurementSample[] {
  const byTimestamp = new Map(loaded.map((sample) => [sample.timestamp, sample]));
  for (const sample of live) byTimestamp.set(sample.timestamp, sample);
  return [...byTimestamp.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-limit);
}

function mergeLegacySeries(loaded: Reading[], live: Iterable<Reading>, limit: number): Reading[] {
  const byTimestamp = new Map(loaded.map((reading) => [reading.timestamp, reading]));
  for (const reading of live) byTimestamp.set(reading.timestamp, reading);
  return [...byTimestamp.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-limit);
}

const unauthenticatedSession: AppSession = {
  authenticated: false,
  principal: { type: "unauthenticated", email: null },
  tenant: { id: "local", name: "Local Stuga", role: "guest" },
  availableTenants: [{ id: "local", name: "Local Stuga", role: "guest" }],
  readOnly: true,
  grants: [],
};

function blankState(session: AppSession = unauthenticatedSession): ClimateState {
  const base = withoutDemoTelemetry(createDemoState(), true);
  return {
    ...base,
    session,
    properties: [],
    propertyAreas: [],
    areaEquipment: [],
    propertyNotes: [],
    latestMeasurements: {},
    measurementHistory: {},
    measurementForecasts: {},
    houses: [],
    sensors: [],
    readings: {},
    history: {},
    forecasts: {},
    alertRules: [],
    alerts: [],
    observations: [],
    maintenanceTasks: [],
    staticParameters: [],
    scenarios: [],
  };
}

function apiStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}

export function useClimateData() {
  // Telemetry starts empty until the API positively confirms that this database
  // is still allowed to use demo data. This prevents a real installation from
  // flashing or regenerating mock values while its API is slow or unreachable.
  const initialHouseId = useRef(typeof window === "undefined" ? null : routeFromLocation(window.location).houseId);
  const sessionLockedRef = useRef(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [state, setStateInternal] = useState<ClimateState>(() => blankState());
  const setState = useCallback((next: SetStateAction<ClimateState>) => {
    // Once local logout locks the workspace, late completions from an aborted
    // request must not put old-session data back into React state.
    if (!sessionLockedRef.current) setStateInternal(next);
  }, []);
  const [loading, setLoading] = useState(true);
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [dataMode, setDataMode] = useState<DataMode>("unknown");
  const [streamConnections, setStreamConnections] = useState<StreamConnections>({
    legacy: "offline",
    measurements: "offline",
  });
  const connection = aggregateConnection(streamConnections);
  const [pollingFallback, setPollingFallback] = useState(false);
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  const [seriesStates, setSeriesStates] = useState<Record<string, SeriesLoadState>>({});
  const [scenario, setScenario] = useState<MockScenario["id"]>("normal");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tpLinkDevices, setTpLinkDevices] = useState<TpLinkDiscoveredDevice[]>([]);
  const tpLinkDevicesRef = useRef<TpLinkDiscoveredDevice[]>([]);
  const [tpLinkDevicesLoading, setTpLinkDevicesLoading] = useState(false);
  const [tpLinkDevicesError, setTpLinkDevicesError] = useState<string | null>(null);
  const tick = useRef(0);
  const apiAvailable = useRef(false);
  const dataModeRef = useRef<DataMode>("unknown");
  const stateRef = useRef(state);
  const streamConnectionsRef = useRef(streamConnections);
  const hasReachedLiveConnection = useRef(false);
  const hasHydratedActiveHouse = useRef(false);
  const heartbeatPollAt = useRef(0);
  const reconnectResyncTimer = useRef<number | null>(null);
  const heartbeatFallbackTimer = useRef<number | null>(null);
  const mutationRefreshTimer = useRef<number | null>(null);
  const sensorMoveQueues = useRef(new Map<string, Promise<void>>());
  const sensorMoveVersions = useRef(new Map<string, number>());
  const persistedSensorPoints = useRef(new Map<string, Point>());
  const activeHouseId = useRef<string | null>(initialHouseId.current);
  const activeHouseLoadVersion = useRef(0);
  const houseTelemetryVersions = useRef(new Map<string, number>());
  const seriesLoadVersions = useRef(new Map<string, number>());
  const seriesCommitVersions = useRef(new Map<string, SeriesCommit>());
  const seriesCommitSequence = useRef(0);
  const tpLinkPollStatus = useRef<Pick<IntegrationStatus["tpLink"], "lastPollAt" | "discoveredDevices"> | null>(null);
  const tpLinkRefreshVersion = useRef(0);
  const pendingMeasurementSamples = useRef<MeasurementSample[]>([]);
  const measurementFlushTimer = useRef<number | null>(null);
  const saveStateTimer = useRef<number | null>(null);
  const activeTelemetryLoadBuffers = useRef(new Set<Map<string, BufferedLiveTelemetry>>());
  const activeHouseMutationBuffers = useRef(new Set<HouseMutationBuffer>());
  const activeSeriesTelemetryBuffers = useRef(new Set<BufferedSeriesTelemetry>());
  const activeInventoryMutationBuffers = useRef(new Set<Map<string, HouseInventoryMutation>>());
  const activeStreamUnsubscribers = useRef(new Set<() => void>());
  const activeStreamGateReleases = useRef(new Set<() => void>());
  const sessionLifecycleEpoch = useRef(0);
  const globalFieldVersions = useRef({ alertRules: 0, alerts: 0, integration: 0 });

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { streamConnectionsRef.current = streamConnections; }, [streamConnections]);
  useEffect(() => () => {
    if (measurementFlushTimer.current !== null) window.clearTimeout(measurementFlushTimer.current);
    if (reconnectResyncTimer.current !== null) window.clearTimeout(reconnectResyncTimer.current);
    if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
    if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
    if (saveStateTimer.current !== null) window.clearTimeout(saveStateTimer.current);
    measurementFlushTimer.current = null;
    reconnectResyncTimer.current = null;
    heartbeatFallbackTimer.current = null;
    mutationRefreshTimer.current = null;
    saveStateTimer.current = null;
    pendingMeasurementSamples.current = [];
    for (const unsubscribe of activeStreamUnsubscribers.current) unsubscribe();
    activeStreamUnsubscribers.current.clear();
    for (const release of activeStreamGateReleases.current) release();
    activeStreamGateReleases.current.clear();
  }, []);

  const recordResourceError = useCallback((key: string, error: unknown | null) => {
    setResourceErrors((current) => {
      if (error === null) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      const message = errorMessage(error, "This data source is temporarily unavailable");
      return current[key] === message ? current : { ...current, [key]: message };
    });
  }, []);

  const recordHouseMutation = useCallback((mutation: BufferedHouseMutation) => {
    const key = houseMutationKey(mutation);
    for (const buffer of activeHouseMutationBuffers.current) {
      buffer.delete(key);
      buffer.set(key, mutation);
    }
  }, []);

  const recordInventoryMutation = useCallback((mutation: HouseInventoryMutation) => {
    const id = mutation.action === "delete" ? mutation.id : mutation.value.id;
    for (const buffer of activeInventoryMutationBuffers.current) {
      buffer.delete(id);
      buffer.set(id, mutation);
    }
  }, []);

  const applyIntegrationStatus = useCallback((integration: IntegrationStatus) => {
    globalFieldVersions.current.integration += 1;
    if (integration.mock.mode === "real" && dataModeRef.current !== "real") {
      globalFieldVersions.current.alerts += 1;
    }
    dataModeRef.current = integration.mock.mode;
    setDataMode(integration.mock.mode);
    setState((current) => {
      const next = { ...current, integration };
      return integration.mock.mode === "real" && current.integration.mock.mode !== "real"
        ? withoutDemoTelemetry(next, true)
        : next;
    });
  }, []);

  const refreshTpLinkDevices = useCallback(async (houseId?: string) => {
    const refreshVersion = ++tpLinkRefreshVersion.current;
    if (!apiAvailable.current) {
      tpLinkDevicesRef.current = [];
      setTpLinkDevices([]);
      setTpLinkDevicesError(null);
      setTpLinkDevicesLoading(false);
      return [];
    }
    setTpLinkDevicesLoading(true);
    setTpLinkDevicesError(null);
    try {
      const devices = await api.tpLinkDevices(houseId);
      if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
      // A house-scoped inventory request is authoritative only for that house.
      // Keep sibling-house devices in memory so visiting Sensors or Setup for
      // one Home cannot make another Home's discovery notice disappear.
      const nextDevices = houseId
        ? [
            ...tpLinkDevicesRef.current.filter((device) => device.houseId !== houseId),
            ...devices,
          ]
        : devices;
      tpLinkDevicesRef.current = nextDevices;
      setTpLinkDevices(nextDevices);
      return devices;
    } catch (error) {
      // A superseded caller receives the authoritative newer inventory instead
      // of surfacing an obsolete failure in page-local error state.
      if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
      setTpLinkDevicesError(error instanceof Error ? error.message : "Could not load TP-Link devices");
      throw error;
    } finally {
      if (tpLinkRefreshVersion.current === refreshVersion) setTpLinkDevicesLoading(false);
    }
  }, []);

  const disconnectHomeAssistant = useCallback(async (houseId: string) => api.disconnectHomeAssistant(houseId), []);

  const applyDetachedTpLinkSensors = useCallback((sensorIds: string[]) => {
    const detached = new Set(sensorIds);
    for (const sensor of stateRef.current.sensors) {
      if (!detached.has(sensor.id)) continue;
      const updated = { ...sensor };
      delete updated.tpLinkDeviceId;
      delete updated.tpLinkConnectionId;
      recordHouseMutation({ resource: "sensor", action: "upsert", houseId: updated.houseId, value: updated });
    }
    if (detached.size > 0) {
      setState((current) => ({
        ...current,
        sensors: current.sensors.map((sensor) => {
          if (!detached.has(sensor.id)) return sensor;
          const updated = { ...sensor };
          delete updated.tpLinkDeviceId;
          delete updated.tpLinkConnectionId;
          return updated;
        }),
      }));
    }
  }, [recordHouseMutation]);

  const disconnectTpLink = useCallback(async (connectionId: string) => {
    const result = await api.disconnectTpLink(connectionId);
    applyDetachedTpLinkSensors(result.detachedSensorIds);
    settleInBackground(refreshTpLinkDevices());
    return result;
  }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);

  const moveHomeAssistant = useCallback(async (fromHouseId: string, houseId: string) => (
    api.moveHomeAssistant(fromHouseId, houseId)
  ), []);

  const moveTpLink = useCallback(async (connectionId: string, houseId: string) => {
    const result = await api.moveTpLink(connectionId, houseId);
    applyDetachedTpLinkSensors(result.detachedSensorIds);
    settleInBackground(refreshTpLinkDevices());
    return result;
  }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);

  const loadHouseData = useCallback(async (
    houseId: string,
    includeGlobalData = false,
    streamReady: Promise<void> | null = null,
  ) => {
    const bufferedLiveTelemetry = new Map<string, BufferedLiveTelemetry>();
    const bufferedHouseMutations: HouseMutationBuffer = new Map();
    activeTelemetryLoadBuffers.current.add(bufferedLiveTelemetry);
    activeHouseMutationBuffers.current.add(bufferedHouseMutations);
    const seriesVersionAtLoadStart = seriesCommitSequence.current;
    const globalVersionsAtLoadStart = { ...globalFieldVersions.current };
    activeHouseId.current = houseId;
    const activeVersion = ++activeHouseLoadVersion.current;
    const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
    houseTelemetryVersions.current.set(houseId, telemetryVersion);
    const isCurrentLoad = () => activeHouseId.current === houseId
      && activeHouseLoadVersion.current === activeVersion
      && houseTelemetryVersions.current.get(houseId) === telemetryVersion;
    const optionalResource = async <T,>(name: string, promise: Promise<T>): Promise<T | null> => {
      try {
        const value = await promise;
        if (isCurrentLoad()) recordResourceError(`${houseId}:${name}`, null);
        return value;
      } catch (error) {
        if (isCurrentLoad()) recordResourceError(`${houseId}:${name}`, error);
        return null;
      }
    };
    let houseMutationBufferDeferred = false;
    try {
      if (streamReady) await streamReady;
      if (!isCurrentLoad()) return;
      const measurementSnapshot = optionalResource("measurement-snapshot", api.measurementSnapshot(houseId));
      const observationsRequest = optionalResource("observations", api.observations(houseId));
      const maintenanceRequest = optionalResource("maintenance", api.maintenanceTasks({ houseId }));
      const staticParametersRequest = optionalResource("static-parameters", api.staticParameters(houseId));
      const definitionsRequest = includeGlobalData
        ? optionalResource("measurement-definitions", api.measurementDefinitions())
        : Promise.resolve(null);
      const alertRulesRequest = includeGlobalData
        ? optionalResource("alert-rules", api.alertRules())
        : Promise.resolve(null);
      const alertsRequest = includeGlobalData
        ? optionalResource("alerts", api.alerts())
        : Promise.resolve(null);
      const scenariosRequest = includeGlobalData
        ? optionalResource("scenarios", api.scenarios())
        : Promise.resolve(null);
      const integrationRequest = includeGlobalData ? api.integrations() : Promise.resolve(null);
      const [snapshot, integration] = await Promise.all([
        api.snapshot(houseId), integrationRequest,
      ]);
      if (!isCurrentLoad()) return;
      recordResourceError(`${houseId}:snapshot`, null);
      const integrationIsCurrent = globalFieldVersions.current.integration === globalVersionsAtLoadStart.integration;
      const enteringRealMode = Boolean(integrationIsCurrent
        && integration?.mock.mode === "real"
        && dataModeRef.current !== "real");
      if (integration && integrationIsCurrent) {
        tpLinkPollStatus.current = {
          lastPollAt: integration.tpLink.lastPollAt,
          discoveredDevices: integration.tpLink.discoveredDevices,
        };
        dataModeRef.current = integration.mock.mode;
        setDataMode(integration.mock.mode);
      }
      const sensors = snapshot.length ? sensorsFromSnapshots(snapshot) : await api.sensors(houseId);
      if (!isCurrentLoad()) return;
      setState((current) => {
        if (!isCurrentLoad()) return current;
        const definitions = enabledDefinitions(current.measurementDefinitions);
        const merged = replayHouseMutations(houseId, {
          sensors,
          observations: [],
          maintenanceTasks: [],
          staticParameters: [],
        }, bufferedHouseMutations);
        const legacyReadings = withoutSensorIds(snapshotToReadings(snapshot), merged.deletedSensorIds);
        const samples = Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, definitions));
        const loadedSensorIds = [...new Set(merged.sensors.map((sensor) => sensor.id))];
        const telemetryWithLiveEvents = replayBufferedLiveTelemetry(
          replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples),
          bufferedLiveTelemetry.values(),
          new Set(loadedSensorIds),
        );
        const telemetryWithSeries = preserveSeriesCommittedDuringLoad(
          telemetryWithLiveEvents,
          current,
          new Set(loadedSensorIds),
          seriesCommitVersions.current,
          seriesVersionAtLoadStart,
        );
        const telemetry = preserveMutatedSensorTelemetry(
          telemetryWithSeries, current, houseId, bufferedHouseMutations,
        );
        const nextIntegration = integration
          && globalFieldVersions.current.integration === globalVersionsAtLoadStart.integration
          ? integration
          : current.integration;
        const next = {
          ...current,
          ...telemetry,
          sensors: replaceHouseSensors(current.sensors, houseId, merged.sensors),
          integration: nextIntegration,
        };
        return nextIntegration.mock.mode === "real"
          ? withoutDemoTelemetry(next, enteringRealMode)
          : next;
      });

      const optionalUpdates: Promise<void>[] = [
        measurementSnapshot.then((generic) => {
          if (!generic || !isCurrentLoad()) return;
          setState((current) => {
            if (!isCurrentLoad()) return current;
            const merged = replayHouseMutations(houseId, {
              sensors: [], observations: [], maintenanceTasks: [], staticParameters: [],
            }, bufferedHouseMutations);
            const samples = generic
              .filter((item) => !merged.deletedSensorIds.has(item.sensorId))
              .flatMap((item) => Object.values(item.measurements))
              .filter((sample) => {
                const existing = current.latestMeasurements[sample.sensorId]?.[sample.metric];
                return !existing || Date.parse(sample.timestamp) > Date.parse(existing.timestamp);
              });
            return samples.length
              ? { ...current, latestMeasurements: upsertLatest(current.latestMeasurements, samples) }
              : current;
          });
        }),
        observationsRequest.then((observations) => {
          if (!observations || !isCurrentLoad()) return;
          setState((current) => {
            if (!isCurrentLoad()) return current;
            const merged = replayHouseMutations(houseId, {
              sensors: [], observations, maintenanceTasks: [], staticParameters: [],
            }, bufferedHouseMutations);
            return { ...current, observations: merged.observations };
          });
        }),
        maintenanceRequest.then((maintenanceTasks) => {
          if (!maintenanceTasks || !isCurrentLoad()) return;
          setState((current) => {
            if (!isCurrentLoad()) return current;
            const merged = replayHouseMutations(houseId, {
              sensors: [], observations: [], maintenanceTasks, staticParameters: [],
            }, bufferedHouseMutations);
            return {
              ...current,
              maintenanceTasks: [
                ...current.maintenanceTasks.filter((task) => task.houseId !== houseId),
                ...merged.maintenanceTasks,
              ],
            };
          });
        }),
        staticParametersRequest.then((staticParameters) => {
          if (!staticParameters || !isCurrentLoad()) return;
          setState((current) => {
            if (!isCurrentLoad()) return current;
            const merged = replayHouseMutations(houseId, {
              sensors: [], observations: [], maintenanceTasks: [], staticParameters,
            }, bufferedHouseMutations);
            return { ...current, staticParameters: merged.staticParameters };
          });
        }),
      ];
      if (includeGlobalData) {
        optionalUpdates.push(
          definitionsRequest.then((definitions) => {
            if (!definitions || !isCurrentLoad()) return;
            setState((current) => isCurrentLoad()
              ? { ...current, measurementDefinitions: enabledDefinitions(definitions) }
              : current);
          }),
          alertRulesRequest.then((alertRules) => {
            if (!alertRules || !isCurrentLoad()
              || globalFieldVersions.current.alertRules !== globalVersionsAtLoadStart.alertRules) return;
            setState((current) => isCurrentLoad()
              && globalFieldVersions.current.alertRules === globalVersionsAtLoadStart.alertRules
              ? { ...current, alertRules }
              : current);
          }),
          alertsRequest.then((alerts) => {
            if (!alerts || !isCurrentLoad()
              || globalFieldVersions.current.alerts !== globalVersionsAtLoadStart.alerts) return;
            setState((current) => isCurrentLoad()
              && globalFieldVersions.current.alerts === globalVersionsAtLoadStart.alerts
              ? { ...current, alerts }
              : current);
          }),
          scenariosRequest.then((scenarios) => {
            if (!scenarios || !isCurrentLoad()) return;
            setState((current) => isCurrentLoad() && scenarios.length
              ? { ...current, scenarios }
              : current);
          }),
        );
      }
      houseMutationBufferDeferred = true;
      settleInBackground(Promise.allSettled(optionalUpdates).finally(() => {
        activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
      }));
    } catch (error) {
      if (isCurrentLoad()) recordResourceError(`${houseId}:snapshot`, error);
      throw error;
    } finally {
      activeTelemetryLoadBuffers.current.delete(bufferedLiveTelemetry);
      if (!houseMutationBufferDeferred) activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
    }
  }, [recordResourceError]);

  const loadPortfolioHouseData = useCallback(async (houseId: string) => {
    if (activeHouseId.current === houseId) return;
    const bufferedLiveTelemetry = new Map<string, BufferedLiveTelemetry>();
    const bufferedHouseMutations: HouseMutationBuffer = new Map();
    activeTelemetryLoadBuffers.current.add(bufferedLiveTelemetry);
    activeHouseMutationBuffers.current.add(bufferedHouseMutations);
    const seriesVersionAtLoadStart = seriesCommitSequence.current;
    const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
    houseTelemetryVersions.current.set(houseId, telemetryVersion);
    try {
      const measurementSnapshot = api.measurementSnapshot(houseId).catch(() => null);
      const [snapshot, generic] = await Promise.all([api.snapshot(houseId), measurementSnapshot]);
      if (activeHouseId.current === houseId
        || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
      const sensors = snapshot.length ? sensorsFromSnapshots(snapshot) : await api.sensors(houseId);
      if (activeHouseId.current === houseId
        || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
      setState((current) => {
        if (activeHouseId.current === houseId
          || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return current;
        const merged = replayHouseMutations(houseId, {
          sensors,
          observations: [],
          maintenanceTasks: [],
          staticParameters: [],
        }, bufferedHouseMutations);
        const legacyReadings = withoutSensorIds(snapshotToReadings(snapshot), merged.deletedSensorIds);
        const samples = generic?.filter((item) => !merged.deletedSensorIds.has(item.sensorId))
          .flatMap((item) => Object.values(item.measurements))
          ?? Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, current.measurementDefinitions));
        const loadedSensorIds = [...new Set([
          ...merged.sensors.map((sensor) => sensor.id),
          ...(generic ?? []).filter((item) => !merged.deletedSensorIds.has(item.sensorId)).map((item) => item.sensorId),
        ])];
        const telemetryWithLiveEvents = replayBufferedLiveTelemetry(
          replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples),
          bufferedLiveTelemetry.values(),
          new Set(loadedSensorIds),
        );
        const telemetryWithSeries = preserveSeriesCommittedDuringLoad(
          telemetryWithLiveEvents,
          current,
          new Set(loadedSensorIds),
          seriesCommitVersions.current,
          seriesVersionAtLoadStart,
        );
        const telemetry = preserveMutatedSensorTelemetry(
          telemetryWithSeries, current, houseId, bufferedHouseMutations,
        );
        const next = {
          ...current,
          ...telemetry,
          sensors: replaceHouseSensors(current.sensors, houseId, merged.sensors),
        };
        return current.integration.mock.mode === "real" ? withoutDemoTelemetry(next) : next;
      });
    } finally {
      activeTelemetryLoadBuffers.current.delete(bufferedLiveTelemetry);
      activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
    }
  }, []);

  const scheduleActiveHouseResync = useCallback((delay = 50) => {
    if (!hasHydratedActiveHouse.current || !apiAvailable.current) return;
    if (reconnectResyncTimer.current !== null) window.clearTimeout(reconnectResyncTimer.current);
    reconnectResyncTimer.current = window.setTimeout(() => {
      reconnectResyncTimer.current = null;
      const houseId = activeHouseId.current;
      if (houseId) settleInBackground(loadHouseData(houseId));
    }, delay);
  }, [loadHouseData]);

  const updateStreamConnection = useCallback((stream: keyof StreamConnections, next: ConnectionState) => {
    const previousAggregate = aggregateConnection(streamConnectionsRef.current);
    const updated = { ...streamConnectionsRef.current, [stream]: next };
    const nextAggregate = aggregateConnection(updated);
    streamConnectionsRef.current = updated;
    setStreamConnections(updated);
    if (nextAggregate === "live") {
      setPollingFallback(false);
      if (hasReachedLiveConnection.current && previousAggregate !== "live") scheduleActiveHouseResync();
      hasReachedLiveConnection.current = true;
    }
  }, [scheduleActiveHouseResync]);

  const resetStreamConnections = useCallback(() => {
    const offline: StreamConnections = { legacy: "offline", measurements: "offline" };
    streamConnectionsRef.current = offline;
    hasReachedLiveConnection.current = false;
    setStreamConnections(offline);
    setPollingFallback(false);
  }, []);

  const handleHeartbeat = useCallback((data: unknown) => {
    const pollingCompatibility = isPollingCompatibilityHeartbeat(data);
    if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
    const activatePollingFallback = () => {
      heartbeatFallbackTimer.current = null;
      if (!pollingCompatibility && aggregateConnection(streamConnectionsRef.current) === "live") return;
      if (pollingCompatibility) updateStreamConnection("legacy", "reconnecting");
      setPollingFallback(true);
      const now = Date.now();
      if (now - heartbeatPollAt.current < HEARTBEAT_POLL_MIN_INTERVAL_MS) return;
      heartbeatPollAt.current = now;
      scheduleActiveHouseResync(0);
    };
    if (pollingCompatibility) activatePollingFallback();
    else heartbeatFallbackTimer.current = window.setTimeout(activatePollingFallback, 1_000);
  }, [scheduleActiveHouseResync, updateStreamConnection]);

  useEffect(() => {
    if (sessionLocked) return undefined;
    let cancelled = false;
    const initializationEpoch = sessionLifecycleEpoch.current;
    const invalidated = () => cancelled || sessionLifecycleEpoch.current !== initializationEpoch;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeMeasurements: (() => void) | undefined;
    let streamGateTimer: number | null = null;
    let releaseStreamGate: (() => void) | undefined;
    const initialize = async () => {
      const hadInventory = stateRef.current.houses.length > 0;
      if (!hadInventory) {
        setLoading(true);
        setBootstrapStatus("loading");
      }
      setBootstrapError(null);
      apiAvailable.current = false;
      hasHydratedActiveHouse.current = false;
      resetStreamConnections();
      const inventoryMutations = new Map<string, HouseInventoryMutation>();
      activeInventoryMutationBuffers.current.add(inventoryMutations);
      try {
        // Resolve authentication before any workspace resource is requested.
        const session = await api.session();
        if (invalidated()) return;
        if (!session.authenticated || session.setupRequired) {
          apiAvailable.current = false;
          const locked = !session.setupRequired;
          sessionLockedRef.current = locked;
          setSessionLocked(locked);
          const cleared = blankState(session);
          stateRef.current = cleared;
          setStateInternal(cleared);
          setDataMode("unknown");
          dataModeRef.current = "unknown";
          resetStreamConnections();
          setBootstrapStatus(session.setupRequired ? "setup-required" : "login-required");
          return;
        }
        const [properties, rawHouses, propertyAreas, areaEquipment, propertyNotes, scopedMaintenanceResult] = await Promise.all([
          api.properties(),
          api.houses(),
          api.propertyAreas(),
          api.areaEquipment(),
          api.propertyNotes(),
          api.maintenanceTasks().then(
            (tasks) => ({ tasks, error: null as unknown }),
            (error: unknown) => ({ tasks: null, error }),
          ),
        ]);
        const houses = replayHouseInventory(rawHouses, inventoryMutations);
        if (invalidated()) return;
        recordResourceError("maintenance:scoped", scopedMaintenanceResult.error);
        apiAvailable.current = true;
        if (houses.length === 0) {
          setState((current) => ({
            ...withoutDemoTelemetry(current, true),
            session,
            properties,
            propertyAreas,
            areaEquipment,
            propertyNotes,
            houses: [],
            sensors: [],
            observations: [],
            maintenanceTasks: scopedMaintenanceResult.tasks ?? current.maintenanceTasks,
            staticParameters: [],
          }));
          setDataMode("unknown");
          dataModeRef.current = "unknown";
          resetStreamConnections();
          setBootstrapStatus(properties.length === 0 && !session.readOnly ? "empty" : "ready");
          return;
        }
        setState((current) => ({
          ...current,
          session,
          properties,
          propertyAreas,
          areaEquipment,
          propertyNotes,
          maintenanceTasks: scopedMaintenanceResult.tasks ?? current.maintenanceTasks,
          houses,
        }));
        const currentHouse = activeHouseId.current
          ? houses.find((house) => house.id === activeHouseId.current)
          : undefined;
        const requestedHouse = initialHouseId.current
          ? houses.find((house) => house.id === initialHouseId.current)
          : undefined;
        const activeHouse = currentHouse ?? requestedHouse ?? houses[0]!;
        // Register the replay buffers first, establish both event listeners,
        // then request snapshots. This closes the snapshot/subscribe race while
        // retaining events delivered during hydration.
        let legacyStreamOpened = false;
        let measurementStreamOpened = false;
        const streamReady = new Promise<void>((resolve) => {
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            activeStreamGateReleases.current.delete(release);
            resolve();
          };
          releaseStreamGate = release;
          activeStreamGateReleases.current.add(release);
        });
        const markStreamOpen = (stream: keyof StreamConnections) => {
          if (invalidated()) return;
          if (stream === "legacy") legacyStreamOpened = true;
          else measurementStreamOpened = true;
          if (legacyStreamOpened && measurementStreamOpened) releaseStreamGate?.();
        };
        streamGateTimer = window.setTimeout(() => releaseStreamGate?.(), STREAM_BOOTSTRAP_WAIT_MS);
        const activeHouseLoad = loadHouseData(activeHouse.id, true, streamReady);
        // A synchronous subscription setup failure must not leave a later load
        // rejection unobserved; the awaited branch still drives normal errors.
        settleInBackground(activeHouseLoad);
        unsubscribe = subscribeToEvents((event) => {
          if (invalidated()) return;
          handleTelemetry(event);
          if (event.type === "heartbeat") handleHeartbeat(event.data);
        }, (nextConnection) => {
          if (!invalidated()) updateStreamConnection("legacy", nextConnection);
        }, () => markStreamOpen("legacy"));
        activeStreamUnsubscribers.current.add(unsubscribe);
        unsubscribeMeasurements = subscribeToMeasurementEvents(
          (sample) => { if (!invalidated()) handleMeasurement(sample); },
          (nextConnection) => {
            if (!invalidated()) updateStreamConnection("measurements", nextConnection);
          },
          () => markStreamOpen("measurements"),
        );
        activeStreamUnsubscribers.current.add(unsubscribeMeasurements);
        await activeHouseLoad;
        if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
        streamGateTimer = null;
        if (invalidated()) return;
        hasHydratedActiveHouse.current = true;
        settleInBackground(refreshTpLinkDevices());
        setBootstrapStatus("ready");
        const secondaryHouseIds = houses.filter((house) => house.id !== activeHouse.id).map((house) => house.id);
        settleInBackground(loadPortfolioInBackground(
          secondaryHouseIds,
          loadPortfolioHouseData,
          invalidated,
        ));
      } catch (error) {
        if (unsubscribe) activeStreamUnsubscribers.current.delete(unsubscribe);
        unsubscribe?.();
        unsubscribe = undefined;
        if (unsubscribeMeasurements) activeStreamUnsubscribers.current.delete(unsubscribeMeasurements);
        unsubscribeMeasurements?.();
        unsubscribeMeasurements = undefined;
        if (!invalidated()) {
          apiAvailable.current = false;
          resetStreamConnections();
          if (apiStatus(error) === 401) {
            sessionLockedRef.current = true;
            setSessionLocked(true);
            setBootstrapError(null);
            setDataMode("unknown");
            dataModeRef.current = "unknown";
            const cleared = blankState();
            stateRef.current = cleared;
            setStateInternal(cleared);
            setBootstrapStatus("login-required");
            return;
          }
          setBootstrapError(error instanceof Error && error.message.trim() ? error.message : "The Stuga service could not be reached.");
          if (hadInventory) {
            // Keep the last confirmed real snapshot visible and mark transport
            // failure separately; a retry must not turn a transient outage into
            // an empty installation or erase the user's spatial context.
            setState((current) => withoutDemoTelemetry(current));
            setBootstrapStatus("ready");
          } else {
            dataModeRef.current = "unknown";
            setDataMode("unknown");
            setState((current) => ({
              ...withoutDemoTelemetry(current, true),
              houses: [],
              sensors: [],
              observations: [],
              staticParameters: [],
            }));
            setBootstrapStatus("unavailable");
          }
        }
      } finally {
        activeInventoryMutationBuffers.current.delete(inventoryMutations);
        if (!invalidated()) setLoading(false);
      }
    };
    settleInBackground(initialize());
    return () => {
      cancelled = true;
      hasHydratedActiveHouse.current = false;
      activeHouseLoadVersion.current += 1;
      if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
      releaseStreamGate?.();
      releaseStreamGate = undefined;
      if (unsubscribe) activeStreamUnsubscribers.current.delete(unsubscribe);
      unsubscribe?.();
      if (unsubscribeMeasurements) activeStreamUnsubscribers.current.delete(unsubscribeMeasurements);
      unsubscribeMeasurements?.();
    };
  }, [bootstrapAttempt, handleHeartbeat, loadHouseData, loadPortfolioHouseData, refreshTpLinkDevices, resetStreamConnections, sessionLocked, updateStreamConnection]);

  const purgeSessionState = useCallback((locked: boolean) => {
    sessionLifecycleEpoch.current += 1;
    sessionLockedRef.current = locked;
    setSessionLocked(locked);
    cancelPendingApiRequests();
    apiAvailable.current = false;
    hasHydratedActiveHouse.current = false;
    hasReachedLiveConnection.current = false;
    heartbeatPollAt.current = 0;
    activeHouseId.current = null;
    initialHouseId.current = null;
    tick.current = 0;

    if (measurementFlushTimer.current !== null) window.clearTimeout(measurementFlushTimer.current);
    if (reconnectResyncTimer.current !== null) window.clearTimeout(reconnectResyncTimer.current);
    if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
    if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
    if (saveStateTimer.current !== null) window.clearTimeout(saveStateTimer.current);
    measurementFlushTimer.current = null;
    reconnectResyncTimer.current = null;
    heartbeatFallbackTimer.current = null;
    mutationRefreshTimer.current = null;
    saveStateTimer.current = null;
    pendingMeasurementSamples.current = [];

    for (const unsubscribe of activeStreamUnsubscribers.current) unsubscribe();
    activeStreamUnsubscribers.current.clear();
    for (const release of activeStreamGateReleases.current) release();
    activeStreamGateReleases.current.clear();
    for (const buffer of activeTelemetryLoadBuffers.current) buffer.clear();
    activeTelemetryLoadBuffers.current.clear();
    for (const buffer of activeHouseMutationBuffers.current) buffer.clear();
    activeHouseMutationBuffers.current.clear();
    for (const buffer of activeSeriesTelemetryBuffers.current) {
      buffer.samples.clear();
      buffer.readings.clear();
    }
    activeSeriesTelemetryBuffers.current.clear();
    for (const buffer of activeInventoryMutationBuffers.current) buffer.clear();
    activeInventoryMutationBuffers.current.clear();

    activeHouseLoadVersion.current += 1;
    tpLinkRefreshVersion.current += 1;
    seriesCommitSequence.current += 1;
    houseTelemetryVersions.current.clear();
    seriesLoadVersions.current.clear();
    seriesCommitVersions.current.clear();
    sensorMoveQueues.current.clear();
    sensorMoveVersions.current.clear();
    persistedSensorPoints.current.clear();
    tpLinkPollStatus.current = null;
    globalFieldVersions.current = {
      alertRules: globalFieldVersions.current.alertRules + 1,
      alerts: globalFieldVersions.current.alerts + 1,
      integration: globalFieldVersions.current.integration + 1,
    };

    const cleared = blankState();
    stateRef.current = cleared;
    setStateInternal(cleared);
    tpLinkDevicesRef.current = [];
    setTpLinkDevices([]);
    setTpLinkDevicesLoading(false);
    setTpLinkDevicesError(null);
    setResourceErrors({});
    setSeriesStates({});
    setScenario("normal");
    setSaveState("idle");
    setBootstrapError(null);
    setDataMode("unknown");
    dataModeRef.current = "unknown";
    resetStreamConnections();
    setBootstrapStatus(locked ? "login-required" : "loading");
    setLoading(!locked);
  }, [resetStreamConnections]);

  const retryBootstrap = useCallback(() => {
    sessionLockedRef.current = false;
    setSessionLocked(false);
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  const revalidateSession = useCallback(() => {
    purgeSessionState(false);
    setBootstrapAttempt((attempt) => attempt + 1);
  }, [purgeSessionState]);

  const endSession = useCallback(() => {
    purgeSessionState(true);
  }, [purgeSessionState]);

  useEffect(() => subscribeToApiAuthorizationChanges((change) => {
    if (change === "expired") endSession();
    else revalidateSession();
  }), [endSession, revalidateSession]);

  useEffect(() => subscribeToAuthEpoch(revalidateSession), [revalidateSession]);

  useEffect(() => {
    if (connection === "live" || dataMode !== "demo") return;
    const timer = window.setInterval(() => {
      tick.current += 1;
      setState((current) => dataModeRef.current === "demo"
        ? advanceMockTelemetry(current, scenario, tick.current)
        : current);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [connection, dataMode, scenario]);

  const handleTelemetry = useCallback((event: TelemetryEvent) => {
    if (event.type === "mutation") {
      if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
      mutationRefreshTimer.current = window.setTimeout(() => {
        mutationRefreshTimer.current = null;
        if (!sessionLockedRef.current) setBootstrapAttempt((attempt) => attempt + 1);
      }, 350);
    } else if (event.type === "reading" && "temperature" in event.data && "humidity" in event.data) {
      const reading = event.data;
      if (dataModeRef.current === "real" && reading.source === "mock") return;
      for (const buffer of activeTelemetryLoadBuffers.current) {
        bufferLiveTelemetry(buffer, { type: "reading", data: reading });
      }
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === reading.sensorId) bufferSeriesValue(buffer.readings, reading.timestamp, reading);
      }
      setState((current) => {
        if (!current.sensors.some((sensor) => sensor.id === reading.sensorId)) return current;
        if (current.integration.mock.mode === "real" && reading.source === "mock") return current;
        const previous = current.readings[reading.sensorId];
        const previousTime = previous ? Date.parse(previous.timestamp) : Number.NEGATIVE_INFINITY;
        const incomingTime = Date.parse(reading.timestamp);
        const latest = !previous || !Number.isFinite(previousTime) || !Number.isFinite(incomingTime) || incomingTime >= previousTime
          ? reading
          : previous;
        const orderedHistory = [...(current.history[reading.sensorId] ?? []).filter((item) => item.timestamp !== reading.timestamp), reading]
          .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
          .slice(-MAX_SERIES_SAMPLES);
        return {
          ...current,
          readings: { ...current.readings, [reading.sensorId]: latest },
          history: { ...current.history, [reading.sensorId]: orderedHistory },
        };
      });
    } else if (event.type === "alert" && "ruleId" in event.data) {
      const alert = event.data;
      globalFieldVersions.current.alerts += 1;
      setState((current) => ({ ...current, alerts: [alert, ...current.alerts.filter((item) => item.id !== alert.id)] }));
    } else if (event.type === "integration" && "homeAssistant" in event.data) {
      const integration = event.data as ClimateState["integration"];
      const previousTpLinkPollStatus = tpLinkPollStatus.current;
      const tpLinkPollAdvanced = previousTpLinkPollStatus !== null && (
        previousTpLinkPollStatus.lastPollAt !== integration.tpLink.lastPollAt
        || previousTpLinkPollStatus.discoveredDevices !== integration.tpLink.discoveredDevices
      );
      tpLinkPollStatus.current = {
        lastPollAt: integration.tpLink.lastPollAt,
        discoveredDevices: integration.tpLink.discoveredDevices,
      };
      applyIntegrationStatus(integration);
      if (tpLinkPollAdvanced) settleInBackground(refreshTpLinkDevices());
    } else if (event.type === "weather" && event.data.type === "weather.snapshot") {
      publishHouseWeatherUpdate(event.data);
    }
  }, [applyIntegrationStatus, refreshTpLinkDevices]);

  const flushMeasurements = useCallback(() => {
    measurementFlushTimer.current = null;
    const queued = pendingMeasurementSamples.current;
    pendingMeasurementSamples.current = [];
    if (!queued.length) return;
    const samples = [...new Map(queued.map((sample) => [
      `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`,
      sample,
    ])).values()];
    setState((current) => {
      const knownSensorIds = new Set(current.sensors.map((sensor) => sensor.id));
      const accepted = samples.filter((sample) => knownSensorIds.has(sample.sensorId)
        && (current.integration.mock.mode !== "real" || sample.source !== "mock"));
      if (!accepted.length) return current;
      return {
        ...current,
        latestMeasurements: upsertLatest(current.latestMeasurements, accepted),
        measurementHistory: appendHistory(current.measurementHistory, accepted),
      };
    });
  }, []);

  const handleMeasurement = useCallback((sample: MeasurementSample) => {
    if (dataModeRef.current === "real" && sample.source === "mock") return;
    for (const buffer of activeTelemetryLoadBuffers.current) {
      bufferLiveTelemetry(buffer, { type: "measurement", data: sample });
    }
    for (const buffer of activeSeriesTelemetryBuffers.current) {
      if (buffer.sensorId === sample.sensorId && buffer.metric === sample.metric) {
        bufferSeriesValue(buffer.samples, sample.timestamp, sample);
      }
    }
    pendingMeasurementSamples.current.push(sample);
    if (measurementFlushTimer.current === null) {
      measurementFlushTimer.current = window.setTimeout(flushMeasurements, 16);
    }
  }, [flushMeasurements]);

  const selectHouse = useCallback(async (houseId: string) => {
    activeHouseId.current = houseId;
    if (!apiAvailable.current) return;
    try { await loadHouseData(houseId); } catch { /* Keep the previous snapshot during transient failures. */ }
  }, [loadHouseData]);

  const importHistoricalMeasurements = useCallback(async (
    houseId: string,
    samples: MeasurementSample[],
    onProgress?: (completed: number, total: number) => void,
  ) => {
    if (!apiAvailable.current) throw new Error("Historical import requires a connection to the Stuga server.");
    const result = await api.importHistoricalMeasurements(samples, onProgress);
    await loadHouseData(houseId);
    return result;
  }, [loadHouseData]);

  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true) => {
    const seriesKey = seriesStateKey(sensorId, metric);
    const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
    seriesLoadVersions.current.set(seriesKey, requestVersion);
    const isCurrentRequest = () => seriesLoadVersions.current.get(seriesKey) === requestVersion;
    const to = new Date();
    const from = new Date(to.getTime() - durationHours(range) * 3600000);
    const requestedFrom = from.toISOString();
    const requestedTo = to.toISOString();
    const limit = seriesLimit(range);
    setSeriesStates((current) => {
      const previous = current[seriesKey];
      return {
        ...current,
        [seriesKey]: {
          status: "loading",
          error: null,
          forecastError: previous?.forecastError ?? null,
          requestedFrom,
          requestedTo,
          loadedFrom: previous?.loadedFrom ?? null,
          loadedTo: previous?.loadedTo ?? null,
          partial: previous?.partial ?? false,
        },
      };
    });
    const fail = (error: unknown) => {
      if (!isCurrentRequest()) return;
      setSeriesStates((current) => ({
        ...current,
        [seriesKey]: {
          ...(current[seriesKey] ?? {
            forecastError: null, loadedFrom: null, loadedTo: null, partial: false,
          }),
          status: "error",
          error: errorMessage(error, "History data is temporarily unavailable"),
          requestedFrom,
          requestedTo,
        },
      }));
    };
    if (!apiAvailable.current) {
      fail(new Error("History data is unavailable while the service is offline"));
      return;
    }
    const liveTelemetry: BufferedSeriesTelemetry = {
      sensorId,
      metric,
      samples: new Map(),
      readings: new Map(),
    };
    for (const buffer of activeSeriesTelemetryBuffers.current) {
      if (buffer.sensorId === sensorId && buffer.metric === metric) {
        activeSeriesTelemetryBuffers.current.delete(buffer);
      }
    }
    activeSeriesTelemetryBuffers.current.add(liveTelemetry);
    try {
      let loaded: Awaited<ReturnType<typeof canonicalSeries>> | null = null;
      let canonicalError: unknown = null;
      try {
        loaded = await canonicalSeries(sensorId, metric, range, requestedFrom, requestedTo, forecastSupported);
      } catch (error) {
        canonicalError = error;
        // The v1 projection below remains available during a staggered upgrade.
      }
      if (!isCurrentRequest()) return;
      if (loaded) {
        const samples = mergeMeasurementSeries(loaded.samples, liveTelemetry.samples.values(), limit);
        seriesCommitSequence.current += 1;
        seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: false });
        setState((current) => {
          const next = {
            ...current,
            measurementHistory: {
              ...current.measurementHistory,
              [sensorId]: { ...current.measurementHistory[sensorId], [metric]: samples },
            },
          };
          return loaded.forecast.value === null ? next : {
            ...next,
            measurementForecasts: {
              ...current.measurementForecasts,
              [sensorId]: { ...current.measurementForecasts[sensorId], [metric]: loaded.forecast.value },
            },
          };
        });
        const loadedFrom = samples[0]?.timestamp ?? null;
        const loadedTo = samples.at(-1)?.timestamp ?? null;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            status: "ready",
            error: null,
            forecastError: loaded.forecast.error,
            requestedFrom,
            requestedTo,
            loadedFrom,
            loadedTo,
            partial: loaded.history.truncated
              || (loadedFrom !== null && Date.parse(loadedFrom) > from.getTime() + (loaded.history.bucketSeconds ?? 0) * 1_000),
          },
        }));
        return;
      }
      if (metric !== "temperature" && metric !== "humidity") {
        fail(canonicalError);
        return;
      }
      let fallback: Awaited<ReturnType<typeof legacySeries>>;
      try {
        fallback = await legacySeries(sensorId, range, requestedFrom, requestedTo, forecastSupported);
      } catch (error) {
        fail(error ?? canonicalError);
        return;
      }
      if (!isCurrentRequest()) return;
      const history = mergeLegacySeries(fallback.history, liveTelemetry.readings.values(), limit);
      seriesCommitSequence.current += 1;
      seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: true });
      setState((current) => {
        const metricSamples = mergeMeasurementSeries(
          metricHistorySamples(history, current.measurementDefinitions, metric),
          liveTelemetry.samples.values(),
          limit,
        );
        const next = {
          ...current,
          history: { ...current.history, [sensorId]: history },
          measurementHistory: {
            ...current.measurementHistory,
            [sensorId]: { ...current.measurementHistory[sensorId], [metric]: metricSamples },
          },
        };
        if (fallback.forecasts.value === null) return next;
        return {
          ...next,
          forecasts: { ...current.forecasts, [sensorId]: fallback.forecasts.value },
          measurementForecasts: {
            ...current.measurementForecasts,
            [sensorId]: {
              ...current.measurementForecasts[sensorId],
              [metric]: metricForecastSamples(fallback.forecasts.value, current.measurementDefinitions, metric),
            },
          },
        };
      });
      const loadedFrom = history[0]?.timestamp ?? null;
      const loadedTo = history.at(-1)?.timestamp ?? null;
      setSeriesStates((current) => ({
        ...current,
        [seriesKey]: {
          status: "ready",
          error: null,
          forecastError: fallback.forecasts.error,
          requestedFrom,
          requestedTo,
          loadedFrom,
          loadedTo,
          partial: history.length >= limit && loadedFrom !== null && Date.parse(loadedFrom) > from.getTime(),
        },
      }));
    } finally {
      activeSeriesTelemetryBuffers.current.delete(liveTelemetry);
    }
  }, []);

  const createSensor = useCallback(async (input: CreateSensorInput): Promise<Sensor> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not saved.");
    const saved = await api.createSensor(input);
    recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
    setState((current) => ({
      ...current,
      sensors: [...current.sensors.filter((sensor) => sensor.id !== saved.id), saved],
    }));
    if (saved.tpLinkDeviceId) settleInBackground(refreshTpLinkDevices());
    return saved;
  }, [recordHouseMutation, refreshTpLinkDevices]);

  const updateSensor = useCallback(async (sensorId: string, patch: SensorPatch): Promise<Sensor> => {
    await sensorMoveQueues.current.get(sensorId)?.catch(() => undefined);
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not updated.");
    const previousHouseId = stateRef.current.sensors.find((sensor) => sensor.id === sensorId)?.houseId;
    const saved = await api.updateSensor(sensorId, patch);
    if (previousHouseId && previousHouseId !== saved.houseId) {
      recordHouseMutation({ resource: "sensor", action: "delete", houseId: previousHouseId, id: sensorId });
    }
    recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
    persistedSensorPoints.current.set(sensorId, { x: saved.x, y: saved.y });
    setState((current) => ({
      ...current,
      sensors: [...current.sensors.filter((sensor) => sensor.id !== sensorId), saved],
    }));
    if (Object.hasOwn(patch, "tpLinkDeviceId")) settleInBackground(refreshTpLinkDevices());
    return saved;
  }, [recordHouseMutation, refreshTpLinkDevices]);

  const deleteSensor = useCallback(async (sensorId: string): Promise<void> => {
    await sensorMoveQueues.current.get(sensorId)?.catch(() => undefined);
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not deleted.");
    const houseId = stateRef.current.sensors.find((sensor) => sensor.id === sensorId)?.houseId;
    const detachedObservations = stateRef.current.observations
      .filter((observation) => observation.sensorId === sensorId)
      .map((observation) => ({ ...observation, sensorId: null }));
    const removedStaticParameters = stateRef.current.staticParameters.filter((parameter) => (
      parameter.scopeType === "sensor" && parameter.scopeId === sensorId
    ));
    await api.deleteSensor(sensorId);
    if (houseId) recordHouseMutation({ resource: "sensor", action: "delete", houseId, id: sensorId });
    for (const observation of detachedObservations) {
      recordHouseMutation({ resource: "observation", action: "upsert", houseId: observation.houseId, value: observation });
    }
    for (const parameter of removedStaticParameters) {
      recordHouseMutation({ resource: "static", action: "delete", houseId: parameter.houseId, id: parameter.id });
    }
    pendingMeasurementSamples.current = pendingMeasurementSamples.current
      .filter((sample) => sample.sensorId !== sensorId);
    for (const buffer of activeTelemetryLoadBuffers.current) {
      for (const [key, event] of buffer) {
        if (event.data.sensorId === sensorId) buffer.delete(key);
      }
    }
    sensorMoveQueues.current.delete(sensorId);
    sensorMoveVersions.current.delete(sensorId);
    persistedSensorPoints.current.delete(sensorId);
    for (const key of seriesLoadVersions.current.keys()) {
      if (key.startsWith(`${sensorId}\u0000`)) seriesLoadVersions.current.delete(key);
    }
    for (const key of seriesCommitVersions.current.keys()) {
      if (key.startsWith(`${sensorId}\u0000`)) seriesCommitVersions.current.delete(key);
    }
    setState((current) => {
      const removedSensorIds = new Set([sensorId]);
      return {
        ...current,
        sensors: current.sensors.filter((sensor) => sensor.id !== sensorId),
        readings: withoutSensorIds(current.readings, removedSensorIds),
        history: withoutSensorIds(current.history, removedSensorIds),
        forecasts: withoutSensorIds(current.forecasts, removedSensorIds),
        latestMeasurements: withoutSensorIds(current.latestMeasurements, removedSensorIds),
        measurementHistory: withoutSensorIds(current.measurementHistory, removedSensorIds),
        measurementForecasts: withoutSensorIds(current.measurementForecasts, removedSensorIds),
        alertRules: current.alertRules.filter((rule) => rule.sensorId !== sensorId),
        alerts: current.alerts.filter((alert) => alert.sensorId !== sensorId),
        observations: current.observations.map((observation) => observation.sensorId === sensorId
          ? { ...observation, sensorId: null }
          : observation),
        staticParameters: current.staticParameters.filter((parameter) => !(
          parameter.scopeType === "sensor" && parameter.scopeId === sensorId
        )),
      };
    });
    settleInBackground(refreshTpLinkDevices());
  }, [recordHouseMutation, refreshTpLinkDevices]);

  const moveSensor = useCallback((sensorId: string, point: Point) => {
    if (!apiAvailable.current) return;
    const currentSensor = stateRef.current.sensors.find((sensor) => sensor.id === sensorId);
    if (!currentSensor) return;
    if (!persistedSensorPoints.current.has(sensorId)) {
      persistedSensorPoints.current.set(sensorId, { x: currentSensor.x, y: currentSensor.y });
    }
    setState((current) => ({
      ...current,
      sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...point } : sensor),
    }));
    const version = (sensorMoveVersions.current.get(sensorId) ?? 0) + 1;
    sensorMoveVersions.current.set(sensorId, version);
    const previous = sensorMoveQueues.current.get(sensorId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      try {
        const saved = await api.updateSensor(sensorId, point);
        if (currentSensor.houseId !== saved.houseId) {
          recordHouseMutation({ resource: "sensor", action: "delete", houseId: currentSensor.houseId, id: sensorId });
        }
        recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
        persistedSensorPoints.current.set(sensorId, { x: saved.x, y: saved.y });
        if (sensorMoveVersions.current.get(sensorId) !== version) return;
        setState((current) => ({
          ...current,
          sensors: [...current.sensors.filter((sensor) => sensor.id !== sensorId), saved],
        }));
      } catch (error) {
        if (sensorMoveVersions.current.get(sensorId) === version) {
          const persisted = persistedSensorPoints.current.get(sensorId);
          if (persisted) {
            setState((current) => ({
              ...current,
              sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...persisted } : sensor),
            }));
          }
        }
        throw error;
      }
    });
    sensorMoveQueues.current.set(sensorId, queued);
    settleInBackground(queued.catch(() => undefined).finally(() => {
      if (sensorMoveQueues.current.get(sensorId) === queued) sensorMoveQueues.current.delete(sensorId);
    }));
  }, [recordHouseMutation]);

  const ensurePropertyWrite = useCallback(() => {
    if (stateRef.current.session.readOnly) throw new Error("This guest account is read-only.");
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not saved.");
  }, []);

  const refreshMovedPropertyContext = useCallback(async (includeEquipment: boolean): Promise<void> => {
    const requests: Promise<void>[] = [
      api.propertyNotes().then((propertyNotes) => {
        setState((current) => ({ ...current, propertyNotes }));
      }),
      api.maintenanceTasks().then((maintenanceTasks) => {
        setState((current) => ({ ...current, maintenanceTasks }));
      }),
    ];
    if (includeEquipment) {
      requests.push(api.areaEquipment().then((areaEquipment) => {
        setState((current) => ({ ...current, areaEquipment }));
      }));
    }
    await Promise.all(requests);
  }, []);

  const createProperty = useCallback(async (input: PropertyCreateInput): Promise<Property> => {
    ensurePropertyWrite();
    const saved = await api.createProperty(input);
    setState((current) => ({ ...current, properties: [...current.properties.filter((item) => item.id !== saved.id), saved] }));
    setBootstrapStatus("ready");
    return saved;
  }, [ensurePropertyWrite]);

  const updateProperty = useCallback(async (id: string, patch: PropertyPatch): Promise<Property> => {
    ensurePropertyWrite();
    const saved = await api.updateProperty(id, patch);
    setState((current) => ({ ...current, properties: current.properties.map((item) => item.id === id ? saved : item) }));
    return saved;
  }, [ensurePropertyWrite]);

  const deleteProperty = useCallback(async (id: string): Promise<void> => {
    ensurePropertyWrite();
    await api.deleteProperty(id);
    setState((current) => ({
      ...current,
      properties: current.properties.filter((item) => item.id !== id),
      propertyAreas: current.propertyAreas.filter((item) => item.propertyId !== id),
      areaEquipment: current.areaEquipment.filter((item) => item.propertyId !== id),
      propertyNotes: current.propertyNotes.filter((item) => item.propertyId !== id),
    }));
  }, [ensurePropertyWrite]);

  const createPropertyArea = useCallback(async (input: PropertyAreaInput): Promise<PropertyArea> => {
    ensurePropertyWrite();
    const saved = await api.createPropertyArea(input);
    setState((current) => ({ ...current, propertyAreas: [...current.propertyAreas.filter((item) => item.id !== saved.id), saved] }));
    return saved;
  }, [ensurePropertyWrite]);

  const updatePropertyArea = useCallback(async (id: string, patch: PropertyAreaPatch): Promise<PropertyArea> => {
    ensurePropertyWrite();
    const previousPropertyId = stateRef.current.propertyAreas.find((item) => item.id === id)?.propertyId;
    const saved = await api.updatePropertyArea(id, patch);
    setState((current) => {
      const movedEquipmentIds = new Set(current.areaEquipment.filter((item) => item.areaId === id).map((item) => item.id));
      const moved = current.propertyAreas.find((item) => item.id === id)?.propertyId !== saved.propertyId;
      return {
        ...current,
        propertyAreas: current.propertyAreas.map((item) => item.id === id ? saved : item),
        areaEquipment: moved
          ? current.areaEquipment.map((item) => item.areaId === id ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt } : item)
          : current.areaEquipment,
        propertyNotes: moved
          ? current.propertyNotes.map((item) => item.areaId === id || (item.equipmentId && movedEquipmentIds.has(item.equipmentId))
            ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
            : item)
          : current.propertyNotes,
        maintenanceTasks: moved
          ? current.maintenanceTasks.map((item) => item.areaId === id || (item.equipmentId && movedEquipmentIds.has(item.equipmentId))
            ? {
              ...item,
              propertyId: saved.propertyId,
              ...(item.houseId && !current.houses.some((house) => house.id === item.houseId && house.propertyId === saved.propertyId)
                ? { houseId: null, floorId: null }
                : {}),
              revision: item.revision + 1,
              updatedAt: saved.updatedAt,
            }
            : item)
          : current.maintenanceTasks,
      };
    });
    if (previousPropertyId !== undefined && previousPropertyId !== saved.propertyId) {
      settleInBackground(refreshMovedPropertyContext(true));
    }
    return saved;
  }, [ensurePropertyWrite, refreshMovedPropertyContext]);

  const deletePropertyArea = useCallback(async (id: string): Promise<void> => {
    ensurePropertyWrite();
    await api.deletePropertyArea(id);
    setState((current) => ({
      ...current,
      propertyAreas: current.propertyAreas.filter((item) => item.id !== id),
      areaEquipment: current.areaEquipment.filter((item) => item.areaId !== id),
      propertyNotes: current.propertyNotes.filter((item) => item.areaId !== id),
      maintenanceTasks: current.maintenanceTasks.map((item) => item.areaId === id ? { ...item, areaId: null, equipmentId: null } : item),
    }));
  }, [ensurePropertyWrite]);

  const createAreaEquipment = useCallback(async (input: AreaEquipmentInput): Promise<AreaEquipment> => {
    ensurePropertyWrite();
    const saved = await api.createAreaEquipment(input);
    setState((current) => ({ ...current, areaEquipment: [...current.areaEquipment.filter((item) => item.id !== saved.id), saved] }));
    return saved;
  }, [ensurePropertyWrite]);

  const updateAreaEquipment = useCallback(async (id: string, patch: AreaEquipmentPatch): Promise<AreaEquipment> => {
    ensurePropertyWrite();
    const previous = stateRef.current.areaEquipment.find((item) => item.id === id);
    const saved = await api.updateAreaEquipment(id, patch);
    setState((current) => {
      const previous = current.areaEquipment.find((item) => item.id === id);
      const moved = previous?.propertyId !== saved.propertyId || previous?.areaId !== saved.areaId;
      return {
        ...current,
        areaEquipment: current.areaEquipment.map((item) => item.id === id ? saved : item),
        propertyNotes: moved
          ? current.propertyNotes.map((item) => item.equipmentId === id
            ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
            : item)
          : current.propertyNotes,
        maintenanceTasks: moved
          ? current.maintenanceTasks.map((item) => item.equipmentId === id
            ? {
              ...item,
              propertyId: saved.propertyId,
              areaId: saved.areaId,
              ...(item.houseId && !current.houses.some((house) => house.id === item.houseId && house.propertyId === saved.propertyId)
                ? { houseId: null, floorId: null }
                : {}),
              revision: item.revision + 1,
              updatedAt: saved.updatedAt,
            }
            : item)
          : current.maintenanceTasks,
      };
    });
    if (previous && (previous.propertyId !== saved.propertyId || previous.areaId !== saved.areaId)) {
      settleInBackground(refreshMovedPropertyContext(true));
    }
    return saved;
  }, [ensurePropertyWrite, refreshMovedPropertyContext]);

  const deleteAreaEquipment = useCallback(async (id: string): Promise<void> => {
    ensurePropertyWrite();
    await api.deleteAreaEquipment(id);
    setState((current) => ({
      ...current,
      areaEquipment: current.areaEquipment.filter((item) => item.id !== id),
      propertyNotes: current.propertyNotes.filter((item) => item.equipmentId !== id),
      maintenanceTasks: current.maintenanceTasks.map((item) => item.equipmentId === id ? { ...item, equipmentId: null } : item),
    }));
  }, [ensurePropertyWrite]);

  const createPropertyNote = useCallback(async (input: PropertyNoteInput): Promise<PropertyNote> => {
    ensurePropertyWrite();
    const saved = await api.createPropertyNote(input);
    setState((current) => ({ ...current, propertyNotes: [...current.propertyNotes.filter((item) => item.id !== saved.id), saved] }));
    return saved;
  }, [ensurePropertyWrite]);

  const updatePropertyNote = useCallback(async (id: string, patch: PropertyNotePatch): Promise<PropertyNote> => {
    ensurePropertyWrite();
    const saved = await api.updatePropertyNote(id, patch);
    setState((current) => ({ ...current, propertyNotes: current.propertyNotes.map((item) => item.id === id ? saved : item) }));
    return saved;
  }, [ensurePropertyWrite]);

  const deletePropertyNote = useCallback(async (id: string): Promise<void> => {
    ensurePropertyWrite();
    await api.deletePropertyNote(id);
    setState((current) => ({ ...current, propertyNotes: current.propertyNotes.filter((item) => item.id !== id) }));
  }, [ensurePropertyWrite]);

  const setHouseGeoreference = useCallback(async (houseId: string, patch: HouseGeoreferencePatch) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The location was not saved.");
    const saved = await api.updateHouseGeoreference(houseId, patch);
    recordInventoryMutation({ action: "upsert", value: saved });
    globalFieldVersions.current.integration += 1;
    setState((current) => {
      const nextHouses = [...current.houses.filter((house) => house.id !== houseId), saved];
      return {
        ...current,
        houses: nextHouses,
        integration: {
          ...current.integration,
          weather: {
            ...current.integration.weather,
            configuredHouses: nextHouses.filter((house) => Boolean(house.location)).length,
          },
        },
      };
    });
  }, [recordInventoryMutation]);

  const updateFloor = useCallback((houseId: string, floor: Floor) => {
    setState((current) => replaceFloor(current, houseId, floor));
  }, []);

  const updateHouseDraft = useCallback((houseId: string, patch: HousePatch) => {
    setState((current) => {
      const houses = current.houses.map((house) => house.id === houseId
        ? { ...house, ...patch, updatedAt: new Date().toISOString() } as House
        : house);
      const floors = houses.find((house) => house.id === houseId)?.floors ?? [];
      return {
        ...current,
        houses,
        sensors: synchronizeSensorRoomLabels(current.sensors, houseId, floors),
      };
    });
  }, []);

  /** Persist an atomic house metadata update, including inferred location and timezone defaults. */
  const updateHouse = useCallback(async (houseId: string, patch: HousePatch): Promise<House> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not saved.");
    const previousPropertyId = stateRef.current.houses.find((house) => house.id === houseId)?.propertyId;
    const saved = await api.updateHouse(houseId, patch);
    recordInventoryMutation({ action: "upsert", value: saved });
    globalFieldVersions.current.integration += 1;
    setState((current) => {
      const previous = current.houses.find((house) => house.id === houseId);
      const moved = previous?.propertyId !== saved.propertyId;
      const nextHouses = [...current.houses.filter((house) => house.id !== houseId), saved];
      return {
        ...current,
        houses: nextHouses,
        sensors: synchronizeSensorRoomLabels(current.sensors, houseId, saved.floors),
        propertyNotes: moved
          ? current.propertyNotes.map((item) => item.houseId === houseId
            ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
            : item)
          : current.propertyNotes,
        maintenanceTasks: moved
          ? current.maintenanceTasks.map((item) => item.houseId === houseId
            ? {
              ...item,
              propertyId: saved.propertyId,
              areaId: item.areaId && current.propertyAreas.some((area) => area.id === item.areaId && area.propertyId === saved.propertyId)
                ? item.areaId : null,
              equipmentId: item.equipmentId && current.areaEquipment.some((equipment) => equipment.id === item.equipmentId && equipment.propertyId === saved.propertyId)
                ? item.equipmentId : null,
              revision: item.revision + 1,
              updatedAt: saved.updatedAt,
            }
            : item)
          : current.maintenanceTasks,
        integration: {
          ...current.integration,
          weather: {
            ...current.integration.weather,
            configuredHouses: nextHouses.filter((house) => Boolean(house.location)).length,
          },
        },
      };
    });
    if (previousPropertyId !== undefined && previousPropertyId !== saved.propertyId) {
      settleInBackground(refreshMovedPropertyContext(false));
    }
    return saved;
  }, [recordInventoryMutation, refreshMovedPropertyContext]);

  const createHouse = useCallback(async (input: CreateHouseInput): Promise<House> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not created.");
    const saved = await api.createHouse(input);
    recordInventoryMutation({ action: "upsert", value: saved });
    setState((current) => ({
      ...current,
      houses: [...current.houses.filter((house) => house.id !== saved.id), saved],
    }));
    return saved;
  }, [recordInventoryMutation]);

  const deleteHouse = useCallback(async (houseId: string): Promise<void> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not deleted.");
    await api.deleteHouse(houseId);
    recordInventoryMutation({ action: "delete", id: houseId });
    const removedSensorIds = new Set(stateRef.current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id));
    houseTelemetryVersions.current.set(houseId, (houseTelemetryVersions.current.get(houseId) ?? 0) + 1);
    if (activeHouseId.current === houseId) activeHouseId.current = null;
    pendingMeasurementSamples.current = pendingMeasurementSamples.current
      .filter((sample) => !removedSensorIds.has(sample.sensorId));
    for (const buffer of activeTelemetryLoadBuffers.current) {
      for (const [key, event] of buffer) {
        if (removedSensorIds.has(event.data.sensorId)) buffer.delete(key);
      }
    }
    for (const key of seriesLoadVersions.current.keys()) {
      const separator = key.indexOf("\u0000");
      if (separator >= 0 && removedSensorIds.has(key.slice(0, separator))) seriesLoadVersions.current.delete(key);
    }
    for (const key of seriesCommitVersions.current.keys()) {
      const separator = key.indexOf("\u0000");
      if (separator >= 0 && removedSensorIds.has(key.slice(0, separator))) seriesCommitVersions.current.delete(key);
    }
    setState((current) => ({
      ...current,
      houses: current.houses.filter((house) => house.id !== houseId),
      sensors: current.sensors.filter((sensor) => sensor.houseId !== houseId),
      observations: current.observations.filter((observation) => observation.houseId !== houseId),
      maintenanceTasks: current.maintenanceTasks.filter((task) => task.houseId !== houseId),
      staticParameters: current.staticParameters.filter((parameter) => parameter.houseId !== houseId),
      readings: withoutSensorIds(current.readings, removedSensorIds),
      history: withoutSensorIds(current.history, removedSensorIds),
      forecasts: withoutSensorIds(current.forecasts, removedSensorIds),
      latestMeasurements: withoutSensorIds(current.latestMeasurements, removedSensorIds),
      measurementHistory: withoutSensorIds(current.measurementHistory, removedSensorIds),
      measurementForecasts: withoutSensorIds(current.measurementForecasts, removedSensorIds),
    }));
  }, [recordInventoryMutation]);

  const saveLayout = useCallback(async (houseId: string, house: House) => {
    setSaveState("saving");
    updateHouseDraft(houseId, { name: house.name, timezone: house.timezone, floors: house.floors });
    try {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The layout was not saved.");
      const saved = await api.updateHouse(houseId, { name: house.name, timezone: house.timezone, floors: house.floors });
      recordInventoryMutation({ action: "upsert", value: saved });
      setState((current) => ({
        ...current,
        houses: [...current.houses.filter((item) => item.id !== houseId), saved],
        sensors: synchronizeSensorRoomLabels(current.sensors, houseId, saved.floors),
      }));
      setSaveState("saved");
      if (saveStateTimer.current !== null) window.clearTimeout(saveStateTimer.current);
      saveStateTimer.current = window.setTimeout(() => {
        saveStateTimer.current = null;
        if (!sessionLockedRef.current) setSaveState("idle");
      }, 1800);
    } catch (error) {
      setSaveState("error");
      throw error;
    }
  }, [recordInventoryMutation, updateHouseDraft]);

  const runScenario = useCallback(async (next: MockScenario["id"]) => {
    if (dataModeRef.current !== "demo") throw new Error("Scenarios are available only after demo mode is confirmed.");
    setScenario(next);
    if (apiAvailable.current) {
      try { await api.runScenario(next); } catch { /* Local simulation still runs when enabled. */ }
    }
  }, []);

  const createRule = useCallback(async (rule: Omit<AlertRule, "id">) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The rule was not saved.");
    const saved = await api.createAlertRule(rule);
    globalFieldVersions.current.alertRules += 1;
    setState((current) => ({ ...current, alertRules: [...current.alertRules, saved] }));
  }, []);

  const updateRule = useCallback(async (id: string, patch: AlertRulePatch) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The rule was not updated.");
    const saved = await api.updateAlertRule(id, patch);
    globalFieldVersions.current.alertRules += 1;
    setState((current) => ({
      ...current,
      alertRules: [...current.alertRules.filter((rule) => rule.id !== id), saved],
    }));
    return saved;
  }, []);

  const acknowledgeAlert = useCallback(async (id: string) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The alert was not acknowledged.");
    const saved = await api.acknowledgeAlert(id);
    globalFieldVersions.current.alerts += 1;
    setState((current) => ({ ...current, alerts: [saved, ...current.alerts.filter((alert) => alert.id !== id)] }));
  }, []);

  const createObservation = useCallback(async (observation: ManualObservationInput) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation was not saved.");
    const saved = await api.createObservation(observation);
    recordHouseMutation({ resource: "observation", action: "upsert", houseId: saved.houseId, value: saved });
    setState((current) => ({ ...current, observations: [...current.observations, saved] }));
    return saved;
  }, [recordHouseMutation]);

  const reloadObservation = useCallback(async (id: string) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation could not be reloaded.");
    const current = stateRef.current.observations.find((observation) => observation.id === id);
    if (!current) throw new Error("The observation is no longer available.");
    const concurrentMutations: HouseMutationBuffer = new Map();
    activeHouseMutationBuffers.current.add(concurrentMutations);
    try {
      const fresh = await api.observations(current.houseId);
      const merged = replayHouseMutations(current.houseId, {
        sensors: [], observations: fresh, maintenanceTasks: [], staticParameters: [],
      }, concurrentMutations).observations;
      activeHouseMutationBuffers.current.delete(concurrentMutations);
      recordHouseMutation({ resource: "observation", action: "replace", houseId: current.houseId, values: merged });
      setState((state) => ({
        ...state,
        observations: [...state.observations.filter((item) => item.houseId !== current.houseId), ...merged],
      }));
      const reloaded = merged.find((observation) => observation.id === id);
      if (!reloaded) throw new Error("The observation is no longer available.");
      return reloaded;
    } finally {
      activeHouseMutationBuffers.current.delete(concurrentMutations);
    }
  }, [recordHouseMutation]);

  const updateObservation = useCallback(async (id: string, patch: ManualObservationPatch) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation was not updated.");
    const previous = stateRef.current.observations.find((observation) => observation.id === id);
    if (!previous) throw new Error("The observation is no longer available.");
    const currentRevision = previous.revision ?? 1;
    if (currentRevision !== patch.baseRevision) throw new Error("The observation changed before this edit could be saved.");

    const { baseRevision, ...changes } = patch;
    const optimisticAt = new Date().toISOString();
    const lifecycleChanges: Partial<ManualObservation> = changes.status === "resolved"
      ? {
          status: "resolved",
          resolutionNote: changes.resolutionNote ?? previous.resolutionNote ?? null,
          resolvedAt: (previous.status ?? "open") === "resolved" ? previous.resolvedAt ?? optimisticAt : optimisticAt,
        }
      : changes.status === "open"
        ? { status: "open", resolutionNote: null, resolvedAt: null }
        : {};
    const optimistic: ManualObservation = {
      ...previous,
      ...changes,
      ...lifecycleChanges,
      revision: baseRevision + 1,
      updatedAt: optimisticAt,
    };
    const publishOptimistically = changes.status === undefined;
    if (publishOptimistically) {
      setState((current) => ({
        ...current,
        observations: current.observations.map((observation) => observation.id === id ? optimistic : observation),
      }));
    }

    try {
      const saved = await api.updateObservation(id, patch);
      recordHouseMutation({ resource: "observation", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({
        ...current,
        observations: [...current.observations.filter((observation) => observation.id !== id), saved],
      }));
      return saved;
    } catch (error) {
      if (publishOptimistically) {
        setState((current) => ({
          ...current,
          observations: current.observations.map((observation) => observation === optimistic ? previous : observation),
        }));
      }
      throw error;
    }
  }, [recordHouseMutation]);

  const observationRevisions = useCallback(async (id: string) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. Revision history could not be loaded.");
    return api.observationRevisions(id);
  }, []);

  const createMaintenanceTask = useCallback(async (input: MaintenanceTaskInput): Promise<MaintenanceTask> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not saved.");
    const saved = await api.createMaintenanceTask(input);
    recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
    setState((current) => ({ ...current, maintenanceTasks: [...current.maintenanceTasks, saved] }));
    return saved;
  }, [recordHouseMutation]);

  const reloadMaintenanceTask = useCallback(async (id: string): Promise<MaintenanceTask> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task could not be reloaded.");
    const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
    if (!current) throw new Error("The maintenance task is no longer available.");
    const concurrentMutations: HouseMutationBuffer = new Map();
    activeHouseMutationBuffers.current.add(concurrentMutations);
    try {
      let fresh: MaintenanceTask | undefined;
      try {
        fresh = await api.maintenanceTask(id);
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : null;
        if (status !== 404) throw error;
      }
      const reloaded = replayMaintenanceTaskMutation(
        id,
        fresh,
        concurrentMutations,
      );
      activeHouseMutationBuffers.current.delete(concurrentMutations);
      if (!reloaded) {
        recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
        setState((state) => ({
          ...state,
          maintenanceTasks: state.maintenanceTasks.filter((item) => item.id !== id),
        }));
        throw new Error("The maintenance task is no longer available.");
      }
      if (current.houseId !== reloaded.houseId) {
        recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
      }
      recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: reloaded.houseId, value: reloaded });
      setState((state) => ({
        ...state,
        maintenanceTasks: [...state.maintenanceTasks.filter((item) => item.id !== id), reloaded],
      }));
      return reloaded;
    } finally {
      activeHouseMutationBuffers.current.delete(concurrentMutations);
    }
  }, [recordHouseMutation]);

  const updateMaintenanceTask = useCallback(async (id: string, patch: MaintenanceTaskPatch): Promise<MaintenanceTask> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not updated.");
    const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
    if (!current) throw new Error("The maintenance task is no longer available.");
    if (current.revision !== patch.baseRevision) throw new Error("The maintenance task changed before this edit could be saved.");
    const saved = await api.updateMaintenanceTask(id, patch);
    if (current.houseId !== saved.houseId) {
      recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
    }
    recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
    setState((state) => ({
      ...state,
      maintenanceTasks: [...state.maintenanceTasks.filter((task) => task.id !== id), saved],
    }));
    return saved;
  }, [recordHouseMutation]);

  const maintenanceTaskRevisions = useCallback(async (id: string) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. Revision history could not be loaded.");
    return api.maintenanceTaskRevisions(id);
  }, []);

  const deleteMaintenanceTask = useCallback(async (id: string): Promise<void> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not deleted.");
    const task = stateRef.current.maintenanceTasks.find((item) => item.id === id);
    await api.deleteMaintenanceTask(id);
    if (task) recordHouseMutation({ resource: "maintenance", action: "delete", houseId: task.houseId, id });
    setState((current) => ({ ...current, maintenanceTasks: current.maintenanceTasks.filter((task) => task.id !== id) }));
  }, [recordHouseMutation]);

  const createStaticParameter = useCallback(async (parameter: Omit<StaticParameter, "id">) => {
    const matchesScopeAndKey = (item: StaticParameter) => item.houseId === parameter.houseId
      && item.scopeType === parameter.scopeType && item.scopeId === parameter.scopeId && item.key === parameter.key;
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The parameter was not saved.");
    const saved = await api.createStaticParameter(parameter);
    recordHouseMutation({ resource: "static", action: "upsert", houseId: saved.houseId, value: saved });
    setState((current) => ({ ...current, staticParameters: [...current.staticParameters.filter((item) => !matchesScopeAndKey(item)), saved] }));
    return saved;
  }, [recordHouseMutation]);

  return {
    state, loading, bootstrapStatus, bootstrapError, retryBootstrap, endSession, dataMode, connection, pollingFallback,
    resourceErrors, seriesStates, scenario, saveState,
    tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, refreshTpLinkDevices,
    disconnectHomeAssistant, disconnectTpLink, moveHomeAssistant, moveTpLink,
    applyIntegrationStatus,
    selectHouse, loadSeries, importHistoricalMeasurements,
    createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea,
    createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote,
    createHouse, deleteHouse, createSensor, updateSensor, deleteSensor, moveSensor, updateFloor, updateHouse, updateHouseDraft, setHouseGeoreference,
    saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions,
    createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter,
  };
}
