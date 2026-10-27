import type { MeasurementSample, OutdoorTemperatureSample, ThermalCalibrationStatus } from "@climate-twin/contracts";
import { saturationVaporPressureOverWaterHpa } from "@climate-twin/spatial-layers";
import { mean, median, range, round } from "./thermal-math.js";
import { isTransitionWithinPassiveIntervals, type PassiveInterval } from "./analytics/heat-pump-evidence.js";
import {
  calibrateRelaxationSteps,
  dailyCycleFromHarmonics,
  meanAbsolute,
  runSteps,
  usableStretches,
  type RelaxationTransition,
} from "./analytics/relaxation-fit.js";

const HOUR_MS = 3_600_000;
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 2;
const MAX_OUTDOOR_GAP_MS = 2 * HOUR_MS;
const MIN_TRANSITIONS = 48;
const MIN_DURATION_HOURS = 24;
const MIN_STRETCH_HOURS = 2;
const DURATION_EDGE_TOLERANCE_HOURS = 0.25;
const MIN_RESPONSE_HOURS = 0.5;
const MAX_RESPONSE_HOURS = 1_000;

interface IndoorMoisturePoint {
  timestamp: string;
  time: number;
  vaporPressureHpa: number;
  weight: number;
}

interface OutdoorMoisturePoint {
  timestamp: string;
  time: number;
  vaporPressureHpa: number;
}

interface AlignedMoisturePoint extends IndoorMoisturePoint {
  outdoorVaporPressureHpa: number;
}

interface MoistureParameters {
  responseTimeHours: number;
  outdoorCoupling: number;
  equilibriumOffsetHpa: number;
  /** Daily (24 h) swing of the moisture equilibrium, when the data shows one. */
  dailyCycle?: { amplitudeHpa: number; peakHourUtc: number };
}

export interface PreparedOutdoorMoistureBoundary {
  points: OutdoorMoisturePoint[];
  interpolationCache: Map<number, number | null>;
}

export interface MoistureCalibrationQuality {
  indoorSamples: number;
  outdoorSamples: number;
  alignedSamples: number;
  transitionsUsed: number;
  stretchesUsed: number;
  durationHours: number;
  indoorRangeHpa: number;
  outdoorRangeHpa: number;
  validationMaeHpa: number | null;
  persistenceMaeHpa: number | null;
  validationBiasHpa: number | null;
  modelSkillPct: number | null;
  medianIndoorVaporPressureHpa: number | null;
  medianOutdoorVaporPressureHpa: number | null;
  medianMoistureExcessHpa: number | null;
  /** 90% block-bootstrap interval of the response time. */
  responseTimeLowHours: number | null;
  responseTimeHighHours: number | null;
}

export interface MoistureCalibration {
  status: ThermalCalibrationStatus;
  parameters: MoistureParameters | null;
  quality: MoistureCalibrationQuality;
  warnings: string[];
}

function usableSample(sample: MeasurementSample): boolean {
  return sample.quality !== "stale"
    && sample.source !== "replay"
    && Number.isFinite(sample.value)
    && Number.isFinite(Date.parse(sample.timestamp));
}

function vaporPressureFromRelativeHumidity(temperatureC: number, relativeHumidityPct: number): number | null {
  if (!Number.isFinite(temperatureC) || temperatureC < -80 || temperatureC > 80
    || !Number.isFinite(relativeHumidityPct) || relativeHumidityPct < 0 || relativeHumidityPct > 100) {
    return null;
  }
  return relativeHumidityPct / 100 * saturationVaporPressureOverWaterHpa(temperatureC);
}

