import { expect, it } from "vitest";
import type { SensorDataGap } from "@climate-twin/contracts";
import { deriveSensorAnalyticsGapStatus } from "./sensorAnalyticsGaps";

const start = Date.parse("2026-09-01T00:00:00Z");
const hour = 3_600_000;
const gap = {
  sensorId: "room", metric: "temperature", startedAt: new Date(start - 30 * 24 * hour).toISOString(),
  endedAt: null, recoveryState: "open",
} as SensorDataGap;
const input = {
  durable: [gap], activeSensorIds: ["room"], metric: "temperature", from: start, to: start + 24 * hour,
  thresholdMs: 1.5 * hour,
};

it("does not mark recorded history missing because an old source outage remains open", () => {
  const status = deriveSensorAnalyticsGapStatus({ ...input,
    observed: [{ sensor: { id: "room" }, points: Array.from({ length: 25 }, (_, i) => ({ timestamp: start + i * hour })) }],
  });
  expect(status.missingSeriesCount).toBe(0);
  expect(status.missingIntervals).toEqual([]);
});

it("keeps real holes without extending them over observations or claiming a live source is offline", () => {
  const status = deriveSensorAnalyticsGapStatus({ ...input,
    observed: [{ sensor: { id: "room" }, points: Array.from({ length: 25 }, (_, i) => i)
      .filter((i) => i < 10 || i > 14).map((i) => ({ timestamp: start + i * hour })) }],
  });
  expect(status.missingSeriesCount).toBe(1);
  expect(status.missingIntervals).toHaveLength(1);
  expect(status.missingIntervals[0]).toMatchObject({ startedAt: start + 9 * hour, endedAt: start + 15 * hour });
  expect(status.statusKey).toBe("analytics.gapRecoveryChecking");
});
