import type {
  MeasurementSample,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  PropertyElectricityPricePoint,
  PropertyElectricityTariff,
  Reading,
  Sensor,
} from "@climate-twin/contracts";
import type {
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementGapQuery,
  MeasurementGapRecord,
  MeasurementHistoryBucketedQuery,
  MeasurementHistoryQuery,
  MeasurementBoundaryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  OpeningStateHistoryQuery,
  OpeningStateRecord,
  OpeningStateSnapshotQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  PowerCostAggregateQuery,
  ThermalMeasurementHistoryQuery,
} from "./types.js";
import { bucketLegacyReadings, bucketMeasurementSamples } from "./read-buckets.js";
import {
  archivedElectricityPrice,
  archivedMeasurement,
  archivedOpeningState,
  archivedOutdoor,
  archivedReading,
  compareElectricityPrices,
  compareMeasurements,
  compareOpeningStates,
  compareOutdoor,
  compareReadings,
  compareText,
  electricityPriceKey,
  measurementCoverageKey,
  measurementKey,
  openingStateIdentityKey,
  openingStateKey,
  outdoorKey,
  readingKey,
} from "./read-records.js";
import {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_WINDOW_LIMIT,
  IncompleteTelemetryHistoryError,
  MAX_HISTORY_LIMIT,
  MAX_WINDOW_LIMIT,
  aborted,
  isSyntheticSource,
  mapWithConcurrency,
  positiveLimit,
  unique,
  yieldToEventLoop,
  type HybridArchiveReadState,
  type HybridMeasurementCoverageResult,
  type HybridTelemetryFamily,
  type HybridTelemetryReadResult,
  type LocalCompletenessQuery,
} from "./read-support.js";
import { readMeasurementAnalyticsRollup, type HybridMeasurementAnalyticsRollupResult } from "./read-analytics-rollup.js";
import { readCostAggregate } from "./read-energy-cost.js";
import { withTariffPrice } from "../electricity/tariff-cost.js";
import { readPowerProfile, type LocalPowerProfileQuery, type PowerProfile } from "./read-power-profile.js";

export { bucketLegacyReadings, bucketMeasurementSamples };
export { IncompleteTelemetryHistoryError, isLocalTelemetryHistoryComplete } from "./read-support.js";
export type {
  HybridArchiveReadState,
  HybridMeasurementCoverageResult,
  HybridTelemetryFamily,
  HybridTelemetryReadProvenance,
  HybridTelemetryReadResult,
  LocalCompletenessQuery,
} from "./read-support.js";
export type { HybridMeasurementAnalyticsRollupResult } from "./read-analytics-rollup.js";
export type { MeasurementWindowQuery } from "./types.js";

