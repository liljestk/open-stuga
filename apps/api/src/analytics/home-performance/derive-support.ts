import type {
  ActionRun,
  AnalyticsPoint,
  AnalyticsQueryResponse,
  AnalyticsSeries,
  House,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  Sensor,
} from "@climate-twin/contracts";
import { COMFORT_TEMPERATURE_LOW_C, ENERGY_MIN_BUCKET_COVERAGE, HOUR_MS, HomePerformanceEnergy, HomePerformanceInput, HomePerformanceMaintenance, HomePerformanceOpeningEffectiveness, HomePerformanceRecovery, RECOVERY_MAX_POINT_GAP_MS, RECOVERY_MIN_BUCKET_COVERAGE, RecoveryEvidence, ValuePoint, absoluteHumidity, compareStable, contiguousRecoveryEvidence, median, resolutionHours, round, seriesFor, values } from "./model.js";
import { averageWattsToKwh } from "@climate-twin/analytics-kernel";
import { deriveOpeningActivity } from "../temporal/opening-intervals.js";

export function moistureRecoveryResult(
  input: HomePerformanceInput,
  evidenceBySensor: ReadonlyMap<string, RecoveryEvidence>,
): HomePerformanceRecovery {
  const halfLives: number[] = [];
  let episodeCount = 0;
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const points = evidenceBySensor.get(sensor.id)?.absoluteHumidity ?? [];
    let lastAcceptedPeak = Number.NEGATIVE_INFINITY;
    for (let index = 4; index < points.length - 2; index += 1) {
      const current = points[index]!;
      if (current.time - lastAcceptedPeak < 3 * HOUR_MS) continue;
      const baselineEvidence = points.slice(index - 4, index);
      const nearFuture = points.slice(index, index + 5);
      if (!contiguousRecoveryEvidence([...baselineEvidence, current])
        || nearFuture.length < 3
        || !contiguousRecoveryEvidence(nearFuture)) continue;
      const baseline = median(baselineEvidence.map((point) => point.value));
      if (baseline === null || current.value - baseline < 0.8) continue;
      if (nearFuture.some((point) => point.value > current.value)) continue;
      episodeCount += 1;
      lastAcceptedPeak = current.time;
      const halfway = baseline + (current.value - baseline) / 2;
      let recovered: ValuePoint | null = null;
      let previous = current;
      for (const point of points.slice(index + 1)) {
        if (point.time > current.time + 6 * HOUR_MS
          || point.coverage < RECOVERY_MIN_BUCKET_COVERAGE
          || point.time <= previous.time
          || point.time - previous.time > RECOVERY_MAX_POINT_GAP_MS) break;
        if (point.value <= halfway) {
          recovered = point;
          break;
        }
        previous = point;
      }
      if (recovered) halfLives.push((recovered.time - current.time) / 60_000);
    }
  }
  return {
    state: halfLives.length >= 2 ? "ready" : episodeCount > 0 ? "limited" : "unavailable",
    episodeCount,
    medianHalfLifeMinutes: round(median(halfLives) ?? 0, 0) || null,
  };
}

export function latestAtOrBefore(points: readonly ValuePoint[], timestamp: number, toleranceMs: number): ValuePoint | null {
  return [...points].reverse().find((point) => point.time <= timestamp && point.time >= timestamp - toleranceMs) ?? null;
}

export function openingDescriptor(
  house: House,
  observation: OpeningStateObservation,
): { key: string; label: string | null } {
  const floor = house.floors.find((candidate) => candidate.id === observation.floorId);
  const element = floor?.planElements?.find((candidate) => candidate.id === observation.elementId);
  return {
    key: `${observation.floorId}\u0000${observation.elementId}`,
    label: element?.label?.trim() || null,
  };
}

export function nearestSensorForOpening(
  input: HomePerformanceInput,
  observation: OpeningStateObservation,
  evidenceBySensor: ReadonlyMap<string, RecoveryEvidence>,
): Sensor | null {
  const floor = input.house.floors.find((candidate) => candidate.id === observation.floorId);
  const element = floor?.planElements?.find((candidate) => candidate.id === observation.elementId);
  if (!element) return null;
  return input.sensors.filter((sensor) => sensor.enabled && sensor.floorId === observation.floorId)
    .filter((sensor) => evidenceBySensor.has(sensor.id))
    .sort((left, right) => (
      Math.hypot(left.x - element.position.x, left.y - element.position.y)
      - Math.hypot(right.x - element.position.x, right.y - element.position.y)
      || compareStable(left.id, right.id)
    ))[0] ?? null;
}

