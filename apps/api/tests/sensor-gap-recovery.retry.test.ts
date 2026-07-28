import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { SensorGapRecoveryCoordinator } from "../src/sensor-gap-recovery.js";
import { sensorGapRecoveryConfig as config } from "./sensor-gap-recoveryTestSupport.js";

describe("sensor data-gap recovery retry scheduling", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("backs off when a partial recovery only replays rows already stored", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-01T02:00:00.000Z";
    const duplicate = {
      sensorId: "sensor-01",
      metric: "temperature",
      value: 21,
      canonicalUnit: "\u00b0C",
      timestamp: "2026-07-01T01:00:00.000Z",
      source: "tp-link" as const,
      quality: "estimated" as const,
    };
    runtime.measurements.ingest(duplicate);
    runtime.database.noteHistoricalSensorDataGap("sensor-01", "temperature", "tp-link", from, to, from);
    const recoverHistory = vi.fn(async () => ({
      state: "partial" as const,
      samples: [duplicate],
      error: "The source retained only part of the interval",
    }));
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [{
      source: "tp-link",
      availability: () => [],
      recoverHistory,
    }], { retryBaseMs: 60_000 });
    const attemptedAt = new Date("2026-07-02T00:00:00.000Z");

    await recovery.runOnce(attemptedAt);

    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "partial",
      recoveredPoints: 0,
      attemptCount: 1,
      nextAttemptAt: "2026-07-02T00:01:00.000Z",
    });
    await recovery.runOnce(new Date("2026-07-02T00:00:01.000Z"));
    expect(recoverHistory).toHaveBeenCalledOnce();
  });
});
