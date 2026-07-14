import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  House,
  ManualObservation,
  MeasurementForecastPoint,
  MeasurementSample,
  Sensor,
  StaticParameter,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
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
  createSensor: vi.fn(),
  updateSensor: vi.fn(),
  updateHouseGeoreference: vi.fn(),
  tpLinkDevices: vi.fn(),
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
    createSensor: mocks.createSensor,
    updateSensor: mocks.updateSensor,
    updateHouseGeoreference: mocks.updateHouseGeoreference,
    tpLinkDevices: mocks.tpLinkDevices,
    createStaticParameter: mocks.createStaticParameter,
  },
  subscribeToEvents: mocks.subscribeToEvents,
  subscribeToMeasurementEvents: mocks.subscribeToMeasurementEvents,
}));

import { replaceLoadedHouseTelemetry, useClimateData, withoutDemoTelemetry } from "./useClimateData";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function twoHouseFixture() {
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

function useTwoHouseApi(fixture: ReturnType<typeof twoHouseFixture>) {
  const { firstHouse, secondHouse, firstSensor, secondSensor, firstSample, secondSample, firstObservation, secondObservation } = fixture;
  mocks.houses.mockResolvedValue([firstHouse, secondHouse]);
  mocks.sensors.mockImplementation(async (houseId: string) => houseId === secondHouse.id ? [secondSensor] : [firstSensor]);
  mocks.snapshot.mockResolvedValue([]);
  mocks.measurementSnapshot.mockImplementation(async (houseId: string) => houseId === secondHouse.id
    ? [{ sensorId: secondSensor.id, measurements: { temperature: secondSample } }]
    : [{ sensorId: firstSensor.id, measurements: { temperature: firstSample } }]);
  mocks.observations.mockImplementation(async (houseId: string) => houseId === secondHouse.id
    ? [secondObservation]
    : [firstObservation]);
  mocks.staticParameters.mockResolvedValue([]);
}

describe("useClimateData", () => {
  beforeEach(() => {
    const demo = createDemoState();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
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
    mocks.tpLinkDevices.mockResolvedValue([]);
    mocks.subscribeToMeasurementEvents.mockReturnValue(vi.fn());
    mocks.createStaticParameter.mockImplementation(async (parameter: Omit<StaticParameter, "id">) => ({
      ...parameter,
      id: "saved-wall-insulation",
    }));
    mocks.updateHouseGeoreference.mockImplementation(async (houseId: string, patch: Record<string, unknown>) => {
      const source = demo.houses.find((candidate) => candidate.id === houseId)!;
      return { ...source, ...patch };
    });
  });

  it("keeps telemetry empty until the API positively confirms demo mode", () => {
    mocks.houses.mockReturnValueOnce(new Promise(() => undefined));
    const { result, unmount } = renderHook(() => useClimateData());

    expect(result.current.loading).toBe(true);
    expect(result.current.state.readings).toEqual({});
    expect(result.current.state.latestMeasurements).toEqual({});
    expect(result.current.state.history).toEqual({});
    unmount();
  });

  it("fails closed without demo telemetry when initial API confirmation fails", async () => {
    mocks.houses.mockRejectedValueOnce(new Error("API unavailable"));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.connection).toBe("offline");
    expect(result.current.state.readings).toEqual({});
    expect(result.current.state.latestMeasurements).toEqual({});
    expect(result.current.state.measurementHistory).toEqual({});
    expect(result.current.state.alerts).toEqual([]);
  });

  it("rejects offline mutations instead of presenting ephemeral data as saved", async () => {
    mocks.houses.mockRejectedValueOnce(new Error("API unavailable"));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensor = createDemoState().sensors[0]!;
    const { id: _id, ...sourceInput } = sensor;
    const input = { ...sourceInput, name: "Offline-only sensor" };
    const before = result.current.state.sensors.map((item) => item.id);

    await expect(act(async () => result.current.createSensor(input))).rejects.toThrow("not saved");
    expect(result.current.state.sensors.map((item) => item.id)).toEqual(before);
    expect(result.current.state.sensors.some((item) => item.name === "Offline-only sensor")).toBe(false);
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

  it("does not retain a static parameter when persistence fails", async () => {
    mocks.createStaticParameter.mockRejectedValueOnce(new Error("Parameter save failed"));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const houseId = result.current.state.houses[0]!.id;

    await expect(act(async () => result.current.createStaticParameter({
      houseId,
      scopeType: "house",
      scopeId: houseId,
      key: "wall_insulation",
      label: "Wall insulation",
      value: "200 mm",
      unit: null,
    }))).rejects.toThrow("Parameter save failed");
    expect(result.current.state.staticParameters).toEqual([]);
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

  it("loads every house for the portfolio and preserves other houses across active-house refreshes", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state.sensors.map((sensor) => sensor.id).sort()).toEqual([
      fixture.firstSensor.id,
      fixture.secondSensor.id,
    ].sort());
    expect(result.current.state.latestMeasurements[fixture.firstSensor.id]?.temperature).toEqual(fixture.firstSample);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(fixture.secondSample);

    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });

    expect(result.current.state.sensors.map((sensor) => sensor.id).sort()).toEqual([
      fixture.firstSensor.id,
      fixture.secondSensor.id,
    ].sort());
    expect(result.current.state.latestMeasurements[fixture.firstSensor.id]?.temperature).toEqual(fixture.firstSample);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(fixture.secondSample);
  });

  it("keeps a non-first deep link intact and initializes its house-specific state", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    window.history.replaceState(null, "", `/sites/${fixture.secondHouse.id}/twin`);
    const housesRequest = deferred<House[]>();
    mocks.houses.mockReturnValueOnce(housesRequest.promise);

    const { result } = renderHook(() => useClimateData());
    expect(result.current.state.houses).toEqual([]);

    await act(async () => { housesRequest.resolve([fixture.firstHouse, fixture.secondHouse]); });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.observations).toHaveBeenCalledWith(fixture.secondHouse.id);
    expect(mocks.observations).not.toHaveBeenCalledWith(fixture.firstHouse.id);
    expect(result.current.state.observations).toEqual([fixture.secondObservation]);
  });

  it("ignores an older house response that finishes after a newer selection", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const older = deferred<ManualObservation[]>();
    const newer = deferred<ManualObservation[]>();
    mocks.observations.mockImplementation((houseId: string) => houseId === fixture.secondHouse.id ? newer.promise : older.promise);

    let olderLoad!: Promise<void>;
    let newerLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.selectHouse(fixture.firstHouse.id);
      newerLoad = result.current.selectHouse(fixture.secondHouse.id);
    });
    await act(async () => {
      newer.resolve([fixture.secondObservation]);
      await newerLoad;
    });
    expect(result.current.state.observations).toEqual([fixture.secondObservation]);

    await act(async () => {
      older.resolve([fixture.firstObservation]);
      await olderLoad;
    });
    expect(result.current.state.observations).toEqual([fixture.secondObservation]);
  });

  it("ignores an older series response that finishes after the latest range request", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensorId = result.current.state.sensors[0]!.id;
    const baseSample = createDemoState().latestMeasurements[sensorId]!.temperature!;
    const olderSample: MeasurementSample = { ...baseSample, value: 18.2 };
    const newerSample: MeasurementSample = { ...baseSample, value: 23.6 };
    const baseForecast = createDemoState().measurementForecasts[sensorId]!.temperature![0]!;
    const olderForecast: MeasurementForecastPoint = { ...baseForecast, value: 18.4 };
    const newerForecast: MeasurementForecastPoint = { ...baseForecast, value: 23.2 };
    const olderHistory = deferred<MeasurementSample[]>();
    const newerHistory = deferred<MeasurementSample[]>();
    const olderForecasts = deferred<MeasurementForecastPoint[]>();
    const newerForecasts = deferred<MeasurementForecastPoint[]>();
    mocks.measurementHistory.mockReturnValueOnce(olderHistory.promise).mockReturnValueOnce(newerHistory.promise);
    mocks.measurementForecast.mockReturnValueOnce(olderForecasts.promise).mockReturnValueOnce(newerForecasts.promise);

    let olderLoad!: Promise<void>;
    let newerLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.loadSeries(sensorId, "temperature", "7d");
      newerLoad = result.current.loadSeries(sensorId, "temperature", "6h");
    });
    await act(async () => {
      newerHistory.resolve([newerSample]);
      newerForecasts.resolve([newerForecast]);
      await newerLoad;
    });
    expect(result.current.state.measurementHistory[sensorId]?.temperature).toEqual([newerSample]);
    expect(result.current.state.measurementForecasts[sensorId]?.temperature).toEqual([newerForecast]);

    await act(async () => {
      olderHistory.resolve([olderSample]);
      olderForecasts.resolve([olderForecast]);
      await olderLoad;
    });
    expect(result.current.state.measurementHistory[sensorId]?.temperature).toEqual([newerSample]);
    expect(result.current.state.measurementForecasts[sensorId]?.temperature).toEqual([newerForecast]);
  });

  it("creates and edits a sensor only after the server confirms persistence", async () => {
    const demo = createDemoState();
    const base = demo.sensors[0]!;
    const created: Sensor = { ...base, id: "sensor-new", name: "New nursery sensor" };
    mocks.createSensor.mockResolvedValue(created);
    mocks.updateSensor.mockImplementation(async (id: string, patch: Partial<Sensor>) => ({ ...created, id, ...patch }));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const { id: _id, ...input } = created;
    await act(async () => { await result.current.createSensor(input); });
    expect(result.current.state.sensors.find((sensor) => sensor.id === created.id)?.name).toBe("New nursery sensor");

    await act(async () => { await result.current.updateSensor(created.id, { name: "Nursery window" }); });
    expect(result.current.state.sensors.find((sensor) => sensor.id === created.id)?.name).toBe("Nursery window");
  });

  it("keeps the prior sensor record when a confirmed edit fails", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensor = result.current.state.sensors[0]!;
    mocks.updateSensor.mockRejectedValue(new Error("Sensor save failed"));

    await expect(act(async () => result.current.updateSensor(sensor.id, { name: "Unsaved name" }))).rejects.toThrow("Sensor save failed");
    expect(result.current.state.sensors.find((item) => item.id === sensor.id)?.name).toBe(sensor.name);
  });

  it("stores a precise map placement without changing the weather-location count", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const house = result.current.state.houses[0]!;
    const configuredBefore = result.current.state.integration.weather.configuredHouses;
    const mapPlacement = {
      latitude: 60.17001,
      longitude: 24.94002,
      metersPerPlanUnit: 0.012,
      footprintFloorId: house.floors[0]!.id,
    };

    await act(async () => { await result.current.setHouseGeoreference(house.id, { mapPlacement }); });

    expect(result.current.state.houses[0]?.mapPlacement).toEqual(mapPlacement);
    expect(result.current.state.integration.weather.configuredHouses).toBe(configuredBefore);
    expect(mocks.updateHouseGeoreference).toHaveBeenCalledWith(house.id, { mapPlacement });
  });

  it("loads discovered TP-Link children and exposes refresh failures", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-1", model: "T315", alias: "Office", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    mocks.tpLinkDevices.mockResolvedValueOnce([device]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([device]));

    mocks.tpLinkDevices.mockRejectedValueOnce(new Error("Hub is restarting"));
    await act(async () => { await result.current.refreshTpLinkDevices(); });
    expect(result.current.tpLinkDevicesError).toBe("Hub is restarting");
  });

  it("serializes rapid map moves so an older request cannot become the final persisted position", async () => {
    const deferred: Array<{ resolve: (sensor: Sensor) => void }> = [];
    mocks.updateSensor.mockImplementation((id: string, patch: Partial<Sensor>) => new Promise<Sensor>((resolve) => {
      const source = createDemoState().sensors.find((sensor) => sensor.id === id)!;
      deferred.push({ resolve: (sensor) => resolve(sensor ?? { ...source, ...patch }) });
    }));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensor = result.current.state.sensors[0]!;

    act(() => {
      result.current.moveSensor(sensor.id, { x: 100, y: 110 });
      result.current.moveSensor(sensor.id, { x: 200, y: 210 });
    });
    await waitFor(() => expect(deferred).toHaveLength(1));
    deferred[0]!.resolve({ ...sensor, x: 100, y: 110 });
    await waitFor(() => expect(deferred).toHaveLength(2));
    deferred[1]!.resolve({ ...sensor, x: 200, y: 210 });
    await waitFor(() => expect(result.current.state.sensors.find((item) => item.id === sensor.id)).toMatchObject({ x: 200, y: 210 }));
    expect(mocks.updateSensor).toHaveBeenCalledTimes(2);
  });

  it("rolls an optimistic sensor move back when the server rejects it", async () => {
    mocks.updateSensor.mockRejectedValueOnce(new Error("Position save failed"));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensor = result.current.state.sensors[0]!;

    act(() => result.current.moveSensor(sensor.id, { x: sensor.x + 100, y: sensor.y + 100 }));

    await waitFor(() => expect(result.current.state.sensors.find((item) => item.id === sensor.id)).toMatchObject({ x: sensor.x, y: sensor.y }));
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

describe("withoutDemoTelemetry", () => {
  it("removes cached demo values while retaining real samples at the one-way boundary", () => {
    const demo = createDemoState();
    const sensorId = demo.sensors[0]!.id;
    const realReading = { ...demo.readings[sensorId]!, timestamp: "2026-07-14T12:00:00.000Z", source: "home-assistant" as const };
    const realSample = { ...demo.latestMeasurements[sensorId]!.temperature!, timestamp: realReading.timestamp, source: "home-assistant" as const };
    const current: ClimateState = {
      ...demo,
      readings: { ...demo.readings, [sensorId]: realReading },
      history: { ...demo.history, [sensorId]: [...demo.history[sensorId]!, realReading] },
      latestMeasurements: { ...demo.latestMeasurements, [sensorId]: { ...demo.latestMeasurements[sensorId], temperature: realSample } },
      measurementHistory: {
        ...demo.measurementHistory,
        [sensorId]: {
          ...demo.measurementHistory[sensorId],
          temperature: [...demo.measurementHistory[sensorId]!.temperature!, realSample],
        },
      },
    };

    const sanitized = withoutDemoTelemetry(current, true);
    expect(Object.values(sanitized.readings).every((reading) => reading.source !== "mock" && reading.source !== "replay")).toBe(true);
    expect(sanitized.history[sensorId]).toEqual([realReading]);
    expect(sanitized.latestMeasurements[sensorId]).toEqual({ temperature: realSample });
    expect(sanitized.measurementHistory[sensorId]).toEqual({ temperature: [realSample] });
    expect(sanitized.forecasts).toEqual({});
    expect(sanitized.measurementForecasts).toEqual({});
    expect(sanitized.alerts).toEqual([]);
  });
});
