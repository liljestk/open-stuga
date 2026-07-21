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
import type { LatestMeasurements, MeasurementHistory } from "./measurements";
import { isHomeRelevantWeatherWarning } from "./weatherWarningRelevance";

const MINUTE_MS = 60_000;

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

type InsightCandidate = Omit<HomeInsight, "rank">;

interface EngineContext {
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

interface WindowEvidence {
  samples: MeasurementSample[];
  matching: number;
  sustained: boolean;
  spanMinutes: number;
}

interface SensorCoverageState {
  sample: MeasurementSample | undefined;
  freshness: HomeInsightFreshness;
  requiredMetrics: Metric[];
}

interface OutdoorGuidance {
  action: string;
  evidence: HomeInsightEvidence[];
}

const FUTURE_TOLERANCE_MS = 2 * MINUTE_MS;
const FRESH_MS = HOME_INSIGHT_THRESHOLDS.freshSampleMinutes * MINUTE_MS;
const AGING_MS = HOME_INSIGHT_THRESHOLDS.agingSampleMinutes * MINUTE_MS;
const TREND_MS = HOME_INSIGHT_THRESHOLDS.trendWindowMinutes * MINUTE_MS;

const severityOrder: Record<HomeInsightSeverity, number> = {
  critical: 4,
  warning: 3,
  notice: 2,
  info: 1,
};

const alertSeverityOrder = { critical: 3, warning: 2, info: 1 } as const;
const qualityOrder: Record<MeasurementSample["quality"], number> = { good: 3, estimated: 2, stale: 1 };

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

function activeAlertInsights(context: EngineContext): {
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

function humidityInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
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

function co2Insight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
  const options = context.enabledSensors.flatMap((sensor) => {
    if (coveredPairs.has(metricPair(sensor.id, "co2"))) return [];
    const sample = newestMetricSample(context, sensor.id, "co2");
    if (!isFreshUsable(sample, context.nowMs) || sample.value < HOME_INSIGHT_THRESHOLDS.co2Ppm) return [];
    const window = windowEvidence(
      context,
      sensor.id,
      "co2",
      (value) => value >= HOME_INSIGHT_THRESHOLDS.co2Ppm,
    );
    const priority = clampPriority(62 + (sample.value - HOME_INSIGHT_THRESHOLDS.co2Ppm) / 25 + (window.sustained ? 4 : 0));
    return [{ sensor, sample, window, priority }];
  }).sort((first, second) => second.priority - first.priority || compareText(first.sensor.id, second.sensor.id));
  const selected = options[0];
  if (!selected) return [];

  const { sensor, sample, window, priority } = selected;
  const guidance = ventilationGuidance(context);
  return [{
    id: `indoor-air:${sensor.id}`,
    kind: "indoor-air",
    severity: sample.value >= HOME_INSIGHT_THRESHOLDS.highCo2Ppm ? "warning" : "notice",
    priority,
    title: `Air needs refreshing in ${targetLabel(sensor)}`,
    summary: window.sustained
      ? `CO2 is ${round(sample.value, 0)} ppm and has been elevated across ${window.matching} of ${window.samples.length} recent readings.`
      : `CO2 is ${round(sample.value, 0)} ppm, suggesting ventilation may not be keeping up right now.`,
    action: guidance.action,
    target: targetFor(context.house, sensor),
    evidence: [
      numericEvidence("Latest CO2", round(sample.value, 0), "ppm", "co2", sensor.id, sample.timestamp),
      ...(window.samples.length >= 2 ? [{
        label: "Elevated readings",
        value: `${window.matching} of ${window.samples.length}`,
        metric: "co2",
        sensorId: sensor.id,
      }] : []),
      ...guidance.evidence,
    ],
    freshness: freshnessForSample(sample, context.nowMs),
    confidence: confidenceForTrend(sample, window),
    safetyNote: "A consumer CO2 reading is a ventilation indicator, not a medical diagnosis. If anyone feels unwell, move to fresh air and seek appropriate help.",
  }];
}

function temperatureInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
  const options = context.enabledSensors.flatMap((sensor) => {
    if (coveredPairs.has(metricPair(sensor.id, "temperature"))) return [];
    const sample = newestMetricSample(context, sensor.id, "temperature");
    if (!isFreshUsable(sample, context.nowMs)) return [];
    const cold = sample.value <= HOME_INSIGHT_THRESHOLDS.lowTemperatureC;
    const hot = sample.value >= HOME_INSIGHT_THRESHOLDS.highTemperatureC;
    if (!cold && !hot) return [];
    const critical = cold
      ? sample.value <= HOME_INSIGHT_THRESHOLDS.criticalLowTemperatureC
      : sample.value >= HOME_INSIGHT_THRESHOLDS.criticalHighTemperatureC;
    const distance = cold
      ? HOME_INSIGHT_THRESHOLDS.lowTemperatureC - sample.value
      : sample.value - HOME_INSIGHT_THRESHOLDS.highTemperatureC;
    const priority = clampPriority(76 + distance * 3 + (critical ? 7 : 0));
    return [{ sensor, sample, cold, critical, priority }];
  }).sort((first, second) => second.priority - first.priority || compareText(first.sensor.id, second.sensor.id));
  const selected = options[0];
  if (!selected) return [];

