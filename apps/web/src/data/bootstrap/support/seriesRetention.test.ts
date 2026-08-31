import type { MeasurementSample, Reading } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";

import { replaceLegacySeriesWindow, replaceMeasurementSeriesWindow } from "./bootstrapState";
import { isLegacySeriesCompatibilityError, MAX_SERIES_SAMPLES, seriesBucketSeconds } from "./telemetryState";

function sample(timestamp: string, value: number): MeasurementSample {
  return {
    sensorId: "sensor-1",
    metric: "temperature",
    value,
    canonicalUnit: "\u00B0C",
    timestamp,
    source: "api",
    quality: "good",
  };
}

function reading(timestamp: string, temperature: number): Reading {
  return {
    sensorId: "sensor-1",
    timestamp,
    temperature,
    humidity: 50,
    battery: null,
    source: "api",
    quality: "good",
  };
}

function apiError(status: number, code: string | null, message: string): Error {
  return Object.assign(new Error(message), { name: "ApiRequestError", status, code });
}

describe("historical series retention", () => {
  it("requests bounded server buckets for every range so responses cover the whole window", () => {
    expect(seriesBucketSeconds("6h")).toBe(15);
    expect(seriesBucketSeconds("24h")).toBe(60);
    expect(seriesBucketSeconds("7d")).toBe(60);
    expect(seriesBucketSeconds("30d")).toBe(300);
    expect(seriesBucketSeconds("90d")).toBe(900);
    expect(seriesBucketSeconds("1y")).toBe(3_600);
  });

  it("recognizes only explicit compatibility responses for the legacy projection", () => {
    expect(isLegacySeriesCompatibilityError(apiError(404, "NOT_FOUND", "API endpoint not found"))).toBe(true);
    expect(isLegacySeriesCompatibilityError(apiError(405, null, "Method not allowed"))).toBe(true);
    expect(isLegacySeriesCompatibilityError(apiError(501, null, "Not implemented"))).toBe(true);
    expect(isLegacySeriesCompatibilityError(apiError(404, "NOT_FOUND", "Sensor not found"))).toBe(false);
    expect(isLegacySeriesCompatibilityError(new DOMException("Timed out", "TimeoutError"))).toBe(false);
    expect(isLegacySeriesCompatibilityError(new DOMException("Cancelled", "AbortError"))).toBe(false);
    expect(isLegacySeriesCompatibilityError(new Error("Connection failed"))).toBe(false);
  });

  it("fully replaces an authoritative requested measurement window and retains samples outside it", () => {
    const retainedBefore = sample("2026-08-10T00:00:00.000Z", 10);
    const staleInside = sample("2026-08-11T00:00:00.000Z", 11);
    const retainedAfter = sample("2026-08-12T00:00:00.000Z", 12);
    const refreshed = sample("2026-08-11T01:00:00.000Z", 21);
    const live = sample("2026-08-11T02:00:00.000Z", 22);

    expect(replaceMeasurementSeriesWindow(
      [retainedBefore, staleInside, retainedAfter],
      [refreshed],
      [live],
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
    )).toEqual([retainedBefore, refreshed, live, retainedAfter]);

    const manyRetained = Array.from({ length: MAX_SERIES_SAMPLES + 1 }, (_, index) => (
      sample(new Date(Date.UTC(2020, 0, 1) + index).toISOString(), index)
    ));
    const capped = replaceMeasurementSeriesWindow(
      manyRetained,
      [sample("2030-01-01T00:00:00.000Z", 30)],
      [],
      "2030-01-01T00:00:00.000Z",
      "2030-01-02T00:00:00.000Z",
    );
    expect(capped).toHaveLength(MAX_SERIES_SAMPLES);
    expect(capped.at(-1)?.value).toBe(30);
  });

  it("retains the cached requested-window prefix that a truncated response did not cover", () => {
    const cachedPrefix = sample("2026-08-11T01:00:00.000Z", 11);
    const staleCoveredGap = sample("2026-08-11T10:30:00.000Z", 12);
    const after = sample("2026-08-12T01:00:00.000Z", 13);
    const refreshedStart = sample("2026-08-11T10:00:00.000Z", 20);
    const refreshedEnd = sample("2026-08-11T11:00:00.000Z", 21);

    expect(replaceMeasurementSeriesWindow(
      [cachedPrefix, staleCoveredGap, after],
      [refreshedStart, refreshedEnd],
      [],
      "2026-08-11T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      true,
    )).toEqual([cachedPrefix, refreshedStart, refreshedEnd, after]);
  });

  it("retains cached requested-window data when an empty truncated response covers no timestamps", () => {
    const cached = sample("2026-08-11T01:00:00.000Z", 11);

    expect(replaceMeasurementSeriesWindow(
      [cached],
      [],
      [],
      "2026-08-11T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      true,
    )).toEqual([cached]);
  });

  it("applies the same requested-window replacement to legacy readings", () => {
    const before = reading("2026-08-10T00:00:00.000Z", 10);
    const stale = reading("2026-08-11T00:00:00.000Z", 11);
    const refreshed = reading("2026-08-11T01:00:00.000Z", 21);
    const after = reading("2026-08-12T00:00:00.000Z", 12);

    expect(replaceLegacySeriesWindow(
      [before, stale, after],
      [refreshed],
      [],
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
    )).toEqual([before, refreshed, after]);
  });
});
