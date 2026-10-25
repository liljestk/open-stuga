/**
 * Shared estimation for first-order relaxation models (thermal and moisture).
 *
 * A state x relaxes towards an equilibrium over each observed step:
 *
 *   x(t + dt) = m·x(t) + (1 − m)·(d(t) + Σ βₖ·uₖ(t)),   m = exp(−dt / τ)
 *
 * d is a drive with a known unit coefficient (outdoor temperature for the
 * thermal model, nothing for moisture) and uₖ are regressors whose
 * coefficients βₖ are fitted. For a fixed τ the βₖ are a robust weighted
 * least-squares problem; τ itself is searched on a continuous log scale by
 * multi-step (rollout) error on held-out data.
 */
import { median as kernelMedian, quantile } from "@climate-twin/analytics-kernel";

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const middleValue = (values: readonly number[]): number => kernelMedian(values) ?? 0;

/** One observed step inside a heat-pump-off stretch. */
export interface RelaxationTransition {
  fromTime: number;
  toTime: number;
  value: number;
  nextValue: number;
  /** Drive term with a known unit coefficient, held over the step. */
  knownDrive: number;
  /** Regressors with fitted coefficients, evaluated at the step start. */
  regressors: readonly number[];
  dtHours: number;
  weight: number;
}

export interface RelaxationParameters {
  tauHours: number;
  coefficients: number[];
}

export interface RolloutErrors {
  residuals: number[];
  persistence: number[];
}

export interface DailyCycle {
  amplitude: number;
  peakHourUtc: number;
}

/** The daily (24 h) harmonic pair at an instant, so a cycle peak can sit at any hour. */
export function dailyHarmonics(time: number): [number, number] {
  const angle = 2 * Math.PI * ((time / HOUR_MS) % DAY_HOURS) / DAY_HOURS;
  return [Math.sin(angle), Math.cos(angle)];
}

/** Amplitude and UTC peak hour of a fitted sin/cos pair. */
export function dailyCycleFromHarmonics(sinCoefficient: number, cosCoefficient: number): DailyCycle {
  const amplitude = Math.hypot(sinCoefficient, cosCoefficient);
  const peakAngle = Math.atan2(sinCoefficient, cosCoefficient);
  const peakHourUtc = ((peakAngle / (2 * Math.PI)) * DAY_HOURS + DAY_HOURS) % DAY_HOURS;
  return { amplitude, peakHourUtc };
}

/** The daily-cycle contribution at an instant from its amplitude and peak hour. */
export function dailyCycleValue(cycle: DailyCycle | null | undefined, time: number): number {
  if (!cycle || cycle.amplitude === 0) return 0;
  const hours = (time / HOUR_MS) % DAY_HOURS;
  return cycle.amplitude * Math.cos(2 * Math.PI * (hours - cycle.peakHourUtc) / DAY_HOURS);
}

export function relaxationStep(
  value: number,
  transition: Pick<RelaxationTransition, "knownDrive" | "regressors" | "dtHours">,
  parameters: RelaxationParameters,
): number {
  const memory = Math.exp(-transition.dtHours / parameters.tauHours);
  let equilibrium = transition.knownDrive;
  for (let index = 0; index < parameters.coefficients.length; index += 1) {
    equilibrium += (parameters.coefficients[index] ?? 0) * (transition.regressors[index] ?? 0);
  }
  return memory * value + (1 - memory) * equilibrium;
}

/** Solves a small linear system with partial pivoting; null when singular. */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) <= 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]! / augmented[column]![column]!;
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row]![entry]! -= factor * augmented[column]![entry]!;
      }
    }
  }
  const solution = augmented.map((row, index) => row[size]! / row[index]!);
  return solution.every(Number.isFinite) ? solution : null;
}

/**
 * Robust (iteratively reweighted, Huber-like) weighted least squares for the
 * coefficients at a fixed τ. `scaleFloor` stops the weights from collapsing
 * on near-perfect data.
 */
