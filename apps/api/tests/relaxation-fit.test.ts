import { describe, expect, it } from "vitest";
import {
  blockBootstrapTimeConstant,
  calibrateRelaxationSteps,
  dailyCycleFromHarmonics,
  dailyCycleValue,
  dailyHarmonics,
  fitCoefficients,
  runSteps,
  searchTimeConstant,
  usableStretches,
  type RelaxationTransition,
} from "../src/analytics/relaxation-fit.js";

const HOUR = 3_600_000;
const STEP_MINUTES = 10;
const START = Date.parse("2026-01-05T00:00:00.000Z");

/** Seeded uniform noise so fixtures are reproducible. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
}

interface Truth {
  tauHours: number;
  liftC: number;
  cycle: { amplitude: number; peakHourUtc: number } | null;
}

/**
 * Indoor temperature relaxing towards outdoor + lift (+ a daily cycle), with
 * a heat pump that runs on a pattern. Steps while it runs are dropped, as the
 * passive-interval filter does, and heating pushes the state up meanwhile.
 */
function thermalFixture(truth: Truth, days: number, pumpRuns: (hour: number) => boolean, seed = 7): RelaxationTransition[] {
  const random = noise(seed);
  const dtHours = STEP_MINUTES / 60;
  const transitions: RelaxationTransition[] = [];
  let indoor = 20;
  for (let step = 0; step < days * 24 * 60 / STEP_MINUTES; step += 1) {
    const time = START + step * STEP_MINUTES * 60_000;
    const hour = (time - START) / HOUR;
    const outdoor = -5 + 6 * Math.sin(2 * Math.PI * hour / 24 - 1) + 3 * Math.sin(2 * Math.PI * hour / 97);
    const running = pumpRuns(hour);
    const memory = Math.exp(-dtHours / truth.tauHours);
    const equilibrium = outdoor + truth.liftC + dailyCycleValue(truth.cycle, time) + (running ? 40 : 0);
    const next = memory * indoor + (1 - memory) * equilibrium;
    const observed = indoor + random() * 0.02;
    const nextObserved = next + random() * 0.02;
    if (!running) {
      transitions.push({
        fromTime: time, toTime: time + STEP_MINUTES * 60_000, value: observed, nextValue: nextObserved,
        knownDrive: outdoor, regressors: [1], dtHours, weight: 1,
      });
    }
    indoor = next;
  }
  // Stitching: consecutive kept steps must share an observed boundary value.
  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1]!;
    const current = transitions[index]!;
    if (previous.toTime === current.fromTime) current.value = previous.nextValue;
  }
  return transitions;
}

const options = { minimumTauHours: 2, maximumTauHours: 1_000, scaleFloor: 0.005 };

