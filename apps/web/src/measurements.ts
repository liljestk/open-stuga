import { BUILTIN_MEASUREMENT_DEFINITIONS } from "@climate-twin/contracts";
import type {
  ForecastPoint,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  Metric,
  Reading,
  UnitSystem,
} from "@climate-twin/contracts";

export type LatestMeasurements = Record<string, Record<Metric, MeasurementSample>>;
export type MeasurementHistory = Record<string, Record<Metric, MeasurementSample[]>>;
export type MeasurementForecasts = Record<string, Record<Metric, MeasurementForecastPoint[]>>;

const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function enabledDefinitions(definitions: readonly MeasurementDefinition[]): MeasurementDefinition[] {
  const source = definitions.length ? definitions : BUILTIN_MEASUREMENT_DEFINITIONS;
  const seen = new Set<string>();
  return source.filter((definition) => {
    if (!definition.enabled || seen.has(definition.id)) return false;
    seen.add(definition.id);
    return true;
  });
}

export function definitionFor(definitions: readonly MeasurementDefinition[], metric: Metric): MeasurementDefinition {
  return definitions.find((definition) => definition.id === metric)
    ?? BUILTIN_MEASUREMENT_DEFINITIONS.find((definition) => definition.id === metric)
    ?? {
      id: metric,
      labels: { en: metric },
      unit: "",
      precision: 1,
      validMin: null,
      validMax: null,
      displayMin: null,
      displayMax: null,
      interpolationDelta: 1,
      colorScale: "sequential",
      builtin: false,
      enabled: true,
      spatialInterpolation: false,
      forecastSupported: false,
      dimension: "finite_scalar",
      allowedUnits: [],
      kind: "gauge",
      defaultAggregation: "mean",
      genericHistoryEnabled: true,
      genericStatsEnabled: true,
    };
}

export function measurementLabel(definition: MeasurementDefinition, locale: string): string {
  return definition.labels[locale]
    ?? definition.labels[locale.split("-")[0] ?? ""]
    ?? definition.labels.en
    ?? Object.values(definition.labels).find(Boolean)
    ?? definition.id;
}

export function measurementValue(
  value: Reading | MeasurementSample | undefined,
  metric: Metric,
): number | undefined {
  if (!value) return undefined;
  if ("metric" in value) return value.metric === metric && Number.isFinite(value.value) ? value.value : undefined;
  const generic = value.measurements?.[metric];
  if (Number.isFinite(generic)) return generic;
  if (metric === "temperature" && Number.isFinite(value.temperature)) return value.temperature;
  if (metric === "humidity" && Number.isFinite(value.humidity)) return value.humidity;
  return undefined;
}

export function forecastMeasurement(
  point: ForecastPoint | MeasurementForecastPoint,
  metric: Metric,
): { value: number; low: number; high: number } | undefined {
  if ("metric" in point) return point.metric === metric ? { value: point.value, low: point.low, high: point.high } : undefined;
  const generic = point.measurements?.[metric];
  if (generic) return generic;
  if (metric === "temperature") return { value: point.temperature, low: point.temperatureLow, high: point.temperatureHigh };
  if (metric === "humidity") return { value: point.humidity, low: point.humidityLow, high: point.humidityHigh };
  return undefined;
}

export function readingSamples(reading: Reading, definitions: readonly MeasurementDefinition[]): MeasurementSample[] {
  return enabledDefinitions(definitions).flatMap((definition) => {
    // Match server ingestion: the canonical legacy fields override an optional
    // generic map so the pushed visual cannot briefly show an older duplicate.
    const value = definition.id === "temperature"
      ? reading.temperature
      : definition.id === "humidity"
        ? reading.humidity
        : measurementValue(reading, definition.id);
    return value == null ? [] : [{
      sensorId: reading.sensorId,
      metric: definition.id,
      value,
      canonicalUnit: definition.unit,
      timestamp: reading.timestamp,
      source: reading.source,
      quality: reading.quality,
    }];
  });
}

export function upsertLatest(latest: LatestMeasurements, samples: MeasurementSample[]): LatestMeasurements {
  const next = { ...latest };
  for (const sample of samples) {
    const current = next[sample.sensorId]?.[sample.metric];
    if (current && Date.parse(current.timestamp) > Date.parse(sample.timestamp)) continue;
    next[sample.sensorId] = { ...(next[sample.sensorId] ?? {}), [sample.metric]: sample };
  }
  return next;
}

