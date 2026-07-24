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

export const HOME_PERFORMANCE_ALGORITHM_VERSION = "home-performance-v1.0.0";

const HOUR_MS = 3_600_000;
const COMFORT_TEMPERATURE_LOW_C = 18;
const COMFORT_TEMPERATURE_HIGH_C = 25;
const COMFORT_HUMIDITY_LOW_PCT = 30;
const COMFORT_HUMIDITY_HIGH_PCT = 60;
const COMFORT_CO2_HIGH_PPM = 1_000;
const RECOVERY_MAX_POINT_GAP_MS = 15 * 60_000;
const RECOVERY_MIN_BUCKET_COVERAGE = 0.5;
const ENERGY_MIN_BUCKET_COVERAGE = 0.75;

export type HomePerformanceEvidenceState = "ready" | "limited" | "unavailable";

export interface HomePerformanceRoomExposure {
  id: string;
  label: string;
  sensorIds: string[];
  guideRangePercent: number;
  observedHours: number;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
}

export interface HomePerformanceExposure {
  state: HomePerformanceEvidenceState;
  guideRangePercent: number | null;
  observedHours: number;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
  worstRoom: HomePerformanceRoomExposure | null;
  rooms: HomePerformanceRoomExposure[];
}

export interface HomePerformanceRecovery {
  state: HomePerformanceEvidenceState;
  episodeCount: number;
  medianHalfLifeMinutes: number | null;
}

export interface HomePerformanceOpeningEffectiveness {
  state: HomePerformanceEvidenceState;
  evaluatedEvents: number;
  effectiveEvents: number;
  medianClearanceMinutes: number | null;
  bestOpeningLabel: string | null;
}

export interface HomePerformanceEnergy {
  state: HomePerformanceEvidenceState;
  energyKwh: number | null;
  heatingDegreeHours: number;
  energyPerHeatingDegreeHour: number | null;
  comparisonChangePercent: number | null;
  source: "heating-meter" | "unclassified-electricity" | null;
}

export interface HomePerformanceMaintenance {
  state: HomePerformanceEvidenceState;
  evaluatedActions: number;
  improvedActions: number;
  improvementPercent: number | null;
  linkedEvaluatedActions: number;
  completedWithoutMeasurement: number;
  recurringObservations: number;
}

export type HomePerformanceSensorIssueCode = "low-coverage" | "flatline" | "changed-baseline";

export interface HomePerformanceSensorIssue {
  code: HomePerformanceSensorIssueCode;
  sensorId: string;
  sensorName: string;
  metric: string;
  value: number;
  unit: string;
}

export interface HomePerformanceSensorHealth {
  state: HomePerformanceEvidenceState;
  monitoredSensors: number;
  healthySensors: number;
  coveragePercent: number | null;
  issues: HomePerformanceSensorIssue[];
}

export type HomePerformanceLimitation =
  | "archive-incomplete"
  | "sensor-scope-limited"
  | "evidence-scope-limited"
  | "opening-history-missing"
  | "unclassified-energy"
  | "maintenance-evidence-missing"
  | "coverage-limited";

export interface HomePerformanceResult {
  status: HomePerformanceEvidenceState;
  generatedAt: string;
  from: string;
  to: string;
  exposure: HomePerformanceExposure;
  recovery: HomePerformanceRecovery;
  openingEffectiveness: HomePerformanceOpeningEffectiveness;
  energy: HomePerformanceEnergy;
  maintenance: HomePerformanceMaintenance;
  sensorHealth: HomePerformanceSensorHealth;
  limitations: HomePerformanceLimitation[];
  provenance: {
    truthClass: "derived";
    algorithmVersion: typeof HOME_PERFORMANCE_ALGORITHM_VERSION;
    sourceIds: string[];
    archiveStates: string[];
  };
}

