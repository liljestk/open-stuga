import { describe, expect, it } from "vitest";
import type { House, OpeningStateObservation } from "@climate-twin/contracts";
import {
  buildHouseTopology,
  buildOpeningConnectionStateIntervals,
} from "../src/spatial-layers/core-input.js";

const at = "2026-07-18T12:00:00.000Z";

function exteriorWindowHouse(): House {
  return {
    id: "house", propertyId: "property", name: "House", timezone: "Europe/Helsinki",
    mapPlacement: { latitude: 60, longitude: 24, metersPerPlanUnit: .1, footprintFloorId: "ground" },
    floors: [{
      id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, ceilingHeight: 2.8,
      walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [{ id: "living", name: "Living", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }],
      planElements: [{
        id: "window", kind: "window", wallId: "north", position: { x: 5, y: 0 }, rotationDegrees: 0,
        width: 2, height: 1, state: "closed",
      }],
    }],
    createdAt: at, updatedAt: at,
  };
}

describe("opening-derived spatial topology", () => {
  it("connects a perimeter window to an outdoor boundary without changing its configured normal state", () => {
    const house = exteriorWindowHouse();
    const observation: OpeningStateObservation = {
      id: "manual-open", houseId: house.id, floorId: "ground", elementId: "window",
      state: "open", openFraction: .5, source: "api", observedAt: at,
    };
    const built = buildHouseTopology({ house, sensors: [], bindings: [], at, openingStateObservations: [observation] });

    expect(built.warnings).not.toContain("OPENING_window_ADJACENCY_UNRESOLVED");
    expect(built.topology.zones).toContainEqual(expect.objectContaining({
      id: "house:house:floor:ground:ventilation-boundary", kind: "outdoor",
    }));
    expect(built.topology.connections).toContainEqual(expect.objectContaining({
      id: "house:house:opening:ground/window",
      zoneAId: "house:house:floor:ground:room:living",
      zoneBId: "house:house:floor:ground:ventilation-boundary",
      kind: "window", enabled: true, normallyOpen: false, openingAreaM2: .1,
      tags: expect.arrayContaining(["state:open", "state-source:api"]),
    }));
  });

  it("does not guess that a one-sided opening on an interior wall is outdoors", () => {
    const house = exteriorWindowHouse();
    house.floors[0]!.walls[0] = { id: "divider", from: { x: 5, y: 1 }, to: { x: 5, y: 7 } };
    const opening = house.floors[0]!.planElements![0]!;
    if (opening.kind !== "window") throw new Error("Expected window fixture");
    opening.wallId = "divider";
    opening.position = { x: 5, y: 4 };

    const built = buildHouseTopology({ house, sensors: [], bindings: [], at });
    expect(built.topology.connections).toEqual([]);
    expect(built.warnings).toContain("OPENING_window_ADJACENCY_UNRESOLVED");
  });

  it("keeps derived connection IDs unique when floor-local opening IDs repeat", () => {
    const house = exteriorWindowHouse();
    house.floors.push({
      ...structuredClone(house.floors[0]!),
      id: "upper",
      name: "Upper",
      elevation: 3,
    });

    const built = buildHouseTopology({ house, sensors: [], bindings: [], at });
    const windows = built.topology.connections.filter((connection) => connection.kind === "window");
    expect(windows).toHaveLength(2);
    expect(new Set(windows.map((connection) => connection.id)).size).toBe(2);
    expect(windows.map((connection) => connection.id)).toEqual(expect.arrayContaining([
      "house:house:opening:ground/window",
      "house:house:opening:upper/window",
    ]));
  });

  it("disables and re-enables derived door, window, and vent edges from runtime observations", () => {
    const house = exteriorWindowHouse();
    const floor = house.floors[0]!;
    floor.walls.push({ id: "divider", from: { x: 5, y: 0 }, to: { x: 5, y: 8 } });
    floor.rooms = [
      { id: "left", name: "Left", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 }, { x: 0, y: 8 }] },
      { id: "right", name: "Right", points: [{ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 5, y: 8 }] },
    ];
    const window = floor.planElements![0]!;
    if (window.kind !== "window") throw new Error("Expected window fixture");
    window.position = { x: 2.5, y: 0 };
    window.state = "open";
    floor.planElements!.push(
      { id: "door", kind: "door", wallId: "divider", position: { x: 5, y: 4 }, rotationDegrees: 90, width: 1, state: "open" },
      { id: "vent", kind: "vent", position: { x: 2.5, y: 4 }, rotationDegrees: 0, width: .3, state: "open" },
    );
    const observations = floor.planElements!.map((element): OpeningStateObservation => ({
      id: `closed-${element.id}`, houseId: house.id, floorId: floor.id, elementId: element.id,
      state: "closed", source: "manual", observedAt: "2026-07-18T12:01:00.000Z",
    }));

    const closed = buildHouseTopology({ house, sensors: [], bindings: [], at: "2026-07-18T12:02:00.000Z", openingStateObservations: observations });
    for (const elementId of ["window", "door", "vent"]) {
      const connection = closed.topology.connections.find((candidate) => candidate.tags?.includes(`plan-element-ref:ground/${elementId}`));
      expect(connection).toMatchObject({ enabled: false, openingAreaM2: 0 });
      expect(connection?.tags).toEqual(expect.arrayContaining([`plan-element-ref:ground/${elementId}`, "state:closed", "state-source:manual"]));
    }

    const opened = buildHouseTopology({
      house, sensors: [], bindings: [], at: "2026-07-18T12:04:00.000Z",
      openingStateObservations: [...observations, ...observations.map((observation) => ({
        ...observation, id: `open-${observation.elementId}`, state: "open" as const, observedAt: "2026-07-18T12:03:00.000Z",
      }))],
    });
    for (const elementId of ["window", "door", "vent"]) {
      expect(opened.topology.connections.find((candidate) => candidate.tags?.includes(`plan-element-ref:ground/${elementId}`))?.enabled).toBe(true);
    }
  });

  it("provides the experimental engine with the opening state across its complete history window", () => {
    const house = exteriorWindowHouse();
    const windowStart = "2026-07-18T12:00:00.000Z";
    const windowEnd = "2026-07-18T12:30:00.000Z";
    const observations: OpeningStateObservation[] = [
      { id: "open-1", houseId: house.id, floorId: "ground", elementId: "window", state: "open", source: "manual", observedAt: "2026-07-18T12:05:00.000Z" },
      { id: "closed", houseId: house.id, floorId: "ground", elementId: "window", state: "closed", source: "manual", observedAt: "2026-07-18T12:10:00.000Z" },
      { id: "open-2", houseId: house.id, floorId: "ground", elementId: "window", state: "open", openFraction: .5, source: "manual", observedAt: "2026-07-18T12:20:00.000Z" },
    ];
    const topology = buildHouseTopology({
      house, sensors: [], bindings: [], at: windowEnd, openingStateObservations: observations,
    }).topology;

    expect(buildOpeningConnectionStateIntervals({
      house,
      sensors: [],
      bindings: [],
      topology,
      openingStateObservations: observations,
      windowStart,
      windowEnd,
    })).toEqual([
      { connectionId: "house:house:opening:ground/window", startAt: windowStart, endAt: "2026-07-18T12:05:00.000Z", enabled: false, openFraction: 0 },
      { connectionId: "house:house:opening:ground/window", startAt: "2026-07-18T12:05:00.000Z", endAt: "2026-07-18T12:10:00.000Z", enabled: true, openFraction: 1 },
      { connectionId: "house:house:opening:ground/window", startAt: "2026-07-18T12:10:00.000Z", endAt: "2026-07-18T12:20:00.000Z", enabled: false, openFraction: 0 },
      { connectionId: "house:house:opening:ground/window", startAt: "2026-07-18T12:20:00.000Z", endAt: windowEnd, enabled: true, openFraction: .5 },
    ]);
  });

  it("overlays effective opening state onto an explicitly configured topology", () => {
    const house = exteriorWindowHouse();
    const configuredConnection = {
      id: "custom-window-edge", zoneAId: "inside", zoneBId: "outside", kind: "window" as const,
      enabled: true, openingAreaM2: .75, anchors: [{ x: 5, y: 0, z: 1.4 }],
      tags: ["custom-edge", "plan-element-ref:ground/window", "plan-element-ref:ground/window", "state:open", "state-source:default"],
    };
    const configuration = { topology: {
      scope: { kind: "house", id: house.id },
      frames: [{ id: "frame", version: at, kind: "building-local-3d", unit: "normalized", floorId: "ground", origin: { x: 0, y: 0, z: 0 } }],
      zones: [
        { id: "inside", name: "Inside", kind: "indoor", frameId: "frame", floorId: "ground", centroid: { x: 5, y: 4, z: 1.4 } },
        { id: "outside", name: "Outside", kind: "outdoor", frameId: "frame", floorId: "ground", centroid: { x: 5, y: -1, z: 1.4 } },
      ],
      connections: [configuredConnection, { ...configuredConnection, id: "admin-disabled-window", enabled: false }],
      sensorBindings: [],
    } };
    const closedObservation: OpeningStateObservation = {
      id: "closed", houseId: house.id, floorId: "ground", elementId: "window",
      state: "closed", source: "manual", observedAt: "2026-07-18T12:01:00.000Z",
    };
    const closed = buildHouseTopology({
      house, sensors: [], bindings: [], at: "2026-07-18T12:02:00.000Z",
      openingStateObservations: [closedObservation], configuration,
    });
    expect(closed.topology.connections[0]).toMatchObject({
      id: configuredConnection.id, zoneAId: "inside", zoneBId: "outside", enabled: false,
      openingAreaM2: 0, anchors: configuredConnection.anchors,
    });
    expect(closed.topology.connections[0]?.tags).toEqual(expect.arrayContaining([
      "custom-edge", "plan-element-ref:ground/window", "state:closed", "state-source:manual",
    ]));

    const opened = buildHouseTopology({
      house, sensors: [], bindings: [], at: "2026-07-18T12:04:00.000Z", configuration,
      openingStateObservations: [closedObservation, {
        ...closedObservation, id: "opened", state: "open", observedAt: "2026-07-18T12:03:00.000Z",
      }],
    });
    expect(opened.topology.connections.find((connection) => connection.id === configuredConnection.id)).toMatchObject({
      enabled: true,
      openingAreaM2: configuredConnection.openingAreaM2,
    });
    expect(opened.topology.connections.find((connection) => connection.id === "admin-disabled-window")?.enabled).toBe(false);

    const unreferencedConfiguration = structuredClone(configuration);
    unreferencedConfiguration.topology.connections = [{
      ...configuredConnection,
      tags: ["custom-edge"],
    }];
    const safeFallback = buildHouseTopology({
      house, sensors: [], bindings: [], at: "2026-07-18T12:04:00.000Z",
      openingStateObservations: [{
        ...closedObservation, id: "opened", state: "open", observedAt: "2026-07-18T12:03:00.000Z",
      }],
      configuration: unreferencedConfiguration,
    });
    expect(safeFallback.warnings).toEqual(expect.arrayContaining([
      "OPENING_STATE_REFERENCE_MISSING",
      "CONFIGURED_TOPOLOGY_INVALID",
    ]));
    expect(safeFallback.topology.connections.some((connection) => connection.id === configuredConnection.id)).toBe(false);
    expect(safeFallback.topology.connections.find((connection) => connection.id === "house:house:opening:ground/window")?.enabled).toBe(true);
  });
});
