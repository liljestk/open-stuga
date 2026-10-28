import { describe, expect, it } from "vitest";
import type { AreaEquipment, HomeMonitoringSummary, PropertyArea } from "@climate-twin/contracts";
import { createDemoState, DEMO_PROPERTY_ID } from "../../domain";
import { derivePropertyTrafficLights } from "./propertyStatus";

const well: PropertyArea = {
  id: "area-well",
  propertyId: DEMO_PROPERTY_ID,
  name: "North well",
  kind: "well",
  description: null,
  polygon: [],
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:00:00.000Z",
};

const connector: AreaEquipment = {
  id: "equipment-well-socket",
  propertyId: DEMO_PROPERTY_ID,
  areaId: well.id,
  name: "Well Tapo Electric socket connector",
  kind: "smart plug",
  manufacturer: "TP-Link",
  model: "P110",
  serialNumber: null,
  status: "active",
  notes: null,
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:00:00.000Z",
};

function byId(lights: ReturnType<typeof derivePropertyTrafficLights>) {
  return Object.fromEntries(lights.map((light) => [light.id, light]));
}

function monitoredOk(houseId: string, enabledSensors: number): HomeMonitoringSummary {
  return {
    houseId,
    generatedAt: "2026-07-17T08:00:00.000Z",
    status: "monitoring-ok",
    pulseStatus: "steady",
    coverage: {
      enabledSensors,
      freshSensors: enabledSensors,
      estimatedSensors: 0,
      agingSensors: 0,
      staleSensors: 0,
      sensorsWithoutData: 0,
    },
    activeAlertCount: 0,
    blockers: [],
  };
}

describe("derivePropertyTrafficLights", () => {
  it("does not infer asset health or failure from an unbound Home connection", () => {
    const state = createDemoState();
    state.alerts = [];
    state.propertyAreas = [well];
    state.areaEquipment = [connector];
    state.integration.tpLink = { ...state.integration.tpLink, configured: true, connected: false };
    const lights = byId(derivePropertyTrafficLights(state, DEMO_PROPERTY_ID, []));

    expect(lights.equipment).toMatchObject({ level: "caution", reason: "not-monitored" });
    expect(lights.well).toMatchObject({ level: "caution", reason: "not-monitored" });
    expect(lights.infrastructure).toBeUndefined();
  });

  it("keeps a well unconfirmed when only unrelated Home telemetry is healthy", () => {
    const state = createDemoState();
    state.alerts = [];
    state.propertyAreas = [well];
    state.areaEquipment = [connector];
    state.integration.tpLink = { ...state.integration.tpLink, configured: true, connected: true };
    const lights = byId(derivePropertyTrafficLights(
      state,
      DEMO_PROPERTY_ID,
      [monitoredOk(state.houses[0]!.id, state.sensors.length)],
    ));

    expect(lights.house?.level).toBe("ok");
    expect(lights.equipment).toMatchObject({ level: "caution", reason: "not-monitored" });
    expect(lights.well).toMatchObject({ level: "caution", reason: "not-monitored" });
  });

  it("does not invent warning lights for asset categories that are not present", () => {
    const state = createDemoState();
    state.houses = [];
    state.sensors = [];
    state.propertyAreas = [];
    state.areaEquipment = [];
    const lights = byId(derivePropertyTrafficLights(state, DEMO_PROPERTY_ID, []));

    expect(lights).toEqual({});
  });

  it("turns an out-of-service asset red", () => {
    const state = createDemoState();
    state.alerts = [];
    state.propertyAreas = [well];
    state.areaEquipment = [{ ...connector, manufacturer: null, name: "Well pump", status: "out-of-service" }];
    const lights = byId(derivePropertyTrafficLights(state, DEMO_PROPERTY_ID, []));

    expect(lights.equipment).toMatchObject({ level: "critical", reason: "asset-failure" });
    expect(lights.well).toMatchObject({ level: "critical", reason: "asset-failure" });
  });
});
