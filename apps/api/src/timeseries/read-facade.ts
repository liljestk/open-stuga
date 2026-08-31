import type {
  MeasurementSample,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  PropertyElectricityPricePoint,
  Reading,
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
  type SourcedElectricityPrice,
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
  type HybridArchiveReadState,
  type HybridMeasurementCoverageResult,
  type HybridTelemetryFamily,
  type HybridTelemetryReadResult,
  type LocalCompletenessQuery,
} from "./read-support.js";
import { readMeasurementAnalyticsRollup, type HybridMeasurementAnalyticsRollupResult } from "./read-analytics-rollup.js";
import { readCostAggregate } from "./read-energy-cost.js";

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

/** The synchronous, crash-safe SQLite reads needed by the facade. */
export interface LocalTelemetryReader {
  isRealDataMode(): boolean;
  measurementCoverage?(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
  measurementSampleGaps?(
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
  ): MeasurementSample[];
  thermalTemperatureHistory?(
    sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number,
  ): MeasurementSample[];
  thermalClimateHistory?(
    sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number,
  ): MeasurementSample[];
  measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
  history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
  outdoorTemperatureHistory(
    houseId: string,
    locationKey: string,
    from: string,
    to: string,
    limit?: number,
  ): OutdoorTemperatureSample[];
  listPropertyElectricityPrices?(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
  listOpeningStateObservations?(
    houseId: string, limit?: number, at?: string | number | Date,
  ): OpeningStateObservation[];
  listOpeningStateObservationHistory?(
    houseId: string, from: string | number | Date, to: string | number | Date, limit?: number,
  ): OpeningStateObservation[];
  energyCostAggregate?(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
  powerCostAggregate?(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
}

/** Structural archive methods used by the hybrid reader. */
export interface ArchiveTelemetryReader {
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
  /** Best-effort wake-up after an archive read fails. */
  reconcile?: () => void | Promise<void>;
  /** Defaults to true for standalone SQLite mode. */
  localHistoryComplete?: boolean | ((query: LocalCompletenessQuery) => boolean);
  /** Bounds the compatibility fan-out used until the archive has a batch window query. */
  archiveWindowConcurrency?: number;
}

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
    const cancellation = aborted(query.signal);
    if (cancellation) throw cancellation;
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local: () => this.#local.measurementHistory(
        query.sensorId,
        query.metric,
        query.from,
        query.to,
        limit,
        query.before,
      ),
      signal: query.signal,
      archiveRead: async () => (await this.#archive!.measurementHistory({ ...query, limit })).map(archivedMeasurement),
      key: measurementKey,
      compare: compareMeasurements,
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
    const readLocal = () => {
      const rawLocal = this.#local.measurementHistoryBucketed(
        query.sensorId,
        query.metric,
        query.from,
        query.to,
        query.bucketSeconds,
        limit,
        realMode,
      );
      // The per-bucket completeness probe is only meaningful when the window as a
      // whole is incomplete; hoisting the check keeps the common case from
      // re-parsing two dates for every one of up to 20,000 buckets.
      const queryToMs = Date.parse(query.to);
      return complete ? rawLocal : rawLocal.filter((sample) => this.#isLocalHistoryComplete({
        family: "measurement",
        from: sample.timestamp,
        to: new Date(Math.min(
          queryToMs,
          Date.parse(sample.timestamp) + query.bucketSeconds * 1_000,
        )).toISOString(),
      }));
    };
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit,
      local: readLocal,
      signal: query.signal,
      archiveRead: async () => {
        if (!this.#archive!.measurementHistoryBucketed) {
          throw new Error("Bucketed archive reads are unavailable");
        }
        return (await this.#archive!.measurementHistoryBucketed({
          ...query,
          limit,
          excludeSynthetic: realMode,
        })).map(archivedMeasurement);
      },
      key: (record) => JSON.stringify([record.sensorId, record.metric, record.timestamp]),
      compare: compareMeasurements,
    });
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
    const readLocal = () => bounded(this.#local.measurementSampleGaps?.(
      query.sensorId,
      query.metric,
      query.source,
      query.from,
      query.to,
      query.minimumGapMs,
      limit,
    ) ?? []);
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
    const readLocal = (): MeasurementSample[] => {
      if (metrics.length === 1 && metrics[0] === "temperature" && this.#local.thermalTemperatureHistory) {
        return this.#local.thermalTemperatureHistory(
          query.sensorId,
          query.from,
          query.to,
          bucketMinutes,
          limitPerMetric,
        );
      }
      if (metrics.every((metric) => metric === "temperature" || metric === "humidity")
        && this.#local.thermalClimateHistory) {
        const requestedMetrics = new Set<string>(metrics);
        return this.#local.thermalClimateHistory(
          query.sensorId,
          query.from,
          query.to,
          bucketMinutes,
          limitPerMetric,
        ).filter((sample) => requestedMetrics.has(sample.metric));
      }
      return bucketMeasurementSamples(
        this.#local.measurementWindow(
          [query.sensorId],
          metrics,
          query.from,
          query.to,
          MAX_WINDOW_LIMIT,
        ).filter((sample) => sample.quality !== "stale" && sample.source !== "replay"),
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
      local: () => this.#local.measurementWindow(sensorIds, metrics, query.from, query.to, limit),
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
      local: () => (this.#local.listPropertyElectricityPrices?.(query.propertyId, query.from, query.to) ?? [])
        .map((record) => ({ ...record, source: "sqlite" })),
      signal: query.signal,
      archiveRead: async () => this.#archive!.electricityPriceHistory
        ? (await this.#archive!.electricityPriceHistory({ ...query, limit })).map(archivedElectricityPrice)
        : [],
      key: electricityPriceKey,
      compare: compareElectricityPrices,
    });
    return {
      records: result.records.map(({ source: _source, ...record }) => record),
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
      local: () => this.#local.listOpeningStateObservationHistory?.(
        query.houseId,
        query.from,
        query.to,
        limit,
      ) ?? [],
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
      local: () => this.#local.listOpeningStateObservations?.(query.houseId, limit, query.at) ?? [],
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

  #costAggregate(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    const scopedQuery = { ...query, excludeSynthetic: this.#local.isRealDataMode() };
    return readCostAggregate({
      query: scopedQuery, metric, local: this.#local, archive: this.#archive,
      archivePhase: this.#archivePhase ? this.#safeArchivePhase() ?? "not-ready" : "ready",
      localHistoryComplete: this.#isLocalHistoryComplete({ family: "measurement", from: query.from, to: query.to }),
      requestReconciliation: () => this.#requestReconciliation(),
    });
  }

  async #read<T extends { source: string }>(input: {
    family: HybridTelemetryFamily;
    from: string;
    to: string;
    limit: number;
    local: () => T[];
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
    // The synchronous SQLite read can fail on its own — a wide window sort can
    // exhaust spill space, or the file can be briefly locked. The archive holds
    // the same history, so a local failure only ends the request when no
    // archive read can stand in for it; then the original error propagates
    // instead of being disguised as an empty result.
    let local: T[] = [];
    let localReadError: unknown = null;
    try {
      local = input.local();
    } catch (error) {
      localReadError = error;
    }
    const filteredLocal = realMode ? local.filter((record) => !isSyntheticSource(record.source)) : local;
    const localFilteredCount = local.length - filteredLocal.length;
    const localOnlyInput = { limit: input.limit, local, compare: input.compare };

    if (!this.#archive) {
      if (localReadError !== null) throw localReadError;
      return this.#localOnly(localOnlyInput, filteredLocal, localFilteredCount, complete, "not-configured");
    }
    const phase = this.#archivePhase ? this.#safeArchivePhase() : "ready";
    if (phase !== "ready" && phase !== "syncing") {
      if (localReadError !== null) throw localReadError;
      return this.#localOnly(localOnlyInput, filteredLocal, localFilteredCount, complete, "not-ready");
    }

    let archived: T[];
    try {
      archived = await input.archiveRead();
    } catch (error) {
      const afterFailureCancellation = aborted(input.signal);
      if (afterFailureCancellation) throw afterFailureCancellation;
      this.#requestReconciliation();
      if (localReadError !== null) throw localReadError;
      return this.#localOnly(localOnlyInput, filteredLocal, localFilteredCount, complete, "failed");
    }
    const afterArchiveCancellation = aborted(input.signal);
    if (afterArchiveCancellation) throw afterArchiveCancellation;
    const filteredArchive = realMode ? archived.filter((record) => !isSyntheticSource(record.source)) : archived;
    const archiveFilteredCount = archived.length - filteredArchive.length;
    const merged = new Map<string, T>();
    for (const record of filteredArchive) merged.set(input.key(record), record);
    for (const record of filteredLocal) {
      const key = input.key(record);
      const existing = merged.get(key);
      merged.set(key, existing && input.mergeDuplicate
        ? input.mergeDuplicate(existing, record)
        : record);
    }
    const duplicates = filteredArchive.length + filteredLocal.length - merged.size;
    const records = [...merged.values()].sort(input.compare).slice(-input.limit);
    const afterMergeCancellation = aborted(input.signal);
    if (afterMergeCancellation) throw afterMergeCancellation;
    return {
      records,
      provenance: {
        localSource: "sqlite",
        archiveSource: "timescale",
        archiveState: "merged",
        localHistoryComplete: complete,
        localRecordCount: local.length,
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
