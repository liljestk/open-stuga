import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaticParameter } from "@climate-twin/contracts";
import { createDemoState, type ClimateState } from "./domain";

const mocks = vi.hoisted(() => ({
  houses: vi.fn(),
  sensors: vi.fn(),
  snapshot: vi.fn(),
  alertRules: vi.fn(),
  alerts: vi.fn(),
  observations: vi.fn(),
  staticParameters: vi.fn(),
  integrations: vi.fn(),
  scenarios: vi.fn(),
  measurementDefinitions: vi.fn(),
  measurementSnapshot: vi.fn(),
  measurementHistory: vi.fn(),
  measurementForecast: vi.fn(),
  createStaticParameter: vi.fn(),
  subscribeToEvents: vi.fn(() => vi.fn()),
  subscribeToMeasurementEvents: vi.fn(() => vi.fn()),
}));

vi.mock("./api", () => ({
  api: {
    houses: mocks.houses,
    sensors: mocks.sensors,
    snapshot: mocks.snapshot,
    alertRules: mocks.alertRules,
    alerts: mocks.alerts,
    observations: mocks.observations,
    staticParameters: mocks.staticParameters,
    integrations: mocks.integrations,
    scenarios: mocks.scenarios,
    measurementDefinitions: mocks.measurementDefinitions,
    measurementSnapshot: mocks.measurementSnapshot,
    measurementHistory: mocks.measurementHistory,
    measurementForecast: mocks.measurementForecast,
    createStaticParameter: mocks.createStaticParameter,
  },
  subscribeToEvents: mocks.subscribeToEvents,
  subscribeToMeasurementEvents: mocks.subscribeToMeasurementEvents,
}));

import { replaceLoadedHouseTelemetry, useClimateData } from "./useClimateData";

describe("useClimateData static parameters", () => {
  beforeEach(() => {
    const demo = createDemoState();
    vi.clearAllMocks();
    mocks.subscribeToEvents.mockReturnValue(vi.fn());
    mocks.houses.mockResolvedValue(demo.houses);
    mocks.sensors.mockResolvedValue(demo.sensors);
    mocks.snapshot.mockResolvedValue([]);
    mocks.alertRules.mockResolvedValue(demo.alertRules);
    mocks.alerts.mockResolvedValue(demo.alerts);
    mocks.observations.mockResolvedValue(demo.observations);
    mocks.staticParameters.mockResolvedValue([]);
    mocks.integrations.mockResolvedValue(demo.integration);
    mocks.scenarios.mockResolvedValue(demo.scenarios);
    mocks.measurementDefinitions.mockResolvedValue(demo.measurementDefinitions);
    mocks.measurementSnapshot.mockResolvedValue(Object.entries(demo.latestMeasurements).map(([sensorId, measurements]) => ({
      sensorId,
      measurements,
    })));
    mocks.measurementHistory.mockResolvedValue([]);
    mocks.measurementForecast.mockResolvedValue([]);
    mocks.subscribeToMeasurementEvents.mockReturnValue(vi.fn());
    mocks.createStaticParameter.mockImplementation(async (parameter: Omit<StaticParameter, "id">) => ({
      ...parameter,
      id: "saved-wall-insulation",
    }));
  });

  it("reconciles repeated server upserts into one latest list item", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const houseId = result.current.state.houses[0]!.id;
    const base = {
      houseId,
      scopeType: "house" as const,
      scopeId: houseId,
      key: "wall_insulation",
      label: "Wall insulation",
      unit: null,
    };

    await act(async () => {
      await result.current.createStaticParameter({ ...base, value: "200 mm mineral wool" });
    });
    await act(async () => {
      await result.current.createStaticParameter({ ...base, value: "300 mm cellulose" });
    });

    const matching = result.current.state.staticParameters.filter((parameter) => parameter.key === base.key);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ id: "saved-wall-insulation", value: "300 mm cellulose" });
  });

  it("wires an empty v2 snapshot through replacement instead of retaining same-ID demo telemetry", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    mocks.sensors.mockResolvedValue([sensor]);
    mocks.snapshot.mockResolvedValue([]);
    mocks.measurementSnapshot.mockResolvedValue([{ sensorId: sensor.id, measurements: {} }]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state.sensors.map((item) => item.id)).toEqual([sensor.id]);
    expect(result.current.state.latestMeasurements[sensor.id]).toBeUndefined();
    expect(result.current.state.measurementHistory[sensor.id]).toBeUndefined();
    expect(result.current.state.measurementForecasts[sensor.id]).toBeUndefined();
    expect(result.current.state.readings[sensor.id]).toBeUndefined();
    expect(result.current.state.history[sensor.id]).toBeUndefined();
    expect(result.current.state.forecasts[sensor.id]).toBeUndefined();
  });
});

