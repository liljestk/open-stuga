import { describe, expect, it } from "vitest";
import type { House, HouseWeather } from "@climate-twin/contracts";
import {
  cardinalDirection,
  createOutdoorBoundaryContext,
  normalizeDegrees,
  planRelativeWindFrom,
  windPathOnUnitPlan,
  windSourceVector,
  windwardPlanEdge,
} from "./outdoorContext";

const house: House = {
  id: "house-1",
  name: "House",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94 },
  orientationDegrees: 90,
  floors: [],
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

function weather(windDirectionDegrees?: number): HouseWeather {
  return {
    houseId: house.id,
    location: house.location!,
    provider: "fmi",
    attribution: "FMI",
    fetchedAt: "2026-07-14T10:01:00.000Z",
    forecastIssuedAt: null,
    stale: false,
    current: {
      timestamp: "2026-07-14T10:00:00.000Z",
      temperatureC: 3,
      relativeHumidityPercent: 83,
      windSpeedMps: 7,
      ...(windDirectionDegrees === undefined ? {} : { windDirectionDegrees }),
    },
    observationStation: null,
    forecast: [],
    warnings: [],
    unavailable: [],
  };
}

describe("outdoor plan geometry", () => {
  it("normalizes angles and labels compass sectors around north", () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(720)).toBe(0);
    expect(cardinalDirection(0)).toBe("N");
    expect(cardinalDirection(44.9)).toBe("NE");
    expect(cardinalDirection(270)).toBe("W");
    expect(cardinalDirection(359.9)).toBe("N");
    expect(() => normalizeDegrees(Number.NaN)).toThrow(RangeError);
  });

  it("translates true bearings to the plan and chooses the windward edge", () => {
    expect(planRelativeWindFrom(90, 90)).toBe(0);
    expect(planRelativeWindFrom(270, 90)).toBe(180);
    expect(windwardPlanEdge(0)).toBe("top");
    expect(windwardPlanEdge(90)).toBe("right");
    expect(windwardPlanEdge(180)).toBe("bottom");
    expect(windwardPlanEdge(270)).toBe("left");
  });

  it("uses SVG y-down coordinates and creates an inward path", () => {
    expect(windSourceVector(0)).toEqual({ x: 0, y: -1 });
    const west = windSourceVector(270);
    expect(west.x).toBeCloseTo(-1);
    expect(west.y).toBeCloseTo(0);
    const westPath = windPathOnUnitPlan(270);
    expect(westPath.sourcePoint.x).toBeCloseTo(0);
    expect(westPath.sourcePoint.y).toBeCloseTo(0.5);
    expect(westPath.inwardTarget.x).toBeGreaterThan(westPath.sourcePoint.x);
  });
});

describe("createOutdoorBoundaryContext", () => {
  it("keeps outdoor readings and derives an incoming plan vector", () => {
    // This plan's top is east, so true west is the plan's bottom edge.
    const context = createOutdoorBoundaryContext(house, weather(270));
    expect(context).toMatchObject({
      observedAt: "2026-07-14T10:00:00.000Z",
      stale: false,
      windFromDegrees: 270,
      windFromCardinal: "W",
      planWindFromDegrees: 180,
      windwardEdge: "bottom",
      conditions: { temperatureC: 3, relativeHumidityPercent: 83, windSpeedMps: 7 },
    });
    expect(context?.sourceVector?.y).toBeCloseTo(1);
    expect(context?.inwardVector?.y).toBeCloseTo(-1);
  });

  it("preserves weather but suppresses relative geometry when orientation is unknown", () => {
    const { orientationDegrees: _orientation, ...unorientedHouse } = house;
    const context = createOutdoorBoundaryContext(unorientedHouse, weather(270));
    expect(context?.conditions.temperatureC).toBe(3);
    expect(context?.windFromCardinal).toBe("W");
    expect(context?.planWindFromDegrees).toBeNull();
    expect(context?.sourceVector).toBeNull();
    expect(context?.inwardVector).toBeNull();
    expect(context?.windwardEdge).toBeNull();
    expect(context?.inwardTarget).toBeNull();
  });

  it("preserves non-directional weather when FMI has no wind bearing", () => {
    const context = createOutdoorBoundaryContext(house, weather());
    expect(context?.conditions.relativeHumidityPercent).toBe(83);
    expect(context?.windFromDegrees).toBeNull();
    expect(context?.planWindFromDegrees).toBeNull();
  });

  it("returns null without a current observation", () => {
    expect(createOutdoorBoundaryContext(house, null)).toBeNull();
    expect(createOutdoorBoundaryContext(house, { ...weather(90), current: null })).toBeNull();
  });
});