  const { sensor, sample, cold, critical, priority } = selected;
  const outdoor = usableOutdoorConditions(context);
  const evidence: HomeInsightEvidence[] = [
    numericEvidence("Latest temperature", round(sample.value, 1), "\u00b0C", "temperature", sensor.id, sample.timestamp),
  ];
  if (outdoor && finiteNumber(outdoor.temperatureC)) {
    evidence.push(numericEvidence("Outdoor temperature", round(outdoor.temperatureC, 1), "\u00b0C", "temperature", undefined, outdoor.timestamp));
  }

  return [{
    id: `temperature:${cold ? "low" : "high"}:${sensor.id}`,
    kind: "temperature",
    severity: critical ? "critical" : "warning",
    priority,
    title: `${critical ? "Very " : ""}${cold ? "low" : "high"} temperature in ${targetLabel(sensor)}`,
    summary: `The latest reading is ${round(sample.value, 1)}\u00b0C. Check the room and confirm the reading with another thermometer if available.`,
    action: cold
      ? "Check heating, doors, and windows now. If freezing conditions or plumbing are at risk, protect the property and contact a qualified professional."
      : "Check occupants first, reduce heat gain, and use safe cooling. Seek medical help if anyone shows signs of heat illness.",
    target: targetFor(context.house, sensor),
    evidence,
    freshness: freshnessForSample(sample, context.nowMs),
    confidence: sample.quality === "good"
      ? confidence("medium", "This is a fresh, good-quality reading, but it should be physically confirmed before major action.", 0.78)
      : confidence("low", "The fresh reading is estimated and should be confirmed."),
    safetyNote: "Treat extreme-temperature insight as a prompt to check people and the property, not as an emergency diagnosis.",
  }];
}

function temperatureBalanceInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
  const temperatures = context.enabledSensors.flatMap((sensor) => {
    if (coveredPairs.has(metricPair(sensor.id, "temperature"))) return [];
    const sample = newestMetricSample(context, sensor.id, "temperature");
    return isFreshUsable(sample, context.nowMs) ? [{ sensor, sample }] : [];
  }).sort((first, second) => first.sample.value - second.sample.value || compareText(first.sensor.id, second.sensor.id));
  if (temperatures.length < 2) return [];
  // An extreme-temperature insight already gives the safer, more direct action.
  // Avoid spending a second card on the same evidence as a room imbalance.
  if (temperatures.some(({ sample }) => sample.value <= HOME_INSIGHT_THRESHOLDS.lowTemperatureC
    || sample.value >= HOME_INSIGHT_THRESHOLDS.highTemperatureC)) return [];
  const coldest = temperatures[0]!;
  const warmest = temperatures.at(-1)!;
  const spread = warmest.sample.value - coldest.sample.value;
  if (spread < HOME_INSIGHT_THRESHOLDS.temperatureImbalanceC) return [];

  const allGood = temperatures.every(({ sample }) => sample.quality === "good");
  return [{
    id: `temperature-balance:${coldest.sensor.id}:${warmest.sensor.id}`,
    kind: "temperature-balance",
    severity: spread >= 5 ? "warning" : "notice",
    priority: clampPriority(48 + spread * 3.5),
    title: `Rooms differ by ${round(spread, 1)}\u00b0C`,
    summary: `${targetLabel(coldest.sensor)} is ${round(coldest.sample.value, 1)}\u00b0C while ${targetLabel(warmest.sensor)} is ${round(warmest.sample.value, 1)}\u00b0C.`,
    action: "Check closed doors, drafts, radiators, and supply vents in the cooler room, then compare the rooms again after the system has had time to respond.",
    target: targetFor(context.house, coldest.sensor),
    evidence: [
      numericEvidence(`${targetLabel(coldest.sensor)} temperature`, round(coldest.sample.value, 1), "\u00b0C", "temperature", coldest.sensor.id, coldest.sample.timestamp),
      numericEvidence(`${targetLabel(warmest.sensor)} temperature`, round(warmest.sample.value, 1), "\u00b0C", "temperature", warmest.sensor.id, warmest.sample.timestamp),
    ],
    freshness: freshnessForTimestamp(
      Date.parse(coldest.sample.timestamp) <= Date.parse(warmest.sample.timestamp)
        ? coldest.sample.timestamp
        : warmest.sample.timestamp,
      context.nowMs,
    ),
    confidence: temperatures.length >= 3 && allGood
      ? confidence("high", "Three or more fresh, good-quality sensors support the room-to-room comparison.", 0.9)
      : confidence("medium", "Two fresh sensors support the comparison, but placement can affect room readings."),
  }];
}

