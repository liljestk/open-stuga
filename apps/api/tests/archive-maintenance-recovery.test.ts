import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startArchiveMaintenance } from "../src/timeseries/archive-maintenance.js";
import { TelemetryOrderedRollupWorker } from "../src/timeseries/ordered-rollup-worker.js";
import type { TimeseriesStore } from "../src/timeseries/store.js";

describe("archive maintenance recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("prepares ordered history after archive recovery even when initial startup rejects", async () => {
    let phase = "initialization-failed";
    const rebuild = vi.fn(async () => ({ processed: false }));
    const ordered = new TelemetryOrderedRollupWorker({
      rebuildNextMeasurementOrderedRollup: rebuild,
    } as unknown as TimeseriesStore, { ready: () => ["syncing", "ready"].includes(phase) });
    const archive = { start: vi.fn()
      .mockRejectedValueOnce(new Error("temporary schema lock"))
      .mockImplementation(async () => { phase = "syncing"; }) };
    const retention = { start: vi.fn() };
    try {
      await expect(startArchiveMaintenance(archive, ordered, retention)).rejects.toThrow("temporary schema lock");
      expect(retention.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rebuild).not.toHaveBeenCalled();
      // The archive owns this retry; maintenance is never started a second time.
      await archive.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rebuild).toHaveBeenCalledOnce();
    } finally {
      await ordered.stop();
    }
  });

  it("retries transient rebuild failures and stops querying if archive readiness is lost", async () => {
    let ready = true;
    const rebuild = vi.fn().mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue({ processed: false });
    const ordered = new TelemetryOrderedRollupWorker({
      rebuildNextMeasurementOrderedRollup: rebuild,
    } as unknown as TimeseriesStore, { ready: () => ready });
    try {
      ordered.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(rebuild).toHaveBeenCalledOnce();
      ready = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rebuild).toHaveBeenCalledOnce();
      ready = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rebuild).toHaveBeenCalledTimes(2);
    } finally {
      await ordered.stop();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
});
