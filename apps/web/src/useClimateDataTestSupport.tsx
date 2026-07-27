import { act, renderHook, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AreaEquipment,
  House,
  IntegrationStatus,
  MaintenanceTask,
  ManualObservation,
  MeasurementForecastPoint,
  MeasurementSample,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
  TpLinkDiscoveredDevice,
  PropertyArea,
  PropertyNote,
} from "@climate-twin/contracts";

import { createDemoState, type ClimateState } from "./domain";

import { replaceLoadedHouseTelemetry, seriesStateKey, useClimateData, withoutDemoTelemetry } from "./useClimateData";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function twoHouseFixture() {
  const demo = createDemoState();
  const firstHouse = demo.houses[0]!;
  const secondHouse: House = {
    ...firstHouse,
    id: "house-lake",
    name: "Lake House",
    floors: firstHouse.floors.map((floor) => ({ ...floor, id: `lake-${floor.id}` })),
  };
  const firstSensor = demo.sensors[0]!;
  const secondSensor: Sensor = {
    ...firstSensor,
    id: "sensor-lake-living",
    houseId: secondHouse.id,
    floorId: secondHouse.floors[0]!.id,
    name: "Lake living room",
  };
  const firstSample = demo.latestMeasurements[firstSensor.id]!.temperature!;
  const secondSample: MeasurementSample = {
    ...firstSample,
    sensorId: secondSensor.id,
    value: 17.4,
  };
  const firstObservation = demo.observations[0]!;
  const secondObservation: ManualObservation = {
    ...firstObservation,
    id: "observation-lake",
    houseId: secondHouse.id,
    floorId: secondHouse.floors[0]!.id,
    note: "Lake house inspection",
  };
  return {
    demo,
    firstHouse,
    secondHouse,
    firstSensor,
    secondSensor,
    firstSample,
    secondSample,
    firstObservation,
    secondObservation,
  };
}
