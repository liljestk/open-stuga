import { co2Insight, coverageInsight, humidityGuidance, measureCoverage, metricGuidance, temperatureBalanceInsight, temperatureInsight, windowEvidence } from "./freshness.js";
import { clampPriority, compareAlerts, compareCandidates, confidence, confidenceForTrend, coverageStateForSensor, freshnessForSample, freshnessForTimestamp, guidanceSafetyNote, isFreshUsable, metricLabel, metricPair, metricUnit, newestMetricSample, normalizeMaximum, numericEvidence, parseReferenceTime, pulseStatus, round, targetFor, targetLabel, EngineContext, HOME_INSIGHT_THRESHOLDS, HomeInsightEvidence, HomePulseSensorCoverage, InsightCandidate, HomeInsightSeverity, HomeInsight, HomeInsightInput, HomePulseResult, HOME_INSIGHT_ADVISORY } from "./model.js";
import { compareCodeUnits } from "../../text-order.js";

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
    .sort((first, second) => compareCodeUnits(first.id, second.id));
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
    const safetyNote = guidanceSafetyNote(alert.metric, rule?.operator, current?.value ?? alert.value);

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
      ...(safetyNote ? { safetyNote } : {}),
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
  }).sort((first, second) => second.priority - first.priority || compareCodeUnits(first.sensor.id, second.sensor.id));
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
