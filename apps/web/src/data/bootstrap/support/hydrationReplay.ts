import type {
  Floor,
  ManualObservation,
  MaintenanceTask,
  MeasurementSample,
  Sensor,
  StaticParameter,
} from "@climate-twin/contracts";
import {
  api,
} from "../../../api";
import { type ClimateState, type TimeRange } from "../../../domain";
import { appendHistory, legacyForecastSamples, readingSamples, upsertLatest } from "../../../measurements";
import { MAX_SERIES_SAMPLES, optionalForecast, seriesLimit, withoutSensorIds } from "./telemetryState";
import type { BufferedHouseMutation, BufferedLiveTelemetry, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit } from "./telemetryState";
import { mergeLegacySeries, mergeMeasurementSeries } from "./bootstrapState";

export async function legacySeries(
  sensorId: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
  signal?: AbortSignal,
) {
  const [history, forecasts] = await Promise.all([
    api.readings(sensorId, from, to, seriesLimit(range), signal),
    forecastSupported
      ? optionalForecast(api.forecast(sensorId, 360, signal))
      : Promise.resolve({ value: [], error: null }),
  ]);
  return { history, forecasts };
}

export function metricHistorySamples(
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

export function metricForecastSamples(
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

export function replaceFloor(current: ClimateState, houseId: string, floor: Floor): ClimateState {
  const houses = current.houses.map((house) => {
    if (house.id !== houseId) return house;
    const footprintFloorId = house.mapPlacement?.footprintFloorId ?? house.floors[0]?.id;
    const mapPlacement = house.mapPlacement && footprintFloorId === floor.id && floor.metersPerPlanUnit
      ? { ...house.mapPlacement, metersPerPlanUnit: floor.metersPerPlanUnit }
      : house.mapPlacement;
    return {
      ...house,
      floors: house.floors.map((item) => item.id === floor.id ? floor : item),
      ...(mapPlacement ? { mapPlacement } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  const floors = houses.find((house) => house.id === houseId)?.floors ?? [];
  return { ...current, houses, sensors: synchronizeSensorRoomLabels(current.sensors, houseId, floors) };
}

export function synchronizeSensorRoomLabels(
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

export function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export const PORTFOLIO_LOAD_CONCURRENCY = 3;

export async function loadPortfolioInBackground(
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

export function replayBufferedLiveTelemetry(
  loaded: LoadedTelemetryState,
  buffered: Iterable<BufferedLiveTelemetry>,
  loadedSensorIds: Set<string>,
  definitions: ClimateState["measurementDefinitions"],
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
    const samples = readingSamples(reading, definitions);
    latestMeasurements = upsertLatest(latestMeasurements, samples);
    measurementHistory = appendHistory(measurementHistory, samples);
  }
  return { ...loaded, latestMeasurements, measurementHistory, readings, history };
}

export function replayHouseMutations<T extends {
  sensors: Sensor[];
  observations: ManualObservation[];
  maintenanceTasks: MaintenanceTask[];
  staticParameters: StaticParameter[];
}>(houseId: string | null, loaded: T, buffered: HouseMutationBuffer): T & { deletedSensorIds: Set<string> } {
  const replay: ReplayedHouseResources = {
    sensors: loaded.sensors,
    observations: loaded.observations,
    maintenanceTasks: loaded.maintenanceTasks,
    staticParameters: loaded.staticParameters,
    deletedSensorIds: new Set<string>(),
  };
  for (const mutation of buffered.values()) {
    if (mutation.houseId !== houseId) continue;
    if (mutation.resource === "sensor") replaySensorMutation(replay, mutation);
    else if (mutation.resource === "observation") replayObservationMutation(replay, mutation);
    else if (mutation.resource === "maintenance") replayMaintenanceMutation(replay, mutation);
    else replayStaticParameterMutation(replay, mutation);
  }
  return { ...loaded, ...replay };
}

interface ReplayedHouseResources {
  sensors: Sensor[];
  observations: ManualObservation[];
  maintenanceTasks: MaintenanceTask[];
  staticParameters: StaticParameter[];
  deletedSensorIds: Set<string>;
}

type MutationFor<Resource extends BufferedHouseMutation["resource"]> = Extract<BufferedHouseMutation, { resource: Resource }>;

// Deleting a sensor detaches its observations and drops its sensor-scoped parameters.
function replaySensorMutation(replay: ReplayedHouseResources, mutation: MutationFor<"sensor">): void {
  if (mutation.action === "delete") {
    replay.sensors = replay.sensors.filter((sensor) => sensor.id !== mutation.id);
    replay.observations = replay.observations.map((observation) => observation.sensorId === mutation.id
      ? { ...observation, sensorId: null }
      : observation);
    replay.staticParameters = replay.staticParameters.filter((parameter) => !(
      parameter.scopeType === "sensor" && parameter.scopeId === mutation.id
    ));
    replay.deletedSensorIds.add(mutation.id);
    return;
  }
  replay.sensors = [...replay.sensors.filter((sensor) => sensor.id !== mutation.value.id), mutation.value];
  replay.deletedSensorIds.delete(mutation.value.id);
}

function replayObservationMutation(replay: ReplayedHouseResources, mutation: MutationFor<"observation">): void {
  replay.observations = mutation.action === "replace"
    ? mutation.values
    : [...replay.observations.filter((item) => item.id !== mutation.value.id), mutation.value];
}

function replayMaintenanceMutation(replay: ReplayedHouseResources, mutation: MutationFor<"maintenance">): void {
  if (mutation.action === "replace") {
    replay.maintenanceTasks = mutation.values;
  } else if (mutation.action === "delete") {
    replay.maintenanceTasks = replay.maintenanceTasks.filter((item) => item.id !== mutation.id);
  } else {
    replay.maintenanceTasks = [...replay.maintenanceTasks.filter((item) => item.id !== mutation.value.id), mutation.value];
  }
}

// A static parameter is keyed by its scope and key, so an upsert replaces any value at that slot.
function replayStaticParameterMutation(replay: ReplayedHouseResources, mutation: MutationFor<"static">): void {
  if (mutation.action === "delete") {
    replay.staticParameters = replay.staticParameters.filter((item) => item.id !== mutation.id);
    return;
  }
  const value = mutation.value;
  replay.staticParameters = [
    ...replay.staticParameters.filter((item) => !(item.scopeType === value.scopeType
      && item.scopeId === value.scopeId && item.key === value.key)),
    value,
  ];
}

export function replayMaintenanceTaskMutation(
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

/** Keeps explicitly queried series across snapshot refreshes, including in-flight commits. */
export function preserveSeriesCommittedDuringLoad(
  loaded: LoadedTelemetryState,
  current: ClimateState,
  loadedSensorIds: Set<string>,
  commits: Map<string, SeriesCommit>,
): LoadedTelemetryState {
  let measurementHistory = loaded.measurementHistory;
  let measurementForecasts = loaded.measurementForecasts;
  let history = loaded.history;
  let forecasts = loaded.forecasts;
  for (const [seriesKey, commit] of commits) {
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
      const legacy = withCommittedLegacySeries(history, forecasts, current, sensorId);
      history = legacy.history;
      forecasts = legacy.forecasts;
    }
  }
  return { ...loaded, measurementHistory, measurementForecasts, history, forecasts };
}

function withCommittedLegacySeries(
  history: LoadedTelemetryState["history"],
  forecasts: LoadedTelemetryState["forecasts"],
  current: ClimateState,
  sensorId: string,
): Pick<LoadedTelemetryState, "history" | "forecasts"> {
  let nextHistory = history;
  let nextForecasts = forecasts;
  if (current.history[sensorId] !== undefined) {
    nextHistory = {
      ...history,
      [sensorId]: mergeLegacySeries(current.history[sensorId], history[sensorId] ?? [], MAX_SERIES_SAMPLES),
    };
  }
  if (current.forecasts[sensorId] !== undefined) nextForecasts = { ...forecasts, [sensorId]: current.forecasts[sensorId] };
  return { history: nextHistory, forecasts: nextForecasts };
}