export function fitCoefficients(
  transitions: readonly RelaxationTransition[],
  tauHours: number,
  scaleFloor: number,
): number[] | null {
  const size = transitions[0]?.regressors.length ?? 0;
  if (!transitions.length || size === 0) return null;
  const terms = transitions.map((transition) => {
    const relaxation = 1 - Math.exp(-transition.dtHours / tauHours);
    return {
      x: transition.regressors.map((regressor) => relaxation * regressor),
      y: transition.nextValue - (1 - relaxation) * transition.value - relaxation * transition.knownDrive,
      weight: transition.weight,
    };
  });
  let robust = terms.map(() => 1);
  let coefficients: number[] | null = null;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const normal = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const right = new Array<number>(size).fill(0);
    terms.forEach((term, index) => {
      const weight = term.weight * robust[index]!;
      for (let row = 0; row < size; row += 1) {
        right[row]! += weight * term.x[row]! * term.y;
        for (let column = 0; column < size; column += 1) normal[row]![column]! += weight * term.x[row]! * term.x[column]!;
      }
    });
    coefficients = solve(normal, right);
    if (!coefficients) return null;
    if (iteration === 4) break;
    const fitted = coefficients;
    const residuals = terms.map((term) => term.y - term.x.reduce((sum, value, index) => sum + value * fitted[index]!, 0));
    const center = middleValue(residuals);
    const scale = Math.max(scaleFloor, 1.4826 * middleValue(residuals.map((residual) => Math.abs(residual - center))));
    robust = residuals.map((residual) => Math.min(1, 1.5 * scale / Math.max(Math.abs(residual - center), 1e-12)));
  }
  return coefficients;
}

/** Simulates each stretch from its first observed value; persistence is the "no change" baseline. */
export function rollout(transitions: readonly RelaxationTransition[], parameters: RelaxationParameters): RolloutErrors {
  const residuals: number[] = [];
  const persistence: number[] = [];
  let simulated: number | null = null;
  let persistent: number | null = null;
  let previousEnd: number | null = null;
  for (const transition of transitions) {
    if (previousEnd !== transition.fromTime || simulated === null || persistent === null) {
      simulated = transition.value;
      persistent = transition.value;
    }
    simulated = relaxationStep(simulated, transition, parameters);
    residuals.push(transition.nextValue - simulated);
    persistence.push(transition.nextValue - persistent);
    previousEnd = transition.toTime;
  }
  return { residuals, persistence };
}

export function meanAbsolute(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length : 0;
}

/** Continuous runs of transitions (each starts where the previous one ended). */
export function continuousStretches<T extends Pick<RelaxationTransition, "fromTime" | "toTime">>(
  transitions: readonly T[],
): T[][] {
  const stretches: T[][] = [];
  for (const transition of transitions) {
    const current = stretches.at(-1);
    if (current && current.at(-1)?.toTime === transition.fromTime) current.push(transition);
    else stretches.push([transition]);
  }
  return stretches;
}

/**
 * Every heat-pump-off stretch long enough to carry dynamics, instead of only
 * the longest one: a cycling heat pump leaves many short passive stretches.
 */
export function usableStretches<T extends Pick<RelaxationTransition, "fromTime" | "toTime" | "dtHours">>(
  transitions: readonly T[],
  minimumStretchHours: number,
): { transitions: T[]; stretches: number } {
  const kept = continuousStretches(transitions)
    .filter((stretch) => stretch.reduce((sum, transition) => sum + transition.dtHours, 0) >= minimumStretchHours);
  return { transitions: kept.flat(), stretches: kept.length };
}

export interface TimeConstantSearch {
  tauHours: number;
  objective: number;
  atLowerLimit: boolean;
  atUpperLimit: boolean;
}

/** Runs a step generator to completion. */
export function runSteps<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/** Runs a step generator, yielding to the event loop every few steps so long fits never block it. */
export async function runStepsAsync<T>(
  steps: Generator<void, T>,
  options: { signal?: AbortSignal; yieldEvery?: number } = {},
): Promise<T> {
  const yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 4));
  let count = 0;
  let result = steps.next();
  while (!result.done) {
    count += 1;
    if (count % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      options.signal?.throwIfAborted();
    }
    result = steps.next();
  }
  return result.value;
}