function indoorPoints(samples: MeasurementSample[]): IndoorMoisturePoint[] {
  const temperature = new Map<number, { value: number; weight: number }>();
  const humidity = new Map<number, { value: number; weight: number }>();
  for (const sample of samples) {
    if (!usableSample(sample) || (sample.metric !== "temperature" && sample.metric !== "humidity")) continue;
    const target = sample.metric === "temperature" ? temperature : humidity;
    const time = Date.parse(sample.timestamp);
    const candidate = { value: sample.value, weight: sample.quality === "estimated" ? 0.25 : 1 };
    const current = target.get(time);
    if (!current || candidate.weight >= current.weight) target.set(time, candidate);
  }
  return [...temperature.entries()].flatMap(([time, temperaturePoint]) => {
    const humidityPoint = humidity.get(time);
    if (!humidityPoint) return [];
    const vaporPressureHpa = vaporPressureFromRelativeHumidity(temperaturePoint.value, humidityPoint.value);
    if (vaporPressureHpa === null) return [];
    return [{
      timestamp: new Date(time).toISOString(),
      time,
      vaporPressureHpa,
      weight: Math.min(temperaturePoint.weight, humidityPoint.weight),
    }];
  }).sort((left, right) => left.time - right.time);
}

function outdoorPoints(samples: OutdoorTemperatureSample[]): OutdoorMoisturePoint[] {
  const priority: Record<OutdoorTemperatureSample["source"], number> = {
    "fmi-observation": 3,
    "open-meteo-current": 3,
    "fmi-backfill": 3,
    "open-meteo-backfill": 3,
    api: 2,
    mock: 1,
  };
  const deduplicated = new Map<number, OutdoorMoisturePoint & { priority: number }>();
  for (const sample of samples) {
    const time = Date.parse(sample.timestamp);
    const temperatureC = sample.conditions?.temperatureC ?? sample.temperatureC;
    const relativeHumidityPct = sample.conditions?.relativeHumidityPercent;
    const dewPointC = sample.conditions?.dewPointC;
    if (!Number.isFinite(time) || !Number.isFinite(temperatureC)) continue;
    const humidityVaporPressure = Number.isFinite(relativeHumidityPct)
      ? vaporPressureFromRelativeHumidity(temperatureC, relativeHumidityPct as number)
      : null;
    const dewPointVaporPressure = Number.isFinite(dewPointC)
      && (dewPointC as number) >= -80
      && (dewPointC as number) <= 80
      && (dewPointC as number) <= temperatureC + 0.5
      ? saturationVaporPressureOverWaterHpa(dewPointC as number)
      : null;
    const vaporPressureHpa = humidityVaporPressure ?? dewPointVaporPressure;
    if (vaporPressureHpa === null || !Number.isFinite(vaporPressureHpa)) continue;
    const candidate = {
      timestamp: new Date(time).toISOString(),
      time,
      vaporPressureHpa,
      priority: priority[sample.source] ?? 0,
    };
    const current = deduplicated.get(time);
    if (!current || candidate.priority > current.priority) deduplicated.set(time, candidate);
  }
  return [...deduplicated.values()].sort((left, right) => left.time - right.time);
}

export function prepareOutdoorMoistureBoundary(
  samples: OutdoorTemperatureSample[],
): PreparedOutdoorMoistureBoundary {
  return { points: outdoorPoints(samples), interpolationCache: new Map() };
}

