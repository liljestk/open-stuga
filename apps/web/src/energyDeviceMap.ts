import type { MeasurementDefinition, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { definitionFor, formatMeasurement } from "./measurements";

const ENERGY_METRICS = ["power", "energy"] as const;
const ENERGY_DEVICE_MODEL = /(?:^|[^a-z0-9])(?:p110m?|p115|h110|hs110|kp115|kp125m?)(?=$|[^a-z0-9])/i;
const ENERGY_DEVICE_TAGS = new Set(["energy", "energy-monitor", "plug", "smart-plug"]);

export interface EnergyDeviceMapStats {
  power: MeasurementSample | null;
  energy: MeasurementSample | null;
  /** Compact, already unit-formatted text suitable for a map marker. */
  short: string | null;
}

/**
 * Identifies map endpoints by measured capability first. Model/tag fallbacks
 * keep a newly placed plug recognizable before its first telemetry sample.
 */
export function isEnergyDeviceSensor(
  sensor: Pick<Sensor, "measurementEntityIds" | "model" | "tags">,
  measurements: Record<string, MeasurementSample> = {},
): boolean {
  if (ENERGY_METRICS.some((metric) => Boolean(measurements[metric] || sensor.measurementEntityIds?.[metric]))) return true;
  if (sensor.tags.some((tag) => ENERGY_DEVICE_TAGS.has(tag.trim().toLowerCase()))) return true;
  return ENERGY_DEVICE_MODEL.test(sensor.model.trim());
}

export function energyDeviceMapStats(
  measurements: Record<string, MeasurementSample> = {},
  definitions: MeasurementDefinition[],
  units: UnitSystem,
): EnergyDeviceMapStats {
  const power = measurements.power ?? null;
  const energy = measurements.energy ?? null;
  const values = [power, energy].flatMap((sample) => sample && Number.isFinite(sample.value)
    ? [formatMeasurement(sample.value, definitionFor(definitions, sample.metric), units)]
    : []);
  return { power, energy, short: values.length ? values.join(" · ") : null };
}
