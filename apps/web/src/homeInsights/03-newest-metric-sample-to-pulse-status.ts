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
import type { LatestMeasurements, MeasurementHistory } from "../measurements";
import { isHomeRelevantWeatherWarning } from "../weatherWarningRelevance";
import { AGING_MS, EngineContext, FRESH_MS, FUTURE_TOLERANCE_MS, HOME_INSIGHT_DEFAULT_MAX, HOME_INSIGHT_THRESHOLDS, HomeInsightConfidence, HomeInsightConfidenceLevel, HomeInsightEvidence, HomeInsightFreshness, HomeInsightFreshnessState, HomeInsightTarget, HomePulseCoverage, HomePulseStatus, InsightCandidate, MINUTE_MS, SensorCoverageState, WindowEvidence, alertSeverityOrder, qualityOrder, severityOrder } from "./01-minute-ms-to-humidity-insight";

export function newestMetricSample(context: EngineContext, sensorId: string, metric: Metric): MeasurementSample | undefined {
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

export function newestSensorSample(context: EngineContext, sensorId: string): MeasurementSample | undefined {
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

export function coverageStateForSensor(context: EngineContext, sensorId: string): SensorCoverageState {
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

export function declaredCoverageMetrics(sensor: Sensor): Metric[] {
  return [
    ...Object.keys(sensor.measurementEntityIds ?? {}).filter((metric) => metric !== "battery"),
    ...(sensor.temperatureEntityId ? ["temperature"] : []),
    ...(sensor.humidityEntityId ? ["humidity"] : []),
    ...(sensor.tpLinkDeviceId && /\bT3(?:10|15)\b/i.test(sensor.model) ? ["temperature", "humidity"] : []),
  ];
}

export function supportedSensorMetrics(
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

export function validSample(
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

export function newerSample(first: MeasurementSample, second: MeasurementSample): MeasurementSample {
  const timeDifference = Date.parse(second.timestamp) - Date.parse(first.timestamp);
  if (timeDifference > 0) return second;
  if (timeDifference < 0) return first;
  return preferredSample(first, second);
}

export function preferredSample(first: MeasurementSample, second: MeasurementSample): MeasurementSample {
  const qualityDifference = qualityOrder[second.quality] - qualityOrder[first.quality];
  if (qualityDifference > 0) return second;
  if (qualityDifference < 0) return first;
  return compareSamples(first, second) <= 0 ? first : second;
}

export function compareSamples(first: MeasurementSample, second: MeasurementSample): number {
  return compareText(first.source, second.source)
    || compareText(first.canonicalUnit, second.canonicalUnit)
    || first.value - second.value;
}

export function isFreshUsable(
  sample: MeasurementSample | undefined,
  nowMs: number,
): sample is MeasurementSample {
  return Boolean(sample && sample.quality !== "stale" && freshnessForSample(sample, nowMs).state === "fresh");
}

export function freshnessForSample(sample: MeasurementSample, nowMs: number): HomeInsightFreshness {
  if (sample.quality === "stale") {
    const freshness = freshnessForTimestamp(sample.timestamp, nowMs);
    return { ...freshness, state: freshness.state === "unknown" ? "unknown" : "stale" };
  }
  return freshnessForTimestamp(sample.timestamp, nowMs);
}

export function coverageFreshnessForSample(sample: MeasurementSample, nowMs: number): HomeInsightFreshness {
  const freshness = freshnessForSample(sample, nowMs);
  return sample.quality === "estimated" && freshness.state === "fresh"
    ? { ...freshness, state: "estimated" }
    : freshness;
}

export function freshnessForTimestamp(timestamp: string, nowMs: number): HomeInsightFreshness {
  const observedMs = Date.parse(timestamp);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + FUTURE_TOLERANCE_MS) return unknownFreshness();
  const ageMs = Math.max(0, nowMs - observedMs);
  return {
    state: ageMs <= FRESH_MS ? "fresh" : ageMs <= AGING_MS ? "aging" : "stale",
    evidenceAt: timestamp,
    ageMinutes: round(ageMs / MINUTE_MS, 1),
  };
}

export function unknownFreshness(): HomeInsightFreshness {
  return { state: "unknown", evidenceAt: null, ageMinutes: null };
}

export function confidenceForTrend(sample: MeasurementSample, window: WindowEvidence): HomeInsightConfidence {
  if (sample.quality === "estimated") {
    return confidence("low", "The latest reading is estimated; confirm it before making a major change.", 0.55);
  }
  if (window.sustained && window.samples.length >= 4 && window.spanMinutes >= 60) {
    return confidence("high", "Multiple good-quality readings over at least an hour support this pattern.", 0.92);
  }
  return confidence("medium", "The latest reading is fresh, but longer history would make the trend more certain.", 0.74);
}

export function confidence(
  level: HomeInsightConfidenceLevel,
  reason: string,
  score = level === "high" ? 0.9 : level === "medium" ? 0.7 : 0.5,
): HomeInsightConfidence {
  return { level, score, reason };
}

export function targetFor(house: House, sensor: Sensor): HomeInsightTarget {
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

export function targetLabel(sensor: Sensor): string {
  return sensor.room.trim() || sensor.name.trim() || "the selected room";
}

export function metricPair(sensorId: string, metric: Metric): string {
  return `${sensorId}\u0000${metric}`;
}

export function metricLabel(metric: Metric): string {
  if (metric === "co2") return "CO2";
  return metric
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function metricUnit(metric: Metric): string {
  if (metric === "temperature") return "\u00b0C";
  if (metric === "humidity") return "%";
  if (metric === "co2") return "ppm";
  return "";
}

export function numericEvidence(
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

export function guidanceSafetyNote(
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

export function dewPointC(temperatureC: number, relativeHumidityPercent: number): number | null {
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

export function finiteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseReferenceTime(value: string | number): number {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError("referenceTime must be a valid timestamp");
  return parsed;
}

export function normalizeMaximum(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return HOME_INSIGHT_DEFAULT_MAX;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

export function clampPriority(value: number): number {
  return round(Math.min(100, Math.max(0, value)), 1);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function compareCandidates(first: InsightCandidate, second: InsightCandidate): number {
  return severityOrder[second.severity] - severityOrder[first.severity]
    || second.priority - first.priority
    || compareText(first.id, second.id);
}

export function compareAlerts(first: AlertEvent, second: AlertEvent): number {
  return alertSeverityOrder[second.severity] - alertSeverityOrder[first.severity]
    || Number(Boolean(first.acknowledgedAt)) - Number(Boolean(second.acknowledgedAt))
    || Date.parse(second.startedAt) - Date.parse(first.startedAt)
    || compareText(first.id, second.id);
}

export function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function pulseStatus(candidates: readonly InsightCandidate[], coverage: HomePulseCoverage): HomePulseStatus {
  if (candidates.some((insight) => insight.severity === "critical")) return "critical";
  if (candidates.some((insight) => insight.severity === "warning")) return "attention";
  if (candidates.some((insight) => insight.severity === "notice")) return "watch";
  if (coverage.freshSensors > 0) return "steady";
  return "unknown";
}
