import { minimum } from "@climate-twin/analytics-kernel";
import type { AlertRule, HomeInsightEvidence, HomePulseCoverage, HomePulseSensorCoverage, MeasurementSample, Metric, OutdoorConditions, Sensor, WeatherWarning } from "@climate-twin/contracts";
import { isHomeRelevantWeatherWarning } from "@climate-twin/contracts";
import { AGING_MS, EngineContext, FUTURE_TOLERANCE_MS, HOME_INSIGHT_THRESHOLDS, InsightCandidate, MINUTE_MS, OutdoorGuidance, TREND_MS, WindowEvidence, clampPriority, compareSamples, confidence, confidenceForTrend, coverageStateForSensor, dewPointC, isFiniteNumber, freshnessForSample, freshnessForTimestamp, isFreshUsable, metricPair, newestMetricSample, numericEvidence, preferredSample, round, targetFor, targetLabel, unknownFreshness, validSample } from "./model.js";
import { compareCodeUnits } from "../../text-order.js";

export function co2Insight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
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
  }).sort((first, second) => second.priority - first.priority || compareCodeUnits(first.sensor.id, second.sensor.id));
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

export function temperatureInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
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
  }).sort((first, second) => second.priority - first.priority || compareCodeUnits(first.sensor.id, second.sensor.id));
  const selected = options[0];
  if (!selected) return [];

  const { sensor, sample, cold, critical, priority } = selected;
  const outdoor = usableOutdoorConditions(context);
  const evidence: HomeInsightEvidence[] = [
    numericEvidence("Latest temperature", round(sample.value, 1), "\u00b0C", "temperature", sensor.id, sample.timestamp),
  ];
  if (outdoor && isFiniteNumber(outdoor.temperatureC)) {
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

export function temperatureBalanceInsight(context: EngineContext, coveredPairs: ReadonlySet<string>): InsightCandidate[] {
  const temperatures = context.enabledSensors.flatMap((sensor) => {
    if (coveredPairs.has(metricPair(sensor.id, "temperature"))) return [];
    const sample = newestMetricSample(context, sensor.id, "temperature");
    return isFreshUsable(sample, context.nowMs) ? [{ sensor, sample }] : [];
  }).sort((first, second) => first.sample.value - second.sample.value || compareCodeUnits(first.sensor.id, second.sensor.id));
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

export function coverageInsight(context: EngineContext, coverage: HomePulseCoverage): InsightCandidate[] {
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
      || compareCodeUnits(first.sensor.id, second.sensor.id);
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

export function measureCoverage(sensorCoverage: readonly HomePulseSensorCoverage[]): HomePulseCoverage {
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

export function metricGuidance(
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

export function humidityGuidance(context: EngineContext, sensor: Sensor, humidity: number): OutdoorGuidance {
  const unsafeReason = unsafeAiringReason(context);
  const outdoor = usableOutdoorConditions(context);
  const indoorTemperature = newestMetricSample(context, sensor.id, "temperature");
  const indoorDewPoint = isFreshUsable(indoorTemperature, context.nowMs)
    ? dewPointC(indoorTemperature.value, humidity)
    : null;
  const outdoorDewPoint = outdoor
    ? isFiniteNumber(outdoor.dewPointC)
      ? outdoor.dewPointC
      : isFiniteNumber(outdoor.temperatureC) && isFiniteNumber(outdoor.relativeHumidityPercent)
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

export function ventilationGuidance(context: EngineContext): OutdoorGuidance {
  const outdoor = usableOutdoorConditions(context);
  const unsafeReason = unsafeAiringReason(context);
  const evidence: HomeInsightEvidence[] = [];
  if (outdoor && isFiniteNumber(outdoor.temperatureC)) {
    evidence.push(numericEvidence("Outdoor temperature", round(outdoor.temperatureC, 1), "\u00b0C", "temperature", undefined, outdoor.timestamp));
  }
  if (outdoor && isFiniteNumber(outdoor.windSpeedMps)) {
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

export function unsafeAiringReason(context: EngineContext): string | null {
  const warning = (context.outdoor?.warnings ?? []).find((item) =>
    isHomeRelevantWeatherWarning(item)
      && (item.severity === "severe" || item.severity === "extreme")
      && warningIsCurrent(item, context.nowMs));
  if (warning) return `An active ${warning.severity} weather warning may make airing unsafe`;
  const outdoor = usableOutdoorConditions(context);
  if (!outdoor) return null;
  if ((isFiniteNumber(outdoor.windGustMps) && outdoor.windGustMps >= 18)
    || (isFiniteNumber(outdoor.windSpeedMps) && outdoor.windSpeedMps >= 12)) {
    return "Strong wind may make airing unsafe";
  }
  if (isFiniteNumber(outdoor.temperatureC) && (outdoor.temperatureC <= -10 || outdoor.temperatureC >= 30)) {
    return "Extreme outdoor temperature makes prolonged airing inefficient or unsafe";
  }
  if (isFiniteNumber(outdoor.precipitationIntensityMmPerHour) && outdoor.precipitationIntensityMmPerHour >= 3) {
    return "Heavy precipitation may make airing impractical";
  }
  return null;
}

export function usableOutdoorConditions(context: EngineContext): OutdoorConditions | null {
  if (!context.outdoor || context.outdoor.stale === true) return null;
  const conditions = context.outdoor.current ?? context.outdoor.conditions ?? null;
  if (!conditions) return null;
  const timestamp = Date.parse(conditions.timestamp);
  if (!Number.isFinite(timestamp)
    || timestamp > context.nowMs + FUTURE_TOLERANCE_MS
    || context.nowMs - timestamp > AGING_MS) return null;
  return conditions;
}

export function warningIsCurrent(warning: WeatherWarning, nowMs: number): boolean {
  const starts = [warning.effectiveAt, warning.onsetAt]
    .flatMap((value) => value ? [Date.parse(value)] : [])
    .filter(Number.isFinite);
  if (starts.length && (minimum(starts) ?? Number.POSITIVE_INFINITY) > nowMs) return false;
  const expires = warning.expiresAt ? Date.parse(warning.expiresAt) : Number.NaN;
  return !Number.isFinite(expires) || expires >= nowMs;
}

export function windowEvidence(
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

export function metricWindowSamples(
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
