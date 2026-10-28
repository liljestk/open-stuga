import { act, renderHook, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MaintenanceTask,
  MeasurementSample,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";

import { createDemoState } from "./domain";

import { useClimateData } from "./useClimateData";

import { writeLocalStorage } from "./browserStorage";
import { ApiVersionMismatchError, assertApiRuntimeVersion } from "./apiRuntimeVersion";

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
      tenant: { id: "local", name: "Local Stugu", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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

  it("stops before workspace requests when the API runtime is stale", async () => {
    mocks.session.mockRejectedValueOnce(new ApiVersionMismatchError("0.28.0"));

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("incompatible"));

    expect(mocks.properties).not.toHaveBeenCalled();
    expect(mocks.houses).not.toHaveBeenCalled();
    expect(result.current.bootstrapError).toContain("cannot use API 0.28.0");
  });

  it("blocks an open workspace as soon as a changed API reports another version", async () => {
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    act(() => {
      try {
        assertApiRuntimeVersion("0.28.0", true);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiVersionMismatchError);
      }
    });

    await waitFor(() => expect(result.current.bootstrapStatus).toBe("incompatible"));
    expect(mocks.cancelPendingApiRequests).toHaveBeenCalled();
    expect(result.current.connection).toBe("offline");
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
    writeLocalStorage("logout-proof", "private account state");
    const scopedStorageKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .find((key) => key?.endsWith(".logout-proof"));
    expect(scopedStorageKey).toBeTruthy();
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
    expect(localStorage.getItem(scopedStorageKey!)).toBeNull();
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

  it("rehydrates workspace inventory once after both hidden streams resume, not on initial live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    let unmount: (() => void) | undefined;
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      const hook = renderHook(() => useClimateData());
      unmount = hook.unmount;
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      const initialSessionLoads = mocks.session.mock.calls.length;
      const initialPropertyLoads = mocks.properties.mock.calls.length;
      const initialHouseLoads = mocks.houses.mock.calls.length;
      const initialSnapshotLoads = mocks.snapshot.mock.calls.length;
      const [, initialLegacyState] = mocks.subscribeToEvents.mock.calls[0]!;
      const [, initialMeasurementState] = mocks.subscribeToMeasurementEvents.mock.calls[0]!;

      act(() => {
        initialLegacyState("live");
        initialMeasurementState("live");
      });
      await act(async () => Promise.resolve());
      expect(mocks.session).toHaveBeenCalledTimes(initialSessionLoads);
      expect(mocks.properties).toHaveBeenCalledTimes(initialPropertyLoads);
      expect(mocks.houses).toHaveBeenCalledTimes(initialHouseLoads);

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(mocks.subscribeToMeasurementEvents).toHaveBeenCalledTimes(2));
      const [, resumedLegacyState] = mocks.subscribeToEvents.mock.calls[1]!;
      const [, resumedMeasurementState] = mocks.subscribeToMeasurementEvents.mock.calls[1]!;

      act(() => resumedLegacyState("live"));
      expect(mocks.session).toHaveBeenCalledTimes(initialSessionLoads);
      act(() => resumedMeasurementState("live"));
      await waitFor(() => expect(mocks.session).toHaveBeenCalledTimes(initialSessionLoads + 1));
      await waitFor(() => expect(mocks.properties).toHaveBeenCalledTimes(initialPropertyLoads + 1));
      await waitFor(() => expect(mocks.houses).toHaveBeenCalledTimes(initialHouseLoads + 1));
      await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); });
      expect(mocks.session).toHaveBeenCalledTimes(initialSessionLoads + 1);
      expect(mocks.properties).toHaveBeenCalledTimes(initialPropertyLoads + 1);
      expect(mocks.houses).toHaveBeenCalledTimes(initialHouseLoads + 1);
      expect(mocks.snapshot).toHaveBeenCalledTimes(initialSnapshotLoads + 1);
      unmount();
      unmount = undefined;
    } finally {
      unmount?.();
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
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
});