/** The local SQLite reads needed by the facade, with optional worker isolation. */
/** Local SQLite reads the hybrid reader needs; ClimateDatabase implements every one. */
export interface LocalTelemetryReader {
  isRealDataMode(): boolean;
  measurementWindowAsync(query: MeasurementWindowQuery): Promise<MeasurementSample[]>;
  optimizerPowerProfileAsync(query: LocalPowerProfileQuery): Promise<PowerProfile>;
  thermalMeasurementHistoryAsync(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSample[]>;
  measurementHistoryBucketedAsync(query: MeasurementHistoryBucketedQuery & { toExclusive?: boolean }): Promise<MeasurementSample[]>;
  measurementBoundarySamples(query: MeasurementBoundaryQuery): MeasurementSample[];
  measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
  measurementSampleGaps(
    sensorId: string,
    metric: string,
    source: string,
    from: string,
    to: string,
    minimumGapMs: number,
    limit?: number,
  ): MeasurementGapRecord[];
  measurementHistory(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    limit?: number,
    before?: { timestamp: string; source: string },
  ): MeasurementSample[];
  measurementHistoryBucketed(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    bucketSeconds: number,
    limit?: number,
    excludeSynthetic?: boolean,
    toExclusive?: boolean,
  ): MeasurementSample[];
  thermalTemperatureHistory(
    sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number,
  ): MeasurementSample[];
  thermalClimateHistory(
    sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number,
  ): MeasurementSample[];
  measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
  measurementWindowPage(
    sensorIds: string[],
    metrics: string[],
    from: string,
    to: string,
    limit: number,
    before?: { timestamp: string; id: number } | null,
  ): { samples: MeasurementSample[]; next: { timestamp: string; id: number } | null };
  history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
  outdoorTemperatureHistory(
    houseId: string,
    locationKey: string,
    from: string,
    to: string,
    limit?: number,
  ): OutdoorTemperatureSample[];
  listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
  getPropertyElectricityTariff(propertyId: string): PropertyElectricityTariff | null;
  propertyElectricityTimeZone(propertyId: string): string;
  listOpeningStateObservations(
    houseId: string, limit?: number, at?: string | number | Date,
  ): OpeningStateObservation[];
  listOpeningStateObservationHistory(
    houseId: string, from: string | number | Date, to: string | number | Date, limit?: number,
  ): OpeningStateObservation[];
  energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
  powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
  costAggregateAsync(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
}

/** Structural archive methods used by the hybrid reader. */
export interface ArchiveTelemetryReader {
  measurementBoundarySamples?(query: MeasurementBoundaryQuery): Promise<MeasurementSampleRecord[]>;
  measurementCoverage?(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
  measurementSampleGaps?(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]>;
  measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
  measurementHistoryBucketed?(query: MeasurementHistoryBucketedQuery): Promise<MeasurementSampleRecord[]>;
  thermalMeasurementHistory?(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
  measurementWindow?(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
  measurementAnalyticsRollup?(query: MeasurementAnalyticsRollupQuery): Promise<MeasurementAnalyticsRollupResult>;
  legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
  outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
  electricityPriceHistory?(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
  openingStateHistory?(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
  openingStateSnapshot?(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
  energyCostAggregate?(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
  powerCostAggregate?(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
}

export interface HybridTelemetryReaderOptions {
  local: LocalTelemetryReader;
  archive?: ArchiveTelemetryReader | null;
  /** An injected archive is assumed ready when no phase provider is supplied. */
  archivePhase?: () => string | null | undefined;
  /**
   * When a reconcile pass completed this recently, bucketed reads trust the
   * archive for everything older than the local hot tail. Without a provider
   * the local store is always read over the full window.
   */
  archiveLastSuccessAt?: () => string | null | undefined;
  /** Best-effort wake-up after an archive read fails. */
  reconcile?: () => void | Promise<void>;
  /** Defaults to true for standalone SQLite mode. */
  localHistoryComplete?: boolean | ((query: LocalCompletenessQuery) => boolean);
  /** Bounds the compatibility fan-out used until the archive has a batch window query. */
  archiveWindowConcurrency?: number;
  /** Injectable clock for hot-tail decisions. */
  now?: () => number;
}

/**
 * node:sqlite runs one statement to completion without observing signals.
 * File-backed SQLite runs bucket reads in its bounded worker. Compatibility
 * readers still tile windows into day-scale statements and yield between them.
 */
const LOCAL_BUCKET_CHUNK_SECONDS = 86_400;

/** A reconcile pass completed this recently proves older samples are archived. */
const ARCHIVE_FRESH_WINDOW_MS = 15 * 60_000;

/**
 * With a fresh archive, SQLite only serves the unacknowledged hot tail. The
 * tail is deliberately far larger than the worst observed archive lag; samples
 * imported with old timestamps stay invisible for at most one reconcile pass.
 */
const LOCAL_HOT_TAIL_MS = 24 * 3_600_000;

/**
 * The thermal compatibility variant of the bucketing contract described in
 * `read-buckets.ts`. It deliberately differs in one respect — estimated samples
 * carry a quarter weight, matching the archive's `thermalMeasurementHistory`
 * SQL — but the bucket key and the good/estimated quality rule must stay
 * identical to the other two implementations.
 */
function qualityWeightedThermalBuckets(
  samples: readonly MeasurementSample[],
  bucketMinutes: number,
  limitPerMetric: number,
): MeasurementSample[] {
  const bucketMs = bucketMinutes * 60_000;
  const grouped = new Map<string, MeasurementSample[]>();
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const bucketTimestamp = new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString();
    const key = JSON.stringify([sample.sensorId, sample.metric, bucketTimestamp]);
    const bucket = grouped.get(key) ?? [];
    bucket.push(sample);
    grouped.set(key, bucket);
  }

  const byMetric = new Map<string, MeasurementSample[]>();
  for (const [key, bucket] of grouped) {
    const [sensorId, metric, timestamp] = JSON.parse(key) as [string, string, string];
    const weighted = bucket.reduce((total, sample) => total + sample.value * (sample.quality === "estimated" ? 0.25 : 1), 0);
    const weight = bucket.reduce((total, sample) => total + (sample.quality === "estimated" ? 0.25 : 1), 0);
    const result: MeasurementSample = {
      sensorId,
      metric,
      timestamp,
      value: weighted / weight,
      canonicalUnit: [...bucket].sort((left, right) => left.canonicalUnit.localeCompare(right.canonicalUnit))[0]!.canonicalUnit,
      source: [...bucket].sort((left, right) => left.source.localeCompare(right.source))[0]!.source,
      quality: bucket.some((sample) => sample.quality === "good") ? "good" : "estimated",
    };
    const series = byMetric.get(metric) ?? [];
    series.push(result);
    byMetric.set(metric, series);
  }
  return [...byMetric.values()].flatMap((series) => series
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limitPerMetric))
    .sort(compareMeasurements);
}

/**
 * Rows fetched per synchronous SQLite statement while assembling a large local
 * window. Sized so one page stays around 100 ms on a Raspberry Pi; the
 * assembly loop yields between pages.
 */

/** Records merged or partitioned between event-loop yields in bulk paths. */
export const BULK_RECORDS_PER_SLICE = 25_000;

export class HybridTelemetryReader {
  readonly #local: LocalTelemetryReader;
  readonly #archive: ArchiveTelemetryReader | null;
  readonly #archivePhase: (() => string | null | undefined) | undefined;
  readonly #archiveLastSuccessAt: (() => string | null | undefined) | undefined;
  readonly #reconcile: (() => void | Promise<void>) | undefined;
  readonly #localHistoryComplete: boolean | ((query: LocalCompletenessQuery) => boolean);
  readonly #archiveWindowConcurrency: number;
  readonly #now: () => number;

  constructor(options: HybridTelemetryReaderOptions) {
    this.#local = options.local;
    this.#archive = options.archive ?? null;
    this.#archivePhase = options.archivePhase;
    this.#archiveLastSuccessAt = options.archiveLastSuccessAt;
    this.#reconcile = options.reconcile;
    this.#localHistoryComplete = options.localHistoryComplete ?? true;
    this.#archiveWindowConcurrency = positiveLimit(options.archiveWindowConcurrency, 4, 32);
    this.#now = options.now ?? Date.now;
  }

  async measurementHistory(query: MeasurementHistoryQuery): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local: (from) => this.#local.measurementHistory(
        query.sensorId,
        query.metric,
        from,
        query.to,
        limit,
        query.before,
      ),
      hotTail: true,
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.measurementHistory({ ...query, limit })).map(archivedMeasurement),
      key: measurementKey,
      compare: compareMeasurements,
    });
  }

  async measurementBoundarySamples(query: MeasurementBoundaryQuery): Promise<HybridTelemetryReadResult<MeasurementSample> | null> {
    const scoped = { ...query, excludeSynthetic: this.#local.isRealDataMode() };
    return this.#read({
      family: "measurement", from: query.from, to: query.to, limit: MAX_HISTORY_LIMIT,
      local: () => this.#local.measurementBoundarySamples(scoped),
      signal: query.signal,
      archiveRead: async () => {
        if (!this.#archive?.measurementBoundarySamples) throw new Error("Archive boundary reads unavailable");
        return (await this.#archive.measurementBoundarySamples(scoped)).map(archivedMeasurement);
      },
      key: measurementKey, compare: compareMeasurements,
    });
  }

  async measurementHistoryBucketed(
    query: MeasurementHistoryBucketedQuery,
  ): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    if (!Number.isInteger(query.bucketSeconds) || query.bucketSeconds < 1 || query.bucketSeconds > 86_400) {
      throw new RangeError("bucketSeconds must be an integer from 1 to 86400");
    }
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    const realMode = this.#local.isRealDataMode();
    const complete = this.#isLocalHistoryComplete({
      family: "measurement",
      from: query.from,
      to: query.to,
    });
    const fromMs = Date.parse(query.from);
    const queryToMs = Date.parse(query.to);
    // The per-bucket completeness probe is only meaningful when the window as a
    // whole is incomplete; hoisting the check keeps the common case from
    // re-parsing two dates for every one of up to 20,000 buckets.
    const bucketFilter = complete ? null : (sample: MeasurementSample) => this.#isLocalHistoryComplete({
      family: "measurement",
      from: sample.timestamp,
      to: new Date(Math.min(
        queryToMs,
        Date.parse(sample.timestamp) + query.bucketSeconds * 1_000,
      )).toISOString(),
    });
    const readLocal = (localFromMs: number) => localFromMs > queryToMs
      ? Promise.resolve<MeasurementSample[]>([])
      : this.#localBucketsChunked({
        sensorId: query.sensorId,
        metric: query.metric,
        fromMs: localFromMs,
        to: query.to,
        toMs: queryToMs,
        bucketSeconds: query.bucketSeconds,
        limit,
        excludeSynthetic: realMode,
        signal: query.signal,
        bucketFilter,
      });
    const key = (record: MeasurementSample) => JSON.stringify([record.sensorId, record.metric, record.timestamp]);
    const localOnlyInput = (local: MeasurementSample[]) => ({ limit, local, compare: compareMeasurements });

    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if (!this.#archive || (phase !== "ready" && phase !== "syncing")) {
      const archiveState = this.#archive ? "not-ready" as const : "not-configured" as const;
      if (!complete) throw new IncompleteTelemetryHistoryError(archiveState);
      const local = await readLocal(fromMs);
      return this.#localOnly(localOnlyInput(local), local, 0, true, archiveState);
    }

    let archived: MeasurementSample[];
    try {
      if (!this.#archive.measurementHistoryBucketed) {
        throw new Error("Bucketed archive reads are unavailable");
      }
      archived = (await this.#archive.measurementHistoryBucketed({
        ...query,
        limit,
        excludeSynthetic: realMode,
        includeMetadata: false,
      })).map(archivedMeasurement);
    } catch {
      const afterFailureCancellation = aborted(query.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      if (!complete) throw new IncompleteTelemetryHistoryError("failed");
      const local = await readLocal(fromMs);
      return this.#localOnly(localOnlyInput(local), local, 0, true, "failed");
    }
    const afterArchiveCancellation = aborted(query.signal);
    if (afterArchiveCancellation) throw afterArchiveCancellation;

    // With a recent completed reconcile pass, everything older than the hot
    // tail is already archived, so SQLite is spared the long historical scan.
    // Freshly imported samples carrying old timestamps stay invisible for at
    // most one reconcile pass; without a freshness provider the local copy is
    // always read over the full window.
    const now = this.#now();
    const hotTailStart = Math.floor((now - LOCAL_HOT_TAIL_MS) / (query.bucketSeconds * 1_000)) * query.bucketSeconds * 1_000;
    const local = await readLocal(this.#archiveFresh(now) ? Math.max(fromMs, hotTailStart) : fromMs);
    const filteredArchive = realMode ? archived.filter((record) => !isSyntheticSource(record.source)) : archived;
    const result = await this.#mergeRecords({ limit, key, compare: compareMeasurements }, {
      complete,
      localTotal: local.length,
      archivedTotal: archived.length,
      filteredLocal: local,
      filteredArchive,
    });
    const afterMergeCancellation = aborted(query.signal);
    if (afterMergeCancellation) throw afterMergeCancellation;
    return result;
  }

  /**
   * Reads local buckets newest-first as day-scale statements, stopping once
   * the requested number of buckets is collected and yielding to the event
   * loop between statements. Chunk edges land on the bucket grid, so a bucket
   * is always aggregated by exactly one statement.
   */
  async #localBucketsChunked(input: {
    sensorId: string;
    metric: string;
    fromMs: number;
    to: string;
    toMs: number;
    bucketSeconds: number;
    limit: number;
    excludeSynthetic: boolean;
    signal: AbortSignal | undefined;
    bucketFilter: ((sample: MeasurementSample) => boolean) | null;
  }): Promise<MeasurementSample[]> {
    const bucketMs = input.bucketSeconds * 1_000;
    const chunkMs = Math.max(
      bucketMs,
      Math.floor(LOCAL_BUCKET_CHUNK_SECONDS / input.bucketSeconds) * input.bucketSeconds * 1_000,
    );
    const firstChunkStartMs = Math.floor(input.fromMs / bucketMs) * bucketMs;
    const chunkStarts: number[] = [];
    // The newest chunk absorbs the inclusive upper bound, so a window ending
    // exactly on a chunk edge does not spawn a zero-width statement.
    for (let start = firstChunkStartMs; start < input.toMs || chunkStarts.length === 0; start += chunkMs) {
      chunkStarts.push(start);
    }
    let collected: MeasurementSample[] = [];
    for (let index = chunkStarts.length - 1; index >= 0; index -= 1) {
      const cancellation = aborted(input.signal);
      if (cancellation) throw cancellation;
      const chunkStartMs = chunkStarts[index]!;
      const chunkFrom = new Date(Math.max(input.fromMs, chunkStartMs)).toISOString();
      const needed = input.limit - collected.length;
      const isNewestChunk = index === chunkStarts.length - 1;
      const rows = await this.#local.measurementHistoryBucketedAsync({
        sensorId: input.sensorId, metric: input.metric, from: chunkFrom,
        to: isNewestChunk ? input.to : new Date(chunkStartMs + chunkMs).toISOString(),
        bucketSeconds: input.bucketSeconds, limit: needed,
        excludeSynthetic: input.excludeSynthetic, toExclusive: !isNewestChunk,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const kept = input.bucketFilter ? rows.filter(input.bucketFilter) : rows;
      if (kept.length) collected = [...kept, ...collected];
      if (collected.length >= input.limit) break;
      if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return collected.slice(-input.limit);
  }

  /**
   * Finds bounded timestamp pairs without materializing and sorting a complete
   * raw series in Node. Once available, the archive is authoritative for this
   * historical scan so adjacency is never split across two databases.
   */
  async measurementSampleGaps(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]> {
    const limit = positiveLimit(query.limit, 100, 1_000);
    const complete = this.#isLocalHistoryComplete({
      family: "measurement",
      from: query.from,
      to: query.to,
    });
    const bounded = (records: MeasurementGapRecord[]) => {
      const merged = new Map<string, MeasurementGapRecord>();
      for (const record of records) merged.set(`${record.startedAt}\u0000${record.endedAt}`, record);
      return [...merged.values()]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
          || left.endedAt.localeCompare(right.endedAt))
        .slice(0, limit);
    };
    const readLocal = () => bounded(this.#local.measurementSampleGaps(
      query.sensorId,
      query.metric,
      query.source,
      query.from,
      query.to,
      query.minimumGapMs,
      limit,
    ));
    if (!this.#archive) {
      if (!complete) throw new IncompleteTelemetryHistoryError("not-configured");
      return readLocal();
    }
    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if ((phase !== "ready" && phase !== "syncing") || !this.#archive.measurementSampleGaps) {
      if (!complete) throw new IncompleteTelemetryHistoryError("not-ready");
      return readLocal();
    }
    try {
      const archived = await this.#archive.measurementSampleGaps({ ...query, limit });
      return bounded(archived);
    } catch {
      const cancellation = aborted(query.signal);
      if (cancellation) throw cancellation;
      this.#requestReconciliation();
      if (!complete) throw new IncompleteTelemetryHistoryError("failed");
      return readLocal();
    }
  }

  async thermalMeasurementHistory(
    query: ThermalMeasurementHistoryQuery,
  ): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    const metrics = unique(query.metrics);
    const bucketMinutes = positiveLimit(query.bucketMinutes, 5, 60);
    const limitPerMetric = positiveLimit(query.limitPerMetric, 5_000, 20_000);
    if (metrics.length === 0) {
      return this.#localOnly({
        limit: 1,
        local: [],
        compare: compareMeasurements,
      }, [], 0, true, "not-configured");
    }
    if (metrics.length > 5) throw new RangeError("thermal history supports at most 5 metrics");
    const readLocal = async (): Promise<MeasurementSample[]> => {
      if (metrics.every(metric => metric === "temperature" || metric === "humidity")) {
        return this.#local.thermalMeasurementHistoryAsync({
          ...query, metrics, bucketMinutes, limitPerMetric,
        });
      }
      return bucketMeasurementSamples(
        (await this.#localMeasurementWindow(
          [query.sensorId],
          metrics,
          query.from,
          query.to,
          MAX_WINDOW_LIMIT,
          query.signal,
        )).filter((sample) => sample.quality !== "stale" && sample.source !== "replay"),
        bucketMinutes * 60,
      );
    };
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit: limitPerMetric * metrics.length,
      local: readLocal,
      signal: query.signal,
      archiveRead: async () => {
        try {
          if (!this.#archive!.thermalMeasurementHistory) {
            throw new Error("Thermal rollup reads are unavailable");
          }
          return (await this.#archive!.thermalMeasurementHistory({
            ...query,
            metrics,
            bucketMinutes,
            limitPerMetric,
          })).map(archivedMeasurement);
        } catch (error) {
          const cancellation = aborted(query.signal);
          if (cancellation) throw cancellation;
          this.#requestReconciliation();
          let raw: MeasurementSampleRecord[];
          if (this.#archive!.measurementWindow) {
            raw = await this.#archive!.measurementWindow({
              sensorIds: [query.sensorId],
              metrics,
              from: query.from,
              to: query.to,
              limit: MAX_WINDOW_LIMIT,
              ...(query.signal ? { signal: query.signal } : {}),
              ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }),
            });
            if (raw.length >= MAX_WINDOW_LIMIT) throw error;
          } else {
            const pages = await mapWithConcurrency(metrics, this.#archiveWindowConcurrency, (metric) => (
              this.#archive!.measurementHistory({
                sensorId: query.sensorId,
                metric,
                from: query.from,
                to: query.to,
                limit: MAX_HISTORY_LIMIT,
                ...(query.signal ? { signal: query.signal } : {}),
                ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }),
              })
            ));
            if (pages.some((page) => page.length >= MAX_HISTORY_LIMIT)) throw error;
            raw = pages.flat();
          }
          const realMode = this.#local.isRealDataMode();
          return qualityWeightedThermalBuckets(
            raw.map(archivedMeasurement).filter((sample) => (
              (sample.quality === "good" || sample.quality === "estimated")
              && sample.source !== "replay"
              && (!realMode || !isSyntheticSource(sample.source))
            )),
            bucketMinutes,
            limitPerMetric,
          );
        }
      },
      key: (record) => JSON.stringify([record.sensorId, record.metric, record.timestamp]),
      compare: compareMeasurements,
    });
  }

  async measurementWindow(query: MeasurementWindowQuery): Promise<HybridTelemetryReadResult<MeasurementSample>> {
    const limit = positiveLimit(query.limit, DEFAULT_WINDOW_LIMIT, MAX_WINDOW_LIMIT);
    const sensorIds = unique(query.sensorIds);
    const metrics = unique(query.metrics);
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#localMeasurementWindow(sensorIds, metrics, query.from, query.to, limit, query.signal),
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

  async measurementAnalyticsRollup(
    query: Omit<MeasurementAnalyticsRollupQuery, "excludeSynthetic">,
  ): Promise<HybridMeasurementAnalyticsRollupResult | null> {
    return readMeasurementAnalyticsRollup({
      archive: this.#archive,
      archivePhase: this.#archivePhase,
      reconcile: this.#reconcile,
      realDataMode: this.#local.isRealDataMode(),
    }, query);
  }

  async measurementCoverage(query: MeasurementCoverageQuery): Promise<HybridMeasurementCoverageResult> {
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    const sensorIds = unique(query.sensorIds);
    const metrics = unique(query.metrics);
    const local = this.#local.measurementCoverage(sensorIds, metrics);
    const localComplete = this.#localHistoryComplete === true;
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
    return this.#read({
      family: "legacy-reading",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#local.history(sensorIds, query.from, query.to, limit),
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
    return this.#read({
      family: "outdoor-temperature",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#local.outdoorTemperatureHistory(
        query.houseId,
        query.locationKey,
        query.from,
        query.to,
        limit,
      ),
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.outdoorTemperatureHistory({ ...query, limit })).map(archivedOutdoor),
      key: outdoorKey,
      compare: compareOutdoor,
    });
  }

  async electricityPriceHistory(
    query: ElectricityPriceHistoryQuery,
  ): Promise<HybridTelemetryReadResult<PropertyElectricityPricePoint>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const result = await this.#read({
      family: "electricity-price",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#local.listPropertyElectricityPrices(query.propertyId, query.from, query.to)
        .map((record) => ({ ...record, source: "sqlite" })),
      signal: query.signal,
      archiveRead: async () => this.#archive!.electricityPriceHistory
        ? (await this.#archive!.electricityPriceHistory({ ...query, limit })).map(archivedElectricityPrice)
        : [],
      key: electricityPriceKey,
      compare: compareElectricityPrices,
    });
    // Archived rows carry the margin snapshot from fetch time; effective
    // prices always come from the raw price and the tariff in force.
    const tariff = this.#local.getPropertyElectricityTariff(query.propertyId);
    const timeZone = this.#local.propertyElectricityTimeZone(query.propertyId);
    return {
      records: result.records.map(({ source: _source, ...record }) => (
        tariff ? withTariffPrice(record, tariff.versions, timeZone) : record
      )),
      provenance: result.provenance,
    };
  }

  async openingStateHistory(
    query: OpeningStateHistoryQuery,
  ): Promise<HybridTelemetryReadResult<OpeningStateObservation>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    return this.#read({
      family: "opening-state",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#local.listOpeningStateObservationHistory(
        query.houseId,
        query.from,
        query.to,
        limit,
      ),
      signal: query.signal,
      archiveRead: async () => {
        if (!this.#archive!.openingStateHistory) throw new Error("Opening-state archive reads are unavailable");
        return (await this.#archive!.openingStateHistory({ ...query, limit })).map(archivedOpeningState);
      },
      key: openingStateKey,
      compare: compareOpeningStates,
    });
  }

  async openingStateSnapshot(
    query: OpeningStateSnapshotQuery,
  ): Promise<HybridTelemetryReadResult<OpeningStateObservation>> {
    const limit = positiveLimit(query.limit, 10_000, MAX_HISTORY_LIMIT);
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    return this.#read({
      family: "opening-state",
      from: "1970-01-01T00:00:00.000Z",
      to: query.at,
      limit,
      local: () => this.#local.listOpeningStateObservations(query.houseId, limit, query.at),
      signal: query.signal,
      archiveRead: async () => {
        if (!this.#archive!.openingStateSnapshot) throw new Error("Opening-state archive snapshots are unavailable");
        return (await this.#archive!.openingStateSnapshot({ ...query, limit })).map(archivedOpeningState);
      },
      key: openingStateIdentityKey,
      compare: compareOpeningStates,
      mergeDuplicate: (archived, local) => (
        archived.observedAt > local.observedAt ? archived : local
      ),
    });
  }

  /**
   * Derived aggregates cannot be merged without double-counting the hot tail.
   * An acknowledged Timescale archive is the sole durable source. SQLite is
   * used only for standalone deployments or a visibly pending hot-tail result.
   */
  async energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    return this.#costAggregate("energy", query);
  }

  async powerCostAggregate(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    return this.#costAggregate("power", query);
  }
  async optimizerPowerProfile(sensors: readonly Sensor[], query: MeasurementWindowQuery, profileFrom: string): Promise<PowerProfile> {
    query = { ...query, sensorIds: unique(query.sensorIds.filter(Boolean)), metrics: ["power"],
      limit: positiveLimit(query.limit, DEFAULT_WINDOW_LIMIT, MAX_WINDOW_LIMIT) };
    return readPowerProfile({ local: this.#local, localOnly: !this.#archive,
      localComplete: this.#isLocalHistoryComplete({ family: "measurement", from: query.from, to: query.to }),
      sensors, query, profileFrom, readWindow: () => this.measurementWindow(query) });
  }

  #costAggregate(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    const scopedQuery = { ...query, excludeSynthetic: this.#local.isRealDataMode() };
    return readCostAggregate({
      query: scopedQuery, metric, local: this.#local, archive: this.#archive,
      archivePhase: this.#archivePhase ? this.#safeArchivePhase() ?? "not-ready" : "ready",
      localHistoryComplete: this.#isLocalHistoryComplete({ family: "measurement", from: query.from, to: query.to }),
      requestReconciliation: () => this.#requestReconciliation(),
    });
  }

  /**
   * Assembles a local window from bounded keyset pages, yielding between
   * pages, so a quarter-million-row window can no longer monopolize the event
   * loop for the whole read. Falls back to the one-shot local read for
   * stores that do not page.
   */
  async #localMeasurementWindow(
    sensorIds: string[],
    metrics: string[],
    from: string,
    to: string,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<MeasurementSample[]> {
    return this.#local.measurementWindowAsync({ sensorIds, metrics, from, to, limit, ...(signal ? { signal } : {}) });
  }

  async #read<T extends { source: string }>(input: {
    family: HybridTelemetryFamily;
    from: string;
    to: string;
    limit: number;
    /** Reads SQLite from `from`, which is the window start unless the hot-tail shortcut applies. */
    local: (from: string) => T[] | Promise<T[]>;
    /**
     * The archive holds this family's history older than the hot tail once a
     * reconcile pass is fresh, so SQLite may read only the tail.
     */
    hotTail?: boolean;
    signal: AbortSignal | undefined;
    archiveRead: () => Promise<T[]>;
    key: (record: T) => string;
    compare: (left: T, right: T) => number;
    /** Defaults to the local record; snapshots can instead keep a newer archived state. */
    mergeDuplicate?: (archived: T, local: T) => T;
  }): Promise<HybridTelemetryReadResult<T>> {
    const cancellation = aborted(input.signal);
    if (cancellation) throw cancellation;
    const complete = this.#isLocalHistoryComplete({ family: input.family, from: input.from, to: input.to });
    const realMode = this.#local.isRealDataMode();
    const phase = !this.#archive ? null : this.#archivePhase ? this.#safeArchivePhase() : "ready";
    const archiveUsable = phase === "ready" || phase === "syncing";
    // Started before the synchronous SQLite read, so the archive query runs
    // while SQLite works instead of after it.
    const archivePending = archiveUsable
      ? input.archiveRead().then(
        (records) => ({ records, error: null }),
        (error: unknown) => ({ records: [] as T[], error: error ?? new Error("Archive read failed") }),
      )
      : null;
    const localFrom = archiveUsable && input.hotTail ? this.#hotTailFrom(input.from) : input.from;
    // The synchronous SQLite read can fail on its own — a wide window sort can
    // exhaust spill space, or the file can be briefly locked. The archive holds
    // the same history, so a local failure only ends the request when no
    // archive read can stand in for it; then the original error propagates
    // instead of being disguised as an empty result.
    const readLocal = async (from: string): Promise<{ records: T[]; error: unknown }> => {
      try {
        return { records: await input.local(from), error: null };
      } catch (error) {
        return { records: [], error };
      }
    };
    let { records: local, error: localReadError } = await readLocal(localFrom);
    const localOnly = (archiveState: "not-configured" | "not-ready" | "failed") => {
      const filtered = realMode ? local.filter((record) => !isSyntheticSource(record.source)) : local;
      return this.#localOnly(
        { limit: input.limit, local, compare: input.compare },
        filtered,
        local.length - filtered.length,
        complete,
        archiveState,
      );
    };

    if (!archivePending) {
      if (localReadError !== null) throw localReadError;
      return localOnly(this.#archive ? "not-ready" : "not-configured");
    }
    const archiveResult = await archivePending;
    if (archiveResult.error !== null) {
      const afterFailureCancellation = aborted(input.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      // Without the archive, the shortcut's older history must come from SQLite after all.
      if (localFrom !== input.from) ({ records: local, error: localReadError } = await readLocal(input.from));
      if (localReadError !== null) throw localReadError;
      return localOnly("failed");
    }
    const archived = archiveResult.records;
    const filteredLocal = realMode ? local.filter((record) => !isSyntheticSource(record.source)) : local;
    const afterArchiveCancellation = aborted(input.signal);
    if (afterArchiveCancellation) throw afterArchiveCancellation;
    const filteredArchive = realMode ? archived.filter((record) => !isSyntheticSource(record.source)) : archived;
    const result = await this.#mergeRecords(input, {
      complete,
      localTotal: local.length,
      archivedTotal: archived.length,
      filteredLocal,
      filteredArchive,
    });
    const afterMergeCancellation = aborted(input.signal);
    if (afterMergeCancellation) throw afterMergeCancellation;
    return result;
  }

  async #mergeRecords<T extends { source: string }>(input: {
    limit: number;
    key: (record: T) => string;
    compare: (left: T, right: T) => number;
    /** Defaults to the local record; snapshots can instead keep a newer archived state. */
    mergeDuplicate?: (archived: T, local: T) => T;
  }, context: {
    complete: boolean;
    localTotal: number;
    archivedTotal: number;
    filteredLocal: T[];
    filteredArchive: T[];
  }): Promise<HybridTelemetryReadResult<T>> {
    const merged = new Map<string, T>();
    let sliceRemaining = BULK_RECORDS_PER_SLICE;
    for (const record of context.filteredArchive) {
      merged.set(input.key(record), record);
      if (--sliceRemaining === 0) {
        sliceRemaining = BULK_RECORDS_PER_SLICE;
        await yieldToEventLoop();
      }
    }
    for (const record of context.filteredLocal) {
      const key = input.key(record);
      const existing = merged.get(key);
      merged.set(key, existing && input.mergeDuplicate
        ? input.mergeDuplicate(existing, record)
        : record);
      if (--sliceRemaining === 0) {
        sliceRemaining = BULK_RECORDS_PER_SLICE;
        await yieldToEventLoop();
      }
    }
    const duplicates = context.filteredArchive.length + context.filteredLocal.length - merged.size;
    const records = [...merged.values()].sort(input.compare).slice(-input.limit);
    return {
      records,
      provenance: {
        localSource: "sqlite",
        archiveSource: "timescale",
        archiveState: "merged",
        localHistoryComplete: context.complete,
        localRecordCount: context.localTotal,
        archiveRecordCount: context.archivedTotal,
        duplicateRecordCount: duplicates,
        filteredSyntheticRecordCount: (context.localTotal - context.filteredLocal.length)
          + (context.archivedTotal - context.filteredArchive.length),
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

  #safeArchiveLastSuccessAt(): string | null | undefined {
    try {
      return this.#archiveLastSuccessAt?.();
    } catch {
      return null;
    }
  }

  /** A reconcile pass completed this recently proves everything older than the hot tail is archived. */
  #archiveFresh(now: number): boolean {
    const lastSuccessAt = this.#safeArchiveLastSuccessAt();
    const lastSuccessMs = typeof lastSuccessAt === "string" ? Date.parse(lastSuccessAt) : Number.NaN;
    return Number.isFinite(lastSuccessMs) && lastSuccessMs <= now && now - lastSuccessMs <= ARCHIVE_FRESH_WINDOW_MS;
  }

  /** Where SQLite must start for a hot-tail read: the tail when the archive is fresh, otherwise `from`. */
  #hotTailFrom(from: string): string {
    const now = this.#now();
    const fromMs = Date.parse(from);
    const tailStart = now - LOCAL_HOT_TAIL_MS;
    return this.#archiveFresh(now) && Number.isFinite(fromMs) && tailStart > fromMs
      ? new Date(tailStart).toISOString()
      : from;
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
