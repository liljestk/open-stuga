import type {
  AlertEvent,
  AlertRule,
  House,
  MeasurementSample,
  Metric,
  OutdoorConditions,
  Sensor,
  WeatherWarning,
} from "@climate-twin/contracts";
import { isHomeRelevantWeatherWarning } from "@climate-twin/contracts";
import { co2Insight, coverageInsight, humidityGuidance, measureCoverage, metricGuidance, temperatureBalanceInsight, temperatureInsight, windowEvidence } from "./freshness.js";
import { clampPriority, compareAlerts, compareCandidates, compareText, confidence, confidenceForTrend, coverageStateForSensor, freshnessForSample, freshnessForTimestamp, guidanceSafetyNote, isFreshUsable, metricLabel, metricPair, metricUnit, newestMetricSample, normalizeMaximum, numericEvidence, parseReferenceTime, pulseStatus, round, targetFor, targetLabel } from "./model.js";

export type LatestMeasurements = Record<string, Record<Metric, MeasurementSample>>;
export type MeasurementHistory = Record<string, Record<Metric, MeasurementSample[]>>;

export const MINUTE_MS = 60_000;

export const HOME_INSIGHT_DEFAULT_MAX = 5;

export const HOME_INSIGHT_ADVISORY =
  "These insights support household monitoring; they do not replace a physical inspection, a safety alarm, or professional advice.";

export const HOME_INSIGHT_THRESHOLDS = {
  freshSampleMinutes: 30,
  agingSampleMinutes: 120,
  trendWindowMinutes: 120,
  humidityPercent: 65,
  highHumidityPercent: 75,
  co2Ppm: 1_000,
  highCo2Ppm: 1_500,
  lowTemperatureC: 12,
  criticalLowTemperatureC: 8,
  highTemperatureC: 30,
  criticalHighTemperatureC: 35,
  temperatureImbalanceC: 3,
} as const;

export type HomeInsightKind =
  | "active-alert"
  | "humidity"
  | "indoor-air"
  | "temperature"
  | "temperature-balance"
  | "sensor-coverage"
  | "setup";

export type HomeInsightSeverity = "critical" | "warning" | "notice" | "info";

export type HomeInsightConfidenceLevel = "high" | "medium" | "low";

export type HomeInsightFreshnessState = "fresh" | "estimated" | "aging" | "stale" | "unknown";

export type HomePulseStatus = "critical" | "attention" | "watch" | "steady" | "unknown";

export interface HomeInsightTarget {
  houseId: string;
  sensorId?: string;
  sensorName?: string;
  floorId?: string;
  floorName?: string;
  room?: string;
}

/** A render-ready fact. Numeric values are kept numeric so the UI may localize them. */
export interface HomeInsightEvidence {
  label: string;
  value: number | string;
  unit?: string;
  metric?: Metric;
  sensorId?: string;
  observedAt?: string;
}

export interface HomeInsightFreshness {
  state: HomeInsightFreshnessState;
  evidenceAt: string | null;
  ageMinutes: number | null;
}

export interface HomeInsightConfidence {
  level: HomeInsightConfidenceLevel;
  score: number;
  reason: string;
}

export interface HomeInsight {
  /** Stable across runs for the same underlying condition; suitable as a React key. */
  id: string;
  rank: number;
  kind: HomeInsightKind;
  severity: HomeInsightSeverity;
  /** Transparent 0..100 ranking score. Higher means more actionable. */
  priority: number;
  title: string;
  summary: string;
  action: string;
  /** Stable semantic presentation parameters; clients localize the codes. */
  parameters?: Record<string, string | number | boolean | null>;
  target: HomeInsightTarget;
  evidence: HomeInsightEvidence[];
  freshness: HomeInsightFreshness;
  confidence: HomeInsightConfidence;
  safetyNote?: string;
}

/**
 * Accepts either HouseWeather (`current`) or OutdoorBoundaryContext
 * (`conditions`) without coupling the engine to a data-fetching hook.
 */
export interface HomeInsightOutdoorContext {
  current?: OutdoorConditions | null;
  conditions?: OutdoorConditions | null;
  stale?: boolean;
  warnings?: readonly WeatherWarning[];
}

export interface HomeInsightInput {
  house: House;
  sensors: readonly Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementHistory?: MeasurementHistory;
  alerts?: readonly AlertEvent[];
  alertRules?: readonly AlertRule[];
  outdoor?: HomeInsightOutdoorContext | null;
  /** Required by design: the engine never reads the wall clock. */
  referenceTime: string | number;
  maxInsights?: number;
}

export interface HomePulseCoverage {
  enabledSensors: number;
  freshSensors: number;
  estimatedSensors: number;
  agingSensors: number;
  staleSensors: number;
  sensorsWithoutData: number;
}

export interface HomePulseSensorCoverage {
  sensorId: string;
  freshness: HomeInsightFreshness;
  /** Enabled alert-rule metrics that must be current for this sensor to be considered covered. */
  requiredMetrics: Metric[];
}