/**
 * Minimizes `objective(τ)` over [minimumHours, maximumHours] on a log scale:
 * a coarse grid, then golden-section refinement around the best grid point.
 */
export function searchTimeConstant(
  objective: (tauHours: number) => number | null,
  minimumHours: number,
  maximumHours: number,
  gridSize = 40,
): TimeConstantSearch | null {
  return runSteps(searchTimeConstantSteps(objective, minimumHours, maximumHours, gridSize));
}

/** {@link searchTimeConstant} as steps that yield after every objective evaluation. */
export function* searchTimeConstantSteps(
  objective: (tauHours: number) => number | null,
  minimumHours: number,
  maximumHours: number,
  gridSize = 40,
): Generator<void, TimeConstantSearch | null> {
  const logMin = Math.log(minimumHours);
  const logMax = Math.log(maximumHours);
  const grid = Array.from({ length: gridSize }, (_, index) => Math.exp(logMin + (logMax - logMin) * index / (gridSize - 1)));
  const evaluated: Array<{ tau: number; value: number | null }> = [];
  for (const tau of grid) {
    evaluated.push({ tau, value: objective(tau) });
    yield;
  }
  let bestIndex = -1;
  for (let index = 0; index < evaluated.length; index += 1) {
    const value = evaluated[index]!.value;
    if (value === null || !Number.isFinite(value)) continue;
    if (bestIndex < 0 || value < evaluated[bestIndex]!.value!) bestIndex = index;
  }
  if (bestIndex < 0) return null;
  let low = Math.log(grid[Math.max(0, bestIndex - 1)]!);
  let high = Math.log(grid[Math.min(grid.length - 1, bestIndex + 1)]!);
  let best = { tau: grid[bestIndex]!, value: evaluated[bestIndex]!.value! };
  const ratio = (Math.sqrt(5) - 1) / 2;
  const at = (logTau: number) => {
    const tau = Math.exp(logTau);
    const value = objective(tau) ?? Number.POSITIVE_INFINITY;
    if (value < best.value) best = { tau, value };
    return value;
  };
  let left = high - ratio * (high - low);
  let right = low + ratio * (high - low);
  let leftValue = at(left);
  let rightValue = at(right);
  for (let iteration = 0; iteration < 24 && high - low > 1e-4; iteration += 1) {
    yield;
    if (leftValue <= rightValue) {
      high = right;
      right = left;
      rightValue = leftValue;
      left = high - ratio * (high - low);
      leftValue = at(left);
    } else {
      low = left;
      left = right;
      leftValue = rightValue;
      right = low + ratio * (high - low);
      rightValue = at(right);
    }
  }
  const edgeTolerance = 1.05;
  return {
    tauHours: best.tau,
    objective: best.value,
    atLowerLimit: best.tau <= minimumHours * edgeTolerance,
    atUpperLimit: best.tau >= maximumHours / edgeTolerance,
  };
}

/** Deterministic 32-bit generator so repeated calibrations report the same interval. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface BootstrapInterval {
  low: number;
  high: number;
  replicates: number;
}

export interface BootstrapInput {
  transitions: readonly RelaxationTransition[];
  fit: (tauHours: number) => RelaxationParameters | null;
  minimumHours: number;
  maximumHours: number;
  blockHours?: number;
  replicates?: number;
  gridSize?: number;
  seed?: number;
  level?: number;
}

/**
 * Moving-block bootstrap of the time constant. Transitions are cut into
 * blocks of `blockHours` (never across a stretch boundary), each block's
 * rollout error is computed once per grid τ with coefficients fitted on all
 * data for that τ, and every replicate resamples blocks with replacement and
 * takes the τ that minimizes the summed error, refined by a parabola in log
 * τ. Serial correlation within a block is preserved.
 */
export function blockBootstrapTimeConstant(input: BootstrapInput): BootstrapInterval | null {
  return runSteps(blockBootstrapTimeConstantSteps(input));
}

