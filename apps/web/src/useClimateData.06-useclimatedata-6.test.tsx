import { ApiRequestError } from "./api/support/request-error";
import { act, renderHook, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  House,
  IntegrationStatus,
  ManualObservation,
  MeasurementForecastPoint,
  MeasurementSample,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
} from "@climate-twin/contracts";

import { createDemoState } from "./domain";

import { seriesStateKey, useClimateData } from "./useClimateData";

import { deferred, twoHouseFixture } from "./useClimateDataTestSupport";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  properties: vi.fn(),
  propertyAreas: vi.fn(),
  areaEquipment: vi.fn(),
  propertyNotes: vi.fn(),
  houses: vi.fn(),
  sensors: vi.fn(),
  snapshot: vi.fn(),
  alertRules: vi.fn(),
  alerts: vi.fn(),
  observations: vi.fn(),
  maintenanceTasks: vi.fn(),
  maintenanceTask: vi.fn(),
  staticParameters: vi.fn(),
  integrations: vi.fn(),
  scenarios: vi.fn(),
  measurementDefinitions: vi.fn(),
  measurementSnapshot: vi.fn(),
  measurementHistory: vi.fn(),
  measurementHistoryPage: vi.fn(),
  measurementForecast: vi.fn(),
  readings: vi.fn(),
  forecast: vi.fn(),
  updatePropertyArea: vi.fn(),
  createHouse: vi.fn(),
  createSensor: vi.fn(),
  updateSensor: vi.fn(),
  deleteSensor: vi.fn(),
  createAlertRule: vi.fn(),
  updateAlertRule: vi.fn(),
  acknowledgeAlert: vi.fn(),
  updateHouseGeoreference: vi.fn(),
  tpLinkDevices: vi.fn(),
  disconnectHomeAssistant: vi.fn(),
  disconnectTpLink: vi.fn(),
  moveHomeAssistant: vi.fn(),
  moveTpLink: vi.fn(),
  createObservation: vi.fn(),
  updateObservation: vi.fn(),
  observationRevisions: vi.fn(),
  createMaintenanceTask: vi.fn(),
  updateMaintenanceTask: vi.fn(),
  maintenanceTaskRevisions: vi.fn(),
  deleteMaintenanceTask: vi.fn(),
  createStaticParameter: vi.fn(),
  cancelPendingApiRequests: vi.fn(),
  subscribeToApiAuthorizationChanges: vi.fn((
    _listener: (change: "changed" | "expired") => void,
  ) => vi.fn()),
  subscribeToEvents: vi.fn((
    _onEvent: (event: TelemetryEvent) => void,
    _onState: (state: "live" | "reconnecting") => void,
    _onOpen?: () => void,
  ) => vi.fn()),
  subscribeToMeasurementEvents: vi.fn((
    _onSample: (sample: MeasurementSample) => void,
    _onState: (state: "live" | "reconnecting") => void,
    _onOpen?: () => void,
  ) => vi.fn()),
  subscribeToAuthEpoch: vi.fn((_listener: () => void) => vi.fn()),
}));

