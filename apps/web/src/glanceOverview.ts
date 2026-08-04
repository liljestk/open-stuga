import type { MeasurementSample, Metric, Sensor } from "@climate-twin/contracts";
import type { LatestMeasurements } from "./measurements";

export const GLANCE_METRICS = ["temperature", "humidity", "power", "co2"] as const;
export type GlanceMetric = typeof GLANCE_METRICS[number];
export type GlanceScope = "home" | "property";

export interface GlancePreference {
  scope: GlanceScope;
  targetId: string;
  metrics: GlanceMetric[];
}

export interface GlanceMetricSummary {
  metric: GlanceMetric;
  value: number | null;
  sampleCount: number;
  latestAt: string | null;
}

const MAX_READING_AGE_MS = 15 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

function recentSample(sample: MeasurementSample | undefined, now: number): sample is MeasurementSample {
  if (!sample || sample.quality === "stale" || !Number.isFinite(sample.value)) return false;
  const observedAt = Date.parse(sample.timestamp);
  if (!Number.isFinite(observedAt)) return false;
  const age = now - observedAt;
  return age >= -FUTURE_TOLERANCE_MS && age <= MAX_READING_AGE_MS;
}

function electricitySamples(
  samples: Array<{ sensor: Sensor; sample: MeasurementSample }>,
): Array<{ sensor: Sensor; sample: MeasurementSample }> {
  const byHome = new Map<string, Array<{ sensor: Sensor; sample: MeasurementSample }>>();
  for (const item of samples) {
    const homeSamples = byHome.get(item.sensor.houseId) ?? [];
    homeSamples.push(item);
    byHome.set(item.sensor.houseId, homeSamples);
  }
  return [...byHome.values()].flatMap((homeSamples) => {
    const wholeHome = homeSamples.filter(({ sensor }) => sensor.energyMeterRole === "whole_home");
    if (wholeHome.length) return wholeHome;
    const standalone = homeSamples.filter(({ sensor }) => sensor.energyMeterRole !== "submeter");
    return standalone.length ? standalone : homeSamples;
  });
}

function environmentalAverage(
  samples: Array<{ sensor: Sensor; sample: MeasurementSample }>,
): number {
  const totals = new Map<string, { total: number; count: number }>();
  for (const { sensor, sample } of samples) {
    const current = totals.get(sensor.houseId) ?? { total: 0, count: 0 };
    totals.set(sensor.houseId, { total: current.total + sample.value, count: current.count + 1 });
  }
  const homeAverages = [...totals.values()].map(({ total, count }) => total / count);
  return homeAverages.reduce((sum, value) => sum + value, 0) / homeAverages.length;
}

/**
 * Summarizes only current evidence. Environmental readings are averaged;
 * instantaneous electricity is summed without double-counting submeters when
 * a whole-Home meter is available.
 */
export function summarizeGlanceMetric(
  sensors: readonly Sensor[],
  latest: LatestMeasurements,
  metric: GlanceMetric,
  now = Date.now(),
): GlanceMetricSummary {
  let samples = sensors.flatMap((sensor) => {
    const sample = latest[sensor.id]?.[metric];
    return sensor.enabled && recentSample(sample, now) ? [{ sensor, sample }] : [];
  });
  if (metric === "power") samples = electricitySamples(samples);
  if (!samples.length) return { metric, value: null, sampleCount: 0, latestAt: null };

  const total = samples.reduce((sum, { sample }) => sum + sample.value, 0);
  const latestAt = samples
    .map(({ sample }) => sample.timestamp)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
  return {
    metric,
    value: metric === "power" ? total : environmentalAverage(samples),
    sampleCount: samples.length,
    latestAt,
  };
}

export function normalizeGlanceMetrics(values: readonly string[] | undefined): GlanceMetric[] {
  const selected = GLANCE_METRICS.filter((metric) => values?.includes(metric));
  return selected.length ? selected : [...GLANCE_METRICS];
}

export function mergeLatestMeasurements(
  current: LatestMeasurements,
  incoming: LatestMeasurements,
): LatestMeasurements {
  const merged: LatestMeasurements = { ...current };
  for (const [sensorId, measurements] of Object.entries(incoming)) {
    for (const [metric, sample] of Object.entries(measurements)) {
      if (!sample) continue;
      const existing = merged[sensorId]?.[metric];
      if (existing && Date.parse(existing.timestamp) > Date.parse(sample.timestamp)) continue;
      merged[sensorId] = { ...(merged[sensorId] ?? {}), [metric as Metric]: sample };
    }
  }
  return merged;
}
