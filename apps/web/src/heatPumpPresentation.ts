import type {
  HeatPumpState,
  MeasurementDefinition,
  MeasurementSample,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import { formatMeasurement, measurementValue, toDisplayValue } from "./measurements";
import {
  DEFAULT_SPATIAL_FUTURE_TOLERANCE_MS,
  isSpatialSampleFresh,
} from "./spatialFreshness";

export function heatPumpName(state: Pick<HeatPumpState, "name" | "brand" | "model">): string {
  return state.name ?? ([state.brand, state.model].filter(Boolean).join(" ") || "Gree/Wilfa");
}

export function heatPumpSensorId(connectionId: string): string {
  return `sensor-${connectionId}`;
}

export function sensorRepresentsHeatPump(sensor: Sensor, states: readonly HeatPumpState[]): boolean {
  return states.some((state) => heatPumpSensorId(state.connectionId) === sensor.id);
}

export function isHeatPumpStateFresh(
  state: HeatPumpState,
  referenceTimeMs: number,
  maxSampleAgeMs: number,
): boolean {
  if (!state.available) return false;
  const timestampMs = Date.parse(state.observedAt);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(referenceTimeMs)) return false;
  return timestampMs <= referenceTimeMs + DEFAULT_SPATIAL_FUTURE_TOLERANCE_MS
    && referenceTimeMs - timestampMs <= Math.max(0, maxSampleAgeMs);
}

function directMeasurement(state: HeatPumpState, metric: string): number | null {
  if (metric === "temperature") return state.currentTemperatureC;
  if (metric === "humidity") return state.currentHumidityPercent;
  if (metric === "heat_pump_target_temperature") return state.targetTemperatureC;
  if (metric === "heat_pump_target_humidity") return state.targetHumidityPercent;
  if (metric === "heat_pump_compressor_frequency") return state.compressorFrequencyHz;
  if (metric === "heat_pump_available") return state.available ? 1 : 0;
  if (metric === "heat_pump_power") return state.power === null ? null : state.power ? 1 : 0;
  return null;
}

export interface HeatPumpMarkerReading {
  value: number | null;
  fresh: boolean;
  compact: string;
  formatted: string;
}

export interface HeatPumpMarkerReadingInput {
  state: HeatPumpState;
  sample: MeasurementSample | undefined;
  definition: MeasurementDefinition;
  units: UnitSystem;
  referenceTimeMs: number;
  maxSampleAgeMs: number;
  locale: string;
  noData: string;
}

export function heatPumpMarkerReading({
  state,
  sample,
  definition,
  units,
  referenceTimeMs,
  maxSampleAgeMs,
  locale,
  noData,
}: HeatPumpMarkerReadingInput): HeatPumpMarkerReading {
  const sampleValue = measurementValue(sample, definition.id);
  const value = sampleValue ?? directMeasurement(state, definition.id);
  const fresh = state.available && (sample
    ? isSpatialSampleFresh(sample, { referenceTimeMs, maxSampleAgeMs })
    : isHeatPumpStateFresh(state, referenceTimeMs, maxSampleAgeMs));
  if (value === null || !fresh) return { value, fresh, compact: "—", formatted: noData };
  const display = toDisplayValue(value, definition, units);
  const compact = new Intl.NumberFormat(locale, {
    maximumFractionDigits: definition.precision,
  }).format(display);
  return {
    value,
    fresh,
    compact,
    formatted: formatMeasurement(value, definition, units),
  };
}

export function formatHeatPumpTemperature(value: number | null, units: UnitSystem, locale: string, noData: string): string {
  if (value === null) return noData;
  const converted = units === "imperial" ? value * 9 / 5 + 32 : value;
  const unit = units === "imperial" ? "°F" : "°C";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(converted)} ${unit}`;
}

export function formatHeatPumpHumidity(value: number | null, locale: string, noData: string): string {
  return value === null
    ? noData
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
}

export function humanizeHeatPumpValue(value: string | null, noData: string): string {
  if (!value) return noData;
  const spaced = value
    .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll(/[-_]+/gu, " ")
    .trim();
  return spaced ? `${spaced.charAt(0).toLocaleUpperCase()}${spaced.slice(1)}` : noData;
}
