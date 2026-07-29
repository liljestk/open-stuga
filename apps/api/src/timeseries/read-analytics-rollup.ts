import type {
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
} from "./types.js";
import {
  IncompleteTelemetryHistoryError,
  aborted,
  type HybridArchiveReadState,
} from "./read-support.js";

interface AnalyticsRollupArchive {
  measurementAnalyticsRollup?(
    query: MeasurementAnalyticsRollupQuery,
  ): Promise<MeasurementAnalyticsRollupResult>;
}

interface ReadMeasurementAnalyticsRollupOptions {
  archive: AnalyticsRollupArchive | null;
  archivePhase: (() => string | null | undefined) | undefined;
  reconcile: (() => void | Promise<void>) | undefined;
  localHistoryComplete: boolean;
  realDataMode: boolean;
}

export interface HybridMeasurementAnalyticsRollupResult {
  result: MeasurementAnalyticsRollupResult;
  archiveState: HybridArchiveReadState;
}

function safePhase(provider: (() => string | null | undefined) | undefined): string | null | undefined {
  if (!provider) return "ready";
  try {
    return provider();
  } catch {
    return null;
  }
}

function requestReconciliation(reconcile: (() => void | Promise<void>) | undefined): void {
  if (!reconcile) return;
  try {
    const result = reconcile();
    if (result && typeof result.then === "function") void result.catch(() => undefined);
  } catch {
    // A best-effort wake-up must not replace the read failure.
  }
}

/**
 * Derived aggregates cannot be merged with an overlapping SQLite tail without
 * double counting. Catch up first and then use the archive as the sole source.
 */
export async function readMeasurementAnalyticsRollup(
  options: ReadMeasurementAnalyticsRollupOptions,
  query: Omit<MeasurementAnalyticsRollupQuery, "excludeSynthetic">,
): Promise<HybridMeasurementAnalyticsRollupResult | null> {
  const cancellation = aborted(query.signal);
  if (cancellation) throw cancellation;
  if (!options.archive?.measurementAnalyticsRollup) {
    if (options.localHistoryComplete) return null;
    throw new IncompleteTelemetryHistoryError("not-configured");
  }

  let phase = safePhase(options.archivePhase);
  if (phase === "syncing" && options.reconcile) {
    try {
      await options.reconcile();
    } catch {
      // The phase and archive read below decide whether history is complete.
    }
    const afterReconcileCancellation = aborted(query.signal);
    if (afterReconcileCancellation) throw afterReconcileCancellation;
    phase = safePhase(options.archivePhase);
  }
  if (phase !== "ready") {
    if (options.localHistoryComplete) return null;
    throw new IncompleteTelemetryHistoryError("not-ready");
  }

  try {
    return {
      result: await options.archive.measurementAnalyticsRollup({
        ...query,
        excludeSynthetic: options.realDataMode,
      }),
      archiveState: "merged",
    };
  } catch (error) {
    const afterFailureCancellation = aborted(query.signal);
    if (afterFailureCancellation) throw afterFailureCancellation;
    requestReconciliation(options.reconcile);
    if (options.localHistoryComplete) return null;
    throw new IncompleteTelemetryHistoryError("failed");
  }
}