describe("replaceLoadedHouseTelemetry", () => {
  it("removes colliding demo telemetry for an empty loaded snapshot while preserving unrelated sensors", () => {
    const demo = createDemoState();
    const houseId = demo.houses[0]!.id;
    const collidingSensorId = demo.sensors.find((sensor) => sensor.houseId === houseId)!.id;
    const unrelatedSensorId = "sensor-unrelated-house";
    const sourceReading = demo.readings[collidingSensorId]!;
    const sourceSamples = demo.latestMeasurements[collidingSensorId]!;
    const sourceHistory = demo.measurementHistory[collidingSensorId]!;
    const sourceForecasts = demo.measurementForecasts[collidingSensorId]!;
    const unrelatedSamples = Object.fromEntries(Object.entries(sourceSamples).map(([metric, sample]) => [
      metric, { ...sample, sensorId: unrelatedSensorId },
    ]));
    const unrelatedMeasurementHistory = Object.fromEntries(Object.entries(sourceHistory).map(([metric, samples]) => [
      metric, samples.map((sample) => ({ ...sample, sensorId: unrelatedSensorId })),
    ]));
    const unrelatedMeasurementForecasts = Object.fromEntries(Object.entries(sourceForecasts).map(([metric, points]) => [
      metric, points.map((point) => ({ ...point, sensorId: unrelatedSensorId })),
    ]));
    const unrelatedReading = { ...sourceReading, sensorId: unrelatedSensorId };
    const unrelatedLegacyHistory = (demo.history[collidingSensorId] ?? []).map((reading) => ({ ...reading, sensorId: unrelatedSensorId }));
    const unrelatedLegacyForecasts = (demo.forecasts[collidingSensorId] ?? []).map((point) => ({ ...point, sensorId: unrelatedSensorId }));
    const current: ClimateState = {
      ...demo,
      sensors: [...demo.sensors, { ...demo.sensors[0]!, id: unrelatedSensorId, houseId: "house-unrelated" }],
      latestMeasurements: { ...demo.latestMeasurements, [unrelatedSensorId]: unrelatedSamples },
      measurementHistory: { ...demo.measurementHistory, [unrelatedSensorId]: unrelatedMeasurementHistory },
      measurementForecasts: { ...demo.measurementForecasts, [unrelatedSensorId]: unrelatedMeasurementForecasts },
      readings: { ...demo.readings, [unrelatedSensorId]: unrelatedReading },
      history: { ...demo.history, [unrelatedSensorId]: unrelatedLegacyHistory },
      forecasts: { ...demo.forecasts, [unrelatedSensorId]: unrelatedLegacyForecasts },
    };

    expect(current.latestMeasurements[collidingSensorId]?.co2).toBeDefined();
    expect(current.measurementHistory[collidingSensorId]?.co2).not.toHaveLength(0);
    expect(current.measurementForecasts[collidingSensorId]?.co2).not.toHaveLength(0);

    const replaced = replaceLoadedHouseTelemetry(current, houseId, [collidingSensorId], {}, []);
    const loadedHouseSensorIds = current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id);
    for (const sensorId of loadedHouseSensorIds) {
      expect(replaced.latestMeasurements[sensorId]).toBeUndefined();
      expect(replaced.measurementHistory[sensorId]).toBeUndefined();
      expect(replaced.measurementForecasts[sensorId]).toBeUndefined();
      expect(replaced.readings[sensorId]).toBeUndefined();
      expect(replaced.history[sensorId]).toBeUndefined();
      expect(replaced.forecasts[sensorId]).toBeUndefined();
    }
    expect(replaced.latestMeasurements[unrelatedSensorId]).toEqual(current.latestMeasurements[unrelatedSensorId]);
    expect(replaced.measurementHistory[unrelatedSensorId]).toEqual(current.measurementHistory[unrelatedSensorId]);
    expect(replaced.measurementForecasts[unrelatedSensorId]).toEqual(current.measurementForecasts[unrelatedSensorId]);
    expect(replaced.readings[unrelatedSensorId]).toEqual(current.readings[unrelatedSensorId]);
    expect(replaced.history[unrelatedSensorId]).toEqual(current.history[unrelatedSensorId]);
    expect(replaced.forecasts[unrelatedSensorId]).toEqual(current.forecasts[unrelatedSensorId]);
  });
});
