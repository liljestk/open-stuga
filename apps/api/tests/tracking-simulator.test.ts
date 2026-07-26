import { describe, expect, it } from "vitest";
import {
  generateTrackingSimulation,
  replayTrackingSimulation,
} from "../src/tracking/simulator.js";

describe("tracking field simulation and replay", () => {
  it("is deterministic for a seed and exercises noisy, missed, delayed evidence", () => {
    const options = {
      seed: 42,
      durationSeconds: 120,
      stepSeconds: 2,
      missedAdvertisementRate: 0.2,
      networkOutage: { startsAtSeconds: 30, durationSeconds: 20 },
    };
    const first = generateTrackingSimulation(options);
    const second = generateTrackingSimulation(options);
    const changed = generateTrackingSimulation({ ...options, seed: 43 });

    expect(first).toEqual(second);
    expect(first.frames.flatMap((frame) => frame.observations).length).toBeGreaterThan(20);
    expect(changed.frames.flatMap((frame) => frame.observations).map((item) => item.rssi))
      .not.toEqual(first.frames.flatMap((frame) => frame.observations).map((item) => item.rssi));
    expect(first.frames.flatMap((frame) => frame.observations).some(
      (item) => Date.parse(item.receivedAt) - Date.parse(item.observedAt) > 10_000,
    )).toBe(true);
  });

  it("replays the same raw stream through uncertainty-aware inference", () => {
    const simulation = generateTrackingSimulation({
      seed: 7,
      durationSeconds: 180,
      stepSeconds: 3,
    });
    const replay = replayTrackingSimulation(simulation);
    const coordinateEstimates = replay.filter((item) => item.estimate.coordinate);

    expect(replay.length).toBeGreaterThan(20);
    expect(coordinateEstimates.length).toBeGreaterThan(5);
    expect(coordinateEstimates.every(
      (item) => (item.estimate.accuracyRadiusMeters ?? 0) >= 5,
    )).toBe(true);
    expect(replay.some(
      (item) => item.estimate.explanation.method === "MULTI_OBSERVER_WEIGHTED_MEDIAN",
    )).toBe(true);
  });
});
