import { createHash } from "node:crypto";
import type {
  AnalyticsFinding,
  AnalyticsFindingPeriodEvidence,
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
import { analyticsDefinitionSemantics, buildAnalyticsResponse } from "./analytics.js";
import {
  ClimateDatabase,
  outdoorLocationKey,
  type OpeningStateActivityRecord,
} from "./db.js";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
  type HybridArchiveReadState,
} from "./timeseries/read-facade.js";

export const DAILY_ANALYTICS_ALGORITHM_VERSION = "calendar-peer-findings-v1.0.0";

const HISTORY_LIMIT = 100_000;
const BASELINE_YEARS = 5;
const MAX_MEASUREMENT_SERIES = 80;
const MAX_FINDINGS = 16;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_STARTUP_JITTER_MS = 30_000;

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface PeerPeriod {
  key: string;
  year: number;
  start: string;
  end: string;
}

interface FindingPeriods {
  evaluatedThrough: string;
  current: PeerPeriod;
  baseline: PeerPeriod[];
}

interface PeriodValue {
  value: number;
  sampleCount: number;
  coverage: number | null;
  statistic: AnalyticsFindingStatistic;
}

interface RankedFinding {
  finding: AnalyticsFinding;
  score: number;
}

export interface DailyAnalyticsFindingsRunSummary {
  startedAt: string;
  completedAt: string;
  houses: number;
  generated: number;
  skipped: number;
  failed: number;
  findings: number;
  lastError: string | null;
}

export interface DailyAnalyticsFindingsWorkerStatus {
  started: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRun: DailyAnalyticsFindingsRunSummary | null;
}

