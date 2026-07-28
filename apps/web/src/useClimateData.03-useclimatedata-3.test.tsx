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
  OpeningStateObservation,
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
    expect(result.current.state.latestMeasurements[sensor.id]?.temperature).toMatchObject({
      value: liveReading.temperature,
      timestamp: liveReading.timestamp,
      source: liveReading.source,
    });
    expect(result.current.state.measurementHistory[sensor.id]?.temperature?.at(-1)).toMatchObject({
      value: liveReading.temperature,
      timestamp: liveReading.timestamp,
      source: liveReading.source,
    });
  });

  it("exposes the latest live opening observation from the shared event stream", async () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const observation: OpeningStateObservation = {
      id: "opening-live",
      houseId: house.id,
      floorId: house.floors[0]!.id,
      elementId: "door-live",
      state: "open",
      source: "tapo",
      observedAt: new Date().toISOString(),
    };
    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];

    act(() => handleTelemetry({ type: "opening", data: observation }));

    expect(result.current.state.latestOpeningStateObservation).toEqual(observation);
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
});
