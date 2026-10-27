import type { ActionRun, AnalyticsQueryResponse, AnalyticsSeries, HomePerformanceEnergy, HomePerformanceEvidenceState, HomePerformanceExposure, HomePerformanceLimitation, HomePerformanceMaintenance, HomePerformanceOpeningEffectiveness, HomePerformanceRecovery, HomePerformanceSensorHealth, House, MaintenanceTask, ManualObservation, MeasurementDefinition, OpeningStateObservation, OutdoorTemperatureSample, Sensor, StaticParameter } from "@climate-twin/contracts";
import { HOME_PERFORMANCE_ALGORITHM_VERSION } from "@climate-twin/contracts";
import { DEFAULT_COMFORT_BAND, roomComfortBands, type ComfortBand } from "../house-parameters.js";
import {
  isTimeWithinPassiveIntervals,
  type PassiveInterval,
} from "../heat-pump-evidence.js";
import { compareCodeUnits } from "../../text-order.js";

export { HOME_PERFORMANCE_ALGORITHM_VERSION };

export const HOUR_MS = 3_600_000;

export const COMFORT_TEMPERATURE_LOW_C = DEFAULT_COMFORT_BAND.lowC;

export const COMFORT_TEMPERATURE_HIGH_C = DEFAULT_COMFORT_BAND.highC;

export const COMFORT_HUMIDITY_LOW_PCT = 30;

export const COMFORT_HUMIDITY_HIGH_PCT = 60;

export const COMFORT_CO2_HIGH_PPM = 1_000;

export const RECOVERY_MAX_POINT_GAP_MS = 15 * 60_000;

export const RECOVERY_MIN_BUCKET_COVERAGE = 0.5;

export const ENERGY_MIN_BUCKET_COVERAGE = 0.75;

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
  hvacPassiveIntervals?: readonly PassiveInterval[];
  /** House and room static parameters: heating base, comfort bands, excluded rooms. */
  parameters?: readonly StaticParameter[];
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

export { median } from "@climate-twin/analytics-kernel";

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
  { sensorId, metric, series, band = DEFAULT_COMFORT_BAND }: {
    sensorId: string;
    metric: string;
    series: AnalyticsSeries;
    band?: ComfortBand;
  },
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
      const distance = point.value < band.lowC
        ? band.lowC - point.value
        : point.value > band.highC
          ? point.value - band.highC
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

/** The room's comfort band; null means the room is excluded from comfort scoring. */
function sensorComfortBand(bands: ReadonlyMap<string, ComfortBand | null>, roomId: string | null | undefined): ComfortBand | null {
  const stored = roomId ? bands.get(roomId) : undefined;
  return stored === undefined ? DEFAULT_COMFORT_BAND : stored;
}

export function exposureResult(input: HomePerformanceInput): HomePerformanceExposure {
  const home = newExposureAccumulator();
  const rooms = new Map<string, { label: string; band: ComfortBand; accumulator: ExposureAccumulator }>();
  const bands = input.house ? roomComfortBands(input.house, input.parameters ?? []) : new Map<string, ComfortBand | null>();
  const excluded = new Set<string>();
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const label = sensor.room.trim() || sensor.name;
    const band = sensorComfortBand(bands, sensor.roomId);
    if (band === null) {
      excluded.add(label);
      continue;
    }
    const key = roomKey(sensor);
    const room = rooms.get(key) ?? { label, band, accumulator: newExposureAccumulator() };
    rooms.set(key, room);
    for (const metric of ["temperature", "humidity", "co2"]) {
      const series = seriesFor(input.climate, sensor.id, metric);
      if (!series) continue;
      addExposure(home, { sensorId: sensor.id, metric, series, band });
      addExposure(room.accumulator, { sensorId: sensor.id, metric, series, band });
    }
  }
  const formattedRooms = [...rooms.entries()].flatMap(([id, room]) => {
    const accumulator = room.accumulator;
    if (accumulator.evaluatedHours <= 0) return [];
    return [{
      id,
      label: room.label,
      sensorIds: [...accumulator.sensorIds].sort(compareCodeUnits),
      guideRangePercent: round(accumulator.withinHours / accumulator.evaluatedHours * 100, 0),
      observedHours: round(accumulator.evaluatedHours / Math.max(1, accumulator.supportedSeries.size), 1),
      temperatureDegreeHours: round(accumulator.temperatureDegreeHours, 1),
      humidityOutsideGuideHours: round(accumulator.humidityOutsideGuideHours, 1),
      co2AboveGuideHours: round(accumulator.co2AboveGuideHours, 1),
      comfortTemperatureLowC: room.band.lowC,
      comfortTemperatureHighC: room.band.highC,
    }];
  }).sort((left, right) => left.guideRangePercent - right.guideRangePercent || compareCodeUnits(left.label, right.label));
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
    ...(excluded.size > 0 ? { excludedRooms: [...excluded].sort(compareCodeUnits) } : {}),
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
  const passive = (point: ValuePoint) => isTimeWithinPassiveIntervals(
    input.hvacPassiveIntervals,
    point.time,
  );
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const evidence = {
      co2: values(seriesFor(input.recoveryClimate, sensor.id, "co2")).filter(passive),
      absoluteHumidity: absoluteHumiditySeries(input.recoveryClimate, sensor.id).filter(passive),
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