export interface DailyAnalyticsFindingsWorkerOptions {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  intervalMs?: number;
  startupJitterMs?: number;
  now?: () => number;
  random?: () => number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  if (formatterCache.size >= 32) formatterCache.delete(formatterCache.keys().next().value!);
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zonedParts(timestamp: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return [value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second")];
}

function localDate(timestamp: number, timeZone: string): LocalDateParts {
  const [year, month, day] = zonedParts(timestamp, timeZone);
  return { year, month, day };
}

function validLocalDate(parts: LocalDateParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year
    && date.getUTCMonth() === parts.month - 1
    && date.getUTCDate() === parts.day;
}

function addLocalDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Resolve the first real instant of a local date, including midnight offset changes. */
function localDateStart(parts: LocalDateParts, timeZone: string): number | null {
  if (!validLocalDate(parts)) return null;
  for (let minute = 0; minute <= 180; minute += 30) {
    const hour = Math.floor(minute / 60);
    const localMinute = minute % 60;
    const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, hour, localMinute, 0);
    const offsets = new Set<number>();
    for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
      const probe = nominal + deltaHours * 3_600_000;
      const displayed = zonedParts(probe, timeZone);
      offsets.add(Date.UTC(displayed[0], displayed[1] - 1, displayed[2], displayed[3], displayed[4], displayed[5]) - probe);
    }
    const target = [parts.year, parts.month, parts.day, hour, localMinute, 0];
    const candidate = [...offsets].map((offset) => nominal - offset)
      .filter((instant) => zonedParts(instant, timeZone).every((value, index) => value === target[index]))
      .sort((left, right) => left - right)[0];
    if (candidate !== undefined) return candidate;
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Builds fair month-to-date windows ending at the last completed local date. */
export function dailyFindingPeriods(now: number, timeZone: string): FindingPeriods {
  const today = localDate(now, timeZone);
  const through = addLocalDays(today, -1);
  const currentStart = localDateStart({ year: through.year, month: through.month, day: 1 }, timeZone);
  const currentEnd = localDateStart(addLocalDays(through, 1), timeZone);
  if (currentStart === null || currentEnd === null) throw new Error(`Could not resolve calendar boundaries for ${timeZone}`);
  const period = (year: number): PeerPeriod => {
    const lastDay = Math.min(through.day, daysInMonth(year, through.month));
    const start = localDateStart({ year, month: through.month, day: 1 }, timeZone);
    const end = localDateStart(addLocalDays({ year, month: through.month, day: lastDay }, 1), timeZone);
    if (start === null || end === null) throw new Error(`Could not resolve peer calendar boundaries for ${timeZone}`);
    return {
      key: `${year}-${pad2(through.month)}`,
      year,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  };
  return {
    evaluatedThrough: `${through.year}-${pad2(through.month)}-${pad2(through.day)}`,
    current: {
      key: `${through.year}-${pad2(through.month)}`,
      year: through.year,
      start: new Date(currentStart).toISOString(),
      end: new Date(currentEnd).toISOString(),
    },
    baseline: Array.from({ length: BASELINE_YEARS }, (_, index) => period(through.year - index - 1)),
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function rounded(value: number, precision = 6): number {
  return Number(value.toFixed(precision));
}

function periodEvidence(period: PeerPeriod, value: PeriodValue): AnalyticsFindingPeriodEvidence {
  return {
    ...period,
    value: rounded(value.value),
    sampleCount: value.sampleCount,
    coverage: value.coverage === null ? null : rounded(Math.max(0, Math.min(1, value.coverage))),
  };
}

function aggregateAnalyticsSeries(series: AnalyticsSeries): PeriodValue | null {
  const points = series.points.filter((point) => point.value !== null);
  if (points.length === 0) return null;
  const aggregation = series.aggregation === "raw" ? "mean" : series.aggregation;
  let value: number;
  if (aggregation === "sum" || aggregation === "delta") {
    value = points.reduce((total, point) => total + point.value!, 0);
  } else if (aggregation === "last") {
    value = points.at(-1)!.value!;
  } else if (aggregation === "min") {
    value = Math.min(...points.map((point) => point.value!));
  } else if (aggregation === "max") {
    value = Math.max(...points.map((point) => point.value!));
  } else {
    const weights = points.map((point) => Math.max(point.coverage, Number.EPSILON));
    const weight = weights.reduce((total, item) => total + item, 0);
    value = points.reduce((total, point, index) => total + point.value! * weights[index]!, 0) / weight;
  }
  const sampleCount = points.reduce((total, point) => total + point.sampleCount, 0);
  const coverage = series.points.length === 0
    ? 0
    : series.points.reduce((total, point) => total + point.coverage, 0) / series.points.length;
  return {
    value,
    sampleCount,
    coverage,
    statistic: aggregation === "sum" ? "sum" : aggregation === "delta" ? "delta" : "mean",
  };
}

function usable(value: PeriodValue | null): value is PeriodValue {
  if (!value || !Number.isFinite(value.value) || value.coverage === null || value.coverage < 0.5) return false;
  return value.statistic === "sum" ? value.sampleCount >= 1 : value.sampleCount >= 2;
}

function electricityDefinition(definition: MeasurementDefinition): boolean {
  const dimension = (definition.dimension ?? "").toLowerCase();
  const id = definition.id.toLowerCase();
  return dimension === "power" || dimension === "energy"
    || id === "power" || id === "energy"
    || /(?:electric|power|energy|consumption)/u.test(id);
}

function threshold(input: {
  category: AnalyticsFinding["category"];
  metric: string;
  definition?: MeasurementDefinition;
  baseline: number;
  difference: number;
}): { notable: boolean; strong: boolean; score: number } {
  const absolute = Math.abs(input.difference);
  const relative = Math.abs(input.baseline) < 1e-9 ? null : absolute / Math.abs(input.baseline);
  const metric = input.metric.toLowerCase();
  if (input.category === "opening") {
    return { notable: absolute >= 3, strong: absolute >= 10, score: absolute / 3 };
  }
  if (metric.includes("temperature")) {
    return { notable: absolute >= 1, strong: absolute >= 2, score: absolute };
  }
  if (metric.includes("humidity")) {
    return { notable: absolute >= 5, strong: absolute >= 10, score: absolute / 5 };
  }
  if (metric === "co2" || metric.includes("carbon")) {
    return { notable: absolute >= 100, strong: absolute >= 250, score: absolute / 100 };
  }
  if (input.category === "electricity") {
    const unit = input.definition?.unit.toLowerCase() ?? "";
    const minimum = unit.includes("kwh") ? 0.5 : unit === "w" || unit.includes("watt") ? 50 : 10 ** -(input.definition?.precision ?? 1);
    const notable = absolute >= minimum && (relative === null || relative >= 0.1);
    return { notable, strong: notable && (relative === null ? absolute >= minimum * 3 : relative >= 0.25), score: relative ?? absolute / minimum };
  }
  const minimum = Math.max(input.definition?.interpolationDelta ?? 0, 10 ** -(input.definition?.precision ?? 1));
  const notable = absolute >= minimum && (relative === null || relative >= 0.2);
  return { notable, strong: notable && (relative === null ? absolute >= minimum * 3 : relative >= 0.4), score: relative ?? absolute / minimum };
}

function findingId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

function comparisonFinding(input: {
  category: AnalyticsFinding["category"];
  subjectId: string;
  subjectLabel: string;
  metric: string;
  unit: string;
  definition?: MeasurementDefinition;
  currentPeriod: PeerPeriod;
  current: PeriodValue;
  baselinePeriods: PeerPeriod[];
  baseline: PeriodValue[];
}): RankedFinding | null {
  const baselineMedian = median(input.baseline.map((item) => item.value));
  const difference = input.current.value - baselineMedian;
  if (Math.abs(difference) < 1e-12) return null;
  const significance = threshold({
    category: input.category,
    metric: input.metric,
    ...(input.definition ? { definition: input.definition } : {}),
    baseline: baselineMedian,
    difference,
  });
  if (!significance.notable) return null;
  const baselineEvidence = input.baseline.map((value, index) => periodEvidence(input.baselinePeriods[index]!, value));
  return {
    score: significance.score + (significance.strong ? 1 : 0),
    finding: {
      id: findingId([input.category, input.subjectId, input.metric, input.currentPeriod.key]),
      category: input.category,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      metric: input.metric,
      unit: input.unit,
      statistic: input.current.statistic,
      direction: difference > 0 ? "higher" : "lower",
      strength: significance.strong ? "strong" : "notable",
      current: periodEvidence(input.currentPeriod, input.current),
      baseline: baselineEvidence,
      baselineMedian: rounded(baselineMedian),
      absoluteDifference: rounded(Math.abs(difference)),
      percentDifference: Math.abs(baselineMedian) < 1e-9 ? null : rounded(Math.abs(difference / baselineMedian) * 100, 3),
    },
  };
}

const OUTDOOR_TEMPERATURE_DEFINITION: MeasurementDefinition = {
  id: "outdoor_temperature",
  labels: { en: "Outdoor temperature" },
  unit: "°C",
  dimension: "temperature",
  allowedUnits: ["°C"],
  kind: "gauge",
  defaultAggregation: "mean",
  genericHistoryEnabled: true,
  genericStatsEnabled: true,
  precision: 1,
  validMin: -100,
  validMax: 100,
  displayMin: -30,
  displayMax: 40,
  interpolationDelta: 0.5,
  colorScale: "thermal",
  builtin: false,
  enabled: true,
  spatialInterpolation: false,
  forecastSupported: false,
};

function matchingOpeningActivity(
  rows: readonly OpeningStateActivityRecord[],
  floorId: string,
  elementId: string,
  binding: OpeningStateBinding | undefined,
): OpeningStateActivityRecord[] {
  const matchingElement = rows.filter((row) => row.floorId === floorId && row.elementId === elementId);
  if (binding) {
    return matchingElement.filter((row) => row.source === binding.provider
      && row.externalId === binding.externalId
      && (binding.connectionId === undefined || row.connectionId === binding.connectionId));
  }
  const api = matchingElement.filter((row) => row.source === "api");
  return api.length > 0 ? api : matchingElement.filter((row) => row.source === "manual");
}

function openingPeriodValue(
  rows: readonly OpeningStateActivityRecord[],
  floorId: string,
  element: PlanElement,
): PeriodValue | null {
  if (element.kind !== "door" && element.kind !== "window") return null;
  const matching = matchingOpeningActivity(rows, floorId, element.id, element.stateBinding);
  const observations = matching.reduce((total, row) => total + row.observationCount, 0);
  if (observations < 1) return null;
  const value = matching.reduce((total, row) => total + (element.stateBinding?.invert ? row.closedCount : row.openedCount), 0);
  return { value, sampleCount: observations, coverage: null, statistic: "open-count" };
}

function errorMessage(error: unknown): string {
  if (error instanceof IncompleteTelemetryHistoryError) return "Historical telemetry is temporarily unavailable";
  if (error instanceof Error && error.message.startsWith("Could not resolve")) return error.message;
  return "One or more analytics sources could not be processed";
}

async function mapWithConcurrency<T, R>(
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
    ranked.push(...this.#openingFindings(house, periods));

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

  #aggregateSamples(
    samples: MeasurementSample[],
    sensor: Pick<Sensor, "id" | "name">,
    definition: MeasurementDefinition,
    dataMode: DataMode,
    period: PeerPeriod,
    archiveState: HybridArchiveReadState,
  ): PeriodValue | null {
    const response = buildAnalyticsResponse({
      request: {
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
      },
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

  #openingFindings(house: House, periods: FindingPeriods): RankedFinding[] {
    const activity = [periods.current, ...periods.baseline].map((period) => ({
      period,
      rows: this.#database.openingStateActivity(house.id, period.start, period.end),
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
