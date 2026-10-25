import { describe, expect, it, vi } from "vitest";
import { AnalyticsCapacityError } from "../src/analytics/work-limiter.js";
import {
  LOCAL_COST_FALLBACK_MAX_WINDOW_MS,
  readCostAggregate,
} from "../src/timeseries/read-energy-cost.js";
import {
  IncompleteTelemetryHistoryError,
  RollupsMaterializingError,
} from "../src/timeseries/read-support.js";
import type { EnergyCostAggregateRecord } from "../src/timeseries/types.js";

const FROM = "2026-08-30T00:00:00.000Z";
const SHORT_TO = "2026-08-31T00:00:00.000Z";
const LONG_TO = new Date(
  Date.parse(FROM) + LOCAL_COST_FALLBACK_MAX_WINDOW_MS + 60_000,
).toISOString();

function aggregate(spotCostEur: number): EnergyCostAggregateRecord {
  return {
    deltaCount: 2,
    consumptionKwh: 1,
    pricedConsumptionKwh: 1,
    spotCostEur,
    hourly: [],
    totalDurationMs: 3_600_000,
    pricedDurationMs: 3_600_000,
    maximumIntervalDurationMs: 60_000,
    coverageFrom: FROM,
    coverageUntil: SHORT_TO,
  };
}

function readWith(options: {
  to: string;
  archiveError: unknown;
  localHistoryComplete?: boolean;
  archivePhase?: string;
}) {
  const local = vi.fn(() => aggregate(0.1));
  const reconcile = vi.fn();
  const result = readCostAggregate({
    query: { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: options.to },
    metric: "energy",
    local: { energyCostAggregate: local },
    archive: {
      energyCostAggregate: vi.fn(async () => {
        throw options.archiveError;
      }),
    },
    archivePhase: options.archivePhase ?? "ready",
    localHistoryComplete: options.localHistoryComplete ?? true,
    requestReconciliation: reconcile,
  });
  return { result, local, reconcile };
}

describe("readCostAggregate fallback policy", () => {
  it("serves short windows locally while rollups are still materializing", async () => {
    const { result, local, reconcile } = readWith({
      to: SHORT_TO,
      archiveError: new RollupsMaterializingError(),
    });
    await expect(result).resolves.toMatchObject({ spotCostEur: 0.1, archiveState: "pending" });
    expect(local).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("propagates materializing rollups for long windows instead of scanning SQLite", async () => {
    const { result, local, reconcile } = readWith({
      to: LONG_TO,
      archiveError: new RollupsMaterializingError(),
    });
    await expect(result).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(local).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("propagates shed analytics load for long windows without adding local work", async () => {
    const { result, local, reconcile } = readWith({
      to: LONG_TO,
      archiveError: new AnalyticsCapacityError(),
    });
    await expect(result).rejects.toBeInstanceOf(AnalyticsCapacityError);
    expect(local).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("still substitutes locally for short windows when the archive fails", async () => {
    const { result, local, reconcile } = readWith({
      to: SHORT_TO,
      archiveError: new Error("connection refused"),
    });
    await expect(result).resolves.toMatchObject({ spotCostEur: 0.1, archiveState: "pending" });
    expect(local).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("surfaces an archive failure for long windows instead of blocking the event loop", async () => {
    const { result, local, reconcile } = readWith({
      to: LONG_TO,
      archiveError: new Error("connection refused"),
    });
    await expect(result).rejects.toMatchObject({ archiveState: "failed" });
    await expect(result).rejects.toBeInstanceOf(IncompleteTelemetryHistoryError);
    expect(local).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("caps the not-ready archive substitute at the same local window", async () => {
    const local = vi.fn(() => aggregate(0.2));
    const reconcile = vi.fn();
    const base = {
      metric: "energy" as const,
      local: { energyCostAggregate: local },
      archive: { energyCostAggregate: vi.fn(async () => aggregate(0.9)) },
      archivePhase: "degraded",
      localHistoryComplete: true,
      requestReconciliation: reconcile,
    };
    await expect(readCostAggregate({
      ...base,
      query: { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: SHORT_TO },
    })).resolves.toMatchObject({ spotCostEur: 0.2, archiveState: "pending" });
    await expect(readCostAggregate({
      ...base,
      query: { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: LONG_TO },
    })).rejects.toBeInstanceOf(IncompleteTelemetryHistoryError);
    expect(local).toHaveBeenCalledOnce();
  });

  it("keeps archive-less deployments on the local engine for every window", async () => {
    const local = vi.fn(() => aggregate(0.3));
    await expect(readCostAggregate({
      query: { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: LONG_TO },
      metric: "energy",
      local: { energyCostAggregate: local },
      archive: null,
      archivePhase: "ready",
      localHistoryComplete: true,
      requestReconciliation: vi.fn(),
    })).resolves.toMatchObject({ spotCostEur: 0.3, archiveState: "local-only" });
    expect(local).toHaveBeenCalledOnce();
  });
});
