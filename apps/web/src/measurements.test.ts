import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { samplesAt, type MeasurementHistory } from "./measurements";

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
