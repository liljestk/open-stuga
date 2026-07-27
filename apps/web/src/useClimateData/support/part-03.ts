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
  type MeasurementHistoryPage,
  type SensorPatch,
} from "../../api";
import { subscribeToAuthEpoch } from "../../authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, timeRangeHours, type ClimateState, type TimeRange } from "../../domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../../measurements";
import { routeFromLocation } from "../../routing";
import { publishHouseWeatherUpdate } from "../../useHouseWeather";
import { MAX_SERIES_SAMPLES, withoutDemoTelemetry } from "./part-01";
import type { HouseMutationBuffer, LoadedTelemetryState } from "./part-01";

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

export function mergeMeasurementSeries(
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

export function mergeLegacySeries(loaded: Reading[], live: Iterable<Reading>, limit: number): Reading[] {
  const byTimestamp = new Map(loaded.map((reading) => [reading.timestamp, reading]));
  for (const reading of live) byTimestamp.set(reading.timestamp, reading);
  return [...byTimestamp.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-limit);
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
