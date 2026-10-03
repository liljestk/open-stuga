import type {
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
} from "./types.js";
import {
  aborted,
  RollupsMaterializingError,
  type HybridArchiveReadState,
} from "./read-support.js";
import { AnalyticsCapacityError } from "../analytics/work-limiter.js";

interface AnalyticsRollupArchive {
  measurementAnalyticsRollup?(
    query: MeasurementAnalyticsRollupQuery,
  ): Promise<MeasurementAnalyticsRollupResult>;
}

interface ReadMeasurementAnalyticsRollupOptions {
  archive: AnalyticsRollupArchive | null;
  archivePhase: (() => string | null | undefined) | undefined;
  reconcile: (() => void | Promise<void>) | undefined;
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

async function waitForReconciliation(reconcile: () => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return reconcile();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted(signal));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    // The shared archive operation continues; only this caller stops waiting.
    void Promise.resolve().then(reconcile).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
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
    // The optimized path is optional. Returning null lets the caller use the
    // raw hybrid archive reader, which still enforces complete-history rules.
    return null;
  }

  let phase = safePhase(options.archivePhase);
  if (phase === "syncing" && options.reconcile) {
    try {
      await waitForReconciliation(options.reconcile, query.signal);
    } catch {
      // The phase and archive read below decide whether history is complete.
    }
    const afterReconcileCancellation = aborted(query.signal);
    if (afterReconcileCancellation) throw afterReconcileCancellation;
    phase = safePhase(options.archivePhase);
  }
  if (phase !== "ready") {
    return null;
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
    if (error instanceof RollupsMaterializingError || error instanceof AnalyticsCapacityError) throw error;
    requestReconciliation(options.reconcile);
    // A continuous aggregate can briefly lag newly archived raw samples.
    // Fall through to the raw archive instead of turning that lag into a 503.
    return null;
  }
}