vi.mock("./api", () => ({
  api: {
    session: mocks.session,
    properties: mocks.properties,
    propertyAreas: mocks.propertyAreas,
    areaEquipment: mocks.areaEquipment,
    propertyNotes: mocks.propertyNotes,
    houses: mocks.houses,
    sensors: mocks.sensors,
    snapshot: mocks.snapshot,
    alertRules: mocks.alertRules,
    alerts: mocks.alerts,
    observations: mocks.observations,
    maintenanceTasks: mocks.maintenanceTasks,
    maintenanceTask: mocks.maintenanceTask,
    staticParameters: mocks.staticParameters,
    integrations: mocks.integrations,
    scenarios: mocks.scenarios,
    measurementDefinitions: mocks.measurementDefinitions,
    measurementSnapshot: mocks.measurementSnapshot,
    measurementHistory: mocks.measurementHistory,
    measurementHistoryPage: mocks.measurementHistoryPage,
    measurementForecast: mocks.measurementForecast,
    readings: mocks.readings,
    forecast: mocks.forecast,
    updatePropertyArea: mocks.updatePropertyArea,
    createHouse: mocks.createHouse,
    createSensor: mocks.createSensor,
    updateSensor: mocks.updateSensor,
    deleteSensor: mocks.deleteSensor,
    createAlertRule: mocks.createAlertRule,
    updateAlertRule: mocks.updateAlertRule,
    acknowledgeAlert: mocks.acknowledgeAlert,
    updateHouseGeoreference: mocks.updateHouseGeoreference,
    tpLinkDevices: mocks.tpLinkDevices,
    disconnectHomeAssistant: mocks.disconnectHomeAssistant,
    disconnectTpLink: mocks.disconnectTpLink,
    moveHomeAssistant: mocks.moveHomeAssistant,
    moveTpLink: mocks.moveTpLink,
    createObservation: mocks.createObservation,
    updateObservation: mocks.updateObservation,
    observationRevisions: mocks.observationRevisions,
    createMaintenanceTask: mocks.createMaintenanceTask,
    updateMaintenanceTask: mocks.updateMaintenanceTask,
    maintenanceTaskRevisions: mocks.maintenanceTaskRevisions,
    deleteMaintenanceTask: mocks.deleteMaintenanceTask,
    createStaticParameter: mocks.createStaticParameter,
  },
  cancelPendingApiRequests: mocks.cancelPendingApiRequests,
  subscribeToApiAuthorizationChanges: mocks.subscribeToApiAuthorizationChanges,
  subscribeToEvents: mocks.subscribeToEvents,
  subscribeToMeasurementEvents: mocks.subscribeToMeasurementEvents,
}));

vi.mock("./authEpoch", () => ({
  subscribeToAuthEpoch: mocks.subscribeToAuthEpoch,
}));

function useTwoHouseApi(fixture: ReturnType<typeof twoHouseFixture>) {
  const { firstHouse, secondHouse, firstSensor, secondSensor, firstSample, secondSample, firstObservation, secondObservation } = fixture;
  mocks.houses.mockResolvedValue([firstHouse, secondHouse]);
  mocks.sensors.mockImplementation(async (houseId: string) => houseId === secondHouse.id ? [secondSensor] : [firstSensor]);
  mocks.snapshot.mockImplementation(async (houseId: string): Promise<SensorSnapshot[]> => houseId === secondHouse.id
    ? [{ ...secondSensor, reading: null }]
    : [{ ...firstSensor, reading: fixture.demo.readings[firstSensor.id] ?? null }]);
  mocks.measurementSnapshot.mockImplementation(async (houseId: string) => houseId === secondHouse.id
    ? [{ sensorId: secondSensor.id, measurements: { temperature: secondSample } }]
    : [{ sensorId: firstSensor.id, measurements: { temperature: firstSample } }]);
  mocks.observations.mockImplementation(async (houseId: string) => houseId === secondHouse.id
    ? [secondObservation]
    : [firstObservation]);
  mocks.staticParameters.mockResolvedValue([]);
  mocks.maintenanceTasks.mockResolvedValue([]);
}

