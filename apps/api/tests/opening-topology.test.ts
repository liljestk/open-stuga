import { describe, expect, it } from "vitest";
import type { House, OpeningStateObservation } from "@climate-twin/contracts";
import { buildHouseTopology } from "../src/spatial-layers/core-input.js";

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
      id: "house:house:opening:window",
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
});
