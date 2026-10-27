import { withSignal } from "@climate-twin/contracts";
import { maximum, minimum } from "@climate-twin/analytics-kernel";
import type {
  MeasurementSample,
  OutdoorTemperatureSample,
  HvacExclusionSummary,
  ThermalCalibrationQuality,
  ThermalCalibrationResult,
  ThermalModelV1,
  ThermalSimulationPoint,
  ThermalSimulationResult,
} from "@climate-twin/contracts";
import { mean, percentile, range, round } from "./thermal-math.js";
import { SYSTEM_VERSION } from "./version.js";
import { isTransitionWithinPassiveIntervals, type PassiveInterval } from "./analytics/heat-pump-evidence.js";
import {
  calibrateRelaxationSteps,
  dailyCycleFromHarmonics,
  dailyCycleValue,
  meanAbsolute,
  runSteps,
  runStepsAsync,
  usableStretches,
  type DailyCycle,
  type RelaxationCalibration,
  type RelaxationTransition,
} from "./analytics/relaxation-fit.js";

const HOUR_MS = 3_600_000;
const CALIBRATION_INTERVAL_MS = 5 * 60_000;
const MIN_TRANSITIONS = 48;
const MIN_DURATION_HOURS = 24;
const MIN_STRETCH_HOURS = 2;
const DURATION_EDGE_TOLERANCE_HOURS = 0.25;
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 2;
const MAX_OUTDOOR_GAP_MS = 2 * HOUR_MS;
const MAX_HORIZON_HOURS = 72;
const MODEL_MAX_HORIZON_HOURS = 48;
const MAX_SCENARIO_ANCHOR_AGE_HOURS = 2;
const MIN_TAU_HOURS = 2;
const MAX_TAU_HOURS = 1_000;

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

export interface PreparedThermalOutdoorBoundary {
  points: OutdoorPoint[];
  interpolationCache: Map<number, number | null>;
}

interface AlignedPoint extends IndoorPoint {
  outdoorTemperatureC: number;
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
  hvacExclusion?: HvacExclusionSummary;
  passiveIntervals?: readonly PassiveInterval[];
}

function thermalStep(indoorC: number, outdoorC: number, dtHours: number, tauHours: number, liftC: number, cycleC = 0): number {
  const memory = Math.exp(-dtHours / tauHours);
  return memory * indoorC + (1 - memory) * (outdoorC + liftC + cycleC);
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

export function prepareThermalOutdoorBoundary(
  samples: OutdoorTemperatureSample[],
): PreparedThermalOutdoorBoundary {
  return {
    points: outdoorPoints(samples),
    interpolationCache: new Map(),
  };
}

function interpolateOutdoor(boundary: PreparedThermalOutdoorBoundary, timestamp: number): number | null {
  if (boundary.interpolationCache.has(timestamp)) {
    return boundary.interpolationCache.get(timestamp) ?? null;
  }
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
      const exact = points[middle]?.temperatureC ?? null;
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
  const interpolated = before.temperatureC + (after.temperatureC - before.temperatureC) * fraction;
  boundary.interpolationCache.set(timestamp, interpolated);
  return interpolated;
}

function align(indoor: IndoorPoint[], outdoor: PreparedThermalOutdoorBoundary): AlignedPoint[] {
  return indoor.flatMap((point) => {
    const outdoorTemperatureC = interpolateOutdoor(outdoor, point.time);
    return outdoorTemperatureC === null ? [] : [{ ...point, outdoorTemperatureC }];
  });
}

/** Passive steps as relaxation transitions: outdoor temperature is the known drive, the lift the fitted offset. */
function transitionsFrom(points: AlignedPoint[], passiveIntervals?: readonly PassiveInterval[]): RelaxationTransition[] {
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
      value: previous.temperatureC,
      nextValue: current.temperatureC,
      // A zero-order hold matches how discrete weather observations are consumed.
      knownDrive: previous.outdoorTemperatureC,
      regressors: [1],
      dtHours,
      weight: Math.min(1, dtHours / 0.5) * Math.min(previous.weight, current.weight),
    });
  }
  return transitions;
}

function emptyQuality(
  indoor: IndoorPoint[],
  outdoor: OutdoorPoint[],
  aligned: AlignedPoint[],
  transitions: RelaxationTransition[],
  stretches: number,
): ThermalCalibrationQuality {
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
    stretchesUsed: stretches,
  };
}

