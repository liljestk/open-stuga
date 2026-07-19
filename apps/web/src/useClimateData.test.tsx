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

  it("keeps telemetry empty until the API positively confirms demo mode", async () => {
    mocks.houses.mockReturnValueOnce(new Promise(() => undefined));
    const { result, unmount } = renderHook(() => useClimateData());

    // Authentication deliberately precedes all workspace inventory calls.
    // Wait until that boundary is crossed so this one-shot pending response is
    // consumed before the hook is unmounted.
    await waitFor(() => expect(mocks.houses).toHaveBeenCalledOnce());

    expect(result.current.loading).toBe(true);
    expect(result.current.dataMode).toBe("unknown");
    expect(result.current.state.readings).toEqual({});
    expect(result.current.state.latestMeasurements).toEqual({});
    expect(result.current.state.history).toEqual({});
    unmount();
  });

  it("stops at first-owner setup without requesting workspace data", async () => {
    mocks.session.mockResolvedValue({
      authenticated: false,
      principal: { type: "setup-required", email: null },
      tenant: { id: "local", name: "Local Stuga", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
      readOnly: true,
      grants: [],
      setupRequired: true,
    });

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("setup-required"));

    expect(mocks.properties).not.toHaveBeenCalled();
    expect(mocks.houses).not.toHaveBeenCalled();
    expect(mocks.subscribeToEvents).not.toHaveBeenCalled();
    expect(result.current.state.properties).toEqual([]);
  });

  it("stops at sign-in after a 401 without requesting workspace data", async () => {
    mocks.session.mockRejectedValue(Object.assign(new Error("Sign in"), { status: 401 }));

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("login-required"));

    expect(mocks.properties).not.toHaveBeenCalled();
    expect(mocks.houses).not.toHaveBeenCalled();
    expect(mocks.subscribeToEvents).not.toHaveBeenCalled();
    expect(result.current.state.houses).toEqual([]);
    expect(result.current.bootstrapError).toBeNull();
  });

  it("purges every exposed workspace cache and stays locked after local sign-out", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-auth-boundary", model: "T315", alias: "Office", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    mocks.tpLinkDevices.mockResolvedValue([device]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([device]));
    const sessionCalls = mocks.session.mock.calls.length;

    act(() => result.current.endSession());

    expect(result.current.bootstrapStatus).toBe("login-required");
    expect(result.current.state.session.authenticated).toBe(false);
    expect(result.current.state.houses).toEqual([]);
    expect(result.current.state.properties).toEqual([]);
    expect(result.current.state.latestMeasurements).toEqual({});
    expect(result.current.tpLinkDevices).toEqual([]);
    expect(result.current.tpLinkDevicesLoading).toBe(false);
    expect(result.current.tpLinkDevicesError).toBeNull();
    expect(result.current.resourceErrors).toEqual({});
    expect(result.current.seriesStates).toEqual({});
    expect(mocks.cancelPendingApiRequests).toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
    expect(mocks.session).toHaveBeenCalledTimes(sessionCalls);
  });

  it("locks after an authorization revalidation receives a session 401", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    const authorizationListener = mocks.subscribeToApiAuthorizationChanges.mock.calls.at(-1)?.[0];
    const before = mocks.session.mock.calls.length;
    mocks.session.mockRejectedValueOnce(Object.assign(new Error("Sign in"), { status: 401 }));

    act(() => authorizationListener?.("changed"));
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("login-required"));
    expect(result.current.state.houses).toEqual([]);
    expect(mocks.session).toHaveBeenCalledTimes(before + 1);

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
    expect(mocks.session).toHaveBeenCalledTimes(before + 1);
  });

  it("fails closed without demo telemetry when initial API confirmation fails", async () => {
    mocks.houses.mockRejectedValueOnce(new Error("API unavailable"));
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.connection).toBe("offline");
    expect(result.current.dataMode).toBe("unknown");
    expect(result.current.bootstrapStatus).toBe("unavailable");
    expect(result.current.state.readings).toEqual({});
    expect(result.current.state.latestMeasurements).toEqual({});
    expect(result.current.state.measurementHistory).toEqual({});
    expect(result.current.state.alerts).toEqual([]);
  });

  it("derives connection health from both live streams independently", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, legacyState] = mocks.subscribeToEvents.mock.calls[0] as unknown as [
      (event: TelemetryEvent) => void,
      (state: "live" | "reconnecting") => void,
    ];
    const [, measurementState] = mocks.subscribeToMeasurementEvents.mock.calls[0] as unknown as [
      (sample: MeasurementSample) => void,
      (state: "live" | "reconnecting") => void,
    ];

    expect(result.current.connection).toBe("offline");
    act(() => legacyState("live"));
    expect(result.current.connection).toBe("reconnecting");
    act(() => measurementState("live"));
    expect(result.current.connection).toBe("live");
    act(() => legacyState("reconnecting"));
    expect(result.current.connection).toBe("reconnecting");
    act(() => legacyState("live"));
    expect(result.current.connection).toBe("live");
    act(() => measurementState("reconnecting"));
    expect(result.current.connection).toBe("reconnecting");
  });

  it("waits for each distinct stream to open before starting snapshot hydration", async () => {
    mocks.subscribeToEvents.mockImplementation(() => vi.fn());
    mocks.subscribeToMeasurementEvents.mockImplementation(() => vi.fn());
    renderHook(() => useClimateData());
    await waitFor(() => expect(mocks.subscribeToMeasurementEvents).toHaveBeenCalledOnce());
    const legacyOpen = mocks.subscribeToEvents.mock.calls[0]?.[2];
    const measurementOpen = mocks.subscribeToMeasurementEvents.mock.calls[0]?.[2];

    act(() => { legacyOpen?.(); legacyOpen?.(); });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    act(() => measurementOpen?.());
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
  });

  it("resyncs once after both streams recover, without rehydrating on their initial live transition", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderHook(() => useClimateData());
    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      const [, legacyState] = mocks.subscribeToEvents.mock.calls[0]!;
      const [, measurementState] = mocks.subscribeToMeasurementEvents.mock.calls[0]!;
      const initialSnapshots = mocks.snapshot.mock.calls.length;

      act(() => { legacyState("live"); measurementState("live"); });
      await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); });
      expect(mocks.snapshot).toHaveBeenCalledTimes(initialSnapshots);

      act(() => { legacyState("reconnecting"); measurementState("reconnecting"); });
      act(() => legacyState("live"));
      await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); });
      expect(mocks.snapshot).toHaveBeenCalledTimes(initialSnapshots);

      act(() => measurementState("live"));
      await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); });
      expect(mocks.snapshot).toHaveBeenCalledTimes(initialSnapshots + 1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("ignores callbacks queued by streams closed during a bootstrap retry", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const prior = demo.latestMeasurements[sensor.id]!.temperature!;
    const staleStreamSample: MeasurementSample = {
      ...prior,
      timestamp: new Date(Date.parse(prior.timestamp) + 60_000).toISOString(),
      value: 39.5,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, oldLegacyState] = mocks.subscribeToEvents.mock.calls[0]!;
    const [oldMeasurement, oldMeasurementState] = mocks.subscribeToMeasurementEvents.mock.calls[0]!;

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(mocks.subscribeToMeasurementEvents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      oldLegacyState("live");
      oldMeasurementState("live");
      oldMeasurement(staleStreamSample);
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 25)); });

    expect(result.current.connection).toBe("offline");
    expect(result.current.state.latestMeasurements[sensor.id]?.temperature?.value).not.toBe(39.5);
  });

  it("treats a polling compatibility heartbeat as periodic refresh, never continuous live", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleEvent]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];

    act(() => handleEvent({
      type: "heartbeat",
      data: {
        timestamp: "2026-07-16T12:00:00.000Z",
        mode: "polling-compatibility",
        continuous: false,
        finite: true,
        reconnectAfterMs: 60_000,
      },
    } as unknown as TelemetryEvent));

    expect(result.current.pollingFallback).toBe(true);
    expect(result.current.connection).toBe("reconnecting");
  });

  it("debounces mutation events into one authoritative live refresh", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleEvent]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    mocks.session.mockClear();

    act(() => {
      handleEvent({ type: "mutation", data: { method: "PATCH", resource: "/sensors/sensor-living", occurredAt: "2026-07-16T12:00:00.000Z" } });
      handleEvent({ type: "mutation", data: { method: "POST", resource: "/property-notes", occurredAt: "2026-07-16T12:00:00.100Z" } });
    });

    await waitFor(() => expect(mocks.session).toHaveBeenCalledTimes(1), { timeout: 1_500 });
  });

  it("distinguishes an empty installation from an unavailable service and can retry", async () => {
    const demo = createDemoState();
    mocks.properties.mockResolvedValueOnce([]).mockResolvedValueOnce(demo.properties);
    mocks.houses.mockResolvedValueOnce([]).mockResolvedValueOnce(demo.houses);
    const { result } = renderHook(() => useClimateData());

    await waitFor(() => expect(result.current.bootstrapStatus).toBe("empty"));
    expect(result.current.state.houses).toEqual([]);
    expect(result.current.bootstrapError).toBeNull();

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    expect(result.current.state.houses).toHaveLength(demo.houses.length);
  });

  it("loads scoped area maintenance for a guest that cannot see any houses", async () => {
    const demo = createDemoState();
    const task: MaintenanceTask = {
      id: "maintenance-area-only",
      propertyId: demo.properties[0]!.id,
      houseId: null,
      floorId: null,
      areaId: "area-well",
      equipmentId: null,
      title: "Inspect well cover",
      description: null,
      basis: "scheduled",
      basisDetail: null,
      priority: "normal",
      plannedFor: "2026-08-01",
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
    mocks.session.mockResolvedValue({
      authenticated: true,
      principal: { type: "access", email: "guest@example.test" },
      tenant: { id: "tenant-1", name: "Pine Estate", role: "guest" },
      availableTenants: [{ id: "tenant-1", name: "Pine Estate", role: "guest" }],
      readOnly: true,
      grants: [{ scopeType: "area", scopeId: "area-well" }],
    });
    mocks.houses.mockResolvedValue([]);
    mocks.properties.mockResolvedValue(demo.properties);
    mocks.maintenanceTasks.mockResolvedValue([task]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    expect(mocks.maintenanceTasks).toHaveBeenCalledWith();
    expect(result.current.state.houses).toEqual([]);
    expect(result.current.state.maintenanceTasks).toEqual([task]);
  });

  it("preserves area-scoped maintenance whose house is outside a mixed guest grant", async () => {
    const demo = createDemoState();
    const visibleHouse = demo.houses[0]!;
    const areaTask: MaintenanceTask = {
      id: "maintenance-hidden-house-area",
      propertyId: demo.properties[0]!.id,
      houseId: "house-not-granted",
      floorId: null,
      areaId: "area-granted",
      equipmentId: null,
      title: "Inspect granted well",
      description: null,
      basis: "scheduled",
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
    mocks.session.mockResolvedValue({
      authenticated: true,
      principal: { type: "access", email: "guest@example.test" },
      tenant: { id: "tenant-1", name: "Pine Estate", role: "guest" },
      availableTenants: [{ id: "tenant-1", name: "Pine Estate", role: "guest" }],
      readOnly: true,
      grants: [
        { scopeType: "house", scopeId: visibleHouse.id },
        { scopeType: "area", scopeId: "area-granted" },
      ],
    });
    mocks.houses.mockResolvedValue([visibleHouse]);
    mocks.maintenanceTasks.mockImplementation(async (filters?: { houseId?: string }) => filters?.houseId ? [] : [areaTask]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    await waitFor(() => expect(result.current.state.maintenanceTasks).toContainEqual(areaTask));

    expect(mocks.maintenanceTasks).toHaveBeenCalledWith();
    expect(mocks.maintenanceTasks).toHaveBeenCalledWith({ houseId: visibleHouse.id });
  });

  it("creates and reconciles property maintenance without any house", async () => {
    const demo = createDemoState();
    const propertyId = demo.properties[0]!.id;
    const saved: MaintenanceTask = {
      id: "maintenance-land-only",
      propertyId,
      houseId: null,
      floorId: null,
      areaId: "area-orchard",
      equipmentId: null,
      title: "Prune the orchard",
      description: null,
      basis: "scheduled",
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
    mocks.houses.mockResolvedValue([]);
    mocks.createMaintenanceTask.mockResolvedValue(saved);
    mocks.maintenanceTasks.mockResolvedValue([]);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    await act(async () => {
      await result.current.createMaintenanceTask({
        propertyId,
        houseId: null,
        areaId: "area-orchard",
        title: saved.title,
        basis: "scheduled",
      });
    });

    expect(mocks.createMaintenanceTask).toHaveBeenCalledWith({
      propertyId,
      houseId: null,
      areaId: "area-orchard",
      title: saved.title,
      basis: "scheduled",
    });
    expect(result.current.state.maintenanceTasks).toEqual([saved]);

    const refreshed = { ...saved, areaId: "area-new-orchard", revision: 2, title: "Prune and inspect the orchard" };
    mocks.maintenanceTask.mockResolvedValueOnce(refreshed);
    await act(async () => { await result.current.reloadMaintenanceTask(saved.id); });
    expect(mocks.maintenanceTask).toHaveBeenCalledWith(saved.id);
    expect(result.current.state.maintenanceTasks).toEqual([refreshed]);
  });

  it("reconciles server-authored aggregate context after moving a property area", async () => {
    const demo = createDemoState();
    const sourceProperty = demo.properties[0]!;
    const targetProperty = {
      ...sourceProperty,
      id: "property-lake",
      name: "Lake Estate",
    };
    const sourceArea: PropertyArea = {
      id: "area-well",
      propertyId: sourceProperty.id,
      name: "Well",
      kind: "well",
      description: null,
      polygon: [
        { latitude: 60.1, longitude: 22.1 },
        { latitude: 60.1, longitude: 22.2 },
        { latitude: 60.2, longitude: 22.2 },
      ],
      createdAt: "2026-07-16T07:00:00.000Z",
      updatedAt: "2026-07-16T07:00:00.000Z",
    };
    const savedArea: PropertyArea = {
      ...sourceArea,
      propertyId: targetProperty.id,
      updatedAt: "2026-07-16T08:00:00.000Z",
    };
    const sourceEquipment: AreaEquipment = {
      id: "equipment-pump",
      propertyId: sourceProperty.id,
      areaId: sourceArea.id,
      name: "Well pump",
      kind: "pump",
      manufacturer: null,
      model: null,
      serialNumber: null,
      status: "active",
      notes: null,
      createdAt: sourceArea.createdAt,
      updatedAt: sourceArea.updatedAt,
    };
    const sourceNote: PropertyNote = {
      id: "note-well",
      propertyId: sourceProperty.id,
      houseId: null,
      areaId: sourceArea.id,
      equipmentId: null,
      kind: "inspection",
      text: "Inspect the well cover",
      createdAt: sourceArea.createdAt,
      updatedAt: sourceArea.updatedAt,
    };
    const sourceTask: MaintenanceTask = {
      id: "maintenance-well",
      propertyId: sourceProperty.id,
      houseId: demo.houses[0]!.id,
      floorId: demo.houses[0]!.floors[0]!.id,
      areaId: sourceArea.id,
      equipmentId: sourceEquipment.id,
      title: "Service the well pump",
      description: null,
      basis: "scheduled",
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
      createdAt: sourceArea.createdAt,
      updatedAt: sourceArea.updatedAt,
    };
    const serverUpdatedAt = "2026-07-16T08:00:01.000Z";
    const authoritativeEquipment = { ...sourceEquipment, propertyId: targetProperty.id, updatedAt: serverUpdatedAt };
    const authoritativeNote = { ...sourceNote, propertyId: targetProperty.id, updatedAt: serverUpdatedAt };
    const authoritativeTask = {
      ...sourceTask,
      propertyId: targetProperty.id,
      houseId: null,
      floorId: null,
      revision: 4,
      updatedAt: serverUpdatedAt,
    };
    const equipmentRefresh = deferred<AreaEquipment[]>();
    const noteRefresh = deferred<PropertyNote[]>();
    const maintenanceRefresh = deferred<MaintenanceTask[]>();
    let equipmentRequests = 0;
    let noteRequests = 0;
    let globalMaintenanceRequests = 0;

    mocks.properties.mockResolvedValue([sourceProperty, targetProperty]);
    mocks.propertyAreas.mockResolvedValue([sourceArea]);
    mocks.areaEquipment.mockImplementation(async () => {
      equipmentRequests += 1;
      return equipmentRequests === 1 ? [sourceEquipment] : equipmentRefresh.promise;
    });
    mocks.propertyNotes.mockImplementation(async () => {
      noteRequests += 1;
      return noteRequests === 1 ? [sourceNote] : noteRefresh.promise;
    });
    mocks.maintenanceTasks.mockImplementation(async (filters?: { houseId?: string }) => {
      if (filters?.houseId) return [sourceTask];
      globalMaintenanceRequests += 1;
      return globalMaintenanceRequests === 1 ? [sourceTask] : maintenanceRefresh.promise;
    });
    mocks.updatePropertyArea.mockResolvedValue(savedArea);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.state.propertyAreas).toEqual([sourceArea]));
    await waitFor(() => expect(result.current.state.maintenanceTasks).toEqual([sourceTask]));

    await act(async () => {
      await result.current.updatePropertyArea(sourceArea.id, { propertyId: targetProperty.id });
    });

    expect(mocks.updatePropertyArea).toHaveBeenCalledWith(sourceArea.id, { propertyId: targetProperty.id });
    expect(result.current.state.areaEquipment).toEqual([{ ...sourceEquipment, propertyId: targetProperty.id, updatedAt: savedArea.updatedAt }]);
    expect(result.current.state.propertyNotes).toEqual([{ ...sourceNote, propertyId: targetProperty.id, updatedAt: savedArea.updatedAt }]);
    expect(result.current.state.maintenanceTasks).toEqual([{
      ...sourceTask,
      propertyId: targetProperty.id,
      houseId: null,
      floorId: null,
      revision: 2,
      updatedAt: savedArea.updatedAt,
    }]);

    await act(async () => {
      equipmentRefresh.resolve([authoritativeEquipment]);
      noteRefresh.resolve([authoritativeNote]);
      maintenanceRefresh.resolve([authoritativeTask]);
      await Promise.all([equipmentRefresh.promise, noteRefresh.promise, maintenanceRefresh.promise]);
    });

    await waitFor(() => expect(result.current.state.areaEquipment).toEqual([authoritativeEquipment]));
    expect(result.current.state.propertyNotes).toEqual([authoritativeNote]);
    expect(result.current.state.maintenanceTasks).toEqual([authoritativeTask]);
    expect(equipmentRequests).toBe(2);
    expect(noteRequests).toBe(2);
    expect(globalMaintenanceRequests).toBe(2);
  });

  it("exposes demo mode only after the API confirms it", async () => {
    const { result } = renderHook(() => useClimateData());
    expect(result.current.dataMode).toBe("unknown");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dataMode).toBe("demo");
  });

  it("uses built-in measurement definitions when that optional bootstrap request fails", async () => {
    const demo = createDemoState();
    mocks.measurementDefinitions.mockRejectedValueOnce(new Error("Definitions endpoint is unavailable"));

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bootstrapStatus).toBe("ready");
    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.state.measurementDefinitions).toEqual(demo.measurementDefinitions);
    expect(mocks.alertRules).toHaveBeenCalledOnce();
    expect(mocks.alerts).toHaveBeenCalledOnce();
    expect(mocks.integrations).toHaveBeenCalledOnce();
    expect(mocks.scenarios).toHaveBeenCalledOnce();
  });

  it("becomes ready and subscribes while auxiliary house and global data remain slow or fail", async () => {
    const demo = createDemoState();
    const observationsRequest = deferred<ManualObservation[]>();
    const measurementRequest = deferred<Array<{ sensorId: string; measurements: Record<string, MeasurementSample> }>>();
    const definitionsRequest = deferred<typeof demo.measurementDefinitions>();
    const lateObservation = { ...demo.observations[0]!, id: "observation-late-optional", note: "Loaded after streams" };
    const sensor = demo.sensors[0]!;
    const lateSample: MeasurementSample = {
      ...demo.latestMeasurements[sensor.id]!.temperature!,
      timestamp: new Date(Date.parse(demo.latestMeasurements[sensor.id]!.temperature!.timestamp) + 60_000).toISOString(),
      value: 28.6,
    };
    mocks.observations.mockReturnValueOnce(observationsRequest.promise);
    mocks.measurementSnapshot.mockReturnValueOnce(measurementRequest.promise);
    mocks.measurementDefinitions.mockReturnValueOnce(definitionsRequest.promise);
    mocks.maintenanceTasks.mockRejectedValueOnce(new Error("Maintenance unavailable"));
    mocks.staticParameters.mockRejectedValueOnce(new Error("Parameters unavailable"));
    mocks.alertRules.mockRejectedValueOnce(new Error("Rules unavailable"));
    mocks.alerts.mockRejectedValueOnce(new Error("Alerts unavailable"));
    mocks.scenarios.mockRejectedValueOnce(new Error("Scenarios unavailable"));

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bootstrapStatus).toBe("ready");
    expect(mocks.subscribeToEvents).toHaveBeenCalledOnce();
    expect(mocks.subscribeToMeasurementEvents).toHaveBeenCalledOnce();
    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.state.alertRules).toEqual([]);
    expect(result.current.state.maintenanceTasks).toEqual([]);

    await act(async () => { observationsRequest.resolve([lateObservation]); });
    await waitFor(() => expect(result.current.state.observations).toEqual([lateObservation]));
    await act(async () => {
      measurementRequest.resolve([{ sensorId: sensor.id, measurements: { temperature: lateSample } }]);
      definitionsRequest.resolve(demo.measurementDefinitions);
    });
    await waitFor(() => expect(result.current.state.latestMeasurements[sensor.id]?.temperature).toEqual(lateSample));
  });

  it("subscribes before core hydration completes and replays telemetry over its snapshot", async () => {
    const demo = createDemoState();
    const sensor = demo.sensors[0]!;
    const staleReading = demo.readings[sensor.id]!;
    const liveReading = {
      ...staleReading,
      timestamp: new Date(Date.parse(staleReading.timestamp) + 60_000).toISOString(),
      temperature: staleReading.temperature + 4,
      source: "home-assistant" as const,
    };
    const integrationRequest = deferred<IntegrationStatus>();
    mocks.integrations.mockReturnValueOnce(integrationRequest.promise);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(mocks.subscribeToEvents).toHaveBeenCalledOnce());
    expect(result.current.loading).toBe(true);
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];

    act(() => handleTelemetry({ type: "reading", data: liveReading }));
    await act(async () => { integrationRequest.resolve(demo.integration); });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state.readings[sensor.id]).toEqual(liveReading);
    expect(result.current.state.history[sensor.id]?.at(-1)).toEqual(liveReading);
  });

  it("retries the currently selected house instead of the initial house", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });
    await waitFor(() => expect(result.current.state.observations).toEqual([fixture.secondObservation]));

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(mocks.houses).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const secondHouseLoads = mocks.observations.mock.calls
        .filter(([houseId]) => houseId === fixture.secondHouse.id);
      expect(secondHouseLoads.length).toBeGreaterThanOrEqual(2);
    });

    expect(result.current.state.observations).toEqual([fixture.secondObservation]);
  });

  it("does not let stale retry globals overwrite newer rule, alert, or integration state", async () => {
    const demo = createDemoState();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.state.alerts.length).toBeGreaterThan(0));
    const staleRulesRequest = deferred<typeof demo.alertRules>();
    const staleAlertsRequest = deferred<typeof demo.alerts>();
    mocks.alertRules.mockReturnValueOnce(staleRulesRequest.promise);
    mocks.alerts.mockReturnValueOnce(staleAlertsRequest.promise);

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(mocks.subscribeToEvents).toHaveBeenCalledTimes(2));
    const savedRule = { ...demo.alertRules[0]!, id: "rule-saved-during-retry", name: "Saved during retry" };
    const { id: _ruleId, ...ruleInput } = savedRule;
    const alert = demo.alerts[0]!;
    const acknowledged = { ...alert, acknowledgedAt: "2026-07-16T09:30:00.000Z" };
    mocks.createAlertRule.mockResolvedValueOnce(savedRule);
    mocks.acknowledgeAlert.mockResolvedValueOnce(acknowledged);
    await act(async () => {
      await result.current.createRule(ruleInput);
      await result.current.acknowledgeAlert(alert.id);
    });
    const updatedIntegration: IntegrationStatus = {
      ...demo.integration,
      tpLink: { ...demo.integration.tpLink, connected: !demo.integration.tpLink.connected },
    };
    act(() => result.current.applyIntegrationStatus(updatedIntegration));
    await act(async () => {
      staleRulesRequest.resolve(demo.alertRules);
      staleAlertsRequest.resolve(demo.alerts);
    });

    expect(result.current.state.alertRules).toContainEqual(savedRule);
    expect(result.current.state.alerts.find((item) => item.id === alert.id)).toEqual(acknowledged);
    expect(result.current.state.integration).toEqual(updatedIntegration);
  });

  it("does not let a stale in-flight retry integration response overwrite a newer status", async () => {
    const demo = createDemoState();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const integrationRequest = deferred<IntegrationStatus>();
    mocks.integrations.mockReturnValueOnce(integrationRequest.promise);
    const updatedIntegration: IntegrationStatus = {
      ...demo.integration,
      homeAssistant: { ...demo.integration.homeAssistant, connected: !demo.integration.homeAssistant.connected },
    };

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(mocks.integrations).toHaveBeenCalledTimes(2));
    act(() => result.current.applyIntegrationStatus(updatedIntegration));
    await act(async () => { integrationRequest.resolve(demo.integration); });
    await waitFor(() => expect(mocks.subscribeToEvents).toHaveBeenCalledTimes(2));

    expect(result.current.state.integration).toEqual(updatedIntegration);
  });

  it("clears demo alerts when a retry discovers real mode and alert hydration fails", async () => {
    const demo = createDemoState();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.state.alerts).toEqual(demo.alerts));
    const realIntegration: IntegrationStatus = {
      ...demo.integration,
      mock: { ...demo.integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-16T10:00:00.000Z" },
    };
    mocks.integrations.mockResolvedValueOnce(realIntegration);
    mocks.alerts.mockRejectedValueOnce(new Error("Alerts temporarily unavailable"));

    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(result.current.state.integration.mock.mode).toBe("real"));

    expect(result.current.dataMode).toBe("real");
    expect(result.current.state.alerts).toEqual([]);
  });

  it("merges a house created during an in-flight retry into the stale inventory response", async () => {
    const demo = createDemoState();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const created: House = { ...demo.houses[0]!, id: "house-created-during-retry", name: "New retreat" };
    const createRequest = deferred<House>();
    const inventoryRequest = deferred<House[]>();
    mocks.createHouse.mockReturnValueOnce(createRequest.promise);
    mocks.houses.mockReturnValueOnce(inventoryRequest.promise);
    let createPromise!: Promise<House>;
    act(() => {
      createPromise = result.current.createHouse({
        name: created.name,
        timezone: created.timezone,
        floors: created.floors,
      });
    });
    await waitFor(() => expect(mocks.createHouse).toHaveBeenCalledOnce());
    act(() => result.current.retryBootstrap());
    await waitFor(() => expect(mocks.houses).toHaveBeenCalledTimes(2));
    await act(async () => {
      createRequest.resolve(created);
      await createPromise;
      inventoryRequest.resolve(demo.houses);
    });

    await waitFor(() => expect(result.current.state.houses).toContainEqual(created));
  });

  it("blocks scenario execution while the environment is unconfirmed", async () => {
    mocks.houses.mockReturnValueOnce(new Promise(() => undefined));
    const { result, unmount } = renderHook(() => useClimateData());
    await expect(result.current.runScenario("leak")).rejects.toThrow("only after demo mode is confirmed");
    expect(result.current.scenario).toBe("normal");
    unmount();
  });

  it("rolls back a rejected optimistic observation revision and loads its audit history", async () => {
    const update = deferred<ManualObservation>();
    mocks.updateObservation.mockReturnValueOnce(update.promise);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const original = result.current.state.observations[0]!;
    let request!: Promise<ManualObservation>;

    act(() => {
      request = result.current.updateObservation(original.id, {
        baseRevision: original.revision ?? 1,
        note: "Pending correction",
      });
    });
    expect(result.current.state.observations[0]).toMatchObject({ note: "Pending correction", revision: (original.revision ?? 1) + 1 });

    await act(async () => {
      update.reject(new Error("Revision conflict"));
      await expect(request).rejects.toThrow("Revision conflict");
    });
    expect(result.current.state.observations[0]).toEqual(original);

    const revision = {
      observationId: original.id,
      revision: original.revision ?? 1,
      changedAt: original.updatedAt ?? original.createdAt,
      actor: "local-rest" as const,
      changedFields: ["note" as const],
      snapshot: original,
    };
    mocks.observationRevisions.mockResolvedValueOnce([revision]);
    await expect(result.current.observationRevisions(original.id)).resolves.toEqual([revision]);
  });

  it("publishes resolve and reopen state only after the server confirms each transition", async () => {
    const pendingResolve = deferred<ManualObservation>();
    mocks.updateObservation.mockReturnValueOnce(pendingResolve.promise);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const original = result.current.state.observations[0]!;
    const baseRevision = original.revision ?? 1;
    let resolveRequest!: Promise<ManualObservation>;

    act(() => {
      resolveRequest = result.current.updateObservation(original.id, {
        baseRevision,
        status: "resolved",
        resolutionNote: "Fixed leak",
      });
    });
    expect(result.current.state.observations[0]).toEqual(original);

    const resolved: ManualObservation = {
      ...original,
      status: "resolved",
      resolutionNote: "Fixed leak",
      resolvedAt: "2026-07-15T08:00:00.000Z",
      revision: baseRevision + 1,
      updatedAt: "2026-07-15T08:00:00.000Z",
    };
    await act(async () => {
      pendingResolve.resolve(resolved);
      await resolveRequest;
    });
    expect(result.current.state.observations[0]).toEqual(resolved);

    const reopened: ManualObservation = {
      ...resolved,
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: baseRevision + 2,
      updatedAt: "2026-07-15T09:00:00.000Z",
    };
    const pendingReopen = deferred<ManualObservation>();
    mocks.updateObservation.mockReturnValueOnce(pendingReopen.promise);
    let reopenRequest!: Promise<ManualObservation>;
    act(() => {
      reopenRequest = result.current.updateObservation(original.id, {
        baseRevision: baseRevision + 1,
        status: "open",
        resolutionNote: null,
      });
    });
    expect(result.current.state.observations[0]).toEqual(resolved);

    await act(async () => {
      pendingReopen.resolve(reopened);
      await reopenRequest;
    });
    expect(result.current.state.observations[0]).toEqual(reopened);
  });

  it("reloads an observation from its house and replaces stale observation state", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const original = result.current.state.observations[0]!;
    const fresh: ManualObservation = {
      ...original,
      note: "Server-confirmed inspection",
      revision: (original.revision ?? 1) + 1,
      updatedAt: "2026-07-15T09:30:00.000Z",
    };
    mocks.observations.mockResolvedValueOnce([fresh]);

    let reloaded!: ManualObservation;
    await act(async () => {
      reloaded = await result.current.reloadObservation(original.id);
    });

    expect(mocks.observations).toHaveBeenLastCalledWith(original.houseId);
    expect(reloaded).toEqual(fresh);
    expect(result.current.state.observations).toContainEqual(fresh);
    expect(result.current.state.observations).not.toContainEqual(original);
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
    mocks.snapshot.mockResolvedValue([{ ...sensor, reading: null }]);
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

    await waitFor(() => expect(result.current.state.sensors.map((sensor) => sensor.id).sort()).toEqual([
      fixture.firstSensor.id, fixture.secondSensor.id,
    ].sort()));
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

  it("becomes ready from the active house while portfolio hydration continues in the background", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const secondarySnapshot = deferred<SensorSnapshot[]>();
    mocks.snapshot.mockImplementation(async (houseId: string): Promise<SensorSnapshot[]> => houseId === fixture.secondHouse.id
      ? secondarySnapshot.promise
      : [{ ...fixture.firstSensor, reading: fixture.demo.readings[fixture.firstSensor.id] ?? null }]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bootstrapStatus).toBe("ready");
    expect(result.current.state.sensors.some((sensor) => sensor.id === fixture.firstSensor.id)).toBe(true);
    expect(result.current.state.sensors.some((sensor) => sensor.id === fixture.secondSensor.id)).toBe(false);
    expect(mocks.measurementDefinitions).toHaveBeenCalledOnce();
    expect(mocks.alertRules).toHaveBeenCalledOnce();
    expect(mocks.alerts).toHaveBeenCalledOnce();
    expect(mocks.integrations).toHaveBeenCalledOnce();
    expect(mocks.scenarios).toHaveBeenCalledOnce();
    expect(mocks.sensors).not.toHaveBeenCalled();

    await act(async () => { secondarySnapshot.resolve([{ ...fixture.secondSensor, reading: null }]); });
    await waitFor(() => expect(result.current.state.sensors.some((sensor) => sensor.id === fixture.secondSensor.id)).toBe(true));
    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });

    expect(mocks.measurementDefinitions).toHaveBeenCalledOnce();
    expect(mocks.alertRules).toHaveBeenCalledOnce();
    expect(mocks.alerts).toHaveBeenCalledOnce();
    expect(mocks.integrations).toHaveBeenCalledOnce();
    expect(mocks.scenarios).toHaveBeenCalledOnce();
    expect(mocks.sensors).not.toHaveBeenCalled();
  });

  it("preserves live telemetry received while a secondary house hydrates in the background", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const secondarySnapshot = deferred<SensorSnapshot[]>();
    mocks.snapshot.mockImplementation(async (houseId: string): Promise<SensorSnapshot[]> => houseId === fixture.secondHouse.id
      ? secondarySnapshot.promise
      : [{ ...fixture.firstSensor, reading: fixture.demo.readings[fixture.firstSensor.id] ?? null }]);
    const liveTimestamp = new Date(Date.parse(fixture.secondSample.timestamp) + 60_000).toISOString();
    const liveReading = {
      ...fixture.demo.readings[fixture.firstSensor.id]!,
      sensorId: fixture.secondSensor.id,
      timestamp: liveTimestamp,
      temperature: 25.8,
    };
    const liveSample: MeasurementSample = {
      ...fixture.secondSample,
      timestamp: liveTimestamp,
      value: 25.8,
    };

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledWith(fixture.secondHouse.id));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];

    act(() => {
      handleTelemetry({ type: "reading", data: liveReading });
      handleMeasurement(liveSample);
    });
    expect(result.current.state.sensors.some((sensor) => sensor.id === fixture.secondSensor.id)).toBe(false);
    expect(result.current.state.readings[fixture.secondSensor.id]).toBeUndefined();

    await act(async () => {
      secondarySnapshot.resolve([{ ...fixture.secondSensor, reading: null }]);
    });
    await waitFor(() => expect(result.current.state.sensors.some((sensor) => sensor.id === fixture.secondSensor.id)).toBe(true));

    expect(result.current.state.readings[fixture.secondSensor.id]).toEqual(liveReading);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(liveSample);
    expect(result.current.state.measurementHistory[fixture.secondSensor.id]?.temperature).toContainEqual(liveSample);
  });

  it("does not let a late portfolio response overwrite a house selected in the foreground", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const staleSensor = { ...fixture.secondSensor, name: "Stale portfolio sensor" };
    const freshSensor = { ...fixture.secondSensor, name: "Fresh selected sensor" };
    const freshSample: MeasurementSample = {
      ...fixture.secondSample,
      timestamp: new Date(Date.parse(fixture.secondSample.timestamp) + 1_000).toISOString(),
      value: 19.8,
    };
    let secondHouseSnapshotCalls = 0;
    let secondHouseMeasurementCalls = 0;
    mocks.snapshot.mockImplementation(async (houseId: string): Promise<SensorSnapshot[]> => {
      if (houseId !== fixture.secondHouse.id) {
        return [{ ...fixture.firstSensor, reading: fixture.demo.readings[fixture.firstSensor.id] ?? null }];
      }
      secondHouseSnapshotCalls += 1;
      return secondHouseSnapshotCalls === 1
        ? staleSnapshot.promise
        : [{ ...freshSensor, reading: null }];
    });
    mocks.measurementSnapshot.mockImplementation(async (houseId: string) => {
      if (houseId !== fixture.secondHouse.id) {
        return [{ sensorId: fixture.firstSensor.id, measurements: { temperature: fixture.firstSample } }];
      }
      secondHouseMeasurementCalls += 1;
      const sample = secondHouseMeasurementCalls === 1 ? fixture.secondSample : freshSample;
      return [{ sensorId: fixture.secondSensor.id, measurements: { temperature: sample } }];
    });

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(secondHouseSnapshotCalls).toBe(1));

    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });
    expect(secondHouseSnapshotCalls).toBe(2);
    expect(result.current.state.sensors.find((sensor) => sensor.id === fixture.secondSensor.id)?.name).toBe(freshSensor.name);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(freshSample);

    await act(async () => {
      staleSnapshot.resolve([{ ...staleSensor, reading: null }]);
      await staleSnapshot.promise;
    });
    expect(result.current.state.sensors.find((sensor) => sensor.id === fixture.secondSensor.id)?.name).toBe(freshSensor.name);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(freshSample);
  });

  it("preserves live readings and measurements received during a foreground refresh", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensor = demo.sensors[0]!;
    const staleReading = demo.readings[sensor.id]!;
    const staleSample = demo.latestMeasurements[sensor.id]!.temperature!;
    const liveTimestamp = new Date(Date.parse(staleSample.timestamp) + 60_000).toISOString();
    const liveReading = { ...staleReading, timestamp: liveTimestamp, temperature: 29.4 };
    const liveSample: MeasurementSample = { ...staleSample, timestamp: liveTimestamp, value: 29.4 };
    const snapshotRequest = deferred<SensorSnapshot[]>();
    const measurementRequest = deferred<Array<{ sensorId: string; measurements: Record<string, MeasurementSample> }>>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];
    mocks.snapshot.mockReturnValueOnce(snapshotRequest.promise);
    mocks.measurementSnapshot.mockReturnValueOnce(measurementRequest.promise);

    let refresh!: Promise<void>;
    act(() => { refresh = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    act(() => {
      handleTelemetry({ type: "reading", data: liveReading });
      handleMeasurement(liveSample);
    });
    await act(async () => {
      snapshotRequest.resolve(demo.sensors
        .filter((candidate) => candidate.houseId === house.id)
        .map((candidate) => ({ ...candidate, reading: demo.readings[candidate.id] ?? null })));
      measurementRequest.resolve(Object.entries(demo.latestMeasurements).map(([sensorId, measurements]) => ({
        sensorId,
        measurements,
      })));
      await refresh;
    });

    expect(result.current.state.readings[sensor.id]).toEqual(liveReading);
    expect(result.current.state.latestMeasurements[sensor.id]?.temperature).toEqual(liveSample);
    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toContainEqual(liveSample);
  });

  it("does not let a late house snapshot erase a sensor created during the load", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const created: Sensor = { ...demo.sensors[0]!, id: "sensor-created-during-load", name: "New office sensor" };
    const hydratedObservation: ManualObservation = {
      ...demo.observations[0]!, id: "observation-hydrated-alongside-create", note: "Unrelated hydration survived",
    };
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);
    mocks.observations.mockResolvedValueOnce([hydratedObservation]);
    mocks.createSensor.mockResolvedValueOnce(created);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    const { id: _id, ...input } = created;
    await act(async () => { await result.current.createSensor(input); });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((sensor) => ({ ...sensor, reading: demo.readings[sensor.id] ?? null })));
      await houseLoad;
    });

    expect(result.current.state.sensors).toContainEqual(created);
    await waitFor(() => expect(result.current.state.observations).toEqual([hydratedObservation]));
  });

  it("does not let a late house snapshot revert a sensor updated during the load", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensor = demo.sensors[0]!;
    const saved = { ...sensor, name: "Confirmed updated name" };
    const staleSnapshot = deferred<SensorSnapshot[]>();
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.snapshot.mockReturnValueOnce(staleSnapshot.promise);
    mocks.updateSensor.mockResolvedValueOnce(saved);

    let houseLoad!: Promise<void>;
    act(() => { houseLoad = result.current.selectHouse(house.id); });
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.updateSensor(sensor.id, { name: saved.name }); });
    await act(async () => {
      staleSnapshot.resolve(demo.sensors.map((candidate) => ({ ...candidate, reading: demo.readings[candidate.id] ?? null })));
      await houseLoad;
    });

    expect(result.current.state.sensors.find((candidate) => candidate.id === sensor.id)?.name).toBe(saved.name);
  });

  it("preserves telemetry when a sensor moves into a house whose snapshot is in flight", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.state.sensors).toContainEqual(fixture.secondSensor));
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
    mocks.measurementHistoryPage.mockRejectedValueOnce(new Error("v2 unavailable"));
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
  });

  it("applies a live measurement once even when the legacy reading stream also reports it", async () => {
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

    act(() => handleTelemetry({ type: "reading", data: reading }));
    expect(result.current.state.readings[sensor.id]?.temperature).toBe(26.5);
    expect(result.current.state.latestMeasurements[sensor.id]?.temperature?.value).toBe(priorSample.value);

    act(() => {
      handleMeasurement(sample);
      handleMeasurement(sample);
    });
    await waitFor(() => expect(result.current.state.latestMeasurements[sensor.id]?.temperature?.value).toBe(26.5));
    expect(result.current.state.measurementHistory[sensor.id]?.temperature).toEqual([sample]);
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

  it("keeps only the newest TP-Link refresh result, error, and loading state", async () => {
    const currentDevice: TpLinkDiscoveredDevice = {
      deviceId: "child-current", model: "T315", alias: "Current", status: "online",
      temperature: 21, humidity: 42, battery: 96, lastSeenAt: "2026-07-14T12:00:00.000Z", mappedSensorId: null,
    };
    const staleDevice: TpLinkDiscoveredDevice = { ...currentDevice, deviceId: "child-stale", alias: "Stale" };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.tpLinkDevicesLoading).toBe(false));

    const staleErrorRequest = deferred<TpLinkDiscoveredDevice[]>();
    const latestSuccessRequest = deferred<TpLinkDiscoveredDevice[]>();
    mocks.tpLinkDevices
      .mockReturnValueOnce(staleErrorRequest.promise)
      .mockReturnValueOnce(latestSuccessRequest.promise);
    let staleErrorPromise!: Promise<TpLinkDiscoveredDevice[]>;
    let latestSuccessPromise!: Promise<TpLinkDiscoveredDevice[]>;
    act(() => {
      staleErrorPromise = result.current.refreshTpLinkDevices();
      staleErrorPromise.catch(() => undefined);
      latestSuccessPromise = result.current.refreshTpLinkDevices();
    });
    expect(result.current.tpLinkDevicesLoading).toBe(true);
    await act(async () => {
      latestSuccessRequest.resolve([currentDevice]);
      await latestSuccessPromise;
    });
    expect(result.current.tpLinkDevices).toEqual([currentDevice]);
    expect(result.current.tpLinkDevicesLoading).toBe(false);
    let staleErrorResult: TpLinkDiscoveredDevice[] | undefined;
    await act(async () => {
      staleErrorRequest.reject(new Error("Stale failure"));
      staleErrorResult = await staleErrorPromise;
    });
    expect(staleErrorResult).toEqual([currentDevice]);
    expect(result.current.tpLinkDevices).toEqual([currentDevice]);
    expect(result.current.tpLinkDevicesError).toBeNull();

    const staleSuccessRequest = deferred<TpLinkDiscoveredDevice[]>();
    const latestErrorRequest = deferred<TpLinkDiscoveredDevice[]>();
    mocks.tpLinkDevices
      .mockReturnValueOnce(staleSuccessRequest.promise)
      .mockReturnValueOnce(latestErrorRequest.promise);
    let staleSuccessPromise!: Promise<TpLinkDiscoveredDevice[]>;
    let latestErrorPromise!: Promise<TpLinkDiscoveredDevice[]>;
    act(() => {
      staleSuccessPromise = result.current.refreshTpLinkDevices();
      latestErrorPromise = result.current.refreshTpLinkDevices();
      latestErrorPromise.catch(() => undefined);
    });
    await act(async () => {
      latestErrorRequest.reject(new Error("Newest failure"));
      await latestErrorPromise.catch(() => undefined);
    });
    expect(result.current.tpLinkDevicesLoading).toBe(false);
    expect(result.current.tpLinkDevicesError).toBe("Newest failure");
    let staleSuccessResult: TpLinkDiscoveredDevice[] | undefined;
    await act(async () => {
      staleSuccessRequest.resolve([staleDevice]);
      staleSuccessResult = await staleSuccessPromise;
    });
    expect(staleSuccessResult).toEqual([currentDevice]);
    expect(result.current.tpLinkDevices).toEqual([currentDevice]);
    expect(result.current.tpLinkDevicesError).toBe("Newest failure");
  });

  it("refreshes discovered TP-Link children once when polling status advances", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-later", model: "T315", alias: "Utility room", status: "online",
      temperature: 19.4, humidity: 51, battery: 93, lastSeenAt: "2026-07-14T12:01:00.000Z", mappedSensorId: null,
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(1));
    const [[handleEvent]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const integration = {
      ...result.current.state.integration,
      tpLink: {
        ...result.current.state.integration.tpLink,
        connected: true,
        lastPollAt: "2026-07-14T12:01:00.000Z",
        discoveredDevices: 1,
      },
    };
    mocks.tpLinkDevices.mockResolvedValueOnce([device]);

    act(() => handleEvent({ type: "integration", data: integration }));

    await waitFor(() => expect(result.current.tpLinkDevices).toEqual([device]));
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(2);

    act(() => handleEvent({ type: "integration", data: integration }));
    await waitFor(() => expect(result.current.state.integration).toEqual(integration));
    expect(mocks.tpLinkDevices).toHaveBeenCalledTimes(2);
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