export interface HomePerformanceInput {
  house: House;
  sensors: Sensor[];
  definitions: MeasurementDefinition[];
  climate: AnalyticsQueryResponse | null;
  recoveryClimate: AnalyticsQueryResponse | null;
  energy: AnalyticsQueryResponse | null;
  outdoor: OutdoorTemperatureSample[];
  openings: OpeningStateObservation[];
  actionRuns: ActionRun[];
  maintenanceTasks: MaintenanceTask[];
  observations: ManualObservation[];
  from: string;
  to: string;
  generatedAt?: string;
  sensorScopeTruncated?: boolean;
  evidenceScopeTruncated?: boolean;
}

interface ValuePoint {
  timestamp: string;
  time: number;
  value: number;
  coverage: number;
}

interface RecoveryEvidence {
  co2: ValuePoint[];
  absoluteHumidity: ValuePoint[];
}

interface ExposureAccumulator {
  evaluatedHours: number;
  withinHours: number;
  supportedSeries: Set<string>;
  sensorIds: Set<string>;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
}

function round(value: number, precision = 1): number {
  return Number(value.toFixed(precision));
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] ?? null
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function seriesFor(
  response: AnalyticsQueryResponse | null,
  sensorId: string,
  metric: string,
): AnalyticsSeries | undefined {
  return response?.series.find((series) => series.entityId === sensorId && series.measurementId === metric);
}

function values(series: AnalyticsSeries | undefined): ValuePoint[] {
  if (!series) return [];
  return series.points.flatMap((point) => {
    const time = Date.parse(point.timestamp);
    return point.value === null || !Number.isFinite(time) || !Number.isFinite(point.value)
      ? []
      : [{
          timestamp: point.timestamp,
          time,
          value: point.value,
          coverage: clamp(point.coverage),
        }];
  }).sort((left, right) => left.time - right.time);
}

function resolutionHours(series: AnalyticsSeries): number {
  const seconds: Partial<Record<AnalyticsSeries["resolution"], number>> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3_600,
    "1d": 86_400,
  };
  return (seconds[series.resolution] ?? 3_600) / 3_600;
}

function newExposureAccumulator(): ExposureAccumulator {
  return {
    evaluatedHours: 0,
    withinHours: 0,
    supportedSeries: new Set(),
    sensorIds: new Set(),
    temperatureDegreeHours: 0,
    humidityOutsideGuideHours: 0,
    co2AboveGuideHours: 0,
  };
}

function addExposure(
  accumulator: ExposureAccumulator,
  sensorId: string,
  metric: string,
  series: AnalyticsSeries,
): void {
  if (series.summary.count === 0) return;
  const hoursPerPoint = resolutionHours(series);
  accumulator.supportedSeries.add(`${sensorId}\u0000${metric}`);
  accumulator.sensorIds.add(sensorId);
  for (const point of series.points) {
    if (point.value === null || !Number.isFinite(point.value)) continue;
    const hours = hoursPerPoint * clamp(point.coverage);
    if (hours <= 0) continue;
    accumulator.evaluatedHours += hours;
    if (metric === "temperature") {
      const distance = point.value < COMFORT_TEMPERATURE_LOW_C
        ? COMFORT_TEMPERATURE_LOW_C - point.value
        : point.value > COMFORT_TEMPERATURE_HIGH_C
          ? point.value - COMFORT_TEMPERATURE_HIGH_C
          : 0;
      accumulator.temperatureDegreeHours += distance * hours;
      if (distance === 0) accumulator.withinHours += hours;
    } else if (metric === "humidity") {
      const outside = point.value < COMFORT_HUMIDITY_LOW_PCT || point.value > COMFORT_HUMIDITY_HIGH_PCT;
      if (outside) accumulator.humidityOutsideGuideHours += hours;
      else accumulator.withinHours += hours;
    } else if (metric === "co2") {
      const outside = point.value > COMFORT_CO2_HIGH_PPM;
      if (outside) accumulator.co2AboveGuideHours += hours;
      else accumulator.withinHours += hours;
    }
  }
}