function coverageInsight(context: EngineContext, coverage: HomePulseCoverage): InsightCandidate[] {
  if (coverage.enabledSensors === 0) {
    return [{
      id: `setup:${context.house.id}`,
      kind: "setup",
      severity: "info",
      priority: 30,
      title: "Connect a sensor to start the home pulse",
      summary: "This home has no enabled sensors, so indoor conditions cannot be assessed yet.",
      action: "Add or enable a sensor, assign it to the correct room, and wait for its first reading.",
      target: { houseId: context.house.id },
      evidence: [{ label: "Enabled sensors", value: 0 }],
      freshness: unknownFreshness(),
      confidence: confidence("high", "The setup state comes directly from the enabled sensor list."),
    }];
  }

  const affected = context.enabledSensors.flatMap((sensor) => {
    const { sample, freshness } = coverageStateForSensor(context, sensor.id);
    return freshness.state === "fresh" ? [] : [{ sensor, sample, freshness }];
  });
  if (!affected.length) return [];

  const unavailable = affected.filter(({ freshness }) => freshness.state === "stale" || freshness.state === "unknown");
  const one = affected.length === 1 ? affected[0]! : null;
  const representative = affected.slice().sort((first, second) => {
    if (!first.sample) return -1;
    if (!second.sample) return 1;
    return Date.parse(first.sample.timestamp) - Date.parse(second.sample.timestamp)
      || compareText(first.sensor.id, second.sensor.id);
  })[0]!;
  const rooms = affected.slice(0, 3).map(({ sensor }) => targetLabel(sensor)).join(", ");
  const extraRooms = affected.length > 3 ? ` and ${affected.length - 3} more` : "";
  const noFreshData = coverage.freshSensors + coverage.estimatedSensors === 0;

  return [{
    id: `sensor-coverage:${context.house.id}`,
    kind: "sensor-coverage",
    severity: noFreshData ? "warning" : "notice",
    priority: noFreshData ? 70 : unavailable.length ? 46 : 36,
    title: one ? `${one.sensor.name} needs a data check` : `${affected.length} sensors need a data check`,
    summary: `${rooms}${extraRooms} ${affected.length === 1 ? "is" : "are"} not providing a fresh reading. Health insights for those areas may be incomplete.`,
    action: "Check battery level, hub or Home Assistant connectivity, and the sensor's enabled state. Keep the sensor in place while troubleshooting so comparisons remain meaningful.",
    target: one ? targetFor(context.house, one.sensor) : { houseId: context.house.id },
    evidence: [
      { label: "Fresh sensors", value: coverage.freshSensors },
      ...(coverage.estimatedSensors > 0 ? [{ label: "Estimated sensors", value: coverage.estimatedSensors }] : []),
      { label: "Sensors needing data", value: affected.length },
      ...(representative.sample ? [{
        label: "Oldest affected reading",
        value: representative.sensor.name,
        sensorId: representative.sensor.id,
        observedAt: representative.sample.timestamp,
      }] : []),
    ],
    freshness: representative.freshness,
    confidence: confidence("high", "Freshness is calculated directly from sensor timestamps and quality flags.", 0.94),
  }];
}

