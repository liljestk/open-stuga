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

  it("loads discovered TP-Link children and exposes refresh failures", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-1", model: "T315", alias: "Office", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    mocks.tpLinkDevices.mockResolvedValueOnce([device]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([device]));

    mocks.tpLinkDevices.mockRejectedValueOnce(new Error("Hub is restarting"));
    await expect(result.current.refreshTpLinkDevices()).rejects.toThrow("Hub is restarting");
    await waitFor(() => expect(result.current.tpLinkDevicesError).toBe("Hub is restarting"));
  });

  it("keeps sibling-Home devices when refreshing one Home's hub inventory", async () => {
    const mainDevice: TpLinkDiscoveredDevice = {
      houseId: "house-main", connectionId: "hub-main", deviceId: "child-main", model: "T315", alias: "Office",
      status: "online", temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    const cabinDevice: TpLinkDiscoveredDevice = {
      ...mainDevice, houseId: "house-cabin", connectionId: "hub-cabin", deviceId: "child-cabin", alias: "Cabin",
    };
    const refreshedMain = { ...mainDevice, alias: "Office refreshed" };
    mocks.tpLinkDevices.mockResolvedValueOnce([mainDevice, cabinDevice]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([mainDevice, cabinDevice]));

    mocks.tpLinkDevices.mockResolvedValueOnce([refreshedMain]);
    await act(async () => { await result.current.refreshTpLinkDevices("house-main"); });

    expect(result.current.tpLinkDevices).toEqual([cabinDevice, refreshedMain]);
    expect(mocks.tpLinkDevices).toHaveBeenLastCalledWith("house-main");
  });

  it("clears only direct TP-Link bindings returned by a disconnected assignment", async () => {
    const demo = createDemoState();
    const sensor = {
      ...demo.sensors[0]!,
      tpLinkDeviceId: "child-bound",
      tpLinkConnectionId: "hub-assignment",
    };
    mocks.snapshot.mockResolvedValue([{ ...sensor, reading: demo.readings[sensor.id] ?? null }]);
    mocks.sensors.mockResolvedValue([sensor]);
    mocks.disconnectTpLink.mockResolvedValueOnce({
      ok: true,
      detachedSensorIds: [sensor.id],
      integration: demo.integration,
    });
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.state.sensors.find((candidate) => candidate.id === sensor.id)).toMatchObject({
      tpLinkDeviceId: "child-bound",
      tpLinkConnectionId: "hub-assignment",
    }));

    await act(async () => { await result.current.disconnectTpLink("hub-assignment"); });

    const detached = result.current.state.sensors.find((candidate) => candidate.id === sensor.id)!;
    expect(detached).not.toHaveProperty("tpLinkDeviceId");
    expect(detached).not.toHaveProperty("tpLinkConnectionId");
    expect(detached.id).toBe(sensor.id);
    expect(detached.houseId).toBe(sensor.houseId);
  });

  it("clears source-Home bindings returned when a TP-Link assignment is moved", async () => {
    const demo = createDemoState();
    const sensor = {
      ...demo.sensors[0]!,
      tpLinkDeviceId: "child-bound",
      tpLinkConnectionId: "hub-assignment",
    };
    mocks.snapshot.mockResolvedValue([{ ...sensor, reading: demo.readings[sensor.id] ?? null }]);
    mocks.sensors.mockResolvedValue([sensor]);
    mocks.moveTpLink.mockResolvedValueOnce({
      ok: true,
      fromHouseId: sensor.houseId,
      houseId: "house-cabin",
      detachedSensorIds: [sensor.id],
      integration: demo.integration,
    });
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.state.sensors.find((candidate) => candidate.id === sensor.id)).toHaveProperty("tpLinkConnectionId", "hub-assignment"));

    await act(async () => { await result.current.moveTpLink("hub-assignment", "house-cabin"); });

    expect(mocks.moveTpLink).toHaveBeenCalledWith("hub-assignment", "house-cabin");
    const detached = result.current.state.sensors.find((candidate) => candidate.id === sensor.id)!;
    expect(detached).not.toHaveProperty("tpLinkDeviceId");
    expect(detached).not.toHaveProperty("tpLinkConnectionId");
    expect(detached.houseId).toBe(sensor.houseId);
  });

  it("coalesces concurrent TP-Link inventory refreshes for the same Home", async () => {
    const currentDevice: TpLinkDiscoveredDevice = {
      houseId: "house-main", deviceId: "child-current", model: "T315", alias: "Current", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    const refreshedDevice = { ...currentDevice, alias: "Refreshed" };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.tpLinkDevicesLoading).toBe(false));

    const callsBeforeRefresh = mocks.tpLinkDevices.mock.calls.length;
    const refreshRequest = deferred<TpLinkDiscoveredDevice[]>();
    mocks.tpLinkDevices.mockReturnValueOnce(refreshRequest.promise);
    let firstRefresh!: Promise<TpLinkDiscoveredDevice[]>;
    let secondRefresh!: Promise<TpLinkDiscoveredDevice[]>;
    act(() => {
      firstRefresh = result.current.refreshTpLinkDevices("house-main");
      secondRefresh = result.current.refreshTpLinkDevices("house-main");
    });
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
    expect(result.current.tpLinkDevicesLoading).toBe(true);

    await act(async () => {
      refreshRequest.resolve([currentDevice]);
      await Promise.all([firstRefresh, secondRefresh]);
    });
    expect(result.current.tpLinkDevices).toEqual([currentDevice]);
    expect(result.current.tpLinkDevicesLoading).toBe(false);

    mocks.tpLinkDevices.mockResolvedValueOnce([refreshedDevice]);
    await act(async () => { await result.current.refreshTpLinkDevices("house-main"); });
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(callsBeforeRefresh + 2);
    expect(result.current.tpLinkDevices).toEqual([refreshedDevice]);
  });

  it("runs one trailing forced TP-Link refresh after an older request", async () => {
    const staleDevice: TpLinkDiscoveredDevice = {
      houseId: "house-main", deviceId: "child-current", model: "T315", alias: "Stale", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    const freshDevice = { ...staleDevice, alias: "Fresh" };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.tpLinkDevicesLoading).toBe(false));

    const callsBeforeRefresh = mocks.tpLinkDevices.mock.calls.length;
    const staleRequest = deferred<TpLinkDiscoveredDevice[]>();
    const freshRequest = deferred<TpLinkDiscoveredDevice[]>();
    mocks.tpLinkDevices
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(freshRequest.promise);

    let olderRefresh!: Promise<TpLinkDiscoveredDevice[]>;
    let firstForcedRefresh!: Promise<TpLinkDiscoveredDevice[]>;
    let secondForcedRefresh!: Promise<TpLinkDiscoveredDevice[]>;
    act(() => {
      olderRefresh = result.current.refreshTpLinkDevices("house-main");
      firstForcedRefresh = result.current.refreshTpLinkDevices("house-main", { force: true });
      secondForcedRefresh = result.current.refreshTpLinkDevices("house-main", { force: true });
    });
    expect(firstForcedRefresh).toBe(secondForcedRefresh);
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(callsBeforeRefresh + 1);

    await act(async () => {
      staleRequest.resolve([staleDevice]);
      await olderRefresh;
    });
    await waitFor(() => expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(callsBeforeRefresh + 2));

    await act(async () => {
      freshRequest.resolve([freshDevice]);
      await Promise.all([firstForcedRefresh, secondForcedRefresh]);
    });
    expect(result.current.tpLinkDevices).toEqual([freshDevice]);
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(callsBeforeRefresh + 2);
  });

  it("refreshes discovered TP-Link children when polling or inventory changes", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-later", model: "T315", alias: "Utility room", status: "online",
      temperature: 19.4, humidity: 51, battery: 93, lastSeenAt: "2026-07-14T12:01:00.000Z", mappedSensorId: null,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(1));
    const [[handleEvent]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const pollOnlyIntegration = {
      ...result.current.state.integration,
      tpLink: {
        ...result.current.state.integration.tpLink,
        connected: true,
        lastPollAt: "2026-07-14T12:01:00.000Z",
      },
    };
    mocks.tpLinkDevices.mockResolvedValueOnce([]);

    act(() => handleEvent({ type: "integration", data: pollOnlyIntegration }));
    await waitFor(() => expect(result.current.state.integration).toEqual(pollOnlyIntegration));
    await waitFor(() => expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(2));

    act(() => handleEvent({ type: "integration", data: pollOnlyIntegration }));
    await waitFor(() => expect(result.current.state.integration).toEqual(pollOnlyIntegration));
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(2);

    const inventoryChangedIntegration = {
      ...pollOnlyIntegration,
      tpLink: {
        ...pollOnlyIntegration.tpLink,
        discoveredDevices: pollOnlyIntegration.tpLink.discoveredDevices + 1,
      },
    };
    mocks.tpLinkDevices.mockResolvedValueOnce([device]);

    act(() => handleEvent({ type: "integration", data: inventoryChangedIntegration }));

    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([device]));
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(3);

    act(() => handleEvent({ type: "integration", data: inventoryChangedIntegration }));
    await waitFor(() => expect(result.current.state.integration).toEqual(inventoryChangedIntegration));
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(3);
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

  it("rolls a failed move back to a placement saved through the sensor editor", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const sensor = result.current.state.sensors[0]!;
    const dragged = { ...sensor, x: sensor.x + 10, y: sensor.y + 10 };
    const edited = { ...dragged, x: sensor.x + 20, y: sensor.y + 20 };
    mocks.updateSensor
      .mockResolvedValueOnce(dragged)
      .mockResolvedValueOnce(edited)
      .mockRejectedValueOnce(new Error("Position save failed"));

    act(() => result.current.moveSensor(sensor.id, { x: dragged.x, y: dragged.y }));
    await waitFor(() => expect(mocks.updateSensor).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await result.current.updateSensor(sensor.id, { x: edited.x, y: edited.y }); });
    act(() => result.current.moveSensor(sensor.id, { x: sensor.x + 30, y: sensor.y + 30 }));

    await waitFor(() => expect(result.current.state.sensors.find((item) => item.id === sensor.id)).toMatchObject({
      x: edited.x,
      y: edited.y,
    }));
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
