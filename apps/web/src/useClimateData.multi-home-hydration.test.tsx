import { act, renderHook, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  House,
  ManualObservation,
  MeasurementSample,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
} from "@climate-twin/contracts";

import { createDemoState } from "./domain";

import { useClimateData } from "./useClimateData";

import { mocks } from "./useClimateDataApiMock";

import { deferred, twoHouseFixture } from "./useClimateDataTestSupport";

vi.mock("./api", async () => (await import("./useClimateDataApiMock")).apiModuleMock);

vi.mock("./authEpoch", async () => (await import("./useClimateDataApiMock")).authEpochModuleMock);

function useTwoHouseApi(fixture: ReturnType<typeof twoHouseFixture>) {
  const { firstHouse, secondHouse, firstSensor, secondSensor, firstSample, secondSample, firstObservation, secondObservation } = fixture;
  mocks.houses.mockResolvedValue([firstHouse, secondHouse]);
  mocks.sensors.mockImplementation(async (houseId?: string) => houseId === undefined
    ? [firstSensor, secondSensor]
    : houseId === secondHouse.id ? [secondSensor] : [firstSensor]);
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

  it("keeps initial telemetry requests constant as secondary homes grow", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const secondaryHouses: House[] = [
      fixture.secondHouse,
      ...Array.from({ length: 24 }, (_, index) => ({
        ...fixture.secondHouse,
        id: `house-secondary-${index}`,
        name: `Secondary home ${index}`,
      })),
    ];
    mocks.houses.mockResolvedValue([fixture.firstHouse, ...secondaryHouses]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    expect(result.current.state.houses).toHaveLength(26);
    expect(mocks.sensors).toHaveBeenCalledOnce();
    expect(mocks.sensors).toHaveBeenCalledWith();
    expect(mocks.snapshot.mock.calls.map(([houseId]) => houseId)).toEqual([fixture.firstHouse.id]);
    expect(mocks.measurementSnapshot.mock.calls.map(([houseId]) => houseId)).toEqual([fixture.firstHouse.id]);
    expect(result.current.state.sensors.map((sensor) => sensor.id).sort()).toEqual([
      fixture.firstSensor.id,
      fixture.secondSensor.id,
    ].sort());
  });

  it("indexes a secondary home's alert and targeted rule before hydrating its telemetry", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const secondaryRule = {
      ...fixture.demo.alertRules[0]!,
      id: "rule-lake-temperature",
      sensorId: fixture.secondSensor.id,
      name: "Lake temperature",
    };
    const secondaryAlert = {
      ...fixture.demo.alerts[0]!,
      id: "alert-lake-temperature",
      ruleId: secondaryRule.id,
      sensorId: fixture.secondSensor.id,
    };
    mocks.alertRules.mockResolvedValue([secondaryRule]);
    mocks.alerts.mockResolvedValue([secondaryAlert]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    const indexedSensor = result.current.state.sensors.find((sensor) => sensor.id === secondaryAlert.sensorId);
    expect(indexedSensor).toMatchObject({
      id: fixture.secondSensor.id,
      houseId: fixture.secondHouse.id,
      name: fixture.secondSensor.name,
    });
    expect(result.current.state.alerts).toContainEqual(secondaryAlert);
    expect(result.current.state.alertRules).toContainEqual(secondaryRule);
    expect(mocks.sensors).toHaveBeenCalledOnce();
    expect(mocks.sensors).toHaveBeenCalledWith();
    expect(mocks.snapshot.mock.calls.map(([houseId]) => houseId)).toEqual([fixture.firstHouse.id]);
    expect(mocks.measurementSnapshot.mock.calls.map(([houseId]) => houseId)).toEqual([fixture.firstHouse.id]);

    await act(async () => { await result.current.selectHouse(indexedSensor!.houseId); });
    expect(mocks.snapshot.mock.calls.map(([houseId]) => houseId)).toEqual([
      fixture.firstHouse.id,
      fixture.secondHouse.id,
    ]);
  });

  it("ignores live telemetry for an indexed but unselected secondary home", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const secondaryReading = {
      ...fixture.demo.readings[fixture.firstSensor.id]!,
      sensorId: fixture.secondSensor.id,
      temperature: 31.2,
    };

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    const [[handleTelemetry]] = mocks.subscribeToEvents.mock.calls as unknown as [[(event: TelemetryEvent) => void]];
    const [[handleMeasurement]] = mocks.subscribeToMeasurementEvents.mock.calls as unknown as [[(sample: MeasurementSample) => void]];

    act(() => {
      handleTelemetry({ type: "reading", data: secondaryReading });
      handleMeasurement({ ...fixture.secondSample, value: 31.2 });
    });

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(result.current.state.readings[fixture.secondSensor.id]).toBeUndefined();
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]).toBeUndefined();
    expect(result.current.state.measurementHistory[fixture.secondSensor.id]).toBeUndefined();
  });

  it("hydrates only the selected secondary home and preserves the active home", async () => {
    const fixture = twoHouseFixture();
    useTwoHouseApi(fixture);
    const unselectedHouses: House[] = Array.from({ length: 8 }, (_, index) => ({
      ...fixture.secondHouse,
      id: `house-unselected-${index}`,
      name: `Unselected home ${index}`,
    }));
    mocks.houses.mockResolvedValue([fixture.firstHouse, fixture.secondHouse, ...unselectedHouses]);

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));
    await act(async () => { await result.current.selectHouse(fixture.secondHouse.id); });

    expect(mocks.snapshot.mock.calls.map(([houseId]) => houseId)).toEqual([
      fixture.firstHouse.id,
      fixture.secondHouse.id,
    ]);
    expect(mocks.measurementSnapshot.mock.calls.map(([houseId]) => houseId)).toEqual([
      fixture.firstHouse.id,
      fixture.secondHouse.id,
    ]);
    expect(result.current.state.sensors.map((sensor) => sensor.id).sort()).toEqual([
      fixture.firstSensor.id,
      fixture.secondSensor.id,
    ].sort());
    expect(result.current.state.latestMeasurements[fixture.firstSensor.id]?.temperature).toEqual(fixture.firstSample);
    expect(result.current.state.latestMeasurements[fixture.secondSensor.id]?.temperature).toEqual(fixture.secondSample);
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
});