function measureCoverage(sensorCoverage: readonly HomePulseSensorCoverage[]): HomePulseCoverage {
  const result: HomePulseCoverage = {
    enabledSensors: sensorCoverage.length,
    freshSensors: 0,
    estimatedSensors: 0,
    agingSensors: 0,
    staleSensors: 0,
    sensorsWithoutData: 0,
  };
  for (const sensor of sensorCoverage) {
    const state = sensor.freshness.state;
    if (state === "fresh") result.freshSensors += 1;
    else if (state === "estimated") result.estimatedSensors += 1;
    else if (state === "aging") result.agingSensors += 1;
    else if (state === "stale") result.staleSensors += 1;
    else result.sensorsWithoutData += 1;
  }
  return result;
}

function metricGuidance(
  context: EngineContext,
  sensor: Sensor,
  metric: Metric,
  value: number,
  operator?: AlertRule["operator"],
): OutdoorGuidance {
  const upperBoundAlert = operator === "gt" || operator === "gte";
  const lowerBoundAlert = operator === "lt" || operator === "lte";
  if (metric === "humidity" && (upperBoundAlert || (!operator && value >= HOME_INSIGHT_THRESHOLDS.humidityPercent))) {
    return humidityGuidance(context, sensor, value);
  }
  if (metric === "co2" && (upperBoundAlert || (!operator && value >= HOME_INSIGHT_THRESHOLDS.co2Ppm))) {
    return ventilationGuidance(context);
  }
  if (metric === "temperature") {
    const cold = lowerBoundAlert || (!operator && value < HOME_INSIGHT_THRESHOLDS.lowTemperatureC);
    const hot = upperBoundAlert || (!operator && value >= HOME_INSIGHT_THRESHOLDS.highTemperatureC);
    if (!cold && !hot) {
      return {
        action: `Inspect ${targetLabel(sensor)}, follow the configured alert rule, and confirm the temperature with another thermometer before making a major change.`,
        evidence: [],
      };
    }
    return {
      action: cold
        ? "Check the room, heating, doors, and windows, then confirm the temperature with another thermometer if available."
        : "Check the room and occupants, reduce heat gain or use safe cooling, then confirm the temperature with another thermometer if available.",
      evidence: [],
    };
  }
  return {
    action: `Inspect ${targetLabel(sensor)}, follow the configured alert rule, and confirm the condition with a recent reading before taking irreversible action.`,
    evidence: [],
  };
}

function humidityGuidance(context: EngineContext, sensor: Sensor, humidity: number): OutdoorGuidance {
  const unsafeReason = unsafeAiringReason(context);
  const outdoor = usableOutdoorConditions(context);
  const indoorTemperature = newestMetricSample(context, sensor.id, "temperature");
  const indoorDewPoint = isFreshUsable(indoorTemperature, context.nowMs)
    ? dewPointC(indoorTemperature.value, humidity)
    : null;
  const outdoorDewPoint = outdoor
    ? finiteNumber(outdoor.dewPointC)
      ? outdoor.dewPointC
      : finiteNumber(outdoor.temperatureC) && finiteNumber(outdoor.relativeHumidityPercent)
        ? dewPointC(outdoor.temperatureC, outdoor.relativeHumidityPercent)
        : null
    : null;
  const evidence: HomeInsightEvidence[] = [];

  if (outdoor && outdoorDewPoint !== null) {
    evidence.push(numericEvidence("Outdoor dew point", round(outdoorDewPoint, 1), "\u00b0C", undefined, undefined, outdoor.timestamp));
  }
  if (indoorDewPoint !== null) {
    evidence.push(numericEvidence("Indoor dew point", round(indoorDewPoint, 1), "\u00b0C", undefined, sensor.id, indoorTemperature?.timestamp));
  }

  if (unsafeReason) {
    return {
      action: `Run the extractor or a dehumidifier and check for visible condensation or water. ${unsafeReason}; do not open windows solely on this insight. Recheck after 20-30 minutes.`,
      evidence,
    };
  }
  if (indoorDewPoint !== null && outdoorDewPoint !== null && outdoorDewPoint <= indoorDewPoint - 2) {
    return {
      action: "Run the extractor or use a short, supervised airing: outdoor air currently carries less moisture. Check for visible condensation or water, then recheck humidity after 20-30 minutes.",
      evidence,
    };
  }
  if (indoorDewPoint !== null && outdoorDewPoint !== null && outdoorDewPoint >= indoorDewPoint) {
    return {
      action: "Prefer the extractor or a dehumidifier because outdoor air is not currently drier. Check for visible condensation or water, then recheck humidity after 20-30 minutes.",
      evidence,
    };
  }
  return {
    action: "Run the extractor or a dehumidifier, or briefly air the room only if weather and security conditions make that safe. Check for visible condensation or water, then recheck after 20-30 minutes.",
    evidence,
  };
}

