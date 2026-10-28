import type { MeasurementSample, Sensor } from "@climate-twin/contracts";

export const OPTIMIZER_POWER_HOLD_MS = 15 * 60_000;

interface WeightedPower {
  watts: number;
  durationMs: number;
}

function weightedPercentile(values: readonly WeightedPower[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left.watts - right.watts);
  const target = ordered.reduce((sum, item) => sum + item.durationMs, 0) * fraction;
  let elapsed = 0;
  for (const item of ordered) {
    elapsed += item.durationMs;
    if (elapsed >= target) return item.watts;
  }
  return ordered.at(-1)!.watts;
}

/** Property totals use simultaneous held readings, weighted by elapsed time. */
export function propertyPowerProfile(
  sensors: readonly Sensor[],
  samples: readonly MeasurementSample[],
  from: number,
  to: number,
): { baseline: number | null; peak: number | null } {
  const unavailable = { baseline: null, peak: null };
  const bySensor = new Map<string, Map<number, number>>();
  for (const sample of samples) {
    const at = Date.parse(sample.timestamp);
    if (sample.metric !== "power" || sample.quality === "stale" || !Number.isFinite(sample.value)
      || sample.value < 0 || !Number.isFinite(at) || at >= to || at < from - OPTIMIZER_POWER_HOLD_MS) continue;
    const readings = bySensor.get(sample.sensorId) ?? new Map<number, number>();
    readings.set(at, sample.value);
    bySensor.set(sample.sensorId, readings);
  }

  const homes = new Map<string, Sensor[]>();
  for (const sensor of sensors) {
    if (!sensor.enabled) continue;
    const home = homes.get(sensor.houseId) ?? [];
    home.push(sensor);
    homes.set(sensor.houseId, home);
  }
  const selected: Sensor[] = [];
  for (const home of homes.values()) {
    const wholeHome = home.filter((sensor) => sensor.energyMeterRole === "whole_home")
      .sort((left, right) => left.id.localeCompare(right.id));
    if (wholeHome.length) {
      selected.push(wholeHome[0]!);
      continue;
    }
    const candidates = home.filter((sensor) => bySensor.has(sensor.id)
      || sensor.measurementEntityIds?.power || sensor.measurementEntityIds?.energy);
    const standalone = candidates.filter((sensor) => (sensor.energyMeterRole ?? "standalone") === "standalone");
    // Submeters alone cannot establish total Property power.
    if (candidates.length && !standalone.length) return unavailable;
    selected.push(...standalone);
  }
  if (!selected.length || selected.some((sensor) => !bySensor.has(sensor.id))) return unavailable;

  const events = new Map<number, { watts: number; count: number }>();
  const addEvent = (at: number, watts: number, count: number) => {
    const existing = events.get(at) ?? { watts: 0, count: 0 };
    existing.watts += watts;
    existing.count += count;
    events.set(at, existing);
  };
  for (const sensor of selected) {
    const readings = [...bySensor.get(sensor.id)!.entries()].sort(([left], [right]) => left - right);
    for (let index = 0; index < readings.length; index += 1) {
      const [at, watts] = readings[index]!;
      const start = Math.max(from, at);
      const end = Math.min(to, at + OPTIMIZER_POWER_HOLD_MS, readings[index + 1]?.[0] ?? to);
      if (end <= start) continue;
      addEvent(start, watts, 1);
      addEvent(end, -watts, -1);
    }
  }
  const timeline = [...events.entries()].sort(([left], [right]) => left - right);
  const intervals: WeightedPower[] = [];
  let watts = 0;
  let count = 0;
  for (let index = 0; index < timeline.length - 1; index += 1) {
    const [at, event] = timeline[index]!;
    watts += event.watts;
    count += event.count;
    const durationMs = timeline[index + 1]![0] - at;
    if (count === selected.length && durationMs > 0) intervals.push({ watts: Math.max(0, watts), durationMs });
  }
  return { baseline: weightedPercentile(intervals, 0.1), peak: weightedPercentile(intervals, 0.95) };
}
