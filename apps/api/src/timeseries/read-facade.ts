import type {
  MeasurementSample,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Reading,
} from "@climate-twin/contracts";
import type {
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
} from "./types.js";

const DEFAULT_HISTORY_LIMIT = 20_000;
const DEFAULT_WINDOW_LIMIT = 100_000;
const MAX_HISTORY_LIMIT = 100_000;
const MAX_WINDOW_LIMIT = 250_000;

export type HybridTelemetryFamily = "measurement" | "legacy-reading" | "outdoor-temperature";
export type HybridArchiveReadState = "not-configured" | "not-ready" | "merged" | "failed";

export interface HybridTelemetryReadProvenance {
  /** SQLite is always consulted and remains authoritative for overlapping rows. */
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

export interface MeasurementWindowQuery extends QueryControl {
  sensorIds: readonly string[];
  metrics: readonly string[];
  from: string;
  to: string;
  limit?: number;
}

/** The synchronous, crash-safe SQLite reads needed by the facade. */
export interface LocalTelemetryReader {
  isRealDataMode(): boolean;
  measurementCoverage?(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
  measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number): MeasurementSample[];
  measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
  history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
  outdoorTemperatureHistory(
    houseId: string,
    locationKey: string,
    from: string,
    to: string,
    limit?: number,
  ): OutdoorTemperatureSample[];
  energyCostAggregate?(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
}

/**
 * Structural archive contract. `measurementWindow` is optional so the facade
 * can use today's single-series store and transparently adopt a batch query
 * when one is available.
 */
export interface ArchiveTelemetryReader {
  measurementCoverage?(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
  measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
  measurementWindow?(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
  legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
  outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
  energyCostAggregate?(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
}

export interface LocalCompletenessQuery {
  family: HybridTelemetryFamily;
  from: string;
  to: string;
}

export interface HybridTelemetryReaderOptions {
  local: LocalTelemetryReader;
  archive?: ArchiveTelemetryReader | null;
  /** An injected archive is assumed ready when no phase provider is supplied. */
  archivePhase?: () => string | null | undefined;
  /** Best-effort wake-up after an archive read fails. */
  reconcile?: () => void | Promise<void>;
  /** Defaults to true while SQLite retention is disabled. */
  localHistoryComplete?: boolean | ((query: LocalCompletenessQuery) => boolean);
  /** Bounds the compatibility fan-out used until the archive has a batch window query. */
  archiveWindowConcurrency?: number;
}

export class IncompleteTelemetryHistoryError extends Error {
  readonly code = "TELEMETRY_ARCHIVE_REQUIRED";

  constructor(readonly archiveState: Exclude<HybridArchiveReadState, "merged">) {
    super("Complete telemetry history is temporarily unavailable");
  }
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`limit must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

function isSyntheticSource(source: string): boolean {
  return source === "mock" || source === "replay";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMeasurements(left: MeasurementSample, right: MeasurementSample): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.metric, right.metric)
    || compareText(left.source, right.source);
}

function compareReadings(left: Reading, right: Reading): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.source, right.source);
}

function compareOutdoor(left: OutdoorTemperatureSample, right: OutdoorTemperatureSample): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.houseId, right.houseId)
    || compareText(left.locationKey, right.locationKey)
    || compareText(left.source, right.source);
}

function measurementKey(record: MeasurementSample): string {
  return JSON.stringify([record.sensorId, record.metric, record.timestamp, record.source]);
}

function measurementCoverageKey(record: MeasurementCoverageRecord): string {
  return JSON.stringify([record.sensorId, record.metric]);
}

function readingKey(record: Reading): string {
  return JSON.stringify([record.sensorId, record.timestamp, record.source]);
}

function outdoorKey(record: OutdoorTemperatureSample): string {
  return JSON.stringify([record.houseId, record.locationKey, record.timestamp, record.source]);
}

export function bucketMeasurementSamples(samples: readonly MeasurementSample[], bucketSeconds: number): MeasurementSample[] {
  const buckets = new Map<number, MeasurementSample[]>();
  for (const sample of samples) {
    const epoch = Math.floor(Date.parse(sample.timestamp) / (bucketSeconds * 1_000)) * bucketSeconds;
    if (!Number.isFinite(epoch)) continue;
    const bucket = buckets.get(epoch) ?? [];
    bucket.push(sample);
    buckets.set(epoch, bucket);
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([epoch, bucket]) => {
    const latest = [...bucket].sort(compareMeasurements).at(-1)!;
    return {
      ...latest,
      value: bucket.reduce((sum, sample) => sum + sample.value, 0) / bucket.length,
      timestamp: new Date(epoch * 1_000).toISOString(),
      quality: bucket.length > 1 || new Set(bucket.map((sample) => sample.source)).size > 1 ? "estimated" : latest.quality,
    };
  });
}

export function bucketLegacyReadings(readings: readonly Reading[], bucketSeconds: number): Reading[] {
  const buckets = new Map<string, Reading[]>();
  for (const reading of readings) {
    const epoch = Math.floor(Date.parse(reading.timestamp) / (bucketSeconds * 1_000)) * bucketSeconds;
    if (!Number.isFinite(epoch)) continue;
    const key = JSON.stringify([reading.sensorId, epoch]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(reading);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const [sensorId, epoch] = JSON.parse(key) as [string, number];
    const latest = [...bucket].sort(compareReadings).at(-1)!;
    return {
      ...latest,
      sensorId,
      timestamp: new Date(epoch * 1_000).toISOString(),
      temperature: bucket.reduce((sum, reading) => sum + reading.temperature, 0) / bucket.length,
      humidity: bucket.reduce((sum, reading) => sum + reading.humidity, 0) / bucket.length,
      quality: bucket.length > 1 || new Set(bucket.map((reading) => reading.source)).size > 1 ? "estimated" : latest.quality,
    };
  }).sort(compareReadings);
}

function archivedMeasurement(record: MeasurementSampleRecord): MeasurementSample {
  return {
    sensorId: record.sensorId,
    metric: record.metric,
    value: record.value,
    canonicalUnit: record.canonicalUnit,
    timestamp: record.timestamp,
    // Archive rows originate from the core contract. Its archive type is wider
    // solely to permit future adapters without a storage migration.
    source: record.source as MeasurementSample["source"],
    quality: record.quality as MeasurementSample["quality"],
  };
}

function archivedReading(record: LegacyReadingRecord): Reading {
  return {
    sensorId: record.sensorId,
    timestamp: record.timestamp,
    temperature: record.temperature,
    humidity: record.humidity,
    battery: record.battery,
    source: record.source as Reading["source"],
    quality: record.quality as Reading["quality"],
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function archivedOutdoor(record: OutdoorTemperatureRecord): OutdoorTemperatureSample {
  const metadata = objectValue(record.metadata);
  const conditions = objectValue(metadata?.conditions) as OutdoorConditions | null;
  return {
    houseId: record.houseId,
    locationKey: record.locationKey,
    timestamp: record.timestamp,
    temperatureC: record.temperatureC,
    source: record.source as OutdoorTemperatureSample["source"],
    fetchedAt: record.fetchedAt,
    stationId: record.stationId,
    stationName: record.stationName,
    ...(conditions ? { conditions } : {}),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function mapWithConcurrency<T, R>(
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

function aborted(signal: AbortSignal | undefined): Error | null {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error("Telemetry read aborted");
}

export class HybridTelemetryReader {
  readonly #local: LocalTelemetryReader;
  readonly #archive: ArchiveTelemetryReader | null;
  readonly #archivePhase: (() => string | null | undefined) | undefined;
  readonly #reconcile: (() => void | Promise<void>) | undefined;
  readonly #localHistoryComplete: boolean | ((query: LocalCompletenessQuery) => boolean);
  readonly #archiveWindowConcurrency: number;

  constructor(options: HybridTelemetryReaderOptions) {
    this.#local = options.local;
    this.#archive = options.archive ?? null;
    this.#archivePhase = options.archivePhase;
    this.#reconcile = options.reconcile;
    this.#localHistoryComplete = options.localHistoryComplete ?? true;
    this.#archiveWindowConcurrency = positiveLimit(options.archiveWindowConcurrency, 4, 32);
  }

  async measurementHistory(query: MeasurementHistoryQuery): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const local = this.#local.measurementHistory(query.sensorId, query.metric, query.from, query.to, limit);
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local,
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.measurementHistory({ ...query, limit })).map(archivedMeasurement),
      key: measurementKey,
      compare: compareMeasurements,
    });
  }

  async measurementWindow(query: MeasurementWindowQuery): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    const limit = positiveLimit(query.limit, DEFAULT_WINDOW_LIMIT, MAX_WINDOW_LIMIT);
    const sensorIds = unique(query.sensorIds);
    const metrics = unique(query.metrics);
    const local = this.#local.measurementWindow(sensorIds, metrics, query.from, query.to, limit);
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local,
      signal: query.signal,
      archiveRead: async () => {
        if (sensorIds.length === 0 || metrics.length === 0) return [];
        if (this.#archive!.measurementWindow) {
          return (await this.#archive!.measurementWindow({ ...query, sensorIds, metrics, limit })).map(archivedMeasurement);
        }
        const series = sensorIds.flatMap((sensorId) => metrics.map((metric) => ({ sensorId, metric })));
        const pages = await mapWithConcurrency(series, this.#archiveWindowConcurrency, async ({ sensorId, metric }) => (
          this.#archive!.measurementHistory({
            sensorId,
            metric,
            from: query.from,
            to: query.to,
            limit: Math.min(limit, MAX_HISTORY_LIMIT),
            ...(query.signal ? { signal: query.signal } : {}),
            ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }),
          })
        ));
        return pages.flat().map(archivedMeasurement);
      },
      key: measurementKey,
      compare: compareMeasurements,
    });
  }

  async measurementCoverage(query: MeasurementCoverageQuery): Promise<HybridMeasurementCoverageResult> {
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    const sensorIds = unique(query.sensorIds);
    const metrics = unique(query.metrics);
    const local = this.#local.measurementCoverage?.(sensorIds, metrics) ?? [];
    const localComplete = this.#localHistoryComplete === true && this.#local.measurementCoverage !== undefined;
    if (!this.#archive) return { records: local, archiveState: "not-configured", complete: localComplete };
    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if (phase !== "ready" && phase !== "syncing") {
      return { records: local, archiveState: "not-ready", complete: localComplete };
    }
    if (!this.#archive.measurementCoverage) {
      return { records: local, archiveState: "failed", complete: localComplete };
    }
    try {
      const archived = await this.#archive.measurementCoverage({
        ...query,
        sensorIds,
        metrics,
        excludeSynthetic: this.#local.isRealDataMode(),
      });
      const merged = new Map<string, MeasurementCoverageRecord>();
      for (const record of [...archived, ...local]) {
        const key = measurementCoverageKey(record);
        const current = merged.get(key);
        merged.set(key, current ? {
          ...current,
          start: current.start < record.start ? current.start : record.start,
          end: current.end > record.end ? current.end : record.end,
        } : record);
      }
      return {
        records: [...merged.values()].sort((left, right) => compareText(left.sensorId, right.sensorId) || compareText(left.metric, right.metric)),
        archiveState: "merged",
        complete: true,
      };
    } catch (error) {
      const afterFailureCancellation = aborted(query.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      return { records: local, archiveState: "failed", complete: localComplete };
    }
  }

  async legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<HybridTelemetryReadResult<Reading>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const sensorIds = unique(query.sensorIds);
    const local = this.#local.history(sensorIds, query.from, query.to, limit);
    return this.#read({
      family: "legacy-reading",
      from: query.from,
      to: query.to,
      limit,
      local,
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.legacyReadingHistory({ ...query, sensorIds, limit })).map(archivedReading),
      key: readingKey,
      compare: compareReadings,
    });
  }

  async outdoorTemperatureHistory(
    query: OutdoorTemperatureHistoryQuery,
  ): Promise<HybridTelemetryReadResult<OutdoorTemperatureSample>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const local = this.#local.outdoorTemperatureHistory(
      query.houseId,
      query.locationKey,
      query.from,
      query.to,
      limit,
    );
    return this.#read({
      family: "outdoor-temperature",
      from: query.from,
      to: query.to,
      limit,
      local,
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.outdoorTemperatureHistory({ ...query, limit })).map(archivedOutdoor),
      key: outdoorKey,
      compare: compareOutdoor,
    });
  }

  /**
   * Derived aggregates cannot be merged without double-counting the hot tail.
   * Use SQLite only when its requested measurement window is complete;
   * otherwise use the permanent Timescale archive as the sole source of truth.
   */
  async energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    const complete = this.#isLocalHistoryComplete({ family: "measurement", from: query.from, to: query.to });
    if (complete) {
      if (!this.#local.energyCostAggregate) throw new Error("Local energy-cost aggregation is unavailable");
      return this.#local.energyCostAggregate(query);
    }
    if (!this.#archive || !this.#archive.energyCostAggregate) {
      throw new IncompleteTelemetryHistoryError("not-configured");
    }
    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if (phase !== "ready" && phase !== "syncing") {
      throw new IncompleteTelemetryHistoryError("not-ready");
    }
    try {
      return await this.#archive.energyCostAggregate(query);
    } catch (error) {
      const afterFailureCancellation = aborted(query.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      throw new IncompleteTelemetryHistoryError("failed");
    }
  }

  async #read<T extends { source: string }>(input: {
    family: HybridTelemetryFamily;
    from: string;
    to: string;
    limit: number;
    local: T[];
    signal: AbortSignal | undefined;
    archiveRead: () => Promise<T[]>;
    key: (record: T) => string;
    compare: (left: T, right: T) => number;
  }): Promise<HybridTelemetryReadResult<T>> {
    const cancellation = aborted(input.signal);
    if (cancellation) throw cancellation;
    const complete = this.#isLocalHistoryComplete({ family: input.family, from: input.from, to: input.to });
    const realMode = this.#local.isRealDataMode();
    const filteredLocal = realMode ? input.local.filter((record) => !isSyntheticSource(record.source)) : input.local;
    const localFilteredCount = input.local.length - filteredLocal.length;

    if (!this.#archive) {
      return this.#localOnly(input, filteredLocal, localFilteredCount, complete, "not-configured");
    }
    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if (phase !== "ready" && phase !== "syncing") {
      return this.#localOnly(input, filteredLocal, localFilteredCount, complete, "not-ready");
    }

    let archived: T[];
    try {
      archived = await input.archiveRead();
    } catch (error) {
      const afterFailureCancellation = aborted(input.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      return this.#localOnly(input, filteredLocal, localFilteredCount, complete, "failed");
    }
    const filteredArchive = realMode ? archived.filter((record) => !isSyntheticSource(record.source)) : archived;
    const archiveFilteredCount = archived.length - filteredArchive.length;
    const merged = new Map<string, T>();
    for (const record of filteredArchive) merged.set(input.key(record), record);
    for (const record of filteredLocal) merged.set(input.key(record), record);
    const duplicates = filteredArchive.length + filteredLocal.length - merged.size;
    const records = [...merged.values()].sort(input.compare).slice(-input.limit);
    return {
      records,
      provenance: {
        localSource: "sqlite",
        archiveSource: "timescale",
        archiveState: "merged",
        localHistoryComplete: complete,
        localRecordCount: input.local.length,
        archiveRecordCount: archived.length,
        duplicateRecordCount: duplicates,
        filteredSyntheticRecordCount: localFilteredCount + archiveFilteredCount,
        returnedRecordCount: records.length,
      },
    };
  }

  #localOnly<T extends { source: string }>(
    input: { limit: number; local: T[]; compare: (left: T, right: T) => number },
    filteredLocal: T[],
    filteredSyntheticRecordCount: number,
    complete: boolean,
    archiveState: Exclude<HybridArchiveReadState, "merged">,
  ): HybridTelemetryReadResult<T> {
    if (!complete) throw new IncompleteTelemetryHistoryError(archiveState);
    const records = [...filteredLocal].sort(input.compare).slice(-input.limit);
    return {
      records,
      provenance: {
        localSource: "sqlite",
        archiveSource: this.#archive ? "timescale" : null,
        archiveState,
        localHistoryComplete: true,
        localRecordCount: input.local.length,
        archiveRecordCount: 0,
        duplicateRecordCount: 0,
        filteredSyntheticRecordCount,
        returnedRecordCount: records.length,
      },
    };
  }

  #isLocalHistoryComplete(query: LocalCompletenessQuery): boolean {
    return typeof this.#localHistoryComplete === "function"
      ? this.#localHistoryComplete(query)
      : this.#localHistoryComplete;
  }

  #safeArchivePhase(): string | null | undefined {
    try {
      return this.#archivePhase?.();
    } catch {
      return null;
    }
  }

  #requestReconciliation(): void {
    if (!this.#reconcile) return;
    try {
      const result = this.#reconcile();
      if (result && typeof result.then === "function") void result.catch(() => undefined);
    } catch {
      // Read fallback must not be replaced by a best-effort wake-up failure.
    }
  }
}
