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

export const BUILTIN_MEASUREMENTS: MeasurementDefinition[] = [
  {
    id: "temperature", labels: { en: "Temperature", fi: "Lämpötila" }, unit: "°C", precision: 1,
    validMin: -50, validMax: 60, displayMin: 12, displayMax: 30, interpolationDelta: .35,
    colorScale: "thermal", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "humidity", labels: { en: "Humidity", fi: "Ilmankosteus" }, unit: "%", precision: 0,
    validMin: 0, validMax: 100, displayMin: 20, displayMax: 90, interpolationDelta: 3,
    colorScale: "humidity", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "co2", labels: { en: "Carbon dioxide", fi: "Hiilidioksidi" }, unit: "ppm", precision: 0,
    validMin: 0, validMax: 10_000, displayMin: 400, displayMax: 2_000, interpolationDelta: 50,
    colorScale: "air-quality", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
];

export function enabledDefinitions(definitions: MeasurementDefinition[]): MeasurementDefinition[] {
  const source = definitions.length ? definitions : BUILTIN_MEASUREMENTS;
  const seen = new Set<string>();
  return source.filter((definition) => {
    if (!definition.enabled || seen.has(definition.id)) return false;
    seen.add(definition.id);
    return true;
  });
}

export function definitionFor(definitions: MeasurementDefinition[], metric: Metric): MeasurementDefinition {
  return definitions.find((definition) => definition.id === metric)
    ?? BUILTIN_MEASUREMENTS.find((definition) => definition.id === metric)
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

export function readingSamples(reading: Reading, definitions: MeasurementDefinition[]): MeasurementSample[] {
  return enabledDefinitions(definitions).flatMap((definition) => {
    const value = measurementValue(reading, definition.id);
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

export function legacyForecastSamples(
  point: ForecastPoint,
  definitions: MeasurementDefinition[],
): MeasurementForecastPoint[] {
  return enabledDefinitions(definitions).flatMap((definition) => {
    const measurement = forecastMeasurement(point, definition.id);
    return measurement ? [{
      sensorId: point.sensorId,
      metric: definition.id,
      timestamp: point.timestamp,
      ...measurement,
    }] : [];
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

export function appendHistory(history: MeasurementHistory, samples: MeasurementSample[], limit = 1_000): MeasurementHistory {
  const next = { ...history };
  for (const sample of samples) {
    const sensorHistory = { ...(next[sample.sensorId] ?? {}) };
    const existing = sensorHistory[sample.metric] ?? [];
    const withoutDuplicate = existing.filter((item) => item.timestamp !== sample.timestamp);
    sensorHistory[sample.metric] = [...withoutDuplicate, sample]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(-limit);
    next[sample.sensorId] = sensorHistory;
  }
  return next;
}

export function samplesAt(
  history: MeasurementHistory,
  sensorIds: string[],
  metric: Metric,
  timestamp: number,
): Record<string, MeasurementSample> {
  return Object.fromEntries(sensorIds.flatMap((sensorId) => {
    const sample = (history[sensorId]?.[metric] ?? []).reduce<MeasurementSample | undefined>((closest, item) => {
      const time = Date.parse(item.timestamp);
      if (time > timestamp) return closest;
      return !closest || time > Date.parse(closest.timestamp) ? item : closest;
    }, undefined);
    return sample ? [[sensorId, { ...sample, source: "replay" as const }]] : [];
  }));
}

export function displayUnit(definition: MeasurementDefinition, units: UnitSystem): string {
  return definition.id === "temperature" && units === "imperial" ? "°F" : definition.unit;
}

export function toDisplayValue(value: number, definition: MeasurementDefinition, units: UnitSystem): number {
  return definition.id === "temperature" && units === "imperial" ? value * 9 / 5 + 32 : value;
}

export function fromDisplayValue(value: number, definition: MeasurementDefinition, units: UnitSystem): number {
  return definition.id === "temperature" && units === "imperial" ? (value - 32) * 5 / 9 : value;
}

export function formatMeasurement(value: number, definition: MeasurementDefinition, units: UnitSystem): string {
  const converted = toDisplayValue(value, definition, units);
  const unit = displayUnit(definition, units);
  const separator = unit && unit !== "%" && !unit.startsWith("°") ? " " : "";
  return `${converted.toFixed(definition.precision)}${separator}${unit}`;
}

export function formatMeasurementDelta(value: number, definition: MeasurementDefinition, units: UnitSystem): string {
  const converted = definition.id === "temperature" && units === "imperial" ? value * 9 / 5 : value;
  const unit = displayUnit(definition, units);
  const separator = unit && unit !== "%" && !unit.startsWith("°") ? " " : "";
  return `${Math.abs(converted).toFixed(definition.precision)}${separator}${unit}`;
}

export function measurementDomain(definition: MeasurementDefinition, values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  const actualMin = Math.min(...values);
  const actualMax = Math.max(...values);
  const delta = Math.max(definition.interpolationDelta, 10 ** -definition.precision);
  const min = definition.displayMin == null ? actualMin - delta : Math.min(definition.displayMin, actualMin);
  const max = definition.displayMax == null ? actualMax + delta : Math.max(definition.displayMax, actualMax);
  return max > min ? { min, max } : { min: min - delta, max: max + delta };
}

export function measurementColor(value: number, min: number, max: number, definition: MeasurementDefinition): string {
  const progress = clampValue((value - min) / Math.max(max - min, Number.EPSILON), 0, 1);
  switch (definition.colorScale) {
    case "thermal": return `hsl(${220 - progress * 205} 76% ${61 - Math.abs(progress - .5) * 12}%)`;
    case "humidity": return `hsl(${188 + progress * 42} 72% ${62 - progress * 18}%)`;
    case "air-quality": return `hsl(${145 - progress * 135} ${62 + progress * 12}% ${47 + Math.abs(progress - .5) * 8}%)`;
    default: return `hsl(${205 + progress * 75} 64% ${61 - progress * 16}%)`;
  }
}

export function measurementGradient(definition: MeasurementDefinition): string {
  const colors = [0, .5, 1].map((progress) => measurementColor(progress, 0, 1, definition));
  return `linear-gradient(90deg, ${colors.join(", ")})`;
}

export function defaultAlertThreshold(definition: MeasurementDefinition): number {
  const builtinDefaults: Record<string, number> = { temperature: 20, humidity: 65, co2: 1_000 };
  return builtinDefaults[definition.id]
    ?? (definition.displayMin != null && definition.displayMax != null
      ? (definition.displayMin + definition.displayMax) / 2
      : 0);
}
