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
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  OpeningStateHistoryQuery,
  OpeningStateRecord,
  OpeningStateSnapshotQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
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

export { bucketLegacyReadings, bucketMeasurementSamples };
export { IncompleteTelemetryHistoryError } from "./read-support.js";
export type {
  HybridArchiveReadState,
  HybridMeasurementCoverageResult,
  HybridTelemetryFamily,
  HybridTelemetryReadProvenance,
  HybridTelemetryReadResult,
  LocalCompletenessQuery,
} from "./read-support.js";

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
}

/**
 * Structural archive contract. `measurementWindow` is optional so the facade
 * can use today's single-series store and transparently adopt a batch query
 * when one is available.
 */
export interface ArchiveTelemetryReader {
  measurementCoverage?(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
  measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
  thermalMeasurementHistory?(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
  measurementWindow?(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
  legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
  outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
  electricityPriceHistory?(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
  openingStateHistory?(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
  openingStateSnapshot?(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
  energyCostAggregate?(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
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
    let local: MeasurementSample[];
    if (metrics.length === 1 && metrics[0] === "temperature" && this.#local.thermalTemperatureHistory) {
      local = this.#local.thermalTemperatureHistory(
        query.sensorId,
        query.from,
        query.to,
        bucketMinutes,
        limitPerMetric,
      );
    } else if (metrics.every((metric) => metric === "temperature" || metric === "humidity")
      && this.#local.thermalClimateHistory) {
      local = this.#local.thermalClimateHistory(
        query.sensorId,
        query.from,
        query.to,
        bucketMinutes,
        limitPerMetric,
      ).filter((sample) => new Set<string>(metrics).has(sample.metric));
    } else {
      local = bucketMeasurementSamples(
        this.#local.measurementWindow(
          [query.sensorId],
          metrics,
          query.from,
          query.to,
          MAX_WINDOW_LIMIT,
        ).filter((sample) => sample.quality !== "stale" && sample.source !== "replay"),
        bucketMinutes * 60,
      );
    }
    return this.#read({
      family: "measurement",
      from: query.from,
      to: query.to,
      limit: limitPerMetric * metrics.length,
      local,
      signal: query.signal,
      archiveRead: async () => {
        if (!this.#archive!.thermalMeasurementHistory) {
          throw new Error("Thermal archive reads are unavailable");
        }
        return (await this.#archive!.thermalMeasurementHistory({
          ...query,
          metrics,
          bucketMinutes,
          limitPerMetric,
        })).map(archivedMeasurement);
      },
      key: (record) => JSON.stringify([record.sensorId, record.metric, record.timestamp]),
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

  async electricityPriceHistory(
    query: ElectricityPriceHistoryQuery,
  ): Promise<HybridTelemetryReadResult<PropertyElectricityPricePoint>> {
    const limit = positiveLimit(query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const local = (this.#local.listPropertyElectricityPrices?.(query.propertyId, query.from, query.to) ?? [])
      .map((record) => ({ ...record, source: "sqlite" }));
    const result = await this.#read({
      family: "electricity-price",
      from: query.from,
      to: query.to,
      limit,
      local,
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
    const local = this.#local.listOpeningStateObservationHistory?.(
      query.houseId,
      query.from,
      query.to,
      limit,
    ) ?? [];
    return this.#read({
      family: "opening-state",
      from: query.from,
      to: query.to,
      limit,
      local,
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
    const local = this.#local.listOpeningStateObservations?.(query.houseId, limit, query.at) ?? [];
    return this.#read({
      family: "opening-state",
      from: "1970-01-01T00:00:00.000Z",
      to: query.at,
      limit,
      local,
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
    /** Defaults to the local record; snapshots can instead keep a newer archived state. */
    mergeDuplicate?: (archived: T, local: T) => T;
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
    for (const record of filteredLocal) {
      const key = input.key(record);
      const existing = merged.get(key);
      merged.set(key, existing && input.mergeDuplicate
        ? input.mergeDuplicate(existing, record)
        : record);
    }
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
