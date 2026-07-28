import { describe, expect, it } from "vitest";
import type { MeasurementSample } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import { nextExperimentalVisualizationSelection } from "./experimentalSpatialLayers";
import { createOutdoorBoundaryContextFromConditions } from "./outdoorContext";
import {
  estimateOutdoorInfluence,
  formatOutdoorInfluenceValue,
} from "./outdoorInfluence";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function sample(sensorId: string, metric: string, value: number, timestamp = NOW): MeasurementSample {
  return {
    sensorId,
    metric,
    value,
    canonicalUnit: metric === "temperature" ? "\u00b0C" : "%",
    timestamp: new Date(timestamp).toISOString(),
    source: "mock",
    quality: "good",
  };
}

describe("outdoor influence estimate", () => {
  it("estimates a wind-weighted cooling boundary from fresh replay-compatible samples", () => {
    const state = createDemoState();
    const house = { ...state.houses[0]!, orientationDegrees: 0 };
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id).slice(0, 2);
    const samples = Object.fromEntries(sensors.map((sensor, index) => [sensor.id, {
      temperature: sample(sensor.id, "temperature", 21 + index),
    }]));
    const outdoor = createOutdoorBoundaryContextFromConditions(house, {
      timestamp: new Date(NOW).toISOString(),
      temperatureC: 2,
      relativeHumidityPercent: 85,
      windDirectionDegrees: 270,
      windSpeedMps: 7,
    });

    const result = estimateOutdoorInfluence({
      metric: "temperature",
      sensors,
      samples,
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
      outdoor,
    });

    expect(result).toMatchObject({
      availability: "ready",
      direction: "cooling",
      support: "medium",
      sensorCount: 2,
      outdoorValue: 2,
      indoorValue: 21.5,
      windDriven: true,
      windwardEdge: "left",
    });
    expect(result.strength).toBeGreaterThan(.8);
    expect(result.edges.find((edge) => edge.edge === "left")!.strength)
      .toBeGreaterThan(result.edges.find((edge) => edge.edge === "right")!.strength);
  });

  it("uses water-vapour quantity so cold high-RH air is correctly shown as drying", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id).slice(0, 2);
    const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, {
      temperature: sample(sensor.id, "temperature", 22),
      humidity: sample(sensor.id, "humidity", 45),
    }]));
    const outdoor = createOutdoorBoundaryContextFromConditions(house, {
      timestamp: new Date(NOW).toISOString(),
      temperatureC: -5,
      relativeHumidityPercent: 90,
    });

    const result = estimateOutdoorInfluence({
      metric: "moisture",
      sensors,
      samples,
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
      outdoor,
    });

    expect(result.availability).toBe("ready");
    expect(result.direction).toBe("drying");
    expect(result.difference).toBeLessThan(0);
  });

  it("abstains when paired indoor moisture readings are stale", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const outdoor = createOutdoorBoundaryContextFromConditions(house, {
      timestamp: new Date(NOW).toISOString(),
      temperatureC: 10,
      relativeHumidityPercent: 70,
    });
    const result = estimateOutdoorInfluence({
      metric: "moisture",
      sensors: [sensor],
      samples: {
        [sensor.id]: {
          temperature: sample(sensor.id, "temperature", 21, NOW - 60 * 60_000),
          humidity: sample(sensor.id, "humidity", 45, NOW - 60 * 60_000),
        },
      },
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
      outdoor,
    });

    expect(result).toMatchObject({ availability: "no-indoor", support: "low", strength: 0 });
  });

  it("formats absolute and difference temperatures without changing moisture units", () => {
    expect(formatOutdoorInfluenceValue("temperature", 0, "imperial", "en-US")).toBe("32.0 \u00b0F");
    expect(formatOutdoorInfluenceValue("temperature", -10, "imperial", "en-US", true)).toBe("-18.0 \u00b0F");
    expect(formatOutdoorInfluenceValue("moisture", -2.25, "imperial", "en-US", true)).toBe("-2.3 g/kg");
  });

  it("keeps outdoor influence exclusive while preserving the two established overlays together", () => {
    expect(nextExperimentalVisualizationSelection(["air-movement", "sensor-coverage"], "outdoor-influence", true))
      .toEqual(["outdoor-influence"]);
    expect(nextExperimentalVisualizationSelection(["outdoor-influence"], "sensor-coverage", true))
      .toEqual(["sensor-coverage"]);
    expect(nextExperimentalVisualizationSelection(["air-movement"], "sensor-coverage", true))
      .toEqual(["air-movement", "sensor-coverage"]);
  });
});