/** {@link blockBootstrapTimeConstant} as steps that yield after every grid fit. */
export function* blockBootstrapTimeConstantSteps(input: BootstrapInput): Generator<void, BootstrapInterval | null> {
  const blockHours = input.blockHours ?? 6;
  const replicates = input.replicates ?? 200;
  const gridSize = input.gridSize ?? 32;
  const level = input.level ?? 0.9;
  const blocks: RelaxationTransition[][] = [];
  for (const stretch of continuousStretches(input.transitions)) {
    let block: RelaxationTransition[] = [];
    let hours = 0;
    for (const transition of stretch) {
      block.push(transition);
      hours += transition.dtHours;
      if (hours >= blockHours) {
        blocks.push(block);
        block = [];
        hours = 0;
      }
    }
    if (block.length) blocks.push(block);
  }
  if (blocks.length < 4) return null;
  const logMin = Math.log(input.minimumHours);
  const logMax = Math.log(input.maximumHours);
  const grid = Array.from({ length: gridSize }, (_, index) => logMin + (logMax - logMin) * index / (gridSize - 1));
  // errors[g][b]: summed absolute rollout error of block b under grid τ g.
  const errors: Array<number[] | null> = [];
  for (const logTau of grid) {
    const parameters = input.fit(Math.exp(logTau));
    errors.push(parameters
      ? blocks.map((block) => rollout(block, parameters).residuals.reduce((sum, residual) => sum + Math.abs(residual), 0))
      : null);
    yield;
  }
  if (errors.every((row) => row === null)) return null;
  const random = generator(input.seed ?? 0x5eed);
  const estimates: number[] = [];
  const totals = new Array<number>(grid.length);
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    totals.fill(0);
    for (let draw = 0; draw < blocks.length; draw += 1) {
      const block = Math.floor(random() * blocks.length);
      for (let index = 0; index < grid.length; index += 1) {
        const row = errors[index];
        totals[index]! += row ? row[block]! : Number.POSITIVE_INFINITY;
      }
    }
    let best = 0;
    for (let index = 1; index < totals.length; index += 1) if (totals[index]! < totals[best]!) best = index;
    let logTau = grid[best]!;
    if (best > 0 && best < grid.length - 1) {
      const [left, middle, right] = [totals[best - 1]!, totals[best]!, totals[best + 1]!];
      const curvature = left - 2 * middle + right;
      if (Number.isFinite(curvature) && curvature > 0) {
        const step = grid[1]! - grid[0]!;
        logTau += Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curvature))) * step;
      }
    }
    estimates.push(Math.exp(logTau));
  }
  const tail = (1 - level) / 2;
  return { low: quantile(estimates, tail)!, high: quantile(estimates, 1 - tail)!, replicates };
}

/** A stable seed from the data, so a calibration's interval is reproducible. */
export function dataSeed(transitions: readonly RelaxationTransition[]): number {
  let hash = 0x811c9dc5;
  for (const transition of transitions) {
    hash = Math.imul(hash ^ (transition.fromTime / 60_000 | 0), 0x01000193);
    hash = Math.imul(hash ^ Math.round(transition.value * 1_000), 0x01000193);
  }
  return hash >>> 0;
}

export interface RelaxationCalibrationOptions {
  minimumTauHours: number;
  maximumTauHours: number;
  /** Floor for the robust residual scale, in the model's units. */
  scaleFloor: number;
  /** A daily harmonic is tried only with at least this much data. */
  dailyCycleMinimumHours?: number;
}

export interface RelaxationCalibration {
  /** Fitted on every usable transition. */
  parameters: RelaxationParameters;
  /** Whether the last two coefficients are the daily sin/cos pair. */
  dailyCycle: boolean;
  search: TimeConstantSearch;
  /** Fitted before the chronological holdout and evaluated on it. */
  validation: RolloutErrors;
  interval: BootstrapInterval | null;
  /** Coefficients refitted at the interval's τ ends. */
  intervalCoefficients: { low: number[] | null; high: number[] | null };
}