export function openingEffectivenessResult(
  input: HomePerformanceInput,
  evidenceBySensor: ReadonlyMap<string, RecoveryEvidence>,
): HomePerformanceOpeningEffectiveness {
  const byId = new Map(input.openings.map((observation) => [observation.id, observation]));
  const transitions = deriveOpeningActivity(
    input.house,
    input.openings,
    input.from,
    input.to,
  ).flatMap((series) => series.records.flatMap((record) => (
    record.transition === "opened" && byId.has(record.id) ? [byId.get(record.id)!] : []
  )));
  const nearestByOpening = new Map<string, Sensor | null>();
  const evaluated: Array<{
    openingKey: string;
    label: string | null;
    halfLifeMinutes: number | null;
    effective: boolean;
  }> = [];
  for (const opening of transitions) {
    const descriptor = openingDescriptor(input.house, opening);
    let sensor = nearestByOpening.get(descriptor.key);
    if (!nearestByOpening.has(descriptor.key)) {
      sensor = nearestSensorForOpening(input, opening, evidenceBySensor);
      nearestByOpening.set(descriptor.key, sensor);
    }
    if (!sensor) continue;
    const sensorEvidence = evidenceBySensor.get(sensor.id);
    if (!sensorEvidence) continue;
    const openedAt = Date.parse(opening.observedAt);
    const candidates = [
      { points: sensorEvidence.co2, threshold: 100 },
      { points: sensorEvidence.absoluteHumidity, threshold: 0.5 },
    ].flatMap((candidate) => {
      const baseline = latestAtOrBefore(candidate.points, openedAt, 45 * 60_000);
      if (!baseline || baseline.coverage < RECOVERY_MIN_BUCKET_COVERAGE) return [];
      const continuous: ValuePoint[] = [];
      let previous = baseline;
      for (const point of candidate.points.filter((item) => (
        item.time > baseline.time && item.time <= openedAt + 3 * HOUR_MS
      ))) {
        if (point.coverage < RECOVERY_MIN_BUCKET_COVERAGE
          || point.time - previous.time > RECOVERY_MAX_POINT_GAP_MS) break;
        continuous.push(point);
        previous = point;
      }
      const after = continuous.filter((point) => point.time >= openedAt + 15 * 60_000);
      if (after.length < 2) return [];
      const minimum = Math.min(...after.map((point) => point.value));
      const drop = baseline.value - minimum;
      const halfway = baseline.value - Math.max(0, drop) / 2;
      const cleared = drop >= candidate.threshold
        ? after.find((point) => point.value <= halfway)
        : undefined;
      return [{
        normalizedDrop: drop / candidate.threshold,
        halfLifeMinutes: cleared ? (cleared.time - openedAt) / 60_000 : null,
      }];
    }).sort((left, right) => right.normalizedDrop - left.normalizedDrop);
    const best = candidates[0];
    if (!best) continue;
    evaluated.push({
      openingKey: descriptor.key,
      label: descriptor.label,
      halfLifeMinutes: best.halfLifeMinutes,
      effective: best.normalizedDrop >= 1 && best.halfLifeMinutes !== null,
    });
  }
  const effective = evaluated.filter((event) => event.effective && event.halfLifeMinutes !== null);
  const grouped = new Map<string, { label: string | null; halfLives: number[] }>();
  for (const event of effective) {
    const group = grouped.get(event.openingKey) ?? { label: event.label, halfLives: [] };
    group.halfLives.push(event.halfLifeMinutes!);
    grouped.set(event.openingKey, group);
  }
  const bestOpening = [...grouped.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      median: median(group.halfLives) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.median - right.median || compareStable(left.key, right.key))[0];
  return {
    state: evaluated.length >= 2 ? "ready" : transitions.length > 0 ? "limited" : "unavailable",
    evaluatedEvents: evaluated.length,
    effectiveEvents: effective.length,
    medianClearanceMinutes: round(median(effective.map((event) => event.halfLifeMinutes!)) ?? 0, 0) || null,
    bestOpeningLabel: bestOpening?.label ?? null,
  };
}

