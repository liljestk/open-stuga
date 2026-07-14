import { describe, expect, it } from "vitest";
import { bucketTimestamp, groupMeasurements, metricJsonPath, parseReadingInput, readingsToMeasurements } from "../src/telemetry.js";

describe("hosted telemetry compaction", () => {
  it("coalesces metrics from one sensor into a single time bucket", () => {
    const reading = parseReadingInput({
      sensorId: "sensor-1",
      temperature: 21.4,
      humidity: 44,
      battery: 93,
      timestamp: "2026-07-14T12:07:30.000Z",
      source: "tp-link",
    });
    const grouped = groupMeasurements(readingsToMeasurements([reading]), 600);
    expect(grouped).toEqual([expect.objectContaining({
      sensorId: "sensor-1",
      timestamp: "2026-07-14T12:00:00.000Z",
      values: { temperature: 21.4, humidity: 44, battery: 93 },
    })]);
  });

  it("uses stable UTC bucket boundaries", () => {
    expect(bucketTimestamp("2026-07-14T12:19:59.999Z", 600)).toBe("2026-07-14T12:10:00.000Z");
  });

  it("rejects unsafe metric paths", () => {
    expect(() => metricJsonPath("temperature') OR 1=1 --")).toThrow("registry identifier");
  });

  it("reports invalid client timestamps as a request error", () => {
    expect(() => parseReadingInput({
      sensorId: "sensor-1", temperature: 21, humidity: 40, timestamp: "not-a-date",
    })).toThrow("valid ISO-8601 instant");
  });
});
