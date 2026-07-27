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

  it("does not treat guest-forbidden administrative bootstrap resources as a service outage", async () => {
    const demo = createDemoState();
    const visibleHouse = demo.houses[0]!;
    const forbidden = Object.assign(
      new Error("Guest accounts cannot access administrative configuration"),
      { status: 403 },
    );
    mocks.session.mockResolvedValue({
      authenticated: true,
      principal: { type: "access", email: "guest@example.test" },
      tenant: { id: "tenant-1", name: "Pine Estate", role: "guest" },
      availableTenants: [{ id: "tenant-1", name: "Pine Estate", role: "guest" }],
      readOnly: true,
      grants: [{ scopeType: "house", scopeId: visibleHouse.id }],
    });
    mocks.houses.mockResolvedValue([visibleHouse]);
    mocks.integrations.mockRejectedValue(forbidden);
    mocks.scenarios.mockRejectedValue(forbidden);
    mocks.tpLinkDevices.mockRejectedValue(forbidden);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.state.session.readOnly).toBe(true);
    expect(mocks.snapshot).toHaveBeenCalledWith(visibleHouse.id);
    expect(mocks.integrations).not.toHaveBeenCalled();
    expect(mocks.scenarios).not.toHaveBeenCalled();
    expect(mocks.tpLinkDevices).not.toHaveBeenCalled();
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
});