export function hourKey(timestamp: string | number): number {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

export function outdoorHours(samples: readonly OutdoorTemperatureSample[]): Map<number, number> {
  const buckets = new Map<number, number[]>();
  for (const sample of samples) {
    const key = hourKey(sample.timestamp);
    if (!Number.isFinite(key) || !Number.isFinite(sample.temperatureC)) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(sample.temperatureC);
    buckets.set(key, bucket);
  }
  return new Map([...buckets].map(([key, bucket]) => [
    key,
    bucket.reduce((sum, value) => sum + value, 0) / bucket.length,
  ]));
}

export function heatingTagged(sensor: Sensor): boolean {
  return [...sensor.tags, sensor.name, sensor.model].some((value) => (
    /(?:^|[\s_-])(?:heat(?:er|ing|pump)?|hvac|boiler|radiator)(?:$|[\s_-])/iu.test(value)
  ));
}

export function sensorEnergyByHour(
  response: AnalyticsQueryResponse | null,
  sensor: Sensor,
): Map<number, number> {
  const result = new Map<number, number>();
  const add = (key: number, value: number): void => {
    if (!Number.isFinite(key) || !Number.isFinite(value)) return;
    result.set(key, (result.get(key) ?? 0) + value);
  };
  const energy = new Map<number, number>();
  const energySeries = seriesFor(response, sensor.id, "energy");
  if (energySeries && energySeries.summary.count > 0) {
    for (const point of energySeries.points) {
      if (point.value !== null && Number.isFinite(point.value) && point.value >= 0
        && point.coverage >= ENERGY_MIN_BUCKET_COVERAGE
        && !point.qualityFlags.includes("counter_reset")) {
        const key = hourKey(point.timestamp);
        if (Number.isFinite(key)) energy.set(key, (energy.get(key) ?? 0) + point.value);
      }
    }
  }
  const power = new Map<number, number>();
  const powerSeries = seriesFor(response, sensor.id, "power");
  if (powerSeries && powerSeries.summary.count > 0) {
    const coveredPoints = powerSeries.points.filter((point) => (
      point.value !== null && Number.isFinite(point.value)
      && point.coverage >= ENERGY_MIN_BUCKET_COVERAGE
    ));
    const bidirectional = coveredPoints.some((point) => (point.value ?? 0) < 0);
    if (!bidirectional) {
      const hours = resolutionHours(powerSeries);
      for (const point of coveredPoints) {
        if (point.value !== null && point.value >= 0) {
          const key = hourKey(point.timestamp);
          if (Number.isFinite(key)) {
            power.set(key, (power.get(key) ?? 0) + averageWattsToKwh(point.value, hours));
          }
        }
      }
    }
  }
  for (const key of new Set([...energy.keys(), ...power.keys()])) {
    add(key, energy.get(key) ?? power.get(key) ?? 0);
  }
  return result;
}

export function combinedEnergyByHour(sensorHours: readonly ReadonlyMap<number, number>[]): Map<number, number> {
  const result = new Map<number, number>();
  const first = sensorHours[0];
  if (!first) return result;
  for (const key of first.keys()) {
    let total = 0;
    let complete = true;
    for (const hours of sensorHours) {
      const value = hours.get(key);
      if (value === undefined) {
        complete = false;
        break;
      }
      total += value;
    }
    if (complete) result.set(key, total);
  }
  return result;
}

export function energyResult(input: HomePerformanceInput): HomePerformanceEnergy {
  const supported = input.sensors.filter((sensor) => sensor.enabled)
    .map((sensor) => ({ sensor, hours: sensorEnergyByHour(input.energy, sensor) }))
    .filter((item) => item.hours.size > 0);
  const tagged = supported.filter((item) => heatingTagged(item.sensor));
  const selected = tagged.length > 0 ? tagged : supported;
  const source = selected.length === 0 ? null : tagged.length > 0 ? "heating-meter" : "unclassified-electricity";
  const energy = combinedEnergyByHour(selected.map((item) => item.hours));
  const outdoor = outdoorHours(input.outdoor);
  const midpoint = (Date.parse(input.from) + Date.parse(input.to)) / 2;
  const totals = [
    { energy: 0, degreeHours: 0, overlapHours: 0 },
    { energy: 0, degreeHours: 0, overlapHours: 0 },
  ];
  for (const [hour, outsideC] of outdoor) {
    const energyKwh = energy.get(hour);
    if (energyKwh === undefined) continue;
    const degreeHours = Math.max(0, COMFORT_TEMPERATURE_LOW_C - outsideC);
    const half = hour < midpoint ? 0 : 1;
    totals[half]!.degreeHours += degreeHours;
    totals[half]!.energy += energyKwh;
    totals[half]!.overlapHours += 1;
  }
  const energyKwh = totals[0]!.energy + totals[1]!.energy;
  const heatingDegreeHours = totals[0]!.degreeHours + totals[1]!.degreeHours;
  const overlapHours = totals[0]!.overlapHours + totals[1]!.overlapHours;
  const hasOverlap = overlapHours > 0;
  const index = heatingDegreeHours >= 24 && overlapHours >= 24
    ? energyKwh / heatingDegreeHours
    : null;
  const firstIndex = totals[0]!.degreeHours >= 12 && totals[0]!.overlapHours >= 12
    ? totals[0]!.energy / totals[0]!.degreeHours
    : null;
  const secondIndex = totals[1]!.degreeHours >= 12 && totals[1]!.overlapHours >= 12
    ? totals[1]!.energy / totals[1]!.degreeHours
    : null;
  const comparison = firstIndex !== null && secondIndex !== null && firstIndex !== 0
    ? (secondIndex - firstIndex) / firstIndex * 100
    : null;
  return {
    state: index === null ? hasOverlap ? "limited" : "unavailable" : source === "heating-meter" ? "ready" : "limited",
    energyKwh: hasOverlap ? round(energyKwh, 2) : null,
    heatingDegreeHours: round(heatingDegreeHours, 1),
    energyPerHeatingDegreeHour: index === null ? null : round(index, 3),
    comparisonChangePercent: comparison === null ? null : round(comparison, 0),
    source,
  };
}

export function maintenanceResult(input: HomePerformanceInput): HomePerformanceMaintenance {
  const sensorIds = new Set(input.sensors.map((sensor) => sensor.id));
  const tasks = input.maintenanceTasks.filter((task) => task.houseId === input.house.id);
  const evaluated = input.actionRuns.filter((run) => (
    sensorIds.has(run.sensorId) && (run.status === "verified" || run.status === "not-improved")
    && timestampInRange(run.resultTimestamp ?? run.updatedAt, input.from, input.to)
  ));
  const improved = evaluated.filter((run) => run.status === "verified");
  const evaluatedTaskIds = new Set(evaluated.flatMap((run) => run.maintenanceTaskId ? [run.maintenanceTaskId] : []));
  const completed = tasks.filter((task) => (
    (task.status === "completed" || task.status === "verified")
    && timestampInRange(task.completedAt ?? task.verifiedAt ?? task.updatedAt, input.from, input.to)
  ));
  const moistureObservations = input.observations.filter((observation) => (
    observation.houseId === input.house.id && ["leak", "condensation", "mould"].includes(observation.kind)
  ));
  const resolvedByIssue = new Map<string, Array<{ id: string; time: number }>>();
  for (const observation of moistureObservations) {
    if (observation.status !== "resolved" || !observation.resolvedAt) continue;
    const time = Date.parse(observation.resolvedAt);
    if (!Number.isFinite(time)) continue;
    const key = `${observation.floorId}\u0000${observation.kind}`;
    const resolved = resolvedByIssue.get(key) ?? [];
    resolved.push({ id: observation.id, time });
    resolvedByIssue.set(key, resolved);
  }
  for (const resolved of resolvedByIssue.values()) {
    resolved.sort((left, right) => left.time - right.time || compareStable(left.id, right.id));
  }
  const recurring = moistureObservations.filter((candidate) => {
    if (!timestampInRange(candidate.occurredAt, input.from, input.to)) return false;
    const resolved = resolvedByIssue.get(`${candidate.floorId}\u0000${candidate.kind}`) ?? [];
    const previous = resolved[0]?.id === candidate.id ? resolved[1] : resolved[0];
    return previous !== undefined && Date.parse(candidate.occurredAt) > previous.time;
  });
  const hasContext = completed.length > 0 || input.observations.some((observation) => (
    observation.houseId === input.house.id && timestampInRange(observation.occurredAt, input.from, input.to)
  ));
  return {
    state: evaluated.length > 0 ? "ready" : hasContext ? "limited" : "unavailable",
    evaluatedActions: evaluated.length,
    improvedActions: improved.length,
    improvementPercent: evaluated.length > 0 ? round(improved.length / evaluated.length * 100, 0) : null,
    linkedEvaluatedActions: evaluatedTaskIds.size,
    completedWithoutMeasurement: completed.filter((task) => !evaluatedTaskIds.has(task.id)).length,
    recurringObservations: recurring.length,
  };
}

export function definitionFor(definitions: readonly MeasurementDefinition[], metric: string): MeasurementDefinition | undefined {
  return definitions.find((definition) => definition.id === metric);
}

export function timestampInRange(timestamp: string, from: string, to: string): boolean {
  const time = Date.parse(timestamp);
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  return Number.isFinite(time) && Number.isFinite(fromTime) && Number.isFinite(toTime)
    && time >= fromTime && time <= toTime;
}

export function sampleMedian(points: readonly AnalyticsPoint[], predicate: (time: number) => boolean): number | null {
  return median(points.flatMap((point) => {
    const time = Date.parse(point.timestamp);
    return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || !predicate(time)
      ? []
      : [point.value];
  }));
}