function ventilationGuidance(context: EngineContext): OutdoorGuidance {
  const outdoor = usableOutdoorConditions(context);
  const unsafeReason = unsafeAiringReason(context);
  const evidence: HomeInsightEvidence[] = [];
  if (outdoor && finiteNumber(outdoor.temperatureC)) {
    evidence.push(numericEvidence("Outdoor temperature", round(outdoor.temperatureC, 1), "\u00b0C", "temperature", undefined, outdoor.timestamp));
  }
  if (outdoor && finiteNumber(outdoor.windSpeedMps)) {
    evidence.push(numericEvidence("Outdoor wind", round(outdoor.windSpeedMps, 1), "m/s", undefined, undefined, outdoor.timestamp));
  }
  if (unsafeReason) {
    return {
      action: `Increase mechanical ventilation and check that vents are open. ${unsafeReason}; do not open windows solely on this insight. Recheck CO2 after 10-15 minutes.`,
      evidence,
    };
  }
  if (outdoor) {
    return {
      action: "Increase ventilation. Current outdoor conditions support a short, supervised airing if it is secure to do so; recheck CO2 after 10-15 minutes.",
      evidence,
    };
  }
  return {
    action: "Increase mechanical ventilation, or briefly open a window only if local weather and security conditions make that safe. Recheck CO2 after 10-15 minutes.",
    evidence,
  };
}

function unsafeAiringReason(context: EngineContext): string | null {
  const warning = (context.outdoor?.warnings ?? []).find((item) =>
    isHomeRelevantWeatherWarning(item)
      && (item.severity === "severe" || item.severity === "extreme")
      && warningIsCurrent(item, context.nowMs));
  if (warning) return `An active ${warning.severity} weather warning may make airing unsafe`;
  const outdoor = usableOutdoorConditions(context);
  if (!outdoor) return null;
  if ((finiteNumber(outdoor.windGustMps) && outdoor.windGustMps >= 18)
    || (finiteNumber(outdoor.windSpeedMps) && outdoor.windSpeedMps >= 12)) {
    return "Strong wind may make airing unsafe";
  }
  if (finiteNumber(outdoor.temperatureC) && (outdoor.temperatureC <= -10 || outdoor.temperatureC >= 30)) {
    return "Extreme outdoor temperature makes prolonged airing inefficient or unsafe";
  }
  if (finiteNumber(outdoor.precipitationIntensityMmPerHour) && outdoor.precipitationIntensityMmPerHour >= 3) {
    return "Heavy precipitation may make airing impractical";
  }
  return null;
}

function usableOutdoorConditions(context: EngineContext): OutdoorConditions | null {
  if (!context.outdoor || context.outdoor.stale === true) return null;
  const conditions = context.outdoor.current ?? context.outdoor.conditions ?? null;
  if (!conditions) return null;
  const timestamp = Date.parse(conditions.timestamp);
  if (!Number.isFinite(timestamp)
    || timestamp > context.nowMs + FUTURE_TOLERANCE_MS
    || context.nowMs - timestamp > AGING_MS) return null;
  return conditions;
}

function warningIsCurrent(warning: WeatherWarning, nowMs: number): boolean {
  const starts = [warning.effectiveAt, warning.onsetAt]
    .flatMap((value) => value ? [Date.parse(value)] : [])
    .filter(Number.isFinite);
  if (starts.length && Math.min(...starts) > nowMs) return false;
  const expires = warning.expiresAt ? Date.parse(warning.expiresAt) : Number.NaN;
  return !Number.isFinite(expires) || expires >= nowMs;
}

function windowEvidence(
  context: EngineContext,
  sensorId: string,
  metric: Metric,
  predicate: (value: number) => boolean,
): WindowEvidence {
  const samples = metricWindowSamples(context, sensorId, metric, TREND_MS)
    .filter((sample) => sample.quality !== "stale");
  const matching = samples.filter((sample) => predicate(sample.value)).length;
  const spanMinutes = samples.length >= 2
    ? (Date.parse(samples.at(-1)!.timestamp) - Date.parse(samples[0]!.timestamp)) / MINUTE_MS
    : 0;
  const sustained = samples.length >= 3 && spanMinutes >= 30 && matching / samples.length >= 2 / 3;
  return { samples, matching, sustained, spanMinutes };
}