function roomKey(sensor: Sensor): string {
  return `${sensor.floorId}\u0000${sensor.roomId ?? (sensor.room.trim() || sensor.name)}`;
}

function exposureResult(input: HomePerformanceInput): HomePerformanceExposure {
  const home = newExposureAccumulator();
  const rooms = new Map<string, { label: string; accumulator: ExposureAccumulator }>();
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const key = roomKey(sensor);
    const room = rooms.get(key) ?? {
      label: sensor.room.trim() || sensor.name,
      accumulator: newExposureAccumulator(),
    };
    rooms.set(key, room);
    for (const metric of ["temperature", "humidity", "co2"]) {
      const series = seriesFor(input.climate, sensor.id, metric);
      if (!series) continue;
      addExposure(home, sensor.id, metric, series);
      addExposure(room.accumulator, sensor.id, metric, series);
    }
  }
  const formattedRooms = [...rooms.entries()].flatMap(([id, room]) => {
    const accumulator = room.accumulator;
    if (accumulator.evaluatedHours <= 0) return [];
    return [{
      id,
      label: room.label,
      sensorIds: [...accumulator.sensorIds].sort(compareStable),
      guideRangePercent: round(accumulator.withinHours / accumulator.evaluatedHours * 100, 0),
      observedHours: round(accumulator.evaluatedHours / Math.max(1, accumulator.supportedSeries.size), 1),
      temperatureDegreeHours: round(accumulator.temperatureDegreeHours, 1),
      humidityOutsideGuideHours: round(accumulator.humidityOutsideGuideHours, 1),
      co2AboveGuideHours: round(accumulator.co2AboveGuideHours, 1),
    }];
  }).sort((left, right) => left.guideRangePercent - right.guideRangePercent || compareStable(left.label, right.label));
  const observedHours = home.evaluatedHours / Math.max(1, home.supportedSeries.size);
  return {
    state: observedHours >= 24 ? "ready" : observedHours > 0 ? "limited" : "unavailable",
    guideRangePercent: home.evaluatedHours > 0 ? round(home.withinHours / home.evaluatedHours * 100, 0) : null,
    observedHours: round(observedHours, 1),
    temperatureDegreeHours: round(home.temperatureDegreeHours, 1),
    humidityOutsideGuideHours: round(home.humidityOutsideGuideHours, 1),
    co2AboveGuideHours: round(home.co2AboveGuideHours, 1),
    worstRoom: formattedRooms[0] ?? null,
    rooms: formattedRooms,
  };
}

/** Magnus-based absolute humidity in g/m3, used only when temperature and RH share a bucket. */
function absoluteHumidity(temperatureC: number, relativeHumidityPct: number): number | null {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(relativeHumidityPct)
    || relativeHumidityPct < 0 || relativeHumidityPct > 100) return null;
  const saturationHpa = 6.112 * Math.exp(17.62 * temperatureC / (243.12 + temperatureC));
  const vaporHpa = saturationHpa * relativeHumidityPct / 100;
  const result = 216.7 * vaporHpa / (temperatureC + 273.15);
  return Number.isFinite(result) ? result : null;
}

function absoluteHumiditySeries(response: AnalyticsQueryResponse | null, sensorId: string): ValuePoint[] {
  const temperatures = new Map(values(seriesFor(response, sensorId, "temperature"))
    .map((point) => [point.timestamp, point]));
  return values(seriesFor(response, sensorId, "humidity")).flatMap((humidity) => {
    const temperature = temperatures.get(humidity.timestamp);
    if (!temperature) return [];
    const value = absoluteHumidity(temperature.value, humidity.value);
    return value === null ? [] : [{
      timestamp: humidity.timestamp,
      time: humidity.time,
      value,
      coverage: Math.min(temperature.coverage, humidity.coverage),
    }];
  });
}