function assumptions(): string[] {
  return [
    "The sensor is treated as one well-mixed thermal zone.",
    "The effective equilibrium lift combines average HVAC, occupants, appliances, and solar gains; a daily cycle term captures their regular 24-hour swing when the data shows one.",
    "Only heat-pump-off stretches are fitted, each simulated from its own first reading.",
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

interface CalibrationInput {
  houseId: string;
  sensorId: string;
  indoor: IndoorPoint[];
  outdoor: OutdoorPoint[];
  aligned: AlignedPoint[];
  transitions: RelaxationTransition[];
  stretches: number;
  sources: OutdoorTemperatureSample[];
}

function precheck(input: CalibrationInput): ThermalCalibrationQuality | ThermalCalibrationResult {
  const quality = emptyQuality(input.indoor, input.outdoor, input.aligned, input.transitions, input.stretches);
  if (input.transitions.length < MIN_TRANSITIONS) {
    return insufficient(quality, ["INSUFFICIENT_OVERLAP", `REQUIRES_${MIN_TRANSITIONS}_TRANSITIONS`]);
  }
  if (quality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < MIN_DURATION_HOURS) {
    return insufficient(quality, ["CALIBRATION_WINDOW_TOO_SHORT", `REQUIRES_${MIN_DURATION_HOURS}_HOURS`]);
  }
  return quality;
}

function isCalibrationResult(value: ThermalCalibrationQuality | ThermalCalibrationResult): value is ThermalCalibrationResult {
  return "status" in value;
}

function cycleOf(coefficients: readonly number[] | null, dailyCycle: boolean): DailyCycle | null {
  if (!coefficients || !dailyCycle) return null;
  return dailyCycleFromHarmonics(coefficients[1] ?? 0, coefficients[2] ?? 0);
}

function completeCalibration(
  input: CalibrationInput,
  initialQuality: ThermalCalibrationQuality,
  fit: RelaxationCalibration | null,
): ThermalCalibrationResult {
  if (!fit) return insufficient(initialQuality, ["MODEL_NOT_IDENTIFIABLE"]);
  const { aligned, transitions, sources } = input;
  const residuals = fit.validation.residuals;
  const maeC = meanAbsolute(residuals);
  const rmseC = Math.sqrt(mean(residuals.map((residual) => residual * residual)));
  const biasC = mean(residuals);
  const persistenceMaeC = meanAbsolute(fit.validation.persistence);
  const tauHours = fit.parameters.tauHours;
  const finalLift = fit.parameters.coefficients[0] ?? 0;
  const tauLow = fit.interval?.low ?? tauHours;
  const tauHigh = fit.interval?.high ?? tauHours;
  const lifts = [finalLift, fit.intervalCoefficients.low?.[0], fit.intervalCoefficients.high?.[0]]
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const cycle = cycleOf(fit.parameters.coefficients, fit.dailyCycle);
  const warnings: string[] = [];
  if (sources.some((sample) => sample.source === "mock")) warnings.push("SYNTHETIC_OUTDOOR_BOUNDARY");
  if (initialQuality.durationHours + DURATION_EDGE_TOLERANCE_HOURS < 7 * 24) warnings.push("SHORT_CALIBRATION_WINDOW");
  if (initialQuality.outdoorRangeC < 3) warnings.push("LOW_THERMAL_DRIVE_VARIATION");
  if (fit.search.atLowerLimit || fit.search.atUpperLimit) warnings.push("TIME_CONSTANT_AT_SEARCH_LIMIT");
  if (!fit.interval || tauHigh / Math.max(tauLow, MIN_TAU_HOURS) > 4) warnings.push("WEAK_PARAMETER_IDENTIFICATION");
  if (Math.abs(biasC) > 0.3) warnings.push("HIGH_VALIDATION_BIAS");
  if (maeC >= persistenceMaeC) warnings.push("MODEL_WORSE_THAN_PERSISTENCE");
  if (finalLift < 0) warnings.push("NEGATIVE_EFFECTIVE_EQUILIBRIUM_LIFT");

  const model: ThermalModelV1 = {
    method: "first-order-lumped-v1",
    version: "1.1.0",
    scope: { houseId: input.houseId, sensorIds: [input.sensorId] },
    trainedFrom: new Date(transitions[0]?.fromTime ?? 0).toISOString(),
    trainedTo: new Date(transitions.at(-1)?.toTime ?? 0).toISOString(),
    parameters: {
      timeConstantHours: round(tauHours, 2),
      effectiveEquilibriumLiftC: round(finalLift, 3),
      ...(cycle ? { dailyCycle: { amplitudeC: round(cycle.amplitude, 3), peakHourUtc: round(cycle.peakHourUtc, 2) } } : {}),
    },
    applicability: {
      indoorMinC: round((minimum(aligned.map((point) => point.temperatureC)) ?? Number.POSITIVE_INFINITY), 3),
      indoorMaxC: round((maximum(aligned.map((point) => point.temperatureC)) ?? Number.NEGATIVE_INFINITY), 3),
      outdoorMinC: round((minimum(aligned.map((point) => point.outdoorTemperatureC)) ?? Number.POSITIVE_INFINITY), 3),
      outdoorMaxC: round((maximum(aligned.map((point) => point.outdoorTemperatureC)) ?? Number.NEGATIVE_INFINITY), 3),
      maxHorizonHours: MODEL_MAX_HORIZON_HOURS,
    },
    sensitivity: {
      timeConstantLowHours: round(tauLow, 2),
      timeConstantHighHours: round(tauHigh, 2),
      liftLowC: round((minimum(lifts) ?? Number.POSITIVE_INFINITY), 3),
      liftHighC: round((maximum(lifts) ?? Number.NEGATIVE_INFINITY), 3),
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

const FIT_OPTIONS = { minimumTauHours: MIN_TAU_HOURS, maximumTauHours: MAX_TAU_HOURS, scaleFloor: 0.03 };

function calibrate(input: CalibrationInput): ThermalCalibrationResult {
  const quality = precheck(input);
  if (isCalibrationResult(quality)) return quality;
  return completeCalibration(input, quality, runSteps(calibrateRelaxationSteps(input.transitions, FIT_OPTIONS)));
}

export interface ThermalSimulationAsyncOptions {
  signal?: AbortSignal;
  yieldEveryCandidates?: number;
}

async function yieldThermalWork(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

async function calibrateAsync(
  input: CalibrationInput,
  options: ThermalSimulationAsyncOptions,
): Promise<ThermalCalibrationResult> {
  options.signal?.throwIfAborted();
  const quality = precheck(input);
  if (isCalibrationResult(quality)) return quality;
  const fit = await runStepsAsync(calibrateRelaxationSteps(input.transitions, FIT_OPTIONS), {
    ...withSignal(options.signal),
    yieldEvery: options.yieldEveryCandidates ?? 4,
  });
  options.signal?.throwIfAborted();
  return completeCalibration(input, quality, fit);
}

function modelCycle(model: ThermalModelV1): DailyCycle | null {
  const cycle = model.parameters.dailyCycle;
  return cycle ? { amplitude: cycle.amplitudeC, peakHourUtc: cycle.peakHourUtc } : null;
}

/** Reconstructs each fitted stretch from its first reading; points between stretches are not simulated. */
function historicalPoints(
  aligned: AlignedPoint[],
  transitions: RelaxationTransition[],
  model: ThermalModelV1,
  empiricalBandC: number,
): ThermalSimulationPoint[] {
  const steps = new Map(transitions.map((transition) => [transition.toTime, transition.fromTime]));
  const used = new Set(transitions.flatMap((transition) => [transition.fromTime, transition.toTime]));
  const cycle = modelCycle(model);
  const points: ThermalSimulationPoint[] = [];
  let simulatedC: number | null = null;
  let previous: AlignedPoint | null = null;
  for (const point of aligned) {
    if (!used.has(point.time)) continue;
    if (!previous || simulatedC === null || steps.get(point.time) !== previous.time) {
      simulatedC = point.temperatureC;
    } else {
      simulatedC = thermalStep(
        simulatedC,
        previous.outdoorTemperatureC,
        (point.time - previous.time) / HOUR_MS,
        model.parameters.timeConstantHours,
        model.parameters.effectiveEquilibriumLiftC,
        dailyCycleValue(cycle, previous.time),
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
  const cycle = modelCycle(model);
  const outdoorTemperatureC = scenarioOutdoorTemperatureC ?? anchor.outdoorTemperatureC;
  const anchorGapHours = Math.max(0, (scenarioStartTime - anchor.time) / HOUR_MS);
  let simulatedC = thermalStep(
    anchor.temperatureC,
    outdoorTemperatureC,
    anchorGapHours,
    model.parameters.timeConstantHours,
    model.parameters.effectiveEquilibriumLiftC,
    dailyCycleValue(cycle, anchor.time),
  );
  const points: ThermalSimulationPoint[] = [];
  for (let hour = 1; hour <= horizonHours; hour += 1) {
    simulatedC = thermalStep(
      simulatedC,
      outdoorTemperatureC,
      1,
      model.parameters.timeConstantHours,
      model.parameters.effectiveEquilibriumLiftC,
      dailyCycleValue(cycle, scenarioStartTime + (hour - 1) * HOUR_MS),
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

interface PreparedThermalSimulationRun extends CalibrationInput {
  boundary: PreparedThermalOutdoorBoundary;
  allAligned: AlignedPoint[];
}

function prepareThermalSimulationRun(
  input: ThermalSimulationInput,
  preparedOutdoor?: PreparedThermalOutdoorBoundary,
): PreparedThermalSimulationRun {
  const indoor = indoorPoints(input.indoorSamples);
  const boundary = preparedOutdoor ?? prepareThermalOutdoorBoundary(input.outdoorSamples);
  const allAligned = align(indoor, boundary);
  const usable = usableStretches(transitionsFrom(allAligned, input.passiveIntervals), MIN_STRETCH_HOURS);
  const firstUsedTime = usable.transitions[0]?.fromTime;
  const lastUsedTime = usable.transitions.at(-1)?.toTime;
  const aligned = firstUsedTime === undefined || lastUsedTime === undefined
    ? allAligned
    : allAligned.filter((point) => point.time >= firstUsedTime && point.time <= lastUsedTime);
  return {
    houseId: input.houseId,
    sensorId: input.sensorId,
    indoor,
    outdoor: boundary.points,
    boundary,
    allAligned,
    aligned,
    transitions: usable.transitions,
    stretches: usable.stretches,
    sources: input.outdoorSamples,
  };
}

function completeThermalSimulation(
  input: ThermalSimulationInput,
  prepared: PreparedThermalSimulationRun,
  calibration: ThermalCalibrationResult,
): ThermalSimulationResult {
  const horizonHours = Math.max(0, Math.min(MAX_HORIZON_HOURS, Math.floor(input.horizonHours ?? 12)));
  const scenarioOutdoorTemperatureC = Number.isFinite(input.scenarioOutdoorTemperatureC)
    ? input.scenarioOutdoorTemperatureC as number
    : null;
  if (calibration.model && horizonHours > MODEL_MAX_HORIZON_HOURS) {
    calibration.warnings.push("LONG_SCENARIO_HORIZON");
    calibration.status = "provisional";
  }
  // Fit against every passive stretch, but initialize a scenario from the
  // latest aligned observation even when it falls outside them.
  const scenarioAnchor = calibration.model ? prepared.allAligned.at(-1) ?? null : null;
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
  if (input.hvacExclusion && input.hvacExclusion.excludedSampleCount > 0
    && !calibration.warnings.includes("HVAC_ACTIVE_OR_UNVERIFIED_PERIODS_EXCLUDED")) {
    calibration.warnings.push("HVAC_ACTIVE_OR_UNVERIFIED_PERIODS_EXCLUDED");
  }
  const empiricalBandC = Math.max(0.1, calibration.quality.residualP90C ?? calibration.quality.validationRmseC ?? 0.5);
  const points = calibration.model
    ? [
      ...historicalPoints(prepared.aligned, prepared.transitions, calibration.model, empiricalBandC),
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
    ...(input.hvacExclusion ? { hvacExclusion: input.hvacExclusion } : {}),
  };
}

export function runThermalSimulation(
  input: ThermalSimulationInput,
  preparedOutdoor?: PreparedThermalOutdoorBoundary,
): ThermalSimulationResult {
  const prepared = prepareThermalSimulationRun(input, preparedOutdoor);
  return completeThermalSimulation(input, prepared, calibrate(prepared));
}

export async function runThermalSimulationAsync(
  input: ThermalSimulationInput,
  preparedOutdoor?: PreparedThermalOutdoorBoundary,
  options: ThermalSimulationAsyncOptions = {},
): Promise<ThermalSimulationResult> {
  options.signal?.throwIfAborted();
  await yieldThermalWork(options.signal);
  const prepared = prepareThermalSimulationRun(input, preparedOutdoor);
  await yieldThermalWork(options.signal);
  const calibration = await calibrateAsync(prepared, options);
  await yieldThermalWork(options.signal);
  return completeThermalSimulation(input, prepared, calibration);
}