function appendHistoryWithLimit(
  history: MeasurementHistory,
  samples: MeasurementSample[],
  limitForSeries: (existing: MeasurementSample[]) => number,
): MeasurementHistory {
  const next = { ...history };
  const samplesBySensor = new Map<string, Map<Metric, MeasurementSample[]>>();
  for (const sample of samples) {
    let samplesByMetric = samplesBySensor.get(sample.sensorId);
    if (!samplesByMetric) {
      samplesByMetric = new Map();
      samplesBySensor.set(sample.sensorId, samplesByMetric);
    }
    const seriesSamples = samplesByMetric.get(sample.metric) ?? [];
    seriesSamples.push(sample);
    samplesByMetric.set(sample.metric, seriesSamples);
  }
  for (const [sensorId, samplesByMetric] of samplesBySensor) {
    const sensorHistory = { ...(next[sensorId] ?? {}) };
    for (const [metric, seriesSamples] of samplesByMetric) {
      const existing = sensorHistory[metric] ?? [];
      const limit = Math.max(1, Math.floor(limitForSeries(existing)));
      sensorHistory[metric] = mergeHistorySeries(existing, seriesSamples, limit);
    }
    next[sensorId] = sensorHistory;
  }
  return next;
}

function mergeHistorySeries(
  existing: MeasurementSample[],
  samples: MeasurementSample[],
  limit: number,
): MeasurementSample[] {
  const byTimestamp = new Map<string, MeasurementSample>();
  for (const sample of samples) {
    // Moving an existing key makes the Map order match the last occurrence too.
    byTimestamp.delete(sample.timestamp);
    byTimestamp.set(sample.timestamp, sample);
  }
  const incoming = [...byTimestamp.values()];
  const last = existing.at(-1);
  let previousTime = last ? Date.parse(last.timestamp) : Number.NEGATIVE_INFINITY;
  let orderedAppend = !last || Number.isFinite(previousTime);
  for (const sample of incoming) {
    const sampleTime = Date.parse(sample.timestamp);
    if (!Number.isFinite(sampleTime) || sampleTime < previousTime) {
      orderedAppend = false;
      break;
    }
    previousTime = sampleTime;
  }

  if (orderedAppend) {
    const existingEnd = last?.timestamp === incoming[0]?.timestamp
      ? existing.length - 1
      : existing.length;
    const retainedStart = Math.max(0, existingEnd + incoming.length - limit);
    if (retainedStart >= existingEnd) return incoming.slice(retainedStart - existingEnd);
    const retained = existing.slice(retainedStart, existingEnd);
    for (const sample of incoming) retained.push(sample);
    return retained;
  }

  // Imports and reconnects can arrive out of order. Consolidate the whole batch
  // first so a large retained series is copied and sorted at most once per flush.
  const incomingTimestamps = new Set(byTimestamp.keys());
  const merged = existing.filter((sample) => !incomingTimestamps.has(sample.timestamp));
  for (const sample of incoming) merged.push(sample);
  merged.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return merged.length > limit ? merged.slice(-limit) : merged;
}

export function appendHistory(history: MeasurementHistory, samples: MeasurementSample[], limit = 50_000): MeasurementHistory {
  return appendHistoryWithLimit(history, samples, () => limit);
}

/**
 * Keep a compact live tail without discarding a larger series that the user
 * explicitly loaded. Once a series reaches either size, new samples replace
 * its oldest entries instead of growing it toward the global query ceiling.
 */
export function appendLiveHistory(
  history: MeasurementHistory,
  samples: MeasurementSample[],
  minimumLimit = 500,
): MeasurementHistory {
  return appendHistoryWithLimit(
    history,
    samples,
    (existing) => Math.max(minimumLimit, existing.length),
  );
}

export function samplesAt(
  history: MeasurementHistory,
  sensorIds: string[],
  metric: Metric,
  timestamp: number,
): Record<string, MeasurementSample> {
  return Object.fromEntries(sensorIds.flatMap((sensorId) => {
    const series = history[sensorId]?.[metric] ?? [];
    let low = 0;
    let high = series.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const middleTime = Date.parse(series[middle]!.timestamp);
      if (Number.isFinite(middleTime) && middleTime <= timestamp) low = middle + 1;
      else high = middle;
    }
    let sample: MeasurementSample | undefined;
    for (let index = low - 1; index >= 0; index -= 1) {
      const candidate = series[index]!;
      const candidateTime = Date.parse(candidate.timestamp);
      if (Number.isFinite(candidateTime) && candidateTime <= timestamp) {
        sample = candidate;
        break;
      }
    }
    return sample ? [[sensorId, { ...sample, source: "replay" as const }]] : [];
  }));
}

