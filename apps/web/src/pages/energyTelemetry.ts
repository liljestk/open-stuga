import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import type { ElectricityMetric } from "./ElectricityHistory";

export interface MetricSource {
  sensor: Sensor;
  sample: MeasurementSample | null;
}

function sampleTime(sample: MeasurementSample | null): number {
  if (!sample) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(sample.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function boundToMetric(sensor: Sensor, metric: ElectricityMetric): boolean {
  return Boolean(sensor.measurementEntityIds?.[metric]);
}

export function supportsMetric(state: ClimateState, sensor: Sensor, metric: ElectricityMetric): boolean {
  return boundToMetric(sensor, metric)
    || Boolean(state.latestMeasurements[sensor.id]?.[metric])
    || (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0;
}

export function sensorsForMetric(state: ClimateState, sensors: Sensor[], metric: ElectricityMetric): Sensor[] {
  return sensors.filter((sensor) => supportsMetric(state, sensor, metric));
}

function sourceForMetric(
  state: ClimateState,
  sensors: Sensor[],
  metric: ElectricityMetric,
  now: number,
): MetricSource | null {
  const candidates = sensors.flatMap((sensor): MetricSource[] => {
    const sample = freshestElectricitySample(state, sensor.id, metric, now);
    const hasHistory = (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0;
    return sample || hasHistory || boundToMetric(sensor, metric) ? [{ sensor, sample }] : [];
  });
  return candidates.sort((left, right) => {
    const freshLeft = freshElectricitySample(left.sample, metric, now);
    const freshRight = freshElectricitySample(right.sample, metric, now);
    if (Boolean(freshLeft) !== Boolean(freshRight)) return freshRight ? 1 : -1;
    const byFreshness = sampleTime(freshRight ?? right.sample) - sampleTime(freshLeft ?? left.sample);
    if (byFreshness) return byFreshness;
    return left.sensor.name.localeCompare(right.sensor.name);
  })[0] ?? null;
}

/**
 * Computes usage from a cumulative counter and tolerates a daily/monthly reset.
 * A reset contributes the new counter value instead of a negative delta.
 */
export function counterConsumption(samples: MeasurementSample[]): number | null {
  const usable = samples.filter((sample) => sample.metric === "energy"
    && sample.quality !== "stale"
    && Number.isFinite(sample.value)
    && Number.isFinite(Date.parse(sample.timestamp)));
  const ordered = [...new Map(usable.map((sample) => [sample.timestamp, sample])).values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (ordered.length < 2) return null;
  let total = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.value;
    const current = ordered[index]!.value;
    total += current >= previous ? current - previous : Math.max(0, current);
  }
  return total;
}

export function metricSources(
  state: ClimateState,
  sensors: Sensor[],
  now: number,
): Record<ElectricityMetric, MetricSource | null> {
  return {
    power: sourceForMetric(state, sensors, "power", now),
    energy: sourceForMetric(state, sensors, "energy", now),
    electricity_price: sourceForMetric(state, sensors, "electricity_price", now),
  };
}

export function freshSourcesForMetric(
  state: ClimateState,
  sensors: Sensor[],
  metric: ElectricityMetric,
  now: number,
): MetricSource[] {
  return sensors.flatMap((sensor) => {
    const sample = freshestElectricitySample(state, sensor.id, metric, now);
    return sample ? [{ sensor, sample }] : [];
  });
}

const ELECTRICITY_FRESHNESS_MS: Record<ElectricityMetric, number> = {
  power: 15 * 60_000,
  energy: 2 * 60 * 60_000,
  electricity_price: 2 * 60 * 60_000,
};
const MAX_ELECTRICITY_CLOCK_SKEW_MS = 5 * 60_000;

export function freshElectricitySample(
  sample: MeasurementSample | null | undefined,
  metric: ElectricityMetric,
  now: number,
): MeasurementSample | null {
  if (!sample || sample.quality === "stale") return null;
  const timestamp = Date.parse(sample.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now + MAX_ELECTRICITY_CLOCK_SKEW_MS
    || now - timestamp > ELECTRICITY_FRESHNESS_MS[metric]) return null;
  return sample;
}

function freshestElectricitySample(
  state: ClimateState,
  sensorId: string,
  metric: ElectricityMetric,
  now: number,
): MeasurementSample | null {
  const candidates = [
    state.latestMeasurements[sensorId]?.[metric],
    ...(state.measurementHistory[sensorId]?.[metric] ?? []),
  ];
  return candidates.reduce<MeasurementSample | null>((freshest, candidate) => {
    const sample = freshElectricitySample(candidate, metric, now);
    if (!sample) return freshest;
    return !freshest || Date.parse(sample.timestamp) > Date.parse(freshest.timestamp) ? sample : freshest;
  }, null);
}