describe("useClimateData", () => {
  beforeEach(() => {
    const demo = createDemoState();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    mocks.session.mockResolvedValue(demo.session);
    mocks.properties.mockResolvedValue(demo.properties);
    mocks.propertyAreas.mockResolvedValue(demo.propertyAreas);
    mocks.areaEquipment.mockResolvedValue(demo.areaEquipment);
    mocks.propertyNotes.mockResolvedValue(demo.propertyNotes);
    mocks.subscribeToEvents.mockImplementation((_onEvent, _onState, onOpen) => {
      onOpen?.();
      return vi.fn();
    });
    mocks.houses.mockResolvedValue(demo.houses);
    mocks.sensors.mockResolvedValue(demo.sensors);
    mocks.snapshot.mockImplementation(async (houseId: string): Promise<SensorSnapshot[]> => demo.sensors
      .filter((sensor) => sensor.houseId === houseId)
      .map((sensor) => ({ ...sensor, reading: demo.readings[sensor.id] ?? null })));
    mocks.alertRules.mockResolvedValue(demo.alertRules);
    mocks.alerts.mockResolvedValue(demo.alerts);
    mocks.observations.mockResolvedValue(demo.observations);
    mocks.maintenanceTasks.mockResolvedValue(demo.maintenanceTasks);
    mocks.maintenanceTask.mockImplementation(async (id: string) => {
      const task = demo.maintenanceTasks.find((candidate) => candidate.id === id);
      if (!task) throw Object.assign(new Error("Not found"), { status: 404 });
      return task;
    });
    mocks.staticParameters.mockResolvedValue([]);
    mocks.integrations.mockResolvedValue(demo.integration);
    mocks.scenarios.mockResolvedValue(demo.scenarios);
    mocks.measurementDefinitions.mockResolvedValue(demo.measurementDefinitions);
    mocks.measurementSnapshot.mockResolvedValue(Object.entries(demo.latestMeasurements).map(([sensorId, measurements]) => ({
      sensorId,
      measurements,
    })));
    mocks.measurementHistory.mockResolvedValue([]);
    mocks.measurementHistoryPage.mockResolvedValue({ samples: [], from: "", to: "", bucketSeconds: null, truncated: false });
    mocks.measurementForecast.mockResolvedValue([]);
    mocks.readings.mockResolvedValue([]);
    mocks.forecast.mockResolvedValue([]);
    mocks.tpLinkDevices.mockResolvedValue([]);
    mocks.disconnectHomeAssistant.mockResolvedValue({ ok: true, integration: demo.integration });
    mocks.disconnectTpLink.mockResolvedValue({ ok: true, detachedSensorIds: [], integration: demo.integration });
    mocks.moveHomeAssistant.mockResolvedValue({ ok: true, fromHouseId: "house-main", houseId: "house-cabin", integration: demo.integration });
    mocks.moveTpLink.mockResolvedValue({ ok: true, fromHouseId: "house-main", houseId: "house-cabin", detachedSensorIds: [], integration: demo.integration });
    mocks.deleteSensor.mockResolvedValue(undefined);
    mocks.observationRevisions.mockResolvedValue([]);
    mocks.maintenanceTaskRevisions.mockResolvedValue([]);
    mocks.subscribeToMeasurementEvents.mockImplementation((_onSample, _onState, onOpen) => {
      onOpen?.();
      return vi.fn();
    });
    mocks.createStaticParameter.mockImplementation(async (parameter: Omit<StaticParameter, "id">) => ({
      ...parameter,
      id: "saved-wall-insulation",
    }));
    mocks.updateHouseGeoreference.mockImplementation(async (houseId: string, patch: Record<string, unknown>) => {
      const source = demo.houses.find((candidate) => candidate.id === houseId)!;
      return { ...source, ...patch };
    });
  });

  it("merges a legacy live reading received while the fallback series request is in flight", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const staleReading = {
      ...demo.readings[sensor.id]!,
      timestamp: "2026-07-16T09:00:00.000Z",
      temperature: 20.2,
    };
    const liveReading = {
      ...staleReading,
      timestamp: "2026-07-16T09:01:00.000Z",
      temperature: 27.3,
      measurements: { ...staleReading.measurements, temperature: 27.3 },
    };
    const readingsRequest = deferred<Array<typeof staleReading>>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.measurementHistoryPage.mockRejectedValueOnce(new ApiRequestError(404, "NOT_FOUND", "API endpoint not found"));
    mocks.readings.mockReturnValueOnce(readingsRequest.promise);
    mocks.forecast.mockResolvedValueOnce([]);
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];

    let seriesLoad!: Promise<void>;
    act(() => { seriesLoad = result.current.loadSeries(sensor.id, "temperature", "24h"); });
    await waitFor(() => expect(mocks.readings).toHaveBeenCalled());
    act(() => handleTelemetry({ type: "reading", data: liveReading }));
    await act(async () => {
      readingsRequest.resolve([staleReading]);
      await seriesLoad;
    });

    expect(result.current.state.history[sensor.id]).toEqual([staleReading, liveReading]);
    expect(result.current.state.measurementHistory[sensor.id]?.temperature?.at(-1)?.value).toBe(27.3);
    expect(mocks.measurementHistoryPage).toHaveBeenLastCalledWith(
      sensor.id,
      "temperature",
      expect.any(String),
      expect.any(String),
      20_000,
      60,
    );
  });

  it.each([
    ["timeout", () => new DOMException("The API request timed out", "TimeoutError")],
    ["abort", () => new DOMException("The authenticated session changed", "AbortError")],
    ["general failure", () => new Error("The history service failed")],
  ])("does not start the legacy fallback after a canonical %s", async (_label, createError) => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensorId = result.current.state.sensors[0]!.id;
    const readingsCallsBefore = mocks.readings.mock.calls.length;
    const forecastCallsBefore = mocks.forecast.mock.calls.length;
    mocks.measurementHistoryPage.mockRejectedValueOnce(createError());

    await act(async () => {
      await result.current.loadSeries(sensorId, "temperature", "24h");
    });

    expect(mocks.readings).toHaveBeenCalledTimes(readingsCallsBefore);
    expect(mocks.forecast).toHaveBeenCalledTimes(forecastCallsBefore);
    expect(result.current.seriesStates[seriesStateKey(sensorId, "temperature")]).toMatchObject({
      status: "error",
    });
  });

  it("batches a legacy reading with duplicate live measurements and applies it once", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const priorSample = demo.latestMeasurements[sensor.id]!.temperature!;
    const timestamp = new Date(Date.parse(priorSample.timestamp) + 1_000).toISOString();
    const reading = { ...demo.readings[sensor.id]!, timestamp, temperature: 26.5 };
    const sample: MeasurementSample = { ...priorSample, timestamp, value: 26.5 };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];

    vi.useFakeTimers();
    try {
      act(() => {
        handleTelemetry({ type: "reading", data: reading });
        handleMeasurement(sample);
        handleMeasurement(sample);
      });
      expect(result.current.state.latestMeasurements[sensor.id]?.temperature?.value).not.toBe(26.5);

      await act(async () => { await vi.advanceTimersByTimeAsync(20); });

      expect(result.current.state.readings[sensor.id]?.temperature).toBe(26.5);
      expect(result.current.state.latestMeasurements[sensor.id]?.temperature?.value).toBe(26.5);
      expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([sample]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recreate deleted sensor telemetry from a queued live measurement", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const sample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: "2026-07-16T12:00:00.000Z",
      value: 31.7,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];

    vi.useFakeTimers();
    try {
      act(() => handleMeasurement(sample));
      await act(async () => { await result.current.deleteSensor(sensor.id); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });

      expect(result.current.state.sensors.some((candidate) => candidate.id === sensor.id)).toBe(false);
      expect(result.current.state.latestMeasurements[sensor.id]).toBeUndefined();
      expect(result.current.state.measurementHistory[sensor.id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a late legacy reading after its sensor has been deleted", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const lateReading = {
      ...demo.readings[sensor.id]!,
      timestamp: "2026-07-16T12:01:00.000Z",
      temperature: 32.1,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];

    await act(async () => { await result.current.deleteSensor(sensor.id); });
    act(() => handleTelemetry({ type: "reading", data: lateReading }));

    expect(result.current.state.sensors.some((candidate) => candidate.id === sensor.id)).toBe(false);
    expect(result.current.state.readings[sensor.id]).toBeUndefined();
    expect(result.current.state.history[sensor.id]).toBeUndefined();
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

    expect(mocks.observations).toHaveBeenCalledWith(fixture.secondHouse.id, "optional");
    expect(mocks.observations).not.toHaveBeenCalledWith(fixture.firstHouse.id, "optional");
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
    const olderHistory = deferred<{ samples: MeasurementSample[]; from: string; to: string; bucketSeconds: number | null; truncated: boolean }>();
    const newerHistory = deferred<{ samples: MeasurementSample[]; from: string; to: string; bucketSeconds: number | null; truncated: boolean }>();
    const olderForecasts = deferred<MeasurementForecastPoint[]>();
    const newerForecasts = deferred<MeasurementForecastPoint[]>();
    mocks.measurementHistoryPage.mockReturnValueOnce(olderHistory.promise).mockReturnValueOnce(newerHistory.promise);
    mocks.measurementForecast.mockReturnValueOnce(olderForecasts.promise).mockReturnValueOnce(newerForecasts.promise);

    let olderLoad!: Promise<void>;
    let newerLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.loadSeries(sensorId, "temperature", "7d");
      newerLoad = result.current.loadSeries(sensorId, "temperature", "6h");
    });
    await act(async () => {
      newerHistory.resolve({ samples: [newerSample], from: newerSample.timestamp, to: newerSample.timestamp, bucketSeconds: null, truncated: false });
      newerForecasts.resolve([newerForecast]);
      await newerLoad;
    });
    expect(result.current.state.measurementHistory[sensorId]?.temperature).toEqual([newerSample]);
    expect(result.current.state.measurementForecasts[sensorId]?.temperature).toEqual([newerForecast]);

    await act(async () => {
      olderHistory.resolve({ samples: [olderSample], from: olderSample.timestamp, to: olderSample.timestamp, bucketSeconds: 60, truncated: false });
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

  it("removes sensor-scoped state after a confirmed sensor deletion", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const sensorParameter: StaticParameter = {
      id: "parameter-sensor",
      houseId: sensor.houseId,
      scopeType: "sensor",
      scopeId: sensor.id,
      key: "installation_note",
      value: "Window reveal",
      unit: null,
      label: "Installation note",
    };
    const houseParameter: StaticParameter = {
      ...sensorParameter,
      id: "parameter-house",
      scopeType: "house",
      scopeId: sensor.houseId,
      key: "construction_year",
      value: 1984,
      label: "Construction year",
    };
    mocks.staticParameters.mockResolvedValue([sensorParameter, houseParameter]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.deleteSensor(sensor.id); });

    expect(mocks.deleteSensor).toHaveBeenCalledWith(sensor.id);
    expect(result.current.state.sensors.some((candidate) => candidate.id === sensor.id)).toBe(false);
    expect(result.current.state.latestMeasurements[sensor.id]).toBeUndefined();
    expect(result.current.state.staticParameters).toEqual([houseParameter]);
  });

  it("replaces an alert rule only after its Telegram delivery setting is saved", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const rule = result.current.state.alertRules[0]!;
    mocks.updateAlertRule.mockResolvedValue({ ...rule, telegramEnabled: true });

    await act(async () => { await result.current.updateRule(rule.id, { telegramEnabled: true }); });

    expect(mocks.updateAlertRule).toHaveBeenCalledWith(rule.id, { telegramEnabled: true });
    expect(result.current.state.alertRules.find((item) => item.id === rule.id)?.telegramEnabled).toBe(true);
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

    const calibratedFloor = { ...house.floors[0]!, metersPerPlanUnit: .02 };
    act(() => result.current.updateFloor(house.id, calibratedFloor));
    expect(result.current.state.houses[0]?.floors[0]?.metersPerPlanUnit).toBe(.02);
    expect(result.current.state.houses[0]?.mapPlacement?.metersPerPlanUnit).toBe(.02);
  });

  it("derives the weather-location count when integration SSE precedes the save response", async () => {
    const demo = createDemoState();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const house = result.current.state.houses[0]!;
    const location = {
      latitude: 60.1699,
      longitude: 24.9384,
      source: "manual" as const,
      userOverridden: true,
    };
    const saved = { ...house, location };
    const saveRequest = deferred<House>();
    mocks.updateHouseGeoreference.mockReturnValueOnce(saveRequest.promise);
    let request!: Promise<void>;

    act(() => { request = result.current.setHouseGeoreference(house.id, { location }); });
    await waitFor(() => expect(mocks.updateHouseGeoreference).toHaveBeenCalledWith(house.id, { location }));
    const [[handleEvent]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const statusAfterSave: IntegrationStatus = {
      ...demo.integration,
      weather: { ...demo.integration.weather, configuredHouses: 1 },
    };
    act(() => handleEvent({ type: "integration", data: statusAfterSave }));
    expect(result.current.state.integration.weather.configuredHouses).toBe(1);

    await act(async () => {
      saveRequest.resolve(saved);
      await request;
    });

    expect(result.current.state.integration.weather.configuredHouses).toBe(1);
    expect(result.current.state.houses.find((candidate) => candidate.id === house.id)?.location).toEqual(location);
  });
});
