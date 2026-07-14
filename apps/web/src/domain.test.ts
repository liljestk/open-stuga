import { describe, expect, it } from "vitest";
import type { Reading } from "@climate-twin/contracts";
import { displayValue, readingAt, toCanonicalValue } from "./domain";

describe("display and replay domain helpers", () => {
  it("round-trips imperial alert thresholds to canonical Celsius", () => {
    expect(toCanonicalValue(68, "temperature", "imperial")).toBeCloseTo(20);
    expect(displayValue(toCanonicalValue(68, "temperature", "imperial"), "temperature", "imperial")).toBe("68.0°F");
    expect(toCanonicalValue(65, "humidity", "imperial")).toBe(65);
  });

  it("selects the latest reading at or before a replay timestamp", () => {
    const base: Omit<Reading, "timestamp" | "temperature"> = {
      sensorId: "sensor-1", humidity: 45, battery: 90, source: "mock", quality: "good",
    };
    const readings: Reading[] = [
      { ...base, timestamp: "2026-07-14T08:00:00.000Z", temperature: 20 },
      { ...base, timestamp: "2026-07-14T08:10:00.000Z", temperature: 21 },
    ];
    expect(readingAt(readings, Date.parse("2026-07-14T08:05:00.000Z"))?.temperature).toBe(20);
    expect(readingAt(readings, Date.parse("2026-07-14T07:59:00.000Z"))).toBeUndefined();
  });
});
