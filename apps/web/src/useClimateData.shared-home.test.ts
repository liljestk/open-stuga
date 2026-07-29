import { describe, expect, it } from "vitest";
import { createDemoState } from "./domain";
import { advanceMockTelemetry, isRemoteSharedDemoTelemetry } from "./data/bootstrap/support";

describe("shared Home demo telemetry isolation", () => {
  it("keeps shared sensor labels but removes and never advances their local demo telemetry", () => {
    const state = createDemoState();
    const localSensor = state.sensors[0]!;
    const sharedHouse = {
      ...state.houses[0]!,
      id: "shared-home",
      name: "Shared Home",
      stuguby: {
        stugubyId: "stuguby-test",
        authorityNodeId: "remote-node",
        publicationId: "remote-publication",
        ownership: "shared" as const,
        editPolicy: "read-only" as const,
        syncState: "current" as const,
        authorityEpoch: 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled" as const,
      },
    };
    const sharedSensor = {
      ...localSensor,
      id: "shared-sensor",
      houseId: sharedHouse.id,
      name: "Remote sensor",
      tags: ["stuguby-shared"],
    };
    const sharedReading = {
      ...state.readings[localSensor.id]!,
      sensorId: sharedSensor.id,
    };
    state.houses.push(sharedHouse);
    state.sensors.push(sharedSensor);
    state.readings[sharedSensor.id] = sharedReading;
    state.history[sharedSensor.id] = [sharedReading];
    state.latestMeasurements[sharedSensor.id] = state.latestMeasurements[localSensor.id]!;
    state.measurementHistory[sharedSensor.id] = state.measurementHistory[localSensor.id]!;
    state.forecasts[sharedSensor.id] = state.forecasts[localSensor.id]!;
    state.measurementForecasts[sharedSensor.id] = state.measurementForecasts[localSensor.id]!;

    expect(isRemoteSharedDemoTelemetry(state, sharedSensor.id, "mock")).toBe(true);
    expect(isRemoteSharedDemoTelemetry(state, sharedSensor.id, "replay")).toBe(true);
    expect(isRemoteSharedDemoTelemetry(state, sharedSensor.id, "home-assistant")).toBe(false);

    const next = advanceMockTelemetry(state, "normal", 1);

    expect(next.sensors).toContainEqual(sharedSensor);
    expect(next.readings[localSensor.id]).not.toBe(state.readings[localSensor.id]);
    expect(next.readings[sharedSensor.id]).toBeUndefined();
    expect(next.history[sharedSensor.id]).toBeUndefined();
    expect(next.latestMeasurements[sharedSensor.id]).toBeUndefined();
    expect(next.measurementHistory[sharedSensor.id]).toBeUndefined();
    expect(next.forecasts[sharedSensor.id]).toBeUndefined();
    expect(next.measurementForecasts[sharedSensor.id]).toBeUndefined();

    state.houses = state.houses.map((house) => house.id === sharedHouse.id
      ? { ...house, stuguby: { ...house.stuguby!, syncState: "detached" } }
      : house);
    expect(isRemoteSharedDemoTelemetry(state, sharedSensor.id, "mock")).toBe(false);
  });
});
