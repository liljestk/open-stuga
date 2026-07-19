import type {
  MeasurementSample,
  OutdoorTemperatureSample,
  ThermalCalibrationQuality,
  ThermalCalibrationResult,
  ThermalModelV1,
  ThermalSimulationPoint,
  ThermalSimulationResult,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "./version.js";

const HOUR_MS = 3_600_000;
const CALIBRATION_INTERVAL_MS = 5 * 60_000;
const MIN_TRANSITIONS = 48;
const MIN_DURATION_HOURS = 24;
const DURATION_EDGE_TOLERANCE_HOURS = 0.25;
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 2;
const MAX_OUTDOOR_GAP_MS = 2 * HOUR_MS;
const MAX_HORIZON_HOURS = 72;
const MODEL_MAX_HORIZON_HOURS = 48;
const MAX_SCENARIO_ANCHOR_AGE_HOURS = 2;

interface IndoorPoint {
  timestamp: string;
  time: number;
  temperatureC: number;
  weight: number;
}

interface OutdoorPoint {
  timestamp: string;
  time: number;
  temperatureC: number;
}

interface AlignedPoint extends IndoorPoint {
  outdoorTemperatureC: number;
}

interface Transition {
  fromTime: number;
  toTime: number;
  indoorC: number;
  nextIndoorC: number;
  outdoorC: number;
  dtHours: number;
  weight: number;
}

interface Candidate {
  tauHours: number;
  selectionMaeC: number;
}

export interface ThermalSimulationInput {
  houseId: string;
  sensorId: string;
  roomLabel: string;
  from: string;
  to: string;
  indoorSamples: MeasurementSample[];
  outdoorSamples: OutdoorTemperatureSample[];
  horizonHours?: number;
  scenarioOutdoorTemperatureC?: number | null;
  generatedAt?: string;
}

function round(value: number, precision = 4): number {
  return Number(value.toFixed(precision));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

function range(values: number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function thermalStep(indoorC: number, outdoorC: number, dtHours: number, tauHours: number, liftC: number): number {
  const memory = Math.exp(-dtHours / tauHours);
  return memory * indoorC + (1 - memory) * (outdoorC + liftC);
}

/** Exact discrete first-order step, exported for deterministic physics tests. */
export function simulateThermalStep(
  indoorC: number,
  outdoorC: number,
  dtHours: number,
  tauHours: number,
  effectiveEquilibriumLiftC: number,
): number {
  return thermalStep(indoorC, outdoorC, dtHours, tauHours, effectiveEquilibriumLiftC);
}

function indoorPoints(samples: MeasurementSample[]): IndoorPoint[] {
  const deduplicated = new Map<number, IndoorPoint>();
  for (const sample of samples) {
    const time = Date.parse(sample.timestamp);
    if (sample.metric !== "temperature" || sample.quality === "stale" || sample.source === "replay"
      || !Number.isFinite(time) || !Number.isFinite(sample.value)) continue;
    const point = {
      timestamp: new Date(time).toISOString(),
      time,
      temperatureC: sample.value,
      weight: sample.quality === "estimated" ? 0.25 : 1,
    };
    const current = deduplicated.get(time);
    if (!current || point.weight >= current.weight) deduplicated.set(time, point);
  }
  // Dense 2-10 second telemetry would otherwise create no usable >=5 minute
  // transitions and make fitting block the event loop. Aggregate to stable UTC
  // buckets so calibration and returned reconstruction have a bounded budget.
  const buckets = new Map<number, { weightedTemperature: number; totalWeight: number; samples: number }>();
  for (const point of deduplicated.values()) {
    const bucketTime = Math.floor(point.time / CALIBRATION_INTERVAL_MS) * CALIBRATION_INTERVAL_MS;
    const bucket = buckets.get(bucketTime) ?? { weightedTemperature: 0, totalWeight: 0, samples: 0 };
    bucket.weightedTemperature += point.temperatureC * point.weight;
    bucket.totalWeight += point.weight;
    bucket.samples += 1;
    buckets.set(bucketTime, bucket);
  }
  return [...buckets.entries()].map(([time, bucket]) => ({
    timestamp: new Date(time).toISOString(),
    time,
    temperatureC: bucket.weightedTemperature / Math.max(Number.EPSILON, bucket.totalWeight),
    weight: Math.min(1, bucket.totalWeight / bucket.samples),
  })).sort((first, second) => first.time - second.time);
}

function outdoorPoints(samples: OutdoorTemperatureSample[]): OutdoorPoint[] {
  const priority: Record<OutdoorTemperatureSample["source"], number> = {
    "fmi-observation": 3,
    "open-meteo-current": 3,
    "fmi-backfill": 3,
    "open-meteo-backfill": 3,
    api: 2,
    mock: 1,
  };
  const deduplicated = new Map<number, OutdoorPoint & { priority: number }>();
  for (const sample of samples) {
    const time = Date.parse(sample.timestamp);
    if (!Number.isFinite(time) || !Number.isFinite(sample.temperatureC)) continue;
    const candidate = {
      timestamp: new Date(time).toISOString(),
      time,
      temperatureC: sample.temperatureC,
      priority: priority[sample.source],
    };
    const current = deduplicated.get(time);
    if (!current || candidate.priority > current.priority) deduplicated.set(time, candidate);
  }
  return [...deduplicated.values()].sort((first, second) => first.time - second.time);
}

function interpolateOutdoor(points: OutdoorPoint[], timestamp: number): number | null {
  if (!points.length || timestamp < (points[0]?.time ?? Infinity) || timestamp > (points.at(-1)?.time ?? -Infinity)) return null;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const time = points[middle]?.time ?? 0;
    if (time === timestamp) return points[middle]?.temperatureC ?? null;
    if (time < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  const before = points[high];
  const after = points[low];
  if (!before || !after || after.time - before.time > MAX_OUTDOOR_GAP_MS) return null;
  const fraction = (timestamp - before.time) / Math.max(1, after.time - before.time);
  return before.temperatureC + (after.temperatureC - before.temperatureC) * fraction;
}

function align(indoor: IndoorPoint[], outdoor: OutdoorPoint[]): AlignedPoint[] {
  return indoor.flatMap((point) => {
    const outdoorTemperatureC = interpolateOutdoor(outdoor, point.time);
    return outdoorTemperatureC === null ? [] : [{ ...point, outdoorTemperatureC }];
  });
}

function transitionsFrom(points: AlignedPoint[]): Transition[] {
  const transitions: Transition[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const dtHours = (current.time - previous.time) / HOUR_MS;
    if (dtHours < MIN_INTERVAL_HOURS || dtHours > MAX_INTERVAL_HOURS) continue;
    transitions.push({
      fromTime: previous.time,
      toTime: current.time,
      indoorC: previous.temperatureC,
      nextIndoorC: current.temperatureC,
      // A zero-order hold matches how discrete weather observations are consumed.
      outdoorC: previous.outdoorTemperatureC,
      dtHours,
      weight: Math.min(1, dtHours / 0.5) * Math.min(previous.weight, current.weight),
    });
  }
  return transitions;
}

/** Select one continuous usable span; disconnected fragments cannot fake 24h coverage. */
function longestTransitionSegment(transitions: Transition[]): Transition[] {
  if (!transitions.length) return [];
  let best: Transition[] = [];
  let bestHours = -1;
  let segment: Transition[] = [];
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

function fitLift(transitions: Transition[], tauHours: number): number | null {
  if (!transitions.length) return null;
  let robustWeights = transitions.map(() => 1);
  let lift = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < transitions.length; index += 1) {
      const transition = transitions[index];
      if (!transition) continue;
      const memory = Math.exp(-transition.dtHours / tauHours);
      const z = 1 - memory;
      const y = transition.nextIndoorC - memory * transition.indoorC - z * transition.outdoorC;
      const weight = transition.weight * (robustWeights[index] ?? 1);
      numerator += weight * z * y;
      denominator += weight * z * z;
    }
    if (denominator <= 1e-10) return null;
    lift = numerator / denominator;
    const residuals = transitions.map((transition) => {
      const memory = Math.exp(-transition.dtHours / tauHours);
      const z = 1 - memory;
      const y = transition.nextIndoorC - memory * transition.indoorC - z * transition.outdoorC;
      return y - z * lift;
    });
    const center = median(residuals);
    const scale = Math.max(0.03, 1.4826 * median(residuals.map((residual) => Math.abs(residual - center))));
    robustWeights = residuals.map((residual) => Math.min(1, 1.5 * scale / Math.max(Math.abs(residual), 1e-12)));
  }
  return Number.isFinite(lift) ? lift : null;
}

function rolloutResiduals(transitions: Transition[], tauHours: number, liftC: number): { residuals: number[]; persistence: number[] } {
  const residuals: number[] = [];
  const persistence: number[] = [];
  let simulatedC: number | null = null;
  let persistentC: number | null = null;
  let previousEnd: number | null = null;
  for (const transition of transitions) {
    if (previousEnd !== transition.fromTime || simulatedC === null || persistentC === null) {
      simulatedC = transition.indoorC;
      persistentC = transition.indoorC;
    }
    simulatedC = thermalStep(simulatedC, transition.outdoorC, transition.dtHours, tauHours, liftC);
    residuals.push(transition.nextIndoorC - simulatedC);
    persistence.push(transition.nextIndoorC - persistentC);
    previousEnd = transition.toTime;
  }
  return { residuals, persistence };
}

function tauCandidates(): number[] {
  return [
    ...Array.from({ length: 47 }, (_, index) => index + 2),
    ...Array.from({ length: 48 }, (_, index) => 52 + index * 4),
  ];
}

function emptyQuality(indoor: IndoorPoint[], outdoor: OutdoorPoint[], aligned: AlignedPoint[], transitions: Transition[]): ThermalCalibrationQuality {
  return {
    indoorSamples: indoor.length,
    outdoorSamples: outdoor.length,
    alignedSamples: aligned.length,
    transitionsUsed: transitions.length,
    durationHours: round(transitions.reduce((sum, transition) => sum + transition.dtHours, 0), 2),
    indoorRangeC: round(range(aligned.map((point) => point.temperatureC)), 3),
    outdoorRangeC: round(range(aligned.map((point) => point.outdoorTemperatureC)), 3),
    validationMaeC: null,
    validationRmseC: null,
    validationBiasC: null,
    persistenceMaeC: null,
    residualP90C: null,
  };
}

function assumptions(): string[] {
  return [
    "The sensor is treated as one well-mixed thermal zone.",
    "The effective equilibrium lift combines average HVAC, occupants, appliances, and solar gains.",
    "The fitted parameters are empirical and are not wall U-values, leakage rates, or material properties.",
    "No indoor airflow or moisture transport is simulated.",
  ];
}

function insufficient(
  quality: ThermalCalibrationQuality,
  warnings: string[],
): ThermalCalibrationResult {
  return { status: "insufficient-data", model: null, quality, warnings, assumptions: assumptions() };
}

function calibrate(
  houseId: string,
  sensorId: string,
  indoor: IndoorPoint[],
  outdoor: OutdoorPoint[],
  aligned: AlignedPoint[],
  transitions: Transition[],
  sources: OutdoorTemperatureSample[],
): ThermalCalibrationResult {
  const initialQuality = emptyQuality(indoor, outdoor, aligned, transitions);
  if (transitions.length < MIN_TRANSITIONS) {
    return insufficient(initialQuality, ["INSUFFICIENT_OVERLAP", `REQUIRES_${MIN_TRANSITIONS}_TRANSITIONS`]);
  }
  if (initialQuality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < MIN_DURATION_HOURS) {
    return insufficient(initialQuality, ["CALIBRATION_WINDOW_TOO_SHORT", `REQUIRES_${MIN_DURATION_HOURS}_HOURS`]);
  }

  // Keep the final chronological holdout untouched by parameter selection.
  const trainingEnd = Math.max(1, Math.min(transitions.length - 2, Math.floor(transitions.length * 0.6)));
  const tuningEnd = Math.max(trainingEnd + 1, Math.min(transitions.length - 1, Math.floor(transitions.length * 0.8)));
  const training = transitions.slice(0, trainingEnd);
  const tuning = transitions.slice(trainingEnd, tuningEnd);
  const prevalidation = transitions.slice(0, tuningEnd);
  const validation = transitions.slice(tuningEnd);
  const candidates: Candidate[] = [];
  for (const tauHours of tauCandidates()) {
    const liftC = fitLift(training, tauHours);
    if (liftC === null) continue;
    const selectionResiduals = rolloutResiduals(tuning, tauHours, liftC).residuals;
    if (!selectionResiduals.length) continue;
    candidates.push({
      tauHours,
      selectionMaeC: mean(selectionResiduals.map(Math.abs)),
    });
  }
  candidates.sort((first, second) => first.selectionMaeC - second.selectionMaeC || first.tauHours - second.tauHours);
  const selected = candidates[0];
  if (!selected) return insufficient(initialQuality, ["MODEL_NOT_IDENTIFIABLE"]);
  const validationLift = fitLift(prevalidation, selected.tauHours);
  if (validationLift === null) return insufficient(initialQuality, ["MODEL_NOT_IDENTIFIABLE"]);
  const finalLift = fitLift(transitions, selected.tauHours);
  if (finalLift === null) return insufficient(initialQuality, ["MODEL_NOT_IDENTIFIABLE"]);

  const validationRollout = rolloutResiduals(validation, selected.tauHours, validationLift);
  const residuals = validationRollout.residuals;
  const maeC = mean(residuals.map(Math.abs));
  const rmseC = Math.sqrt(mean(residuals.map((residual) => residual * residual)));
  const biasC = mean(residuals);
  const persistenceMaeC = mean(validationRollout.persistence.map(Math.abs));
  const tolerance = selected.selectionMaeC + Math.max(0.03, selected.selectionMaeC * 0.1);
  const profile = candidates.filter((candidate) => candidate.selectionMaeC <= tolerance);
  const lowCandidate = profile.reduce((best, candidate) => candidate.tauHours < best.tauHours ? candidate : best, profile[0] ?? selected);
  const highCandidate = profile.reduce((best, candidate) => candidate.tauHours > best.tauHours ? candidate : best, profile[0] ?? selected);
  const liftValues = profile.map((candidate) => fitLift(transitions, candidate.tauHours)).filter((value): value is number => value !== null);
  const tauLow = lowCandidate.tauHours;
  const tauHigh = highCandidate.tauHours;
  const warnings: string[] = [];
  if (sources.some((sample) => sample.source === "mock")) warnings.push("SYNTHETIC_OUTDOOR_BOUNDARY");
  if (initialQuality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < 7 * 24) warnings.push("SHORT_CALIBRATION_WINDOW");
  if (initialQuality.outdoorRangeC < 3) warnings.push("LOW_THERMAL_DRIVE_VARIATION");
  if (tauLow === 2 || tauHigh === 240 || tauHigh / Math.max(tauLow, 1) > 4) warnings.push("WEAK_PARAMETER_IDENTIFICATION");
  if (Math.abs(biasC) > 0.3) warnings.push("HIGH_VALIDATION_BIAS");
  if (maeC >= persistenceMaeC) warnings.push("MODEL_WORSE_THAN_PERSISTENCE");
  if (finalLift < 0) warnings.push("NEGATIVE_EFFECTIVE_EQUILIBRIUM_LIFT");

  const model: ThermalModelV1 = {
    method: "first-order-lumped-v1",
    version: "1.0.0",
    scope: { houseId, sensorIds: [sensorId] },
    trainedFrom: new Date(transitions[0]?.fromTime ?? 0).toISOString(),
    trainedTo: new Date(transitions.at(-1)?.toTime ?? 0).toISOString(),
    parameters: {
      timeConstantHours: round(selected.tauHours, 2),
      effectiveEquilibriumLiftC: round(finalLift, 3),
    },
    applicability: {
      indoorMinC: round(Math.min(...aligned.map((point) => point.temperatureC)), 3),
      indoorMaxC: round(Math.max(...aligned.map((point) => point.temperatureC)), 3),
      outdoorMinC: round(Math.min(...aligned.map((point) => point.outdoorTemperatureC)), 3),
      outdoorMaxC: round(Math.max(...aligned.map((point) => point.outdoorTemperatureC)), 3),
      maxHorizonHours: MODEL_MAX_HORIZON_HOURS,
    },
    sensitivity: {
      timeConstantLowHours: round(tauLow, 2),
      timeConstantHighHours: round(tauHigh, 2),
      liftLowC: round(Math.min(...liftValues, finalLift), 3),
      liftHighC: round(Math.max(...liftValues, finalLift), 3),
    },
  };
  const quality: ThermalCalibrationQuality = {
    ...initialQuality,
    validationMaeC: round(maeC, 3),
    validationRmseC: round(rmseC, 3),
    validationBiasC: round(biasC, 3),
    persistenceMaeC: round(persistenceMaeC, 3),
    residualP90C: round(percentile(residuals.map(Math.abs), 0.9), 3),
  };
  return {
    status: warnings.length ? "provisional" : "ready",
    model,
    quality,
    warnings,
    assumptions: assumptions(),
  };
}

function historicalPoints(
  aligned: AlignedPoint[],
  model: ThermalModelV1,
  empiricalBandC: number,
): ThermalSimulationPoint[] {
  const points: ThermalSimulationPoint[] = [];
  let simulatedC: number | null = null;
  let previous: AlignedPoint | null = null;
  for (const point of aligned) {
    if (!previous || simulatedC === null) {
      simulatedC = point.temperatureC;
    } else {
      const dtHours = (point.time - previous.time) / HOUR_MS;
      if (dtHours < MIN_INTERVAL_HOURS || dtHours > MAX_INTERVAL_HOURS) simulatedC = point.temperatureC;
      else simulatedC = thermalStep(
        simulatedC,
        previous.outdoorTemperatureC,
        dtHours,
        model.parameters.timeConstantHours,
        model.parameters.effectiveEquilibriumLiftC,
      );
    }
    points.push({
      timestamp: point.timestamp,
      phase: "fit",
      outdoorTemperatureC: round(point.outdoorTemperatureC, 3),
      observedTemperatureC: round(point.temperatureC, 3),
      simulatedTemperatureC: round(simulatedC, 3),
      residualC: round(point.temperatureC - simulatedC, 3),
      lowC: round(simulatedC - empiricalBandC, 3),
      highC: round(simulatedC + empiricalBandC, 3),
    });
    previous = point;
  }
  return points;
}

function scenarioPoints(
  anchor: AlignedPoint | null,
  model: ThermalModelV1,
  horizonHours: number,
  scenarioOutdoorTemperatureC: number | null,
  empiricalBandC: number,
  scenarioStartTime: number,
): ThermalSimulationPoint[] {
  if (!anchor || horizonHours <= 0) return [];
  const outdoorTemperatureC = scenarioOutdoorTemperatureC ?? anchor.outdoorTemperatureC;
  const anchorGapHours = Math.max(0, (scenarioStartTime - anchor.time) / HOUR_MS);
  let simulatedC = thermalStep(
    anchor.temperatureC,
    outdoorTemperatureC,
    anchorGapHours,
    model.parameters.timeConstantHours,
    model.parameters.effectiveEquilibriumLiftC,
  );
  const points: ThermalSimulationPoint[] = [];
  for (let hour = 1; hour <= horizonHours; hour += 1) {
    simulatedC = thermalStep(
      simulatedC,
      outdoorTemperatureC,
      1,
      model.parameters.timeConstantHours,
      model.parameters.effectiveEquilibriumLiftC,
    );
    const band = empiricalBandC * Math.min(3, Math.sqrt(1 + hour / 12));
    points.push({
      timestamp: new Date(scenarioStartTime + hour * HOUR_MS).toISOString(),
      phase: "scenario",
      outdoorTemperatureC: round(outdoorTemperatureC, 3),
      observedTemperatureC: null,
      simulatedTemperatureC: round(simulatedC, 3),
      residualC: null,
      lowC: round(simulatedC - band, 3),
      highC: round(simulatedC + band, 3),
    });
  }
  return points;
}

export function runThermalSimulation(input: ThermalSimulationInput): ThermalSimulationResult {
  const indoor = indoorPoints(input.indoorSamples);
  const outdoor = outdoorPoints(input.outdoorSamples);
  const allAligned = align(indoor, outdoor);
  const transitions = longestTransitionSegment(transitionsFrom(allAligned));
  const firstUsedTime = transitions[0]?.fromTime;
  const lastUsedTime = transitions.at(-1)?.toTime;
  const aligned = firstUsedTime === undefined || lastUsedTime === undefined
    ? allAligned
    : allAligned.filter((point) => point.time >= firstUsedTime && point.time <= lastUsedTime);
  const calibration = calibrate(input.houseId, input.sensorId, indoor, outdoor, aligned, transitions, input.outdoorSamples);
  const horizonHours = Math.max(0, Math.min(MAX_HORIZON_HOURS, Math.floor(input.horizonHours ?? 12)));
  const scenarioOutdoorTemperatureC = Number.isFinite(input.scenarioOutdoorTemperatureC)
    ? input.scenarioOutdoorTemperatureC as number
    : null;
  if (calibration.model && horizonHours > MODEL_MAX_HORIZON_HOURS) {
    calibration.warnings.push("LONG_SCENARIO_HORIZON");
    calibration.status = "provisional";
  }
  // Fit against the longest continuous span, but initialize a scenario from
  // the latest aligned observation even when it belongs to a newer short span.
  const scenarioAnchor = calibration.model ? allAligned.at(-1) ?? null : null;
  const scenarioAnchorTimestamp = scenarioAnchor?.timestamp ?? null;
  const effectiveScenarioOutdoorC = scenarioOutdoorTemperatureC ?? scenarioAnchor?.outdoorTemperatureC ?? null;
  if (calibration.model && horizonHours > 0 && effectiveScenarioOutdoorC !== null) {
    const { outdoorMinC, outdoorMaxC } = calibration.model.applicability;
    if (effectiveScenarioOutdoorC < outdoorMinC - 2 || effectiveScenarioOutdoorC > outdoorMaxC + 2) {
      calibration.warnings.push("SCENARIO_OUTSIDE_CALIBRATION_RANGE");
      calibration.status = "provisional";
    }
  }
  const scenarioStartTime = Date.parse(input.to);
  const scenarioAnchorTime = scenarioAnchorTimestamp === null ? Number.NaN : Date.parse(scenarioAnchorTimestamp);
  const scenarioAnchorAgeHours = (scenarioStartTime - scenarioAnchorTime) / HOUR_MS;
  const scenarioAnchorFresh = Number.isFinite(scenarioAnchorAgeHours)
    && scenarioAnchorAgeHours >= 0
    && scenarioAnchorAgeHours <= MAX_SCENARIO_ANCHOR_AGE_HOURS;
  if (calibration.model && horizonHours > 0 && !scenarioAnchorFresh) {
    calibration.warnings.push("STALE_SCENARIO_ANCHOR");
    calibration.status = "provisional";
  }
  const empiricalBandC = Math.max(0.1, calibration.quality.residualP90C ?? calibration.quality.validationRmseC ?? 0.5);
  const points = calibration.model
    ? [
      ...historicalPoints(aligned, calibration.model, empiricalBandC),
      ...scenarioPoints(
        scenarioAnchor,
        calibration.model,
        scenarioAnchorFresh ? horizonHours : 0,
        scenarioOutdoorTemperatureC,
        empiricalBandC,
        scenarioStartTime,
      ),
    ]
    : [];
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    systemVersion: SYSTEM_VERSION,
    houseId: input.houseId,
    sensorId: input.sensorId,
    roomLabel: input.roomLabel,
    from: input.from,
    to: input.to,
    horizonHours,
    scenarioOutdoorTemperatureC,
    scenarioAnchorTimestamp,
    calibration,
    points,
  };
}
