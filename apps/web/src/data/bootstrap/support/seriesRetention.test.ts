import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../../api";

import { replaceMeasurementSeriesWindow } from "./bootstrapState";
import { canonicalSeries, MAX_SERIES_SAMPLES, seriesBucketSeconds } from "./telemetryState";

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

describe("historical series retention", () => {
  it("loads a predecessor for electricity integration without extending other metrics", async () => {
    const from = "2026-09-01T00:00:00.000Z";
    const to = "2026-09-02T00:00:00.000Z";
    const request = vi.spyOn(api, "measurementHistoryPage").mockResolvedValue({
      samples: [], from, to, bucketSeconds: 60, truncated: false, nextCursor: null,
    });
    try {
      for (const metric of ["power", "energy", "temperature"]) {
        await canonicalSeries("sensor-1", metric, "24h", from, to, false);
        expect(request).toHaveBeenLastCalledWith(
          "sensor-1", metric,
          metric === "temperature" ? from : "2026-08-31T23:45:00.000Z",
          to, 20_000, 60,
        );
      }
    } finally {
      request.mockRestore();
    }
  });

  it("requests bounded server buckets for every range so responses cover the whole window", () => {
    expect(seriesBucketSeconds("6h")).toBe(15);
    expect(seriesBucketSeconds("24h")).toBe(60);
    expect(seriesBucketSeconds("7d")).toBe(60);
    expect(seriesBucketSeconds("30d")).toBe(300);
    expect(seriesBucketSeconds("90d")).toBe(900);
    expect(seriesBucketSeconds("1y")).toBe(3_600);
    expect(seriesBucketSeconds("1y", "power")).toBe(900);
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
});
