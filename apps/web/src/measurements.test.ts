import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { appendHistory, appendLiveHistory, samplesAt, type MeasurementHistory } from "./measurements";

function sample(sensorId: string, minute: number, value: number): MeasurementSample {
  return {
    sensorId,
    metric: "temperature",
    value,
    canonicalUnit: "°C",
    timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + minute * 60_000).toISOString(),
    source: "api",
    quality: "good",
  };
}

describe("samplesAt", () => {
  it("selects the last recorded sample on or before an arbitrary replay frame", () => {
    const sensorId = "sensor-history";
    const series = [sample(sensorId, 0, 20), sample(sensorId, 5, 21), sample(sensorId, 10, 22)];
    const history: MeasurementHistory = { [sensorId]: { temperature: series } };

    expect(samplesAt(history, [sensorId], "temperature", Date.parse("2025-12-31T23:59:59.000Z"))).toEqual({});
    expect(samplesAt(history, [sensorId], "temperature", Date.parse("2026-01-01T00:07:00.000Z"))[sensorId])
      .toMatchObject({ value: 21, source: "replay" });
    expect(samplesAt(history, [sensorId], "temperature", Date.parse("2026-01-01T00:10:00.000Z"))[sensorId])
      .toMatchObject({ value: 22, source: "replay" });
  });
});

describe("appendLiveHistory", () => {
  it("keeps a compact live tail once the minimum retention is reached", () => {
    const sensorId = "sensor-live";
    const series = Array.from({ length: 500 }, (_, minute) => sample(sensorId, minute, minute));
    const history: MeasurementHistory = { [sensorId]: { temperature: series } };

    const next = appendLiveHistory(history, [sample(sensorId, 500, 500)], 500);

    expect(next[sensorId]?.temperature).toHaveLength(500);
    expect(next[sensorId]?.temperature?.[0]?.value).toBe(1);
    expect(next[sensorId]?.temperature?.at(-1)?.value).toBe(500);
  });

  it("preserves the size of a larger explicitly loaded series", () => {
    const sensorId = "sensor-loaded";
    const series = Array.from({ length: 1_000 }, (_, minute) => sample(sensorId, minute, minute));
    const history: MeasurementHistory = { [sensorId]: { temperature: series } };

    const next = appendLiveHistory(history, [sample(sensorId, 1_000, 1_000)], 500);

    expect(next[sensorId]?.temperature).toHaveLength(1_000);
    expect(next[sensorId]?.temperature?.[0]?.value).toBe(1);
    expect(next[sensorId]?.temperature?.at(-1)?.value).toBe(1_000);
  });

  it("does not trim a 50k retained series once per ordered live event", () => {
    const sensorId = "sensor-large-live";
    const series = Array.from({ length: 50_000 }, (_, minute) => sample(sensorId, minute, minute));
    const incoming = Array.from({ length: 250 }, (_, index) => sample(sensorId, 50_000 + index, 50_000 + index));
    const history: MeasurementHistory = { [sensorId]: { temperature: series } };
    const sliceSpy = vi.spyOn(Array.prototype, "slice");
    let next!: MeasurementHistory;
    let sliceCalls = 0;
    try {
      next = appendLiveHistory(history, incoming, 500);
      sliceCalls = sliceSpy.mock.calls.length;
    } finally {
      sliceSpy.mockRestore();
    }

    expect(sliceCalls).toBeLessThanOrEqual(2);
    expect(next[sensorId]?.temperature).toHaveLength(50_000);
    expect(next[sensorId]?.temperature?.[0]?.value).toBe(250);
    expect(next[sensorId]?.temperature?.at(-1)?.value).toBe(50_249);
    expect(history[sensorId]?.temperature?.[0]?.value).toBe(0);
  });
});

describe("appendHistory", () => {
  it("orders and deduplicates a mixed batch before applying its limit", () => {
    const sensorId = "sensor-reconnect";
    const original = [sample(sensorId, 0, 0), sample(sensorId, 2, 2), sample(sensorId, 4, 4)];
    const history: MeasurementHistory = { [sensorId]: { temperature: original } };

    const next = appendHistory(history, [
      sample(sensorId, 3, 30),
      sample(sensorId, 1, 10),
      sample(sensorId, 3, 33),
      sample(sensorId, 5, 50),
      sample(sensorId, 2, 22),
    ], 5);

    expect(next[sensorId]?.temperature?.map((item) => item.value)).toEqual([10, 22, 33, 4, 50]);
    expect(new Set(next[sensorId]?.temperature?.map((item) => item.timestamp)).size).toBe(5);
    expect(history[sensorId]?.temperature).toEqual(original);
  });
});