export interface HomePulseResult {
  houseId: string;
  generatedAt: string;
  status: HomePulseStatus;
  coverage: HomePulseCoverage;
  sensorCoverage: HomePulseSensorCoverage[];
  insights: HomeInsight[];
  advisory: typeof HOME_INSIGHT_ADVISORY;
}

export type InsightCandidate = Omit<HomeInsight, "rank">;

export interface EngineContext {
  house: House;
  sensors: Sensor[];
  enabledSensors: Sensor[];
  latest: LatestMeasurements;
  history: MeasurementHistory;
  alerts: readonly AlertEvent[];
  rules: ReadonlyMap<string, AlertRule>;
  outdoor: HomeInsightOutdoorContext | null;
  nowMs: number;
}

export interface WindowEvidence {
  samples: MeasurementSample[];
  matching: number;
  sustained: boolean;
  spanMinutes: number;
}

export interface SensorCoverageState {
  sample: MeasurementSample | undefined;
  freshness: HomeInsightFreshness;
  requiredMetrics: Metric[];
}

export interface OutdoorGuidance {
  action: string;
  evidence: HomeInsightEvidence[];
}

export const FUTURE_TOLERANCE_MS = 2 * MINUTE_MS;

export const FRESH_MS = HOME_INSIGHT_THRESHOLDS.freshSampleMinutes * MINUTE_MS;

export const AGING_MS = HOME_INSIGHT_THRESHOLDS.agingSampleMinutes * MINUTE_MS;

export const TREND_MS = HOME_INSIGHT_THRESHOLDS.trendWindowMinutes * MINUTE_MS;

export const severityOrder: Record<HomeInsightSeverity, number> = {
  critical: 4,
  warning: 3,
  notice: 2,
  info: 1,
};

export const alertSeverityOrder = { critical: 3, warning: 2, info: 1 } as const;

export const qualityOrder: Record<MeasurementSample["quality"], number> = { good: 3, estimated: 2, stale: 1 };

/** Return the ranked insight list when a component does not need pulse metadata. */
export function deriveHomeInsights(input: HomeInsightInput): HomeInsight[] {
  return deriveHomePulse(input).insights;
}

/**
 * Derive a deterministic, house-scoped pulse. The function performs no I/O,
 * does not mutate its inputs, and uses only the supplied reference time.
 */
export function deriveHomePulse(input: HomeInsightInput): HomePulseResult {
  const nowMs = parseReferenceTime(input.referenceTime);
  const sensors = input.sensors
    .filter((sensor) => sensor.houseId === input.house.id)
    .slice()
    .sort((first, second) => compareText(first.id, second.id));
  const context: EngineContext = {
    house: input.house,
    sensors,
    enabledSensors: sensors.filter((sensor) => sensor.enabled),
    latest: input.latestMeasurements,
    history: input.measurementHistory ?? {},
    alerts: input.alerts ?? [],
    rules: new Map((input.alertRules ?? []).map((rule) => [rule.id, rule])),
    outdoor: input.outdoor ?? null,
    nowMs,
  };

  const sensorCoverage = context.enabledSensors.map((sensor): HomePulseSensorCoverage => {
    const detail = coverageStateForSensor(context, sensor.id);
    return { sensorId: sensor.id, freshness: detail.freshness, requiredMetrics: detail.requiredMetrics };
  });
  const coverage = measureCoverage(sensorCoverage);
  const alertResult = activeAlertInsights(context);
  const candidates: InsightCandidate[] = [
    ...alertResult.insights,
    ...humidityInsight(context, alertResult.coveredPairs),
    ...co2Insight(context, alertResult.coveredPairs),
    ...temperatureInsight(context, alertResult.coveredPairs),
    ...temperatureBalanceInsight(context, alertResult.coveredPairs),
    ...coverageInsight(context, coverage),
  ];

  const sorted = candidates.slice().sort(compareCandidates);
  const maximum = normalizeMaximum(input.maxInsights);
  const insights = sorted.slice(0, maximum).map((insight, index) => ({ ...insight, rank: index + 1 }));

  return {
    houseId: input.house.id,
    generatedAt: new Date(nowMs).toISOString(),
    status: pulseStatus(sorted, coverage),
    coverage,
    sensorCoverage,
    insights,
    advisory: HOME_INSIGHT_ADVISORY,
  };
}

