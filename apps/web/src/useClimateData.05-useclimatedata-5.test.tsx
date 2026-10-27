import { act, renderHook, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MaintenanceTask,
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

  it("preserves telemetry when a sensor moves into a house whose snapshot is in flight", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });
    expect(result.current.state.sensors).toContainEqual(fixture.secondSensor);
    const destinationSnapshot = deferred<SensorSnapshot[]>();
    mocks.snapshot.mockReturnValueOnce(destinationSnapshot.promise);
    const moved: Sensor = {
      ...fixture.firstSensor,
      houseId: fixture.secondHouse.id,
      floorId: fixture.secondHouse.floors[0]!.id,
    };
    mocks.updateSensor.mockResolvedValueOnce(moved);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(fixture.secondHouse.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(3));
    await act(async () => {
      await result.current.updateSensor(fixture.firstSensor.id, {
        houseId: moved.houseId,
        floorId: moved.floorId,
      });
    });
    await act(async () => {
      destinationSnapshot.resolve([{ ...fixture.secondSensor, reading: null }]);
      await houseLoad;
    });

    expect(result.current.state.sensors).toContainEqual(moved);
    expect(result.current.state.latestMeasurements[moved.id]?.temperature).toEqual(fixture.firstSample);
  });

  it("does not let a late house snapshot resurrect a sensor deleted during the load", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensor = demo.sensors[0]!;
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.deleteSensor(sensor.id); });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((candidate) => ({ ...candidate, reading: demo.readings[candidate.id] ?? null })));
      await houseLoad;
    });

    expect(result.current.state.sensors.some((candidate) => candidate.id === sensor.id)).toBe(false);
  });

  it("does not let late house hydration revert an observation updated during the load", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const original = demo.observations[0]!;
    const saved: ManualObservation = {
      ...original,
      note: "Confirmed during hydration",
      revision: (original.revision ?? 1) + 1,
      updatedAt: "2026-07-16T08:00:00.000Z",
    };
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);
    mocks.observations.mockResolvedValueOnce([original]);
    mocks.updateObservation.mockResolvedValueOnce(saved);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.updateObservation(original.id, {
        baseRevision: original.revision ?? 1,
        note: saved.note,
      });
    });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((sensor) => ({ ...sensor, reading: demo.readings[sensor.id] ?? null })));
      await houseLoad;
    });

    await waitFor(() => expect(result.current.state.observations).toContainEqual(saved));
    expect(result.current.state.observations).not.toContainEqual(original);
  });

  it("does not let late house hydration resurrect a deleted maintenance task", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const task: MaintenanceTask = {
      id: "maintenance-stale-during-load",
      propertyId: demo.properties[0]!.id,
      houseId: house.id,
      floorId: null,
      title: "Inspect roof flashing",
      description: null,
      basis: "condition-based",
      basisDetail: null,
      priority: "normal",
      plannedFor: null,
      dueBy: null,
      observationIds: [],
      status: "planned",
      completionNote: null,
      completedAt: null,
      verificationNote: null,
      verifiedAt: null,
      revision: 1,
      createdAt: "2026-07-16T07:00:00.000Z",
      updatedAt: "2026-07-16T07:00:00.000Z",
    };
    const staleSnapshot = deferred<SensorSnapshot[]>();
    mocks.maintenanceTasks.mockResolvedValue([task]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.state.maintenanceTasks).toContainEqual(task));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.deleteMaintenanceTask(task.id); });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((sensor) => ({ ...sensor, reading: demo.readings[sensor.id] ?? null })));
      await houseLoad;
    });

    await waitFor(() => expect(result.current.state.maintenanceTasks.some((item) => item.id === task.id)).toBe(false));
  });

  it("does not let late house hydration erase a saved static parameter", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const saved: StaticParameter = {
      id: "parameter-saved-during-load",
      houseId: house.id,
      scopeType: "house",
      scopeId: house.id,
      key: "wall_insulation",
      label: "Wall insulation",
      value: "300 mm cellulose",
      unit: null,
    };
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);
    mocks.staticParameters.mockResolvedValueOnce([]);
    mocks.createStaticParameter.mockResolvedValueOnce(saved);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    const { id: _id, ...input } = saved;
    await act(async () => { await result.current.createStaticParameter(input); });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((sensor) => ({ ...sensor, reading: demo.readings[sensor.id] ?? null })));
      await houseLoad;
    });

    await waitFor(() => expect(result.current.state.staticParameters).toContainEqual(saved));
  });

  it("preserves a series that finishes after a foreground house load starts", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensor = demo.sensors[0]!;
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const loadedSample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: "2026-07-16T10:00:00.000Z",
      value: 24.7,
    };
    const loadedForecast: MeasurementForecastPoint = {
      ...demo.measurementForecasts[sensor.id]!.temperature![0]!,
      timestamp: "2026-07-16T11:00:00.000Z",
      value: 24.9,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [loadedSample], from: loadedSample.timestamp, to: loadedSample.timestamp, bucketSeconds: null, truncated: false,
    });
    mocks.measurementForecast.mockResolvedValueOnce([loadedForecast]);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.loadSeries(sensor.id, "temperature", "24h"); });
    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([loadedSample]);
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((candidate) => ({ ...candidate, reading: demo.readings[candidate.id] ?? null })));
      await houseLoad;
    });

    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([loadedSample]);
    expect(result.current.state.measurementForecasts[sensor.id]?.temperature).toEqual([loadedForecast]);
  });

  it("preserves a loaded series across a later foreground house refresh", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensor = demo.sensors[0]!;
    const loadedSample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: "2026-07-16T10:00:00.000Z",
      value: 24.7,
    };
    const loadedForecast: MeasurementForecastPoint = {
      ...demo.measurementForecasts[sensor.id]!.temperature![0]!,
      timestamp: "2026-07-16T11:00:00.000Z",
      value: 24.9,
    };
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [loadedSample], from: loadedSample.timestamp, to: loadedSample.timestamp, bucketSeconds: null, truncated: false,
    });
    mocks.measurementForecast.mockResolvedValueOnce([loadedForecast]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.loadSeries(sensor.id, "temperature", "24h"); });
    await act(async () => { await result.current.selectHouse(house.id); });

    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([loadedSample]);
    expect(result.current.state.measurementForecasts[sensor.id]?.temperature).toEqual([loadedForecast]);
  });

  it("loads an arbitrary recorded window at the requested server resolution", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const from = "2024-02-10T00:00:00.000Z";
    const to = "2024-02-11T00:00:00.000Z";
    const sample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: "2024-02-10T12:00:00.000Z",
      value: 18.6,
      quality: "estimated",
    };
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [sample], from, to, bucketSeconds: 300, truncated: false,
    });
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let page!: Awaited<ReturnType<typeof result.current.loadHistoricalSeries>>;
    await act(async () => {
      page = await result.current.loadHistoricalSeries(sensor.id, "temperature", {
        from,
        to,
        bucketSeconds: 300,
      });
    });

    expect(mocks.measurementHistoryPage).toHaveBeenLastCalledWith(
      sensor.id,
      "temperature",
      from,
      to,
      50_000,
      300,
    );
    expect(page.samples).toEqual([sample]);
    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([sample]);
    expect(result.current.seriesStates[seriesStateKey(sensor.id, "temperature")]).toMatchObject({
      status: "ready",
      requestedFrom: from,
      requestedTo: to,
      loadedFrom: sample.timestamp,
      loadedTo: sample.timestamp,
      partial: false,
    });
  });

  it("retains cached samples outside a refreshed range and replaces samples inside it", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const template = demo.latestMeasurements[sensor.id]!.temperature!;
    const now = Date.now();
    const outside = { ...template, timestamp: new Date(now - 36 * 3_600_000).toISOString(), value: 16.2 };
    const staleInside = { ...template, timestamp: new Date(now - 12 * 3_600_000).toISOString(), value: 17.3 };
    const refreshedInside = { ...template, timestamp: new Date(now - 6 * 3_600_000).toISOString(), value: 22.4 };
    const broadFrom = new Date(now - 48 * 3_600_000).toISOString();
    const broadTo = new Date(now + 3_600_000).toISOString();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [outside, staleInside], from: broadFrom, to: broadTo, bucketSeconds: null, truncated: false,
    });
    await act(async () => {
      await result.current.loadHistoricalSeries(sensor.id, "temperature", {
        from: broadFrom,
        to: broadTo,
        bucketSeconds: null,
      });
    });
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [refreshedInside],
      from: refreshedInside.timestamp,
      to: refreshedInside.timestamp,
      bucketSeconds: 60,
      truncated: false,
    });

    await act(async () => { await result.current.loadSeries(sensor.id, "temperature", "24h"); });

    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([outside, refreshedInside]);
  });

  it("retains a cached requested-window prefix when a truncated series response only covers the suffix", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const template = demo.latestMeasurements[sensor.id]!.temperature!;
    const now = Date.now();
    const outside = { ...template, timestamp: new Date(now - 36 * 3_600_000).toISOString(), value: 16.2 };
    const cachedPrefix = { ...template, timestamp: new Date(now - 18 * 3_600_000).toISOString(), value: 17.3 };
    const refreshedStart = { ...template, timestamp: new Date(now - 6 * 3_600_000).toISOString(), value: 22.4 };
    const staleCoveredGap = { ...template, timestamp: new Date(now - 4 * 3_600_000).toISOString(), value: 19.1 };
    const broadFrom = new Date(now - 48 * 3_600_000).toISOString();
    const broadTo = new Date(now + 3_600_000).toISOString();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [outside, cachedPrefix, staleCoveredGap],
      from: broadFrom,
      to: broadTo,
      bucketSeconds: null,
      truncated: false,
    });
    await act(async () => {
      await result.current.loadHistoricalSeries(sensor.id, "temperature", {
        from: broadFrom,
        to: broadTo,
        bucketSeconds: null,
      });
    });
    mocks.measurementHistoryPage.mockResolvedValueOnce({
      samples: [refreshedStart],
      from: broadFrom,
      to: broadTo,
      bucketSeconds: 60,
      truncated: true,
    });

    await act(async () => { await result.current.loadSeries(sensor.id, "temperature", "24h"); });

    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([
      outside,
      cachedPrefix,
      refreshedStart,
    ]);
  });

  it("rejects invalid historical replay resolution before requesting data", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = mocks.measurementHistoryPage.mock.calls.length;

    await expect(result.current.loadHistoricalSeries(sensor.id, "temperature", {
      from: "2024-02-10T00:00:00.000Z",
      to: "2024-02-11T00:00:00.000Z",
      bucketSeconds: 86_401,
    })).rejects.toThrow("between 1 second and 1 day");
    expect(mocks.measurementHistoryPage).toHaveBeenCalledTimes(callsBefore);
  });

  it("merges a canonical live sample received while its series request is in flight", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const staleSample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: "2026-07-16T09:00:00.000Z",
      value: 20.2,
    };
    const liveSample: MeasurementSample = {
      ...staleSample,
      timestamp: "2026-07-16T09:01:00.000Z",
      value: 27.3,
    };
    const historyRequest = deferred<{ samples: MeasurementSample[]; from: string; to: string; bucketSeconds: number | null; truncated: boolean }>();
    const forecastRequest = deferred<MeasurementForecastPoint[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.measurementHistoryPage.mockReturnValueOnce(historyRequest.promise);
    mocks.measurementForecast.mockReturnValueOnce(forecastRequest.promise);
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];

    let seriesLoad!: Promise<void>;
    act(() => { seriesLoad = result.current.loadSeries(sensor.id, "temperature", "24h"); });
    await waitFor(() => expect(mocks.measurementHistoryPage).toHaveBeenCalled());
    act(() => handleMeasurement(liveSample));
    await act(async () => {
      historyRequest.resolve({ samples: [staleSample], from: staleSample.timestamp, to: staleSample.timestamp, bucketSeconds: null, truncated: false });
      forecastRequest.resolve([]);
      await seriesLoad;
    });

    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([staleSample, liveSample]);
  });
});
