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
  type CreateHouseInput,
  type CreateSensorInput,
  type HousePatch,
  type HouseGeoreferencePatch,
  type MeasurementHistoryPage,
  type SensorPatch,
} from "../../../api";
import { subscribeToAuthEpoch } from "../../../authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, timeRangeHours, type ClimateState, type TimeRange } from "../../../domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../../../measurements";
import { routeFromLocation } from "../../../routing";
import { publishHouseWeatherUpdate } from "../../../useHouseWeather";
import { MAX_SERIES_SAMPLES, optionalForecast, seriesLimit, withoutSensorIds } from "./telemetryState";
import type { BufferedLiveTelemetry, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit } from "./telemetryState";
import { mergeLegacySeries, mergeMeasurementSeries } from "./bootstrapState";

export async function legacySeries(
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