export function activeAlertInsights(context: EngineContext): {
  insights: InsightCandidate[];
  coveredPairs: ReadonlySet<string>;
} {
  const sensorsById = new Map(context.sensors.map((sensor) => [sensor.id, sensor]));
  const active = context.alerts
    .filter((alert) => !alert.resolvedAt && sensorsById.has(alert.sensorId))
    .slice()
    .sort(compareAlerts);
  const coveredPairs = new Set<string>();
  const insights: InsightCandidate[] = [];

  for (const alert of active) {
    const pair = metricPair(alert.sensorId, alert.metric);
    if (coveredPairs.has(pair)) continue;
    coveredPairs.add(pair);
    const sensor = sensorsById.get(alert.sensorId)!;
    const current = newestMetricSample(context, sensor.id, alert.metric);
    const currentFreshness = current
      ? freshnessForSample(current, context.nowMs)
      : freshnessForTimestamp(alert.startedAt, context.nowMs);
    const hasFreshEvidence = currentFreshness.state === "fresh" && current?.quality === "good";
    const rule = context.rules.get(alert.ruleId);
    const label = metricLabel(alert.metric);
    const room = targetLabel(sensor);
    const severity: HomeInsightSeverity = alert.severity === "info" ? "notice" : alert.severity;
    const acknowledged = Boolean(alert.acknowledgedAt);
    const guidance = metricGuidance(context, sensor, alert.metric, current?.value ?? alert.value, rule?.operator);
    const evidence: HomeInsightEvidence[] = [
      numericEvidence("Alert value", alert.value, metricUnit(alert.metric), alert.metric, sensor.id, alert.startedAt),
      numericEvidence("Trigger threshold", alert.threshold, metricUnit(alert.metric), alert.metric, sensor.id),
    ];
    if (current && (current.timestamp !== alert.startedAt || current.value !== alert.value)) {
      evidence.unshift(numericEvidence("Latest reading", current.value, current.canonicalUnit || metricUnit(alert.metric), alert.metric, sensor.id, current.timestamp));
    }
    evidence.push(...guidance.evidence);

    insights.push({
      id: `active-alert:${alert.id}`,
      kind: "active-alert",
      severity,
      priority: clampPriority((alert.severity === "critical" ? 100 : alert.severity === "warning" ? 88 : 68) - (acknowledged ? 8 : 0)),
      title: `${rule?.name.trim() || `${label} alert`} - ${room}`,
      summary: acknowledged
        ? `This ${alert.severity} alert is acknowledged but remains unresolved.`
        : `This ${alert.severity} alert remains open and should be checked.`,
      action: guidance.action,
      parameters: { acknowledged },
      target: targetFor(context.house, sensor),
      evidence,
      freshness: currentFreshness,
      confidence: hasFreshEvidence
        ? confidence("high", "The open alert is supported by a fresh, good-quality reading.", 0.96)
        : currentFreshness.state === "fresh" || currentFreshness.state === "aging"
          ? confidence("medium", "The alert is open, but its supporting evidence is estimated or aging.")
          : confidence("low", "The alert is open, but no recent supporting reading is available."),
      ...(guidanceSafetyNote(alert.metric, rule?.operator, current?.value ?? alert.value)
        ? { safetyNote: guidanceSafetyNote(alert.metric, rule?.operator, current?.value ?? alert.value)! }
        : {}),
    });
  }

  return { insights, coveredPairs };
}

export function humidityInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
  const options = context.enabledSensors.flatMap((sensor) => {
    if (coveredPairs.has(metricPair(sensor.id, "humidity"))) return [];
    const sample = newestMetricSample(context, sensor.id, "humidity");
    if (!isFreshUsable(sample, context.nowMs) || sample.value < HOME_INSIGHT_THRESHOLDS.humidityPercent) return [];
    const window = windowEvidence(
      context,
      sensor.id,
      "humidity",
      (value) => value >= HOME_INSIGHT_THRESHOLDS.humidityPercent,
    );
    const priority = clampPriority(
      55 + (sample.value - HOME_INSIGHT_THRESHOLDS.humidityPercent) * 1.5 + (window.sustained ? 8 : 0),
    );
    return [{ sensor, sample, window, priority }];
  }).sort((first, second) => second.priority - first.priority || compareText(first.sensor.id, second.sensor.id));
  const selected = options[0];
  if (!selected) return [];

  const { sensor, sample, window, priority } = selected;
  const room = targetLabel(sensor);
  const guidance = humidityGuidance(context, sensor, sample.value);
  const sustainedDetail = window.sustained
    ? `${window.matching} of ${window.samples.length} readings were elevated over ${round(window.spanMinutes, 0)} minutes.`
    : "There is not yet enough consistent recent history to call this a sustained trend.";
  const high = sample.value >= HOME_INSIGHT_THRESHOLDS.highHumidityPercent || window.sustained;

  return [{
    id: `humidity:${sensor.id}`,
    kind: "humidity",
    severity: high ? "warning" : "notice",
    priority,
    title: `${window.sustained ? "Humidity has stayed elevated" : "Humidity is elevated"} in ${room}`,
    summary: `The latest relative humidity is ${round(sample.value, 1)}%. ${sustainedDetail}`,
    action: guidance.action,
    target: targetFor(context.house, sensor),
    evidence: [
      numericEvidence("Latest humidity", round(sample.value, 1), "%", "humidity", sensor.id, sample.timestamp),
      ...(window.samples.length >= 2 ? [{
        label: "Elevated readings",
        value: `${window.matching} of ${window.samples.length}`,
        metric: "humidity",
        sensorId: sensor.id,
      }] : []),
      ...guidance.evidence,
    ],
    freshness: freshnessForSample(sample, context.nowMs),
    confidence: confidenceForTrend(sample, window),
    safetyNote: "A humidity sensor measures moisture conditions; it does not detect mold or identify a leak.",
  }];
}
