import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { appendLiveHistory, samplesAt, type MeasurementHistory } from "./measurements";

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
});
