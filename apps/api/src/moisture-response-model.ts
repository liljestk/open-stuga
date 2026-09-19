import type { MeasurementSample, OutdoorTemperatureSample, ThermalCalibrationStatus } from "@climate-twin/contracts";
import { saturationVaporPressureOverWaterHpa } from "@climate-twin/spatial-layers";
import { mean, median, range, round } from "./thermal-math.js";
import { isTransitionWithinPassiveIntervals, type PassiveInterval } from "./analytics/heat-pump-evidence.js";

const HOUR_MS = 3_600_000;
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 2;
const MAX_OUTDOOR_GAP_MS = 2 * HOUR_MS;
const MIN_TRANSITIONS = 48;
const MIN_DURATION_HOURS = 24;
const DURATION_EDGE_TOLERANCE_HOURS = 0.25;
const TAU_CANDIDATES = [
  0.5,
  ...Array.from({ length: 48 }, (_, index) => index + 1),
  ...Array.from({ length: 48 }, (_, index) => 52 + index * 4),
];

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

interface MoistureTransition {
  fromTime: number;
  toTime: number;
  indoorHpa: number;
  nextIndoorHpa: number;
  outdoorHpa: number;
  dtHours: number;
  weight: number;
}

interface MoistureParameters {
  responseTimeHours: number;
  outdoorCoupling: number;
  equilibriumOffsetHpa: number;
}

interface Candidate extends MoistureParameters {
  selectionMaeHpa: number;
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

function transitionsFrom(points: AlignedMoisturePoint[], passiveIntervals?: readonly PassiveInterval[]): MoistureTransition[] {
  const transitions: MoistureTransition[] = [];
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
      indoorHpa: previous.vaporPressureHpa,
      nextIndoorHpa: current.vaporPressureHpa,
      outdoorHpa: previous.outdoorVaporPressureHpa,
      dtHours,
      weight: Math.min(1, dtHours / 0.5) * Math.min(previous.weight, current.weight),
    });
  }
  return transitions;
}

function longestSegment(transitions: MoistureTransition[]): MoistureTransition[] {
  if (!transitions.length) return [];
  let best: MoistureTransition[] = [];
  let bestHours = -1;
  let segment: MoistureTransition[] = [];
  let segmentHours = 0;
  const commit = () => {
    if (segmentHours >= bestHours) {
      best = segment;
      bestHours = segmentHours;
    }
  };
  for (const transition of transitions) {
    if (segment.length && segment.at(-1)?.toTime !== transition.fromTime) {
      commit();
      segment = [];
      segmentHours = 0;
    }
    segment.push(transition);
    segmentHours += transition.dtHours;
  }
  commit();
  return best;
}

function fitParameters(
  transitions: MoistureTransition[],
  responseTimeHours: number,
): MoistureParameters | null {
  if (!transitions.length) return null;
  const terms = transitions.map((transition) => {
    const memory = Math.exp(-transition.dtHours / responseTimeHours);
    const relaxation = 1 - memory;
    return {
      outside: relaxation * transition.outdoorHpa,
      offset: relaxation,
      y: transition.nextIndoorHpa - memory * transition.indoorHpa,
      weight: transition.weight,
    };
  });
  let robustWeights = transitions.map(() => 1);
  let outdoorCoupling = 0;
  let equilibriumOffsetHpa = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    let outsideSquared = 0;
    let cross = 0;
    let offsetSquared = 0;
    let outsideY = 0;
    let offsetY = 0;
    for (let index = 0; index < terms.length; index += 1) {
      const term = terms[index];
      if (!term) continue;
      const weight = term.weight * (robustWeights[index] ?? 1);
      outsideSquared += weight * term.outside * term.outside;
      cross += weight * term.outside * term.offset;
      offsetSquared += weight * term.offset * term.offset;
      outsideY += weight * term.outside * term.y;
      offsetY += weight * term.offset * term.y;
    }
    const determinant = outsideSquared * offsetSquared - cross * cross;
    if (Math.abs(determinant) <= 1e-12) return null;
    outdoorCoupling = (outsideY * offsetSquared - offsetY * cross) / determinant;
    equilibriumOffsetHpa = (outsideSquared * offsetY - cross * outsideY) / determinant;
    if (!Number.isFinite(outdoorCoupling) || !Number.isFinite(equilibriumOffsetHpa)) return null;
    if (iteration === 4) break;
    const residuals = terms.map((term) =>
      term.y - outdoorCoupling * term.outside - equilibriumOffsetHpa * term.offset);
    const center = median(residuals);
    const scale = Math.max(0.02, 1.4826 * median(residuals.map((residual) => Math.abs(residual - center))));
    robustWeights = residuals.map((residual) =>
      Math.min(1, 1.5 * scale / Math.max(Math.abs(residual - center), 1e-12)));
  }
  return { responseTimeHours, outdoorCoupling, equilibriumOffsetHpa };
}

function step(indoorHpa: number, outdoorHpa: number, dtHours: number, parameters: MoistureParameters): number {
  const memory = Math.exp(-dtHours / parameters.responseTimeHours);
  return memory * indoorHpa
    + (1 - memory) * (parameters.outdoorCoupling * outdoorHpa + parameters.equilibriumOffsetHpa);
}

function rollout(
  transitions: MoistureTransition[],
  parameters: MoistureParameters,
): { residuals: number[]; persistence: number[] } {
  const residuals: number[] = [];
  const persistence: number[] = [];
  let simulated: number | null = null;
  let persistent: number | null = null;
  let previousEnd: number | null = null;
  for (const transition of transitions) {
    if (previousEnd !== transition.fromTime || simulated === null || persistent === null) {
      simulated = transition.indoorHpa;
      persistent = transition.indoorHpa;
    }
    simulated = step(simulated, transition.outdoorHpa, transition.dtHours, parameters);
    residuals.push(transition.nextIndoorHpa - simulated);
    persistence.push(transition.nextIndoorHpa - persistent);
    previousEnd = transition.toTime;
  }
  return { residuals, persistence };
}