function interpolateOutdoor(boundary: PreparedOutdoorMoistureBoundary, timestamp: number): number | null {
  if (boundary.interpolationCache.has(timestamp)) return boundary.interpolationCache.get(timestamp) ?? null;
  const { points } = boundary;
  if (!points.length || timestamp < (points[0]?.time ?? Infinity) || timestamp > (points.at(-1)?.time ?? -Infinity)) {
    boundary.interpolationCache.set(timestamp, null);
    return null;
  }
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const time = points[middle]?.time ?? 0;
    if (time === timestamp) {
      const exact = points[middle]?.vaporPressureHpa ?? null;
      boundary.interpolationCache.set(timestamp, exact);
      return exact;
    }
    if (time < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  const before = points[high];
  const after = points[low];
  if (!before || !after || after.time - before.time > MAX_OUTDOOR_GAP_MS) {
    boundary.interpolationCache.set(timestamp, null);
    return null;
  }
  const fraction = (timestamp - before.time) / Math.max(1, after.time - before.time);
  const interpolated = before.vaporPressureHpa
    + (after.vaporPressureHpa - before.vaporPressureHpa) * fraction;
  boundary.interpolationCache.set(timestamp, interpolated);
  return interpolated;
}

function align(
  indoor: IndoorMoisturePoint[],
  outdoor: PreparedOutdoorMoistureBoundary,
): AlignedMoisturePoint[] {
  return indoor.flatMap((point) => {
    const outdoorVaporPressureHpa = interpolateOutdoor(outdoor, point.time);
    return outdoorVaporPressureHpa === null ? [] : [{ ...point, outdoorVaporPressureHpa }];
  });
}

/** Passive steps as relaxation transitions with a fitted outdoor coupling and offset. */
function transitionsFrom(points: AlignedMoisturePoint[], passiveIntervals?: readonly PassiveInterval[]): RelaxationTransition[] {
  const transitions: RelaxationTransition[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const dtHours = (current.time - previous.time) / HOUR_MS;
    if (dtHours < MIN_INTERVAL_HOURS || dtHours > MAX_INTERVAL_HOURS) continue;
    if (!isTransitionWithinPassiveIntervals(passiveIntervals, previous.time, current.time)) continue;
    transitions.push({
      fromTime: previous.time,
      toTime: current.time,
      value: previous.vaporPressureHpa,
      nextValue: current.vaporPressureHpa,
      knownDrive: 0,
      regressors: [previous.outdoorVaporPressureHpa, 1],
      dtHours,
      weight: Math.min(1, dtHours / 0.5) * Math.min(previous.weight, current.weight),
    });
  }
  return transitions;
}

function initialQuality(
  indoor: IndoorMoisturePoint[],
  outdoor: OutdoorMoisturePoint[],
  aligned: AlignedMoisturePoint[],
  transitions: RelaxationTransition[],
  stretches: number,
): MoistureCalibrationQuality {
  const indoorValues = aligned.map((point) => point.vaporPressureHpa);
  const outdoorValues = aligned.map((point) => point.outdoorVaporPressureHpa);
  const excess = aligned.map((point) => point.vaporPressureHpa - point.outdoorVaporPressureHpa);
  return {
    indoorSamples: indoor.length,
    outdoorSamples: outdoor.length,
    alignedSamples: aligned.length,
    transitionsUsed: transitions.length,
    stretchesUsed: stretches,
    durationHours: round(transitions.reduce((sum, transition) => sum + transition.dtHours, 0), 2),
    indoorRangeHpa: round(range(indoorValues), 3),
    outdoorRangeHpa: round(range(outdoorValues), 3),
    validationMaeHpa: null,
    persistenceMaeHpa: null,
    validationBiasHpa: null,
    modelSkillPct: null,
    medianIndoorVaporPressureHpa: indoorValues.length ? round(median(indoorValues), 3) : null,
    medianOutdoorVaporPressureHpa: outdoorValues.length ? round(median(outdoorValues), 3) : null,
    medianMoistureExcessHpa: excess.length ? round(median(excess), 3) : null,
    responseTimeLowHours: null,
    responseTimeHighHours: null,
  };
}

export function calibrateMoistureResponse(
  indoorSamples: MeasurementSample[],
  outdoorSamples: OutdoorTemperatureSample[],
  preparedOutdoor?: PreparedOutdoorMoistureBoundary,
  passiveIntervals?: readonly PassiveInterval[],
): MoistureCalibration {
  const indoor = indoorPoints(indoorSamples);
  const outdoor = preparedOutdoor ?? prepareOutdoorMoistureBoundary(outdoorSamples);
  const allAligned = align(indoor, outdoor);
  const usable = usableStretches(transitionsFrom(allAligned, passiveIntervals), MIN_STRETCH_HOURS);
  const transitions = usable.transitions;
  const used = new Set(transitions.flatMap((transition) => [transition.fromTime, transition.toTime]));
  const aligned = used.size ? allAligned.filter((point) => used.has(point.time)) : allAligned;
  const quality = initialQuality(indoor, outdoor.points, aligned, transitions, usable.stretches);
  if (!indoor.length) {
    return { status: "insufficient-data", parameters: null, quality, warnings: ["INSUFFICIENT_PAIRED_INDOOR_DATA"] };
  }
  if (!outdoor.points.length) {
    return { status: "insufficient-data", parameters: null, quality, warnings: ["INSUFFICIENT_OUTDOOR_HUMIDITY"] };
  }
  if (transitions.length < MIN_TRANSITIONS) {
    return {
      status: "insufficient-data",
      parameters: null,
      quality,
      warnings: ["INSUFFICIENT_OVERLAP", `REQUIRES_${MIN_TRANSITIONS}_TRANSITIONS`],
    };
  }
  if (quality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < MIN_DURATION_HOURS) {
    return {
      status: "insufficient-data",
      parameters: null,
      quality,
      warnings: ["MOISTURE_WINDOW_TOO_SHORT", `REQUIRES_${MIN_DURATION_HOURS}_HOURS`],
    };
  }

  const fit = runSteps(calibrateRelaxationSteps(transitions, {
    minimumTauHours: MIN_RESPONSE_HOURS,
    maximumTauHours: MAX_RESPONSE_HOURS,
    scaleFloor: 0.02,
  }));
  if (!fit) {
    return { status: "insufficient-data", parameters: null, quality, warnings: ["MOISTURE_MODEL_NOT_IDENTIFIABLE"] };
  }
  const [outdoorCoupling = 0, equilibriumOffsetHpa = 0, sinCoefficient, cosCoefficient] = fit.parameters.coefficients;
  const mae = meanAbsolute(fit.validation.residuals);
  const persistenceMae = meanAbsolute(fit.validation.persistence);
  const bias = mean(fit.validation.residuals);
  const modelSkillPct = persistenceMae <= 0
    ? null
    : round(Math.max(-100, Math.min(100, (1 - mae / persistenceMae) * 100)), 1);
  const responseLow = fit.interval?.low ?? fit.parameters.tauHours;
  const responseHigh = fit.interval?.high ?? fit.parameters.tauHours;
  const warnings: string[] = [];
  if (outdoorSamples.some((sample) => sample.source === "mock")) warnings.push("SYNTHETIC_OUTDOOR_MOISTURE");
  if (quality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < 7 * 24) warnings.push("SHORT_MOISTURE_EVIDENCE_WINDOW");
  if (quality.outdoorRangeHpa < 0.8) warnings.push("LOW_OUTDOOR_MOISTURE_VARIATION");
  if (fit.search.atLowerLimit || fit.search.atUpperLimit) warnings.push("RESPONSE_TIME_AT_SEARCH_LIMIT");
  if (!fit.interval || responseHigh / Math.max(responseLow, MIN_RESPONSE_HOURS) > 4) {
    warnings.push("WEAK_MOISTURE_RESPONSE_IDENTIFICATION");
  }
  if (Math.abs(bias) > 0.35) warnings.push("HIGH_MOISTURE_VALIDATION_BIAS");
  if (mae >= persistenceMae) warnings.push("MOISTURE_MODEL_WORSE_THAN_PERSISTENCE");
  if (outdoorCoupling <= 0) warnings.push("NON_POSITIVE_OUTDOOR_MOISTURE_COUPLING");
  if (outdoorCoupling > 2.5) warnings.push("IMPLAUSIBLE_OUTDOOR_MOISTURE_COUPLING");
  const cycle = fit.dailyCycle && sinCoefficient !== undefined && cosCoefficient !== undefined
    ? dailyCycleFromHarmonics(sinCoefficient, cosCoefficient)
    : null;
  return {
    status: warnings.length ? "provisional" : "ready",
    parameters: {
      responseTimeHours: round(fit.parameters.tauHours, 2),
      outdoorCoupling: round(outdoorCoupling, 4),
      equilibriumOffsetHpa: round(equilibriumOffsetHpa, 4),
      ...(cycle ? { dailyCycle: { amplitudeHpa: round(cycle.amplitude, 4), peakHourUtc: round(cycle.peakHourUtc, 2) } } : {}),
    },
    quality: {
      ...quality,
      validationMaeHpa: round(mae, 3),
      persistenceMaeHpa: round(persistenceMae, 3),
      validationBiasHpa: round(bias, 3),
      modelSkillPct,
      responseTimeLowHours: round(responseLow, 2),
      responseTimeHighHours: round(responseHigh, 2),
    },
    warnings,
  };
}
