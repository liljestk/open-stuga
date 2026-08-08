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
import { HOME_PERFORMANCE_ALGORITHM_VERSION } from "@climate-twin/contracts";

export { HOME_PERFORMANCE_ALGORITHM_VERSION };

export const HOUR_MS = 3_600_000;

export const COMFORT_TEMPERATURE_LOW_C = 18;

export const COMFORT_TEMPERATURE_HIGH_C = 25;

export const COMFORT_HUMIDITY_LOW_PCT = 30;

export const COMFORT_HUMIDITY_HIGH_PCT = 60;

export const COMFORT_CO2_HIGH_PPM = 1_000;

export const RECOVERY_MAX_POINT_GAP_MS = 15 * 60_000;

export const RECOVERY_MIN_BUCKET_COVERAGE = 0.5;

export const ENERGY_MIN_BUCKET_COVERAGE = 0.75;

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

export interface ValuePoint {
  timestamp: string;
  time: number;
  value: number;
  coverage: number;
}

export interface RecoveryEvidence {
  co2: ValuePoint[];
  absoluteHumidity: ValuePoint[];
}

export interface ExposureAccumulator {
  evaluatedHours: number;
  withinHours: number;
  supportedSeries: Set<string>;
  sensorIds: Set<string>;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
}

export function round(value: number, precision = 1): number {
  return Number(value.toFixed(precision));
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] ?? null
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function seriesFor(
  response: AnalyticsQueryResponse | null,
  sensorId: string,
  metric: string,
): AnalyticsSeries | undefined {
  return response?.series.find((series) => series.entityId === sensorId && series.measurementId === metric);
}

export function values(series: AnalyticsSeries | undefined): ValuePoint[] {
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

export function resolutionHours(series: AnalyticsSeries): number {
  const seconds: Partial<Record<AnalyticsSeries["resolution"], number>> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3_600,
    "1d": 86_400,
  };
  return (seconds[series.resolution] ?? 3_600) / 3_600;
}

export function newExposureAccumulator(): ExposureAccumulator {
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

export function addExposure(
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

export function roomKey(sensor: Sensor): string {
  return `${sensor.floorId}\u0000${sensor.roomId ?? (sensor.room.trim() || sensor.name)}`;
}

export function exposureResult(input: HomePerformanceInput): HomePerformanceExposure {
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
export function absoluteHumidity(temperatureC: number, relativeHumidityPct: number): number | null {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(relativeHumidityPct)
    || relativeHumidityPct < 0 || relativeHumidityPct > 100) return null;
  const saturationHpa = 6.112 * Math.exp(17.62 * temperatureC / (243.12 + temperatureC));
  const vaporHpa = saturationHpa * relativeHumidityPct / 100;
  const result = 216.7 * vaporHpa / (temperatureC + 273.15);
  return Number.isFinite(result) ? result : null;
}

export function absoluteHumiditySeries(response: AnalyticsQueryResponse | null, sensorId: string): ValuePoint[] {
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

export function recoveryEvidenceBySensor(input: HomePerformanceInput): Map<string, RecoveryEvidence> {
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

export function contiguousRecoveryEvidence(points: readonly ValuePoint[]): boolean {
  return points.length > 0 && points.every((point, index) => (
    point.coverage >= RECOVERY_MIN_BUCKET_COVERAGE
    && (index === 0 || (
      point.time > points[index - 1]!.time
      && point.time - points[index - 1]!.time <= RECOVERY_MAX_POINT_GAP_MS
    ))
  ));
}