const DAILY_CYCLE_IMPROVEMENT = 0.98;

function withDailyCycle(transitions: readonly RelaxationTransition[]): RelaxationTransition[] {
  return transitions.map((transition) => ({
    ...transition,
    regressors: [...transition.regressors, ...dailyHarmonics(transition.fromTime)],
  }));
}

/**
 * Chronological 60/20/20 split: coefficients are fitted on the first part,
 * τ is chosen by rollout error on the second, and the last part stays an
 * untouched holdout. A daily harmonic is kept only when it lowers the
 * selection error by at least 2%.
 */
export function* calibrateRelaxationSteps(
  transitions: readonly RelaxationTransition[],
  options: RelaxationCalibrationOptions,
): Generator<void, RelaxationCalibration | null> {
  if (transitions.length < 3) return null;
  const trainingEnd = Math.max(1, Math.min(transitions.length - 2, Math.floor(transitions.length * 0.6)));
  const tuningEnd = Math.max(trainingEnd + 1, Math.min(transitions.length - 1, Math.floor(transitions.length * 0.8)));
  const durationHours = transitions.reduce((sum, transition) => sum + transition.dtHours, 0);
  const variants: Array<{ dailyCycle: boolean; transitions: readonly RelaxationTransition[] }> = [
    { dailyCycle: false, transitions },
  ];
  if (durationHours >= (options.dailyCycleMinimumHours ?? 48)) {
    variants.push({ dailyCycle: true, transitions: withDailyCycle(transitions) });
  }
  let chosen: { dailyCycle: boolean; transitions: readonly RelaxationTransition[]; search: TimeConstantSearch } | null = null;
  for (const variant of variants) {
    const training = variant.transitions.slice(0, trainingEnd);
    const tuning = variant.transitions.slice(trainingEnd, tuningEnd);
    const search: TimeConstantSearch | null = yield* searchTimeConstantSteps((tauHours) => {
      const coefficients = fitCoefficients(training, tauHours, options.scaleFloor);
      if (!coefficients) return null;
      const residuals = rollout(tuning, { tauHours, coefficients }).residuals;
      return residuals.length ? meanAbsolute(residuals) : null;
    }, options.minimumTauHours, options.maximumTauHours);
    if (!search) continue;
    if (!chosen || (variant.dailyCycle && search.objective < chosen.search.objective * DAILY_CYCLE_IMPROVEMENT)) {
      chosen = { ...variant, search };
    }
  }
  if (!chosen) return null;
  const tauHours = chosen.search.tauHours;
  const all = chosen.transitions;
  const validationCoefficients = fitCoefficients(all.slice(0, tuningEnd), tauHours, options.scaleFloor);
  const finalCoefficients = fitCoefficients(all, tauHours, options.scaleFloor);
  if (!validationCoefficients || !finalCoefficients) return null;
  const validation = rollout(all.slice(tuningEnd), { tauHours, coefficients: validationCoefficients });
  yield;
  const bootstrap: BootstrapInterval | null = yield* blockBootstrapTimeConstantSteps({
    transitions: all,
    fit: (candidate) => {
      const coefficients = fitCoefficients(all, candidate, options.scaleFloor);
      return coefficients ? { tauHours: candidate, coefficients } : null;
    },
    minimumHours: options.minimumTauHours,
    maximumHours: options.maximumTauHours,
    seed: dataSeed(all),
  });
  // The bootstrap centres on the all-data optimum while τ is selected on the
  // tuning split; widen the interval so it always contains the estimate.
  const interval = bootstrap && {
    ...bootstrap,
    low: Math.min(bootstrap.low, tauHours),
    high: Math.max(bootstrap.high, tauHours),
  };
  return {
    parameters: { tauHours, coefficients: finalCoefficients },
    dailyCycle: chosen.dailyCycle,
    search: chosen.search,
    validation,
    interval,
    intervalCoefficients: {
      low: interval ? fitCoefficients(all, interval.low, options.scaleFloor) : null,
      high: interval ? fitCoefficients(all, interval.high, options.scaleFloor) : null,
    },
  };
}