function recoveryEvidenceBySensor(input: HomePerformanceInput): Map<string, RecoveryEvidence> {
  const result = new Map<string, RecoveryEvidence>();
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const evidence = {
      co2: values(seriesFor(input.recoveryClimate, sensor.id, "co2")),
      absoluteHumidity: absoluteHumiditySeries(input.recoveryClimate, sensor.id),
    };
    if (evidence.co2.length > 0 || evidence.absoluteHumidity.length > 0) {
      result.set(sensor.id, evidence);
    }
  }
  return result;
}

function contiguousRecoveryEvidence(points: readonly ValuePoint[]): boolean {
  return points.length > 0 && points.every((point, index) => (
    point.coverage >= RECOVERY_MIN_BUCKET_COVERAGE
    && (index === 0 || (
      point.time > points[index - 1]!.time
      && point.time - points[index - 1]!.time <= RECOVERY_MAX_POINT_GAP_MS
    ))
  ));
}

function moistureRecoveryResult(
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

function latestAtOrBefore(points: readonly ValuePoint[], timestamp: number, toleranceMs: number): ValuePoint | null {
  return [...points].reverse().find((point) => point.time <= timestamp && point.time >= timestamp - toleranceMs) ?? null;
}

function openingDescriptor(
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

function nearestSensorForOpening(
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

function openingTransitions(openings: readonly OpeningStateObservation[], from: string, to: string): OpeningStateObservation[] {
  const state = new Map<string, OpeningStateObservation>();
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const result: OpeningStateObservation[] = [];
  for (const observation of [...openings].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || compareStable(left.id, right.id)
  ))) {
    const key = [
      observation.floorId,
      observation.elementId,
      observation.source,
      observation.externalId ?? "",
      observation.connectionId ?? "",
    ].join("\u0000");
    const timestamp = Date.parse(observation.observedAt);
    const previousObservation = state.get(key);
    const previousValidUntil = previousObservation?.validUntil
      ? Date.parse(previousObservation.validUntil)
      : Number.POSITIVE_INFINITY;
    const previous = previousObservation && previousValidUntil > timestamp
      ? previousObservation.state
      : undefined;
    if (observation.state === "unknown") state.delete(key);
    else state.set(key, observation);
    if (observation.state === "open" && previous === "closed" && timestamp >= fromMs && timestamp <= toMs) {
      result.push(observation);
    }
  }
  return result;
}

function openingEffectivenessResult(
  input: HomePerformanceInput,
  evidenceBySensor: ReadonlyMap<string, RecoveryEvidence>,
): HomePerformanceOpeningEffectiveness {
  const transitions = openingTransitions(input.openings, input.from, input.to);
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

function hourKey(timestamp: string | number): number {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

function outdoorHours(samples: readonly OutdoorTemperatureSample[]): Map<number, number> {
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

function heatingTagged(sensor: Sensor): boolean {
  return [...sensor.tags, sensor.name, sensor.model].some((value) => (
    /(?:^|[\s_-])(?:heat(?:er|ing|pump)?|hvac|boiler|radiator)(?:$|[\s_-])/iu.test(value)
  ));
}

function sensorEnergyByHour(
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
            power.set(key, (power.get(key) ?? 0) + point.value * hours / 1_000);
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

function combinedEnergyByHour(sensorHours: readonly ReadonlyMap<number, number>[]): Map<number, number> {
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

function energyResult(input: HomePerformanceInput): HomePerformanceEnergy {
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

function maintenanceResult(input: HomePerformanceInput): HomePerformanceMaintenance {
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

function definitionFor(definitions: readonly MeasurementDefinition[], metric: string): MeasurementDefinition | undefined {
  return definitions.find((definition) => definition.id === metric);
}

function timestampInRange(timestamp: string, from: string, to: string): boolean {
  const time = Date.parse(timestamp);
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  return Number.isFinite(time) && Number.isFinite(fromTime) && Number.isFinite(toTime)
    && time >= fromTime && time <= toTime;
}

function sampleMedian(points: readonly AnalyticsPoint[], predicate: (time: number) => boolean): number | null {
  return median(points.flatMap((point) => {
    const time = Date.parse(point.timestamp);
    return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || !predicate(time)
      ? []
      : [point.value];
  }));
}

function sensorHealthResult(input: HomePerformanceInput): HomePerformanceSensorHealth {
  const midpoint = (Date.parse(input.from) + Date.parse(input.to)) / 2;
  const enabledSensorIds = new Set(input.sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id));
  const responses = [input.climate, input.energy].filter((value): value is AnalyticsQueryResponse => value !== null);
  const series = responses.flatMap((response) => response.series)
    .filter((item) => item.summary.count > 0 && enabledSensorIds.has(item.entityId));
  const supportedBySensor = new Map<string, AnalyticsSeries[]>();
  for (const item of series) {
    const existing = supportedBySensor.get(item.entityId) ?? [];
    existing.push(item);
    supportedBySensor.set(item.entityId, existing);
  }
  const issues: HomePerformanceSensorIssue[] = [];
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const supported = supportedBySensor.get(sensor.id) ?? [];
    if (supported.length === 0) continue;
    const lowestCoverage = [...supported]
      .sort((left, right) => left.summary.coverage - right.summary.coverage
        || compareStable(left.measurementId, right.measurementId))[0];
    if (lowestCoverage && lowestCoverage.summary.coverage < 0.75) {
      issues.push({
        code: "low-coverage",
        sensorId: sensor.id,
        sensorName: sensor.name,
        metric: lowestCoverage.measurementId,
        value: round(lowestCoverage.summary.coverage * 100, 0),
        unit: "%",
      });
    }
    for (const item of supported.filter((candidate) => ["temperature", "humidity", "co2", "power"].includes(candidate.measurementId))) {
      const pointValues = item.points.flatMap((point) => (
        point.value === null || !Number.isFinite(point.value) ? [] : [point.value]
      ));
      const definition = definitionFor(input.definitions, item.measurementId);
      const flatlineThreshold = Math.max(0.01, (definition?.interpolationDelta ?? 1) * 0.2);
      if (item.summary.coverage >= 0.75 && pointValues.length >= 24
        && Math.max(...pointValues) - Math.min(...pointValues) <= flatlineThreshold) {
        issues.push({
          code: "flatline",
          sensorId: sensor.id,
          sensorName: sensor.name,
          metric: item.measurementId,
          value: round(Math.max(...pointValues) - Math.min(...pointValues), definition?.precision ?? 1),
          unit: definition?.unit ?? "",
        });
      }
      if (item.summary.coverage < 0.75 || !["temperature", "humidity", "co2"].includes(item.measurementId)) continue;
      const peers = series.filter((candidate) => (
        candidate.measurementId === item.measurementId
        && candidate.entityId !== sensor.id
        && candidate.summary.coverage >= 0.75
      ));
      if (peers.length === 0) continue;
      const ownFirst = sampleMedian(item.points, (time) => time < midpoint);
      const ownSecond = sampleMedian(item.points, (time) => time >= midpoint);
      const peerFirst = median(peers.flatMap((peer) => peer.points.flatMap((point) => {
        const time = Date.parse(point.timestamp);
        return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || time >= midpoint
          ? []
          : [point.value];
      })));
      const peerSecond = median(peers.flatMap((peer) => peer.points.flatMap((point) => {
        const time = Date.parse(point.timestamp);
        return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || time < midpoint
          ? []
          : [point.value];
      })));
      if (ownFirst === null || ownSecond === null || peerFirst === null || peerSecond === null) continue;
      const changedOffset = (ownSecond - peerSecond) - (ownFirst - peerFirst);
      const threshold = item.measurementId === "temperature" ? 1 : item.measurementId === "humidity" ? 5 : 150;
      if (Math.abs(changedOffset) >= threshold) {
        issues.push({
          code: "changed-baseline",
          sensorId: sensor.id,
          sensorName: sensor.name,
          metric: item.measurementId,
          value: round(changedOffset, definition?.precision ?? 1),
          unit: definition?.unit ?? "",
        });
      }
    }
  }
  const monitoredSensors = supportedBySensor.size;
  const sensorsWithIssues = new Set(issues.map((issue) => issue.sensorId));
  const coverage = series.length === 0
    ? null
    : series.reduce((sum, item) => sum + item.summary.coverage, 0) / series.length;
  return {
    state: monitoredSensors === 0
      ? "unavailable"
      : (coverage ?? 0) >= 0.75 && issues.length === 0
        ? "ready"
        : "limited",
    monitoredSensors,
    healthySensors: Math.max(0, monitoredSensors - sensorsWithIssues.size),
    coveragePercent: coverage === null ? null : round(coverage * 100, 0),
    issues: issues.sort((left, right) => (
      compareStable(left.sensorName, right.sensorName) || compareStable(left.metric, right.metric)
    )),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function deriveHomePerformance(input: HomePerformanceInput): HomePerformanceResult {
  const recoveryEvidence = recoveryEvidenceBySensor(input);
  const exposure = exposureResult(input);
  const recovery = moistureRecoveryResult(input, recoveryEvidence);
  const openingEffectiveness = openingEffectivenessResult(input, recoveryEvidence);
  const energy = energyResult(input);
  const maintenance = maintenanceResult(input);
  const sensorHealth = sensorHealthResult(input);
  const sections = [exposure, recovery, openingEffectiveness, energy, maintenance, sensorHealth];
  const available = sections.filter((section) => section.state !== "unavailable").length;
  const ready = sections.filter((section) => section.state === "ready").length;
  const archiveStates = unique([
    input.climate?.quality.seriesCount ? input.climate.provenance.map((item) => item.archiveState) : [],
    input.recoveryClimate?.quality.seriesCount ? input.recoveryClimate.provenance.map((item) => item.archiveState) : [],
    input.energy?.quality.seriesCount ? input.energy.provenance.map((item) => item.archiveState) : [],
  ].flat()).sort(compareStable);
  const limitations = unique<HomePerformanceLimitation>([
    ...(archiveStates.some((state) => state === "failed" || state === "not-ready") ? ["archive-incomplete" as const] : []),
    ...(input.sensorScopeTruncated ? ["sensor-scope-limited" as const] : []),
    ...(input.evidenceScopeTruncated ? ["evidence-scope-limited" as const] : []),
    ...(openingEffectiveness.state === "unavailable" ? ["opening-history-missing" as const] : []),
    ...(energy.source === "unclassified-electricity" ? ["unclassified-energy" as const] : []),
    ...(maintenance.state !== "ready" ? ["maintenance-evidence-missing" as const] : []),
    ...(sensorHealth.issues.some((issue) => issue.code === "low-coverage")
      || (sensorHealth.coveragePercent !== null && sensorHealth.coveragePercent < 75)
      ? ["coverage-limited" as const]
      : []),
  ]);
  const enabledSensorIds = new Set(input.sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id));
  const sourceIds = unique([
    ...(input.climate?.series ?? []),
    ...(input.recoveryClimate?.series ?? []),
    ...(input.energy?.series ?? []),
  ].filter((series) => series.summary.count > 0 && enabledSensorIds.has(series.entityId))
    .map((series) => series.entityId)).sort(compareStable);
  return {
    status: available === 0
      ? "unavailable"
      : ready === sections.length && limitations.length === 0
        ? "ready"
        : "limited",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    from: input.from,
    to: input.to,
    exposure,
    recovery,
    openingEffectiveness,
    energy,
    maintenance,
    sensorHealth,
    limitations,
    provenance: {
      truthClass: "derived",
      algorithmVersion: HOME_PERFORMANCE_ALGORITHM_VERSION,
      sourceIds,
      archiveStates,
    },
  };
}
