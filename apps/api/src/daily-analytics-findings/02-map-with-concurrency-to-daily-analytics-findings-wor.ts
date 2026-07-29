import { createHash } from "node:crypto";
import type {
  AnalyticsFinding,
  AnalyticsFindingPeriodEvidence,
  AnalyticsQueryRequest,
  AnalyticsFindingStatistic,
  AnalyticsSeries,
  DailyAnalyticsFindingsSnapshot,
  DataMode,
  House,
  MeasurementDefinition,
  MeasurementSample,
  OpeningStateBinding,
  PlanElement,
  Sensor,
} from "@climate-twin/contracts";
import {
  analyticsDefinitionSemantics,
  buildAnalyticsResponse,
} from "../analytics.js";
import { buildAnalyticsResponseFromRollup, planAnalyticsRollup } from "../analytics-rollup.js";
import {
  ClimateDatabase,
  outdoorLocationKey,
  type OpeningStateActivityRecord,
} from "../db.js";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
  type HybridArchiveReadState,
} from "../timeseries/read-facade.js";
import { DAILY_ANALYTICS_ALGORITHM_VERSION, DEFAULT_INTERVAL_MS, DEFAULT_STARTUP_JITTER_MS, DailyAnalyticsFindingsRunSummary, DailyAnalyticsFindingsWorkerOptions, DailyAnalyticsFindingsWorkerStatus, FindingPeriods, HISTORY_LIMIT, MAX_FINDINGS, MAX_MEASUREMENT_SERIES, OUTDOOR_TEMPERATURE_DEFINITION, PeerPeriod, PeriodValue, RankedFinding, aggregateAnalyticsSeries, comparisonFinding, dailyFindingPeriods, electricityDefinition, errorMessage, openingActivityFromObservations, openingPeriodValue, usable } from "./01-daily-analytics-algorithm-version-to-error-message.js";

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export class DailyAnalyticsFindingsWorker {
  readonly #database: ClimateDatabase;
  readonly #telemetryReader: HybridTelemetryReader;
  readonly #intervalMs: number;
  readonly #startupJitterMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #activeRun: Promise<DailyAnalyticsFindingsRunSummary> | null = null;
  #lifecycle = 0;
  #status: DailyAnalyticsFindingsWorkerStatus = { started: false, running: false, nextRunAt: null, lastRun: null };

  constructor(options: DailyAnalyticsFindingsWorkerOptions) {
    this.#database = options.database;
    this.#telemetryReader = options.telemetryReader;
    this.#intervalMs = Math.max(60_000, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS));
    this.#startupJitterMs = Math.max(0, Math.trunc(options.startupJitterMs ?? DEFAULT_STARTUP_JITTER_MS));
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  status(): DailyAnalyticsFindingsWorkerStatus {
    return { ...this.#status, lastRun: this.#status.lastRun ? { ...this.#status.lastRun } : null };
  }

  start(): void {
    if (this.#status.started) return;
    this.#status.started = true;
    const lifecycle = ++this.#lifecycle;
    const sample = Math.max(0, Math.min(1, this.#random()));
    this.#schedule(Math.floor(sample * this.#startupJitterMs), lifecycle);
  }

  async stop(): Promise<void> {
    this.#status.started = false;
    this.#status.nextRunAt = null;
    this.#lifecycle += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#activeRun?.catch(() => undefined);
  }

  runOnce(options: { force?: boolean } = {}): Promise<DailyAnalyticsFindingsRunSummary> {
    if (this.#activeRun) return this.#activeRun;
    this.#activeRun = this.#execute(options.force === true).finally(() => { this.#activeRun = null; });
    return this.#activeRun;
  }

  async #execute(force: boolean): Promise<DailyAnalyticsFindingsRunSummary> {
    const startedAt = new Date(this.#now()).toISOString();
    const summary: DailyAnalyticsFindingsRunSummary = {
      startedAt,
      completedAt: startedAt,
      houses: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
      findings: 0,
      lastError: null,
    };
    this.#status.running = true;
    try {
      const houses = this.#database.listHouses();
      summary.houses = houses.length;
      await mapWithConcurrency(houses, 2, async (house) => {
        const dataMode: DataMode = this.#database.isRealDataMode() ? "live" : "demo";
        const periods = dailyFindingPeriods(this.#now(), house.timezone);
        const stored = this.#database.dailyAnalyticsFindings(house.id, dataMode);
        if (!force && stored?.snapshot?.evaluatedThrough === periods.evaluatedThrough
          && stored.snapshot.algorithmVersion === DAILY_ANALYTICS_ALGORITHM_VERSION) {
          summary.skipped += 1;
          return;
        }
        try {
          const snapshot = await this.#generateHouse(house, dataMode, periods);
          this.#database.saveDailyAnalyticsFindings(snapshot);
          summary.generated += 1;
          summary.findings += snapshot.findings.length;
        } catch (error) {
          const detail = errorMessage(error);
          summary.failed += 1;
          summary.lastError = detail;
          if (this.#database.getHouse(house.id)) {
            this.#database.recordDailyAnalyticsFindingsFailure(house.id, dataMode, new Date(this.#now()).toISOString(), detail);
          }
        }
      });
    } catch (error) {
      summary.lastError = errorMessage(error);
    } finally {
      summary.completedAt = new Date(this.#now()).toISOString();
      this.#status.running = false;
      this.#status.lastRun = { ...summary };
    }
    return { ...summary };
  }

  async #generateHouse(house: House, dataMode: DataMode, periods: FindingPeriods): Promise<DailyAnalyticsFindingsSnapshot> {
    const warnings = new Set<DailyAnalyticsFindingsSnapshot["warnings"][number]>();
    const ranked: RankedFinding[] = [];
    const sensors = this.#database.listSensors(house.id).filter((sensor) => sensor.enabled);
    const definitions = this.#database.listMeasurementDefinitions(false).filter((definition) => {
      const semantics = analyticsDefinitionSemantics(definition);
      return definition.genericHistoryEnabled !== false
        && definition.genericStatsEnabled !== false
        && semantics.kind !== "categorical_state"
        && semantics.aggregation !== "duration"
        && semantics.aggregation !== "custom";
    });
    if (sensors.length > 0 && definitions.length > 0) {
      const coverage = await this.#telemetryReader.measurementCoverage({
        sensorIds: sensors.map((sensor) => sensor.id),
        metrics: definitions.map((definition) => definition.id),
      });
      if (!coverage.complete) warnings.add("archive-incomplete");
      const sensorById = new Map(sensors.map((sensor) => [sensor.id, sensor]));
      const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
      const candidates = coverage.records
        .filter((record) => sensorById.has(record.sensorId) && definitionById.has(record.metric))
        .sort((left, right) => {
          const leftDefinition = definitionById.get(left.metric)!;
          const rightDefinition = definitionById.get(right.metric)!;
          return Number(electricityDefinition(rightDefinition)) - Number(electricityDefinition(leftDefinition))
            || left.sensorId.localeCompare(right.sensorId)
            || left.metric.localeCompare(right.metric);
        })
        .slice(0, MAX_MEASUREMENT_SERIES);
      if (coverage.records.length > MAX_MEASUREMENT_SERIES) warnings.add("scope-limited");
      const measurementFindings = await mapWithConcurrency(candidates, 4, async (record) => {
        const sensor = sensorById.get(record.sensorId)!;
        const definition = definitionById.get(record.metric)!;
        return this.#measurementFinding(sensor, definition, dataMode, periods, warnings);
      });
      ranked.push(...measurementFindings.filter((item): item is RankedFinding => item !== null));
    }

    if (house.location) {
      const outdoor = await this.#outdoorFinding(house, dataMode, periods, warnings);
      if (outdoor) ranked.push(outdoor);
    }
    ranked.push(...await this.#openingFindings(house, periods, warnings));

    return {
      apiVersion: "1.0",
      houseId: house.id,
      dataMode,
      periodKind: "month-to-date",
      evaluatedThrough: periods.evaluatedThrough,
      algorithmVersion: DAILY_ANALYTICS_ALGORITHM_VERSION,
      generatedAt: new Date(this.#now()).toISOString(),
      findings: ranked.sort((left, right) => right.score - left.score
        || left.finding.subjectLabel.localeCompare(right.finding.subjectLabel))
        .slice(0, MAX_FINDINGS)
        .map((item) => item.finding),
      warnings: [...warnings].sort(),
    };
  }

  async #measurementFinding(
    sensor: Sensor,
    definition: MeasurementDefinition,
    dataMode: DataMode,
    periods: FindingPeriods,
    warnings: Set<DailyAnalyticsFindingsSnapshot["warnings"][number]>,
  ): Promise<RankedFinding | null> {
    const current = await this.#measurementPeriod(sensor, definition, dataMode, periods.current, warnings);
    if (!usable(current)) return null;
    const peers = await Promise.all(periods.baseline.map(async (period) => ({
      period,
      value: await this.#measurementPeriod(sensor, definition, dataMode, period, warnings),
    })));
    const usablePeers = peers.filter((peer): peer is { period: PeerPeriod; value: PeriodValue } => usable(peer.value));
    if (usablePeers.length === 0) return null;
    return comparisonFinding({
      category: electricityDefinition(definition) ? "electricity" : "sensor",
      subjectId: sensor.id,
      subjectLabel: sensor.name,
      metric: definition.id,
      unit: definition.unit,
      definition,
      currentPeriod: periods.current,
      current,
      baselinePeriods: usablePeers.map((peer) => peer.period),
      baseline: usablePeers.map((peer) => peer.value),
    });
  }

  async #measurementPeriod(
    sensor: Sensor,
    definition: MeasurementDefinition,
    dataMode: DataMode,
    period: PeerPeriod,
    warnings: Set<DailyAnalyticsFindingsSnapshot["warnings"][number]>,
  ): Promise<PeriodValue | null> {
    try {
      const request = this.#measurementRequest(sensor, definition, dataMode, period);
      const entities = [{ id: sensor.id, label: sensor.name }];
      const rollupPlan = planAnalyticsRollup({ request, definitions: [definition], entities });
      if (rollupPlan) {
        const rollup = await this.#telemetryReader.measurementAnalyticsRollup(rollupPlan);
        if (rollup) {
          const response = buildAnalyticsResponseFromRollup({
            request,
            definitions: [definition],
            entities,
            rollup: rollup.result,
            archiveState: rollup.archiveState,
          });
          return aggregateAnalyticsSeries(response.series[0]!);
        }
      }
      const read = await this.#telemetryReader.measurementHistory({
        sensorId: sensor.id,
        metric: definition.id,
        from: period.start,
        to: period.end,
        limit: HISTORY_LIMIT,
      });
      if (read.records.length >= HISTORY_LIMIT) {
        warnings.add("source-truncated");
        return null;
      }
      const records = read.records.filter((sample) => sample.timestamp >= period.start
        && sample.timestamp < period.end && sample.quality !== "stale");
      return this.#aggregateSamples(records, sensor, definition, dataMode, period, read.provenance.archiveState);
    } catch (error) {
      if (error instanceof IncompleteTelemetryHistoryError) {
        warnings.add("archive-incomplete");
        return null;
      }
      throw error;
    }
  }

  #measurementRequest(
    sensor: Pick<Sensor, "id">,
    definition: MeasurementDefinition,
    dataMode: DataMode,
    period: PeerPeriod,
  ): AnalyticsQueryRequest {
    return {
      apiVersion: "1.0",
      dataMode,
      scope: { kind: "house", id: "daily-findings", entityIds: [sensor.id] },
      measurementIds: [definition.id],
      range: { start: period.start, end: period.end, timezone: "UTC" },
      resolution: "1d",
      aggregation: "default",
      qualityFilter: { include: ["good", "estimated"] },
      include: ["series", "summary", "quality", "provenance"],
      maxPointsPerSeries: 5_000,
      requestId: `daily-${sensor.id}-${definition.id}-${period.key}`,
    };
  }

  #aggregateSamples(
    samples: MeasurementSample[],
    sensor: Pick<Sensor, "id" | "name">,
    definition: MeasurementDefinition,
    dataMode: DataMode,
    period: PeerPeriod,
    archiveState: HybridArchiveReadState,
  ): PeriodValue | null {
    const response = buildAnalyticsResponse({
      request: this.#measurementRequest(sensor, definition, dataMode, period),
      samples,
      definitions: [definition],
      entities: [{ id: sensor.id, label: sensor.name }],
      archiveState,
    });
    return aggregateAnalyticsSeries(response.series[0]!);
  }

  async #outdoorFinding(
    house: House,
    dataMode: DataMode,
    periods: FindingPeriods,
    warnings: Set<DailyAnalyticsFindingsSnapshot["warnings"][number]>,
  ): Promise<RankedFinding | null> {
    const locationKey = outdoorLocationKey(house.location);
    const readPeriod = async (period: PeerPeriod): Promise<PeriodValue | null> => {
      try {
        const read = await this.#telemetryReader.outdoorTemperatureHistory({
          houseId: house.id,
          locationKey,
          from: period.start,
          to: period.end,
          limit: HISTORY_LIMIT,
        });
        if (read.records.length >= HISTORY_LIMIT) {
          warnings.add("source-truncated");
          return null;
        }
        const samples: MeasurementSample[] = read.records.filter((sample) => sample.timestamp >= period.start && sample.timestamp < period.end)
          .map((sample) => ({
            sensorId: "outdoor-weather",
            metric: OUTDOOR_TEMPERATURE_DEFINITION.id,
            value: sample.temperatureC,
            canonicalUnit: "°C",
            timestamp: sample.timestamp,
            source: "import",
            quality: "good",
          }));
        return this.#aggregateSamples(samples, { id: "outdoor-weather", name: "Outdoor weather" },
          OUTDOOR_TEMPERATURE_DEFINITION, dataMode, period, read.provenance.archiveState);
      } catch (error) {
        if (error instanceof IncompleteTelemetryHistoryError) {
          warnings.add("archive-incomplete");
          return null;
        }
        throw error;
      }
    };
    const current = await readPeriod(periods.current);
    if (!usable(current)) return null;
    const peers = await Promise.all(periods.baseline.map(async (period) => ({ period, value: await readPeriod(period) })));
    const usablePeers = peers.filter((peer): peer is { period: PeerPeriod; value: PeriodValue } => usable(peer.value));
    if (usablePeers.length === 0) return null;
    return comparisonFinding({
      category: "outdoor-weather",
      subjectId: `${house.id}:outdoor-weather`,
      subjectLabel: "Outdoor weather",
      metric: "outdoor_temperature",
      unit: "°C",
      definition: OUTDOOR_TEMPERATURE_DEFINITION,
      currentPeriod: periods.current,
      current,
      baselinePeriods: usablePeers.map((peer) => peer.period),
      baseline: usablePeers.map((peer) => peer.value),
    });
  }

  async #openingFindings(
    house: House,
    periods: FindingPeriods,
    warnings: Set<DailyAnalyticsFindingsSnapshot["warnings"][number]>,
  ): Promise<RankedFinding[]> {
    const activity = await Promise.all([periods.current, ...periods.baseline].map(async (period) => {
      try {
        const leadingAt = new Date(Date.parse(period.start) - 1).toISOString();
        const [leading, history] = await Promise.all([
          this.#telemetryReader.openingStateSnapshot({ houseId: house.id, at: leadingAt, limit: 10_000 }),
          this.#telemetryReader.openingStateHistory({
            houseId: house.id,
            from: period.start,
            to: period.end,
            limit: HISTORY_LIMIT,
          }),
        ]);
        return {
          period,
          rows: openingActivityFromObservations(
            [...leading.records, ...history.records],
            period.start,
            period.end,
          ),
        };
      } catch (error) {
        if (error instanceof IncompleteTelemetryHistoryError) {
          warnings.add("archive-incomplete");
          return { period, rows: [] as OpeningStateActivityRecord[] };
        }
        throw error;
      }
    }));
    const result: RankedFinding[] = [];
    for (const floor of house.floors) {
      for (const element of floor.planElements ?? []) {
        if ((element.kind !== "door" && element.kind !== "window")
          || (element.kind === "door" && element.variant === "open-passage")
          || (element.kind === "window" && element.variant === "fixed")) continue;
        const current = openingPeriodValue(activity[0]!.rows, floor.id, element);
        if (!current) continue;
        const peers = activity.slice(1).flatMap(({ period, rows }) => {
          const value = openingPeriodValue(rows, floor.id, element);
          return value ? [{ period, value }] : [];
        });
        if (peers.length === 0) continue;
        const finding = comparisonFinding({
          category: "opening",
          subjectId: `${floor.id}:${element.id}`,
          subjectLabel: element.label?.trim() || `${element.kind === "door" ? "Door" : "Window"} · ${floor.name}`,
          metric: "opening_events",
          unit: "opens",
          currentPeriod: periods.current,
          current,
          baselinePeriods: peers.map((peer) => peer.period),
          baseline: peers.map((peer) => peer.value),
        });
        if (finding) result.push(finding);
      }
    }
    return result;
  }

  #schedule(delayMs: number, lifecycle: number): void {
    if (!this.#status.started || lifecycle !== this.#lifecycle) return;
    this.#status.nextRunAt = new Date(this.#now() + delayMs).toISOString();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#status.nextRunAt = null;
      void this.runOnce().finally(() => this.#schedule(this.#intervalMs, lifecycle));
    }, delayMs);
  }
}