export function displayUnit(definition: MeasurementDefinition, units: UnitSystem): string {
  return definition.dimension === "temperature" && units === "imperial" ? "°F" : definition.unit;
}

export function toDisplayValue(value: number, definition: MeasurementDefinition, units: UnitSystem): number {
  return definition.dimension === "temperature" && units === "imperial" ? value * 9 / 5 + 32 : value;
}

export function fromDisplayValue(value: number, definition: MeasurementDefinition, units: UnitSystem): number {
  return definition.dimension === "temperature" && units === "imperial" ? (value - 32) * 5 / 9 : value;
}

export function formatMeasurement(value: number, definition: MeasurementDefinition, units: UnitSystem): string {
  const converted = toDisplayValue(value, definition, units);
  const unit = displayUnit(definition, units);
  const separator = unit && unit !== "%" && !unit.startsWith("°") ? " " : "";
  return `${converted.toFixed(definition.precision)}${separator}${unit}`;
}

export function formatMeasurementDelta(value: number, definition: MeasurementDefinition, units: UnitSystem): string {
  const converted = definition.dimension === "temperature" && units === "imperial" ? value * 9 / 5 : value;
  const unit = displayUnit(definition, units);
  const separator = unit && unit !== "%" && !unit.startsWith("°") ? " " : "";
  return `${Math.abs(converted).toFixed(definition.precision)}${separator}${unit}`;
}

export function measurementDomain(definition: MeasurementDefinition, values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  // Charts pass every point of every visible series at once, which is well past
  // the argument-count limit some engines apply to a spread call.
  let actualMin = values[0]!;
  let actualMax = values[0]!;
  for (const value of values) {
    if (value < actualMin) actualMin = value;
    if (value > actualMax) actualMax = value;
  }
  const delta = Math.max(definition.interpolationDelta, 10 ** -definition.precision);
  const min = definition.displayMin == null ? actualMin - delta : Math.min(definition.displayMin, actualMin);
  const max = definition.displayMax == null ? actualMax + delta : Math.max(definition.displayMax, actualMax);
  return max > min ? { min, max } : { min: min - delta, max: max + delta };
}

export function measurementColor(value: number, min: number, max: number, definition: MeasurementDefinition): string {
  const progress = clampValue((value - min) / Math.max(max - min, Number.EPSILON), 0, 1);
  // Each ramp changes in luminance as well as hue. The blue–neutral–vermilion
  // thermal ramp avoids the red/green confusion of a conventional heat map.
  const ramps: Record<MeasurementDefinition["colorScale"], readonly string[]> = {
    thermal: ["#2166ac", "#f2ebdd", "#b54122"],
    humidity: ["#d8f0f6", "#2a84b8", "#123d75"],
    "air-quality": ["#e7f1f8", "#d29b00", "#8c2d04"],
    sequential: ["#e7e0f3", "#7b6ab5", "#3f285f"],
  };
  return interpolateColorRamp(ramps[definition.colorScale], progress);
}

export function measurementComparisonColor(
  definition: MeasurementDefinition,
  indoorValues: number[],
  outsideValue: number | undefined,
): { color: string; domain: { min: number; max: number } } | null {
  if (outsideValue == null || !Number.isFinite(outsideValue)) return null;
  const domain = measurementDomain(
    definition,
    [...indoorValues.filter(Number.isFinite), outsideValue],
  );
  return domain
    ? { color: measurementColor(outsideValue, domain.min, domain.max, definition), domain }
    : null;
}

function interpolateColorRamp(stops: readonly string[], progress: number): string {
  const position = progress * (stops.length - 1);
  const index = Math.min(Math.floor(position), stops.length - 2);
  const amount = position - index;
  const from = hexChannels(stops[index]!);
  const to = hexChannels(stops[index + 1]!);
  const channels = from.map((channel, channelIndex) => Math.round(channel + (to[channelIndex]! - channel) * amount));
  return `rgb(${channels.join(" ")})`;
}

function hexChannels(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

export function measurementGradient(definition: MeasurementDefinition): string {
  const colors = [0, .5, 1].map((progress) => measurementColor(progress, 0, 1, definition));
  return `linear-gradient(90deg, ${colors.join(", ")})`;
}

export function defaultAlertThreshold(definition: MeasurementDefinition): number {
  const builtinDefaults: Record<string, number> = {
    temperature: 20,
    humidity: 65,
    co2: 1_000,
    power: 5_000,
    energy: 20,
    electricity_price: 0.25,
  };
  return builtinDefaults[definition.id]
    ?? (definition.displayMin != null && definition.displayMax != null
      ? (definition.displayMin + definition.displayMax) / 2
      : 0);
}