function initialQuality(
  indoor: IndoorMoisturePoint[],
  outdoor: OutdoorMoisturePoint[],
  aligned: AlignedMoisturePoint[],
  transitions: MoistureTransition[],
): MoistureCalibrationQuality {
  const indoorValues = aligned.map((point) => point.vaporPressureHpa);
  const outdoorValues = aligned.map((point) => point.outdoorVaporPressureHpa);
  const excess = aligned.map((point) => point.vaporPressureHpa - point.outdoorVaporPressureHpa);
  return {
    indoorSamples: indoor.length,
    outdoorSamples: outdoor.length,
    alignedSamples: aligned.length,
    transitionsUsed: transitions.length,
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
  const transitions = longestSegment(transitionsFrom(allAligned, passiveIntervals));
  const firstUsedTime = transitions[0]?.fromTime;
  const lastUsedTime = transitions.at(-1)?.toTime;
  const aligned = firstUsedTime === undefined || lastUsedTime === undefined
    ? allAligned
    : allAligned.filter((point) => point.time >= firstUsedTime && point.time <= lastUsedTime);
  const quality = initialQuality(indoor, outdoor.points, aligned, transitions);
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

  const trainingEnd = Math.max(1, Math.min(transitions.length - 2, Math.floor(transitions.length * 0.6)));
  const tuningEnd = Math.max(trainingEnd + 1, Math.min(transitions.length - 1, Math.floor(transitions.length * 0.8)));
  const training = transitions.slice(0, trainingEnd);
  const tuning = transitions.slice(trainingEnd, tuningEnd);
  const prevalidation = transitions.slice(0, tuningEnd);
  const validation = transitions.slice(tuningEnd);
  const candidates: Candidate[] = [];
  for (const responseTimeHours of TAU_CANDIDATES) {
    const parameters = fitParameters(training, responseTimeHours);
    if (!parameters) continue;
    const residuals = rollout(tuning, parameters).residuals;
    if (residuals.length) candidates.push({
      ...parameters,
      selectionMaeHpa: mean(residuals.map(Math.abs)),
    });
  }
  candidates.sort((left, right) =>
    left.selectionMaeHpa - right.selectionMaeHpa || left.responseTimeHours - right.responseTimeHours);
  const selected = candidates[0];
  if (!selected) {
    return { status: "insufficient-data", parameters: null, quality, warnings: ["MOISTURE_MODEL_NOT_IDENTIFIABLE"] };
  }
  const validationParameters = fitParameters(prevalidation, selected.responseTimeHours);
  const finalParameters = fitParameters(transitions, selected.responseTimeHours);
  if (!validationParameters || !finalParameters) {
    return { status: "insufficient-data", parameters: null, quality, warnings: ["MOISTURE_MODEL_NOT_IDENTIFIABLE"] };
  }
  const validationRollout = rollout(validation, validationParameters);
  const mae = mean(validationRollout.residuals.map(Math.abs));
  const persistenceMae = mean(validationRollout.persistence.map(Math.abs));
  const bias = mean(validationRollout.residuals);
  const modelSkillPct = persistenceMae <= 0
    ? null
    : round(Math.max(-100, Math.min(100, (1 - mae / persistenceMae) * 100)), 1);
  const tolerance = selected.selectionMaeHpa + Math.max(0.02, selected.selectionMaeHpa * 0.1);
  const profile = candidates.filter((candidate) => candidate.selectionMaeHpa <= tolerance);
  const responseLow = Math.min(...profile.map((candidate) => candidate.responseTimeHours));
  const responseHigh = Math.max(...profile.map((candidate) => candidate.responseTimeHours));
  const warnings: string[] = [];
  if (outdoorSamples.some((sample) => sample.source === "mock")) warnings.push("SYNTHETIC_OUTDOOR_MOISTURE");
  if (quality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < 7 * 24) warnings.push("SHORT_MOISTURE_EVIDENCE_WINDOW");
  if (quality.outdoorRangeHpa < 0.8) warnings.push("LOW_OUTDOOR_MOISTURE_VARIATION");
  if (responseLow === 0.5 || responseHigh === 240 || responseHigh / Math.max(responseLow, 0.5) > 4) {
    warnings.push("WEAK_MOISTURE_RESPONSE_IDENTIFICATION");
  }
  if (Math.abs(bias) > 0.35) warnings.push("HIGH_MOISTURE_VALIDATION_BIAS");
  if (mae >= persistenceMae) warnings.push("MOISTURE_MODEL_WORSE_THAN_PERSISTENCE");
  if (finalParameters.outdoorCoupling <= 0) warnings.push("NON_POSITIVE_OUTDOOR_MOISTURE_COUPLING");
  if (finalParameters.outdoorCoupling > 2.5) warnings.push("IMPLAUSIBLE_OUTDOOR_MOISTURE_COUPLING");
  return {
    status: warnings.length ? "provisional" : "ready",
    parameters: {
      responseTimeHours: round(finalParameters.responseTimeHours, 2),
      outdoorCoupling: round(finalParameters.outdoorCoupling, 4),
      equilibriumOffsetHpa: round(finalParameters.equilibriumOffsetHpa, 4),
    },
    quality: {
      ...quality,
      validationMaeHpa: round(mae, 3),
      persistenceMaeHpa: round(persistenceMae, 3),
      validationBiasHpa: round(bias, 3),
      modelSkillPct,
    },
    warnings,
  };
}
