import type { MeasurementCoverageRecord } from "./types.js";

export const DEFAULT_HISTORY_LIMIT = 20_000;
export const DEFAULT_WINDOW_LIMIT = 100_000;
export const MAX_HISTORY_LIMIT = 100_000;
export const MAX_WINDOW_LIMIT = 250_000;

export type HybridTelemetryFamily =
  | "measurement"
  | "legacy-reading"
  | "outdoor-temperature"
  | "electricity-price"
  | "opening-state";
export type HybridArchiveReadState = "not-configured" | "not-ready" | "merged" | "failed";

export interface HybridTelemetryReadProvenance {
  localSource: "sqlite";
  archiveSource: "timescale" | null;
  archiveState: HybridArchiveReadState;
  localHistoryComplete: boolean;
  localRecordCount: number;
  archiveRecordCount: number;
  duplicateRecordCount: number;
  filteredSyntheticRecordCount: number;
  returnedRecordCount: number;
}

export interface HybridTelemetryReadResult<T> {
  records: T[];
  /** Counts and source state only; errors, credentials, paths, and query values are never exposed. */
  provenance: HybridTelemetryReadProvenance;
}

export interface HybridMeasurementCoverageResult {
  records: MeasurementCoverageRecord[];
  archiveState: HybridArchiveReadState;
  /** True when SQLite is complete or archive coverage was merged successfully. */
  complete: boolean;
}

export interface LocalCompletenessQuery {
  family: HybridTelemetryFamily;
  from: string;
  to: string;
}

export interface LocalTelemetryHistoryCompletenessOptions {
  timeseriesEnabled: boolean;
  retentionDays: number;
  from?: string;
  now?: number;
}

/**
 * SQLite is authoritative when TimeDB is disabled and remains a complete
 * redundant copy when retention is explicitly unbounded. A bounded hot copy
 * can only satisfy requests that begin inside its current retention window.
 */
export function isLocalTelemetryHistoryComplete({
  timeseriesEnabled,
  retentionDays,
  from,
  now = Date.now(),
}: LocalTelemetryHistoryCompletenessOptions): boolean {
  if (!timeseriesEnabled || retentionDays === 0) return true;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || from === undefined) return false;
  const fromTimestamp = Date.parse(from);
  return Number.isFinite(fromTimestamp)
    && fromTimestamp >= now - retentionDays * 86_400_000;
}

export class IncompleteTelemetryHistoryError extends Error {
  readonly code = "TELEMETRY_ARCHIVE_REQUIRED";

  constructor(readonly archiveState: Exclude<HybridArchiveReadState, "merged">) {
    super("Complete telemetry history is temporarily unavailable");
  }
}

/**
 * The exact ordered rollups a cost read depends on are enqueued but not yet
 * rebuilt. The data will exist shortly without any caller-side action, so this
 * is a retryable state rather than an archive fault.
 */
export class RollupsMaterializingError extends Error {
  readonly code = "TELEMETRY_ROLLUPS_MATERIALIZING";
  readonly retryAfterSeconds = 5;

  constructor() {
    super("Telemetry cost rollups are still materializing the requested history");
  }
}

export function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`limit must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

export function isSyntheticSource(source: string): boolean {
  return source === "mock" || source === "replay";
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

export function aborted(signal: AbortSignal | undefined): Error | null {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error("Telemetry read aborted");
}
