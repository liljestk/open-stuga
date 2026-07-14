import { describe, expect, it } from "vitest";
import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import { definitionFor } from "./measurements";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "./spatialFreshness";
import {
  clampCameraOrbit, createVolumeClouds, estimateVolumeFlows, interpolateVolume, projectPoint3D,
  type VolumeBounds,
} from "./spatialVolume";

const referenceTimeMs = Date.parse("2026-07-14T12:00:00.000Z");
const freshness = { referenceTimeMs, maxSampleAgeMs: 10 * 60_000, futureToleranceMs: 0 };
const bounds: VolumeBounds = { width: 1000, depth: 640, minZ: 0, maxZ: 6 };

function sample(sensor: Sensor, definition: MeasurementDefinition, value: number, timestamp = "2026-07-14T11:58:00.000Z"): MeasurementSample {
  return {
    sensorId: sensor.id, metric: definition.id, value, canonicalUnit: definition.unit,
    timestamp, source: "mock", quality: "good",
  };
}

describe("3D scalar volume", () => {
  it("estimates diagonal XYZ high-to-low gradients when samples support distinct heights", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensors = state.sensors.slice(0, 4).map((sensor, index) => ({
      ...sensor,
      x: index % 2 ? 820 : 160,
      y: index < 2 ? 120 : 520,
      z: index < 2 ? 1 : 5,
    }));
    const samples = Object.fromEntries(sensors.map((sensor) => [
      sensor.id,
      sample(sensor, definition, 34 - sensor.x / 100 - sensor.y / 160 - sensor.z * 1.6),
    ]));
    const volume = interpolateVolume(sensors, samples, definition, bounds, freshness, 11);
    const vectors = estimateVolumeFlows(volume, definition, 12);

    expect(volume.distinctZCount).toBe(2);
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.some((vector) => vector.hasVerticalComponent)).toBe(true);
    expect(vectors.some((vector) => (
      Math.abs(vector.to.x - vector.from.x) > 1
      && Math.abs(vector.to.y - vector.from.y) > 1
      && Math.abs(vector.to.z - vector.from.z) > .01
    ))).toBe(true);
    vectors.forEach((vector) => expect(vector.from.value).toBeGreaterThan(vector.to.value));
  });

  it("changes projected position when the orbit camera rotates", () => {
    const point = { x: 850, y: 120, z: 4.7 };
    const viewport = { width: 1100, height: 720 };
    const first = projectPoint3D(point, bounds, { yaw: .65, pitch: .62, zoom: 1 }, viewport);
    const rotated = projectPoint3D(point, bounds, { yaw: 1.35, pitch: .62, zoom: 1 }, viewport);

    expect(Math.hypot(first.x - rotated.x, first.y - rotated.y)).toBeGreaterThan(30);
    expect(first.depth).not.toBeCloseTo(rotated.depth, 3);
  });

  it("allows a complete camera orbit from directly above to directly below", () => {
    const above = clampCameraOrbit({ yaw: 0, pitch: Math.PI, zoom: 1 });
    const below = clampCameraOrbit({ yaw: 0, pitch: -Math.PI, zoom: 1 });

    expect(above.pitch).toBeCloseTo(Math.PI / 2, 8);
    expect(below.pitch).toBeCloseTo(-Math.PI / 2, 8);

    const point = { x: 850, y: 120, z: 4.7 };
    const viewport = { width: 1100, height: 720 };
    const projectedAbove = projectPoint3D(point, bounds, above, viewport);
    const projectedBelow = projectPoint3D(point, bounds, below, viewport);
    expect(projectedAbove.y).not.toBeCloseTo(projectedBelow.y, 3);
    expect(projectedAbove.depth).toBeCloseTo(-projectedBelow.depth, 8);
  });

  it("keeps one local cloud but does not invent a vector from one fresh sample", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensor = state.sensors[0]!;
    const volume = interpolateVolume([sensor], { [sensor.id]: sample(sensor, definition, 23) }, definition, bounds, freshness);

    expect(createVolumeClouds(volume, definition)).toHaveLength(1);
    expect(estimateVolumeFlows(volume, definition)).toHaveLength(0);
  });

  it("does not infer vertical vectors from small mounting-height differences", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensors = state.sensors.slice(0, 4).map((sensor, index) => ({ ...sensor, z: 1.2 + index * .08, x: 120 + index * 220 }));
    const samples = Object.fromEntries(sensors.map((sensor, index) => [sensor.id, sample(sensor, definition, 31 - index * 2)]));
    const volume = interpolateVolume(sensors, samples, definition, bounds, freshness);

    expect(volume.distinctZCount).toBeGreaterThan(1);
    expect(volume.verticalSupport).toBe(false);
    expect(estimateVolumeFlows(volume, definition).every((vector) => !vector.hasVerticalComponent)).toBe(true);
  });

  it("caps extreme volume grids and masks blobs outside nearby sensor support", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensors = state.sensors.slice(0, 3).map((sensor, index) => ({
      ...sensor, x: 30 + index * 12, y: 20 + index * 10, z: 1 + index * .8,
    }));
    const samples = Object.fromEntries(sensors.map((sensor, index) => [sensor.id, sample(sensor, definition, 26 - index)]));
    const extremeBounds = { width: 10_000, depth: 20, minZ: 0, maxZ: 100 };
    const volume = interpolateVolume(sensors, samples, definition, extremeBounds, freshness, 1_000);
    const blobs = createVolumeClouds(volume, definition, 24);

    expect(volume.columns).toBeLessThanOrEqual(14);
    expect(volume.rows).toBeLessThanOrEqual(12);
    expect(volume.layers).toBeLessThanOrEqual(9);
    expect(volume.cells.length).toBeLessThanOrEqual(14 * 12 * 9);
    expect(blobs.every((blob) => blob.x < extremeBounds.width * .55)).toBe(true);
  });

  it("suppresses clouds and vectors for no data or a non-spatial definition", () => {
    const state = createDemoState();
    const temperature = definitionFor(state.measurementDefinitions, "temperature");
    const empty = interpolateVolume(state.sensors, {}, temperature, bounds, freshness);
    expect(createVolumeClouds(empty, temperature)).toHaveLength(0);
    expect(estimateVolumeFlows(empty, temperature)).toHaveLength(0);

    const nonSpatial = { ...temperature, id: "manual_index", spatialInterpolation: false };
    const sensor = state.sensors[0]!;
    const disabled = interpolateVolume([sensor], { [sensor.id]: sample(sensor, nonSpatial, 42) }, nonSpatial, bounds, freshness);
    expect(disabled.cells).toHaveLength(0);
    expect(createVolumeClouds(disabled, nonSpatial)).toHaveLength(0);
    expect(estimateVolumeFlows(disabled, nonSpatial)).toHaveLength(0);
  });
});

describe("spatial sample freshness", () => {
  it("uses an overridable positive age configuration", () => {
    expect(configuredSpatialMaxSampleAgeMs()).toBeGreaterThan(0);
    expect(configuredSpatialReplayMaxSampleAgeMs()).toBeGreaterThan(configuredSpatialMaxSampleAgeMs());
  });

  it("rejects stale-quality, over-age, and future-skewed samples against the active clock", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensor = state.sensors[0]!;
    const current = sample(sensor, definition, 22);
    const old = sample(sensor, definition, 22, "2026-07-14T11:40:00.000Z");
    const future = sample(sensor, definition, 22, "2026-07-14T12:01:00.000Z");
    const stale = { ...current, quality: "stale" as const };

    expect(isSpatialSampleFresh(current, freshness)).toBe(true);
    expect(isSpatialSampleFresh(old, freshness)).toBe(false);
    expect(isSpatialSampleFresh(future, freshness)).toBe(false);
    expect(isSpatialSampleFresh(stale, freshness)).toBe(false);
  });
});
