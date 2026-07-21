import { describe, expect, it } from "vitest";
import { createDemoState } from "./domain";
import { assessSensorCoverage, experimentalLayerSuggestions, suggestSensorPlacement } from "./experimentalSpatialLayers";
import type { ClimateSampleMatrix } from "./airflowSimulation";
import type { SpatialLayerSnapshot } from "./spatialLayers";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

describe("experimental spatial visualization support", () => {
  it("marks unsupported rooms and stale sensor positions without inventing coverage", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id);
    const anchor = sensors[0]!;
    const samples: ClimateSampleMatrix = {
      [anchor.id]: {
        temperature: {
          sensorId: anchor.id, metric: "temperature", value: 21.2, canonicalUnit: "°C",
          timestamp: new Date(NOW).toISOString(), source: "mock", quality: "good",
        },
        humidity: {
          sensorId: anchor.id, metric: "humidity", value: 48, canonicalUnit: "%",
          timestamp: new Date(NOW).toISOString(), source: "mock", quality: "good",
        },
      },
    };

    const result = assessSensorCoverage({
      house,
      sensors,
      samples,
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
    });

    expect(result.freshTemperatureSensors).toBe(1);
    expect(result.pairedHumiditySensors).toBe(1);
    expect(result.support).toBe("low");
    expect(result.regions).toHaveLength(1);
    expect(result.recommendations.some((item) => item.reason === "room-uncovered")).toBe(true);
    expect(result.recommendations.some((item) => item.reason === "refresh-sensor")).toBe(true);
  });

  it("turns known model limitations into scoped improvement suggestions", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const coverage = assessSensorCoverage({
      house,
      sensors: [],
      samples: {},
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
    });
    const suggestions = experimentalLayerSuggestions({
      house,
      coverage,
      airflow: {
        temperatureSensors: 1,
        humiditySensors: 0,
        tracerSensors: 0,
        windDriven: false,
        doorOpenings: 0,
        windowOpenings: 0,
        ventOpenings: 0,
        counterflowOpenings: 0,
        pressureAssumed: true,
        support: "low",
        divergenceRms: 0,
      },
    });

    expect(suggestions.map((item) => item.code)).toEqual(expect.arrayContaining([
      "add-temperature-anchor",
      "add-paired-humidity",
      "add-pressure",
      "add-physical-scale",
      "model-vertical-portals",
    ]));

    const calibratedHouse = {
      ...house,
      floors: house.floors.map((floor) => ({ ...floor, metersPerPlanUnit: .012 })),
    };
    expect(experimentalLayerSuggestions({
      house: calibratedHouse,
      coverage: { ...coverage },
      airflow: {
        temperatureSensors: 1, humiditySensors: 1, tracerSensors: 0, windDriven: false,
        doorOpenings: 0, windowOpenings: 0, ventOpenings: 0, counterflowOpenings: 0,
        pressureAssumed: false, support: "low", divergenceRms: 0,
      },
    }).some((item) => item.code === "add-physical-scale")).toBe(false);
  });

  it("chooses the least-supported valid point in the requested room", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const room = floor.rooms[1]!;
    const coverage = assessSensorCoverage({
      house,
      sensors: state.sensors.filter((sensor) => sensor.houseId === house.id),
      samples: state.latestMeasurements,
      freshness: { referenceTimeMs: Date.now(), maxSampleAgeMs: 15 * 60_000 },
    });

    const suggestion = suggestSensorPlacement({ floor, roomName: room.name, coverage });

    expect(suggestion.recommendation).toMatchObject({ floorId: floor.id, roomId: room.id, roomName: room.name });
    expect(suggestion.recommendation.x).toBeGreaterThanOrEqual(0);
    expect(suggestion.recommendation.x).toBeLessThanOrEqual(floor.width);
    expect(suggestion.recommendation.y).toBeGreaterThanOrEqual(0);
    expect(suggestion.recommendation.y).toBeLessThanOrEqual(floor.height);
    expect(suggestion.coverageAtPoint).toBeGreaterThanOrEqual(0);
  });

  it("uses current engine-zone confidence to prioritize a lower-support room", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const strongerRoom = floor.rooms[0]!;
    const weakerRoom = floor.rooms[1]!;
    const centroid = (room: typeof weakerRoom) => ({
      x: room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length,
      y: room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length,
    });
    const coverage = assessSensorCoverage({
      house,
      sensors: [],
      samples: {},
      freshness: { referenceTimeMs: NOW, maxSampleAgeMs: 15 * 60_000 },
    });
    const snapshot: SpatialLayerSnapshot = {
      scope: { kind: "house", id: house.id },
      coordinateFrames: [],
      layerId: "climate.propagation.experimental",
      model: { id: "propagation", version: "1", maturity: "experimental" },
      generatedAt: new Date(NOW).toISOString(),
      windowStart: new Date(NOW - 60_000).toISOString(),
      windowEnd: new Date(NOW).toISOString(),
      status: "ready",
      configVersion: "1",
      inputDigest: "test",
      qualityScore: .6,
      warnings: [],
      reasonCodes: [],
      zones: [
        { zoneId: strongerRoom.id, floorId: floor.id, roomId: strongerRoom.id, centroid: centroid(strongerRoom), metrics: {}, evidence: { confidence: .8 } },
        { zoneId: weakerRoom.id, floorId: floor.id, roomId: weakerRoom.id, centroid: centroid(weakerRoom), metrics: {}, evidence: { confidence: .15 } },
      ],
      connections: [],
      points: [],
    };

    const suggestion = suggestSensorPlacement({ floor, coverage, spatialSnapshots: [snapshot] });

    expect(suggestion.recommendation.roomId).toBe(weakerRoom.id);
    expect(suggestion.engineLayerCount).toBe(1);
    expect(suggestion.engineSupport).toBe(.15);
  });
});