function metricWindowSamples(
  context: EngineContext,
  sensorId: string,
  metric: Metric,
  windowMs: number,
): MeasurementSample[] {
  const candidates = (context.history[sensorId]?.[metric] ?? []).filter((sample) =>
    validSample(sample, sensorId, metric, context.nowMs)
    && Date.parse(sample.timestamp) >= context.nowMs - windowMs);
  const byTimestamp = new Map<string, MeasurementSample>();
  for (const sample of candidates) {
    const existing = byTimestamp.get(sample.timestamp);
    byTimestamp.set(sample.timestamp, existing ? preferredSample(existing, sample) : sample);
  }
  // The normalized latest map is authoritative when history contains a
  // conflicting copy of the same timestamp.
  const direct = context.latest[sensorId]?.[metric];
  if (direct
    && validSample(direct, sensorId, metric, context.nowMs)
    && Date.parse(direct.timestamp) >= context.nowMs - windowMs) {
    byTimestamp.set(direct.timestamp, direct);
  }
  return [...byTimestamp.values()].sort((first, second) =>
    Date.parse(first.timestamp) - Date.parse(second.timestamp)
    || compareSamples(first, second));
}

function newestMetricSample(context: EngineContext, sensorId: string, metric: Metric): MeasurementSample | undefined {
  const direct = context.latest[sensorId]?.[metric];
  const directIsValid = Boolean(direct && validSample(direct, sensorId, metric, context.nowMs));
  let newest = directIsValid ? direct : undefined;
  for (const sample of context.history[sensorId]?.[metric] ?? []) {
    if (!validSample(sample, sensorId, metric, context.nowMs)) continue;
    if (directIsValid && sample.timestamp === direct!.timestamp) continue;
    newest = newest ? newerSample(newest, sample) : sample;
  }
  return newest;
}

function newestSensorSample(context: EngineContext, sensorId: string): MeasurementSample | undefined {
  let newest: MeasurementSample | undefined;
  const latestMetrics = context.latest[sensorId] ?? {};
  for (const metric of Object.keys(latestMetrics).sort(compareText)) {
    if (metric === "battery") continue;
    const sample = latestMetrics[metric];
    if (!sample || !validSample(sample, sensorId, metric, context.nowMs)) continue;
    newest = newest ? newerSample(newest, sample) : sample;
  }
  const historyMetrics = context.history[sensorId] ?? {};
  for (const metric of Object.keys(historyMetrics).sort(compareText)) {
    if (metric === "battery") continue;
    for (const sample of historyMetrics[metric] ?? []) {
      if (!validSample(sample, sensorId, metric, context.nowMs)) continue;
      newest = newest ? newerSample(newest, sample) : sample;
    }
  }
  return newest;
}

function coverageStateForSensor(context: EngineContext, sensorId: string): SensorCoverageState {
  const sensor = context.sensors.find((candidate) => candidate.id === sensorId);
  const declaredMetrics = sensor ? declaredCoverageMetrics(sensor) : [];
  const supportedMetrics = sensor ? supportedSensorMetrics(context, sensor, declaredMetrics) : new Set<Metric>();
  // A sensor-specific rule is an explicit monitoring requirement. A global
  // rule is event-driven and applies only where the sensor declares or has
  // demonstrated that metric; otherwise climate rules would make energy-only
  // devices look disconnected.
  const ruleMetrics = [...context.rules.values()]
    .filter((rule) => rule.enabled && (
      rule.sensorId === sensorId
      || (rule.sensorId === null && supportedMetrics.has(rule.metric))
    ))
    .map((rule) => rule.metric);
  const requiredMetrics = [...ruleMetrics, ...declaredMetrics]
    .filter((metric, index, metrics) => metrics.indexOf(metric) === index)
    .sort(compareText);
  if (requiredMetrics.length === 0) {
    const sample = newestSensorSample(context, sensorId);
    return {
      sample,
      freshness: sample ? coverageFreshnessForSample(sample, context.nowMs) : unknownFreshness(),
      requiredMetrics,
    };
  }

  const priority: Record<HomeInsightFreshnessState, number> = { unknown: 5, stale: 4, aging: 3, estimated: 2, fresh: 1 };
  return requiredMetrics.map((metric): SensorCoverageState => {
    const sample = newestMetricSample(context, sensorId, metric);
    return {
      sample,
      freshness: sample ? coverageFreshnessForSample(sample, context.nowMs) : unknownFreshness(),
      requiredMetrics,
    };
  }).sort((left, right) => priority[right.freshness.state] - priority[left.freshness.state]
    || (Date.parse(left.freshness.evidenceAt ?? "") || Number.NEGATIVE_INFINITY)
      - (Date.parse(right.freshness.evidenceAt ?? "") || Number.NEGATIVE_INFINITY))[0]!;
}

