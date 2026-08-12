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
import { MAX_SERIES_SAMPLES, withoutDemoTelemetry } from "./telemetryState";
import type { HouseMutationBuffer, LoadedTelemetryState } from "./telemetryState";

export function preserveMutatedSensorTelemetry(
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

function mergeOrderedSeries<T extends { timestamp: string }>(
  loaded: T[],
  live: Iterable<T>,
  limit: number,
): T[] {
  let merged = [...loaded];
  for (const item of live) {
    const last = merged.at(-1);
    const itemTime = Date.parse(item.timestamp);
    const lastTime = last ? Date.parse(last.timestamp) : Number.NEGATIVE_INFINITY;
    if (!last || Number.isFinite(itemTime) && Number.isFinite(lastTime) && itemTime >= lastTime) {
      if (last?.timestamp === item.timestamp) merged[merged.length - 1] = item;
      else merged.push(item);
      continue;
    }
    const byTimestamp = new Map(merged.map((current) => [current.timestamp, current]));
    byTimestamp.set(item.timestamp, item);
    merged = [...byTimestamp.values()]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  }
  return merged.slice(-limit);
}

export function mergeMeasurementSeries(
  loaded: MeasurementSample[],
  live: Iterable<MeasurementSample>,
  limit: number,
): MeasurementSample[] {
  return mergeOrderedSeries(loaded, live, limit);
}

export function replaceMeasurementSeriesWindow(
  current: MeasurementSample[],
  refreshed: Iterable<MeasurementSample>,
  live: Iterable<MeasurementSample>,
  from: string,
  to: string,
  responseTruncated = false,
): MeasurementSample[] {
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  const refreshedSamples = [...refreshed];
  const earliestRefreshedTime = refreshedSamples.reduce((earliest, sample) => {
    const sampleTime = Date.parse(sample.timestamp);
    return Number.isFinite(sampleTime) ? Math.min(earliest, sampleTime) : earliest;
  }, Number.POSITIVE_INFINITY);
  // A truncated history response contains the newest suffix. Its missing
  // prefix is not authoritative, so keep any already cached samples there.
  const replacementFromTime = responseTruncated
    ? Math.max(fromTime, earliestRefreshedTime)
    : fromTime;
  const retained = current.filter((sample) => {
    const sampleTime = Date.parse(sample.timestamp);
    return !Number.isFinite(sampleTime) || sampleTime < replacementFromTime || sampleTime > toTime;
  });
  const withRefreshedWindow = mergeOrderedSeries(retained, refreshedSamples, MAX_SERIES_SAMPLES);
  return mergeOrderedSeries(withRefreshedWindow, live, MAX_SERIES_SAMPLES);
}

export function mergeLegacySeries(loaded: Reading[], live: Iterable<Reading>, limit: number): Reading[] {
  return mergeOrderedSeries(loaded, live, limit);
}

export function replaceLegacySeriesWindow(
  current: Reading[],
  refreshed: Iterable<Reading>,
  live: Iterable<Reading>,
  from: string,
  to: string,
): Reading[] {
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  const retained = current.filter((reading) => {
    const readingTime = Date.parse(reading.timestamp);
    return !Number.isFinite(readingTime) || readingTime < fromTime || readingTime > toTime;
  });
  const withRefreshedWindow = mergeOrderedSeries(retained, refreshed, MAX_SERIES_SAMPLES);
  return mergeOrderedSeries(withRefreshedWindow, live, MAX_SERIES_SAMPLES);
}

export const unauthenticatedSession: AppSession = {
  authenticated: false,
  principal: { type: "unauthenticated", email: null },
  tenant: { id: "local", name: "Local Stugu", role: "guest" },
  availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
  readOnly: true,
  grants: [],
};

export function blankState(session: AppSession = unauthenticatedSession): ClimateState {
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

export function apiStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}