describe("relaxation fitting", () => {
  it("finds the time constant on a continuous log scale and reports search limits", () => {
    const search = searchTimeConstant((tau) => (Math.log(tau) - Math.log(137)) ** 2, 2, 1_000);
    expect(search?.tauHours).toBeCloseTo(137, 0);
    expect(search?.atLowerLimit).toBe(false);
    expect(search?.atUpperLimit).toBe(false);
    expect(searchTimeConstant((tau) => -tau, 2, 1_000)?.atUpperLimit).toBe(true);
    expect(searchTimeConstant(() => null, 2, 1_000)).toBeNull();
  });

  it("recovers a daily cycle's amplitude and peak hour from its harmonics", () => {
    const [sin, cos] = dailyHarmonics(Date.parse("2026-01-01T15:00:00Z"));
    const cycle = dailyCycleFromHarmonics(0.6 * sin, 0.6 * cos);
    expect(cycle.amplitude).toBeCloseTo(0.6, 12);
    expect(cycle.peakHourUtc).toBeCloseTo(15, 9);
    expect(dailyCycleValue(cycle, Date.parse("2026-01-03T15:00:00Z"))).toBeCloseTo(0.6, 12);
    expect(dailyCycleValue(cycle, Date.parse("2026-01-03T03:00:00Z"))).toBeCloseTo(-0.6, 12);
  });

  it("keeps every passive stretch above the minimum length, not just the longest", () => {
    const transitions = thermalFixture({ tauHours: 60, liftC: 3, cycle: null }, 4, (hour) => hour % 6 >= 4);
    const usable = usableStretches(transitions, 2);
    expect(usable.stretches).toBe(16);
    expect(usable.transitions).toHaveLength(transitions.length);
    expect(usableStretches(transitions, 5).stretches).toBe(0);
  });

  // Gate for W4: a known time constant is recovered within ±10% under several cycling patterns.
  // With a long time constant the daily forcing barely moves the indoor
  // temperature (about 0.02 °C here), so the cycle is only required where
  // it is observable above the noise.
  it.each([
    ["continuous", () => false, 60, 7, true],
    ["4 h on / 8 h off", (hour: number) => hour % 12 < 4, 60, 10, true],
    ["2 h on / 3 h off", (hour: number) => hour % 5 < 2, 90, 14, true],
    ["nightly heating 22–06", (hour: number) => hour % 24 >= 22 || hour % 24 < 6, 140, 14, false],
    ["long-memory house, 1 h on / 2 h off", (hour: number) => hour % 3 < 1, 320, 21, false],
  ] as const)("recovers the time constant within 10%% with %s operation", (_name, pumpRuns, tauHours, days, cycleObservable) => {
    const truth: Truth = { tauHours, liftC: 3, cycle: { amplitude: 0.8, peakHourUtc: 13 } };
    const transitions = usableStretches(thermalFixture(truth, days, pumpRuns), 2).transitions;
    const calibration = runSteps(calibrateRelaxationSteps(transitions, options));
    expect(calibration).not.toBeNull();
    expect(Math.abs(calibration!.parameters.tauHours / tauHours - 1)).toBeLessThanOrEqual(0.1);
    if (cycleObservable) {
      expect(calibration!.dailyCycle).toBe(true);
      const cycle = dailyCycleFromHarmonics(calibration!.parameters.coefficients[1]!, calibration!.parameters.coefficients[2]!);
      expect(Math.abs(cycle.amplitude - 0.8)).toBeLessThan(0.15);
      expect(Math.abs(cycle.peakHourUtc - 13)).toBeLessThan(1);
      // Without the cycle term the lift absorbs the cycle's mean over the passive hours.
      expect(Math.abs(calibration!.parameters.coefficients[0]! - 3)).toBeLessThan(0.5);
    }
    // The bootstrap interval brackets the truth and is reported in order.
    expect(calibration!.interval).not.toBeNull();
    expect(calibration!.interval!.low).toBeLessThanOrEqual(calibration!.interval!.high);
    expect(calibration!.interval!.low).toBeLessThanOrEqual(tauHours * 1.1);
    expect(calibration!.interval!.high).toBeGreaterThanOrEqual(tauHours * 0.9);
  });

  it("drops the daily term when the data has no daily cycle", () => {
    const transitions = thermalFixture({ tauHours: 50, liftC: 2, cycle: null }, 7, () => false);
    const calibration = runSteps(calibrateRelaxationSteps(transitions, options));
    expect(calibration?.dailyCycle).toBe(false);
    expect(calibration?.parameters.coefficients).toHaveLength(1);
  });

  it("widens the bootstrap interval when the data carries less information", () => {
    const truth: Truth = { tauHours: 80, liftC: 3, cycle: null };
    const fit = (transitions: RelaxationTransition[]) => (tau: number) => {
      const coefficients = fitCoefficients(transitions, tau, 0.005);
      return coefficients ? { tauHours: tau, coefficients } : null;
    };
    const long = thermalFixture(truth, 21, () => false, 3);
    const short = thermalFixture(truth, 3, () => false, 3);
    const longInterval = blockBootstrapTimeConstant({ transitions: long, fit: fit(long), minimumHours: 2, maximumHours: 1_000 })!;
    const shortInterval = blockBootstrapTimeConstant({ transitions: short, fit: fit(short), minimumHours: 2, maximumHours: 1_000 })!;
    expect(longInterval.high / longInterval.low).toBeLessThan(shortInterval.high / shortInterval.low);
    // Reproducible: the seed comes from the data.
    expect(blockBootstrapTimeConstant({ transitions: long, fit: fit(long), minimumHours: 2, maximumHours: 1_000, seed: 1 }))
      .toEqual(blockBootstrapTimeConstant({ transitions: long, fit: fit(long), minimumHours: 2, maximumHours: 1_000, seed: 1 }));
  });
});