function declaredCoverageMetrics(sensor: Sensor): Metric[] {
  return [
    ...Object.keys(sensor.measurementEntityIds ?? {}).filter((metric) => metric !== "battery"),
    ...(sensor.temperatureEntityId ? ["temperature"] : []),
    ...(sensor.humidityEntityId ? ["humidity"] : []),
    ...(sensor.tpLinkDeviceId && /\bT3(?:10|15)\b/i.test(sensor.model) ? ["temperature", "humidity"] : []),
  ];
}

function supportedSensorMetrics(
  context: EngineContext,
  sensor: Sensor,
  declaredMetrics: readonly Metric[],
): ReadonlySet<Metric> {
  const supported = new Set<Metric>(declaredMetrics);
  for (const metric of Object.keys(sensor.measurementEntityIds ?? {})) supported.add(metric);
  if (sensor.temperatureEntityId) supported.add("temperature");
  if (sensor.humidityEntityId) supported.add("humidity");
  if (sensor.batteryEntityId) supported.add("battery");
  for (const metric of Object.keys(context.latest[sensor.id] ?? {})) supported.add(metric);
  for (const [metric, samples] of Object.entries(context.history[sensor.id] ?? {})) {
    if (samples.length > 0) supported.add(metric);
  }
  return supported;
}

function validSample(
  sample: MeasurementSample,
  sensorId: string,
  metric: Metric,
  nowMs: number,
): boolean {
  const timestamp = Date.parse(sample.timestamp);
  return sample.sensorId === sensorId
    && sample.metric === metric
    && Number.isFinite(sample.value)
    && Number.isFinite(timestamp)
    && timestamp <= nowMs + FUTURE_TOLERANCE_MS;
}

function newerSample(first: MeasurementSample, second: MeasurementSample): MeasurementSample {
  const timeDifference = Date.parse(second.timestamp) - Date.parse(first.timestamp);
  if (timeDifference > 0) return second;
  if (timeDifference < 0) return first;
  return preferredSample(first, second);
}

function preferredSample(first: MeasurementSample, second: MeasurementSample): MeasurementSample {
  const qualityDifference = qualityOrder[second.quality] - qualityOrder[first.quality];
  if (qualityDifference > 0) return second;
  if (qualityDifference < 0) return first;
  return compareSamples(first, second) <= 0 ? first : second;
}

function compareSamples(first: MeasurementSample, second: MeasurementSample): number {
  return compareText(first.source, second.source)
    || compareText(first.canonicalUnit, second.canonicalUnit)
    || first.value - second.value;
}

function isFreshUsable(
  sample: MeasurementSample | undefined,
  nowMs: number,
): sample is MeasurementSample {
  return Boolean(sample && sample.quality !== "stale" && freshnessForSample(sample, nowMs).state === "fresh");
}

function freshnessForSample(sample: MeasurementSample, nowMs: number): HomeInsightFreshness {
  if (sample.quality === "stale") {
    const freshness = freshnessForTimestamp(sample.timestamp, nowMs);
    return { ...freshness, state: freshness.state === "unknown" ? "unknown" : "stale" };
  }
  return freshnessForTimestamp(sample.timestamp, nowMs);
}

function coverageFreshnessForSample(sample: MeasurementSample, nowMs: number): HomeInsightFreshness {
  const freshness = freshnessForSample(sample, nowMs);
  return sample.quality === "estimated" && freshness.state === "fresh"
    ? { ...freshness, state: "estimated" }
    : freshness;
}

function freshnessForTimestamp(timestamp: string, nowMs: number): HomeInsightFreshness {
  const observedMs = Date.parse(timestamp);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + FUTURE_TOLERANCE_MS) return unknownFreshness();
  const ageMs = Math.max(0, nowMs - observedMs);
  return {
    state: ageMs <= FRESH_MS ? "fresh" : ageMs <= AGING_MS ? "aging" : "stale",
    evidenceAt: timestamp,
    ageMinutes: round(ageMs / MINUTE_MS, 1),
  };
}

function unknownFreshness(): HomeInsightFreshness {
  return { state: "unknown", evidenceAt: null, ageMinutes: null };
}

function confidenceForTrend(sample: MeasurementSample, window: WindowEvidence): HomeInsightConfidence {
  if (sample.quality === "estimated") {
    return confidence("low", "The latest reading is estimated; confirm it before making a major change.", 0.55);
  }
  if (window.sustained && window.samples.length >= 4 && window.spanMinutes >= 60) {
    return confidence("high", "Multiple good-quality readings over at least an hour support this pattern.", 0.92);
  }
  return confidence("medium", "The latest reading is fresh, but longer history would make the trend more certain.", 0.74);
}

function confidence(
  level: HomeInsightConfidenceLevel,
  reason: string,
  score = level === "high" ? 0.9 : level === "medium" ? 0.7 : 0.5,
): HomeInsightConfidence {
  return { level, score, reason };
}

function targetFor(house: House, sensor: Sensor): HomeInsightTarget {
  const floor = house.floors.find((item) => item.id === sensor.floorId);
  return {
    houseId: house.id,
    sensorId: sensor.id,
    sensorName: sensor.name,
    floorId: sensor.floorId,
    ...(floor ? { floorName: floor.name } : {}),
    ...(sensor.room.trim() ? { room: sensor.room.trim() } : {}),
  };
}

function targetLabel(sensor: Sensor): string {
  return sensor.room.trim() || sensor.name.trim() || "the selected room";
}

function metricPair(sensorId: string, metric: Metric): string {
  return `${sensorId}\u0000${metric}`;
}

function metricLabel(metric: Metric): string {
  if (metric === "co2") return "CO2";
  return metric
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metricUnit(metric: Metric): string {
  if (metric === "temperature") return "\u00b0C";
  if (metric === "humidity") return "%";
  if (metric === "co2") return "ppm";
  return "";
}

function numericEvidence(
  label: string,
  value: number,
  unit?: string,
  metric?: Metric,
  sensorId?: string,
  observedAt?: string,
): HomeInsightEvidence {
  return {
    label,
    value,
    ...(unit ? { unit } : {}),
    ...(metric ? { metric } : {}),
    ...(sensorId ? { sensorId } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

function guidanceSafetyNote(
  metric: Metric,
  operator?: AlertRule["operator"],
  value?: number,
): string | null {
  if (metric === "humidity") return "Humidity readings describe moisture conditions; they do not detect mold or prove that a leak exists.";
  if (metric === "co2"
    && (operator === "gt" || operator === "gte" || (!operator && value !== undefined && value >= HOME_INSIGHT_THRESHOLDS.co2Ppm))) {
    return "A consumer CO2 reading is a ventilation indicator, not a medical diagnosis. If anyone feels unwell, move to fresh air and seek appropriate help.";
  }
  if (metric === "temperature") return "Confirm unusual temperatures and check people and property before relying on an automated reading.";
  return null;
}

function dewPointC(temperatureC: number, relativeHumidityPercent: number): number | null {
  if (!Number.isFinite(temperatureC)
    || !Number.isFinite(relativeHumidityPercent)
    || relativeHumidityPercent <= 0
    || relativeHumidityPercent > 100) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(relativeHumidityPercent / 100) + a * temperatureC / (b + temperatureC);
  const result = b * gamma / (a - gamma);
  return Number.isFinite(result) ? result : null;
}

function finiteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseReferenceTime(value: string | number): number {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError("referenceTime must be a valid timestamp");
  return parsed;
}

function normalizeMaximum(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return HOME_INSIGHT_DEFAULT_MAX;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function clampPriority(value: number): number {
  return round(Math.min(100, Math.max(0, value)), 1);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareCandidates(first: InsightCandidate, second: InsightCandidate): number {
  return severityOrder[second.severity] - severityOrder[first.severity]
    || second.priority - first.priority
    || compareText(first.id, second.id);
}

function compareAlerts(first: AlertEvent, second: AlertEvent): number {
  return alertSeverityOrder[second.severity] - alertSeverityOrder[first.severity]
    || Number(Boolean(first.acknowledgedAt)) - Number(Boolean(second.acknowledgedAt))
    || Date.parse(second.startedAt) - Date.parse(first.startedAt)
    || compareText(first.id, second.id);
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function pulseStatus(candidates: readonly InsightCandidate[], coverage: HomePulseCoverage): HomePulseStatus {
  if (candidates.some((insight) => insight.severity === "critical")) return "critical";
  if (candidates.some((insight) => insight.severity === "warning")) return "attention";
  if (candidates.some((insight) => insight.severity === "notice")) return "watch";
  if (coverage.freshSensors > 0) return "steady";
  return "unknown";
}
