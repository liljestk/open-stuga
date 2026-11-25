import { maximum, mean, minimum } from "@climate-twin/analytics-kernel";
import type { AdaptiveHourlyEvidence, AdaptiveMetric } from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";
import {
  CausalClimatePredictor, climateBaselines, outdoorHours, tuneClimatePolicies,
  type AdaptiveOutdoorHour, type ClimateInputs, type ClimateModelPolicy,
} from "./climate-prediction.js";
import { auditAdaptiveReadiness, evidenceByHour, type EvidencePolicy } from "./evidence.js";
import { calibrateResiduals, type ResidualEvidence } from "./residual-policy.js";

export const ADAPTIVE_CLIMATE_QUALIFICATION_VERSION = "adaptive-climate-qualification/v1";

const MIN_HOURLY_OVERLAP = 0.8;
const MIN_SKILL_GAIN = 0.05;
const MIN_RANGE_COVERAGE = 0.95;
const MAX_INPUTS = 50_000;

interface ContextTransition {
  occurredAt: number;
  availableAt: number;
}

interface QualificationInput {
  evidence: readonly AdaptiveHourlyEvidence[];
  outdoor?: readonly AdaptiveOutdoorHour[];
  contextTransitions?: readonly ContextTransition[];
  policy: EvidencePolicy;
  metric: AdaptiveMetric;
  evaluatedAt: number;
  signal?: AbortSignal;
}

interface AnalysisHours {
  climate: ClimateInputs;
  targets: AdaptiveHourlyEvidence[];
}

interface ForecastEvidence {
  target: AdaptiveHourlyEvidence;
  predicted: number;
  persistence: number | null;
  seasonal: number | null;
}

interface PairedSkill {
  pairedHours: number;
  eligibleHours: number;
  modelMae: number | null;
  persistenceMae: number | null;
  seasonalMae: number | null;
  gainAgainstBestBaseline: number | null;
}

interface RangeSkill {
  eligibleHours: number;
  scoredHours: number;
  insideHours: number;
  coverage: number | null;
  width: number | null;
  /** Sensitivity to dropping a whole UTC day preserves within-day dependence. */
  leaveOneDayOut: { days: number; low: number; high: number } | null;
}

interface CandidateResult {
  policy: ClimateModelPolicy;
  skill: PairedSkill;
}

interface EvaluationResult {
  holdout: PairedSkill;
  range: RangeSkill;
  calibration: ReturnType<typeof calibrateResiduals>;
}

function guardAvailability(transitions: readonly ContextTransition[]): Map<number, number> {
  const guarded = new Map<number, number>();
  for (const event of transitions) {
    if (!Number.isSafeInteger(event.occurredAt) || !Number.isSafeInteger(event.availableAt)
      || event.availableAt < event.occurredAt) throw new RangeError("Invalid adaptive context transition");
    const first = Math.ceil(event.occurredAt / HOUR_MS) * HOUR_MS;
    for (const time of [first, first + HOUR_MS]) {
      guarded.set(time, Math.min(event.availableAt, guarded.get(time) ?? Number.POSITIVE_INFINITY));
    }
  }
  return guarded;
}

function analysisHours(climate: ClimateInputs, block: { from: number; to: number }, guarded: Map<number, number>): AnalysisHours {
  const targets: AdaptiveHourlyEvidence[] = [];
  for (let time = block.from; time < block.to; time += HOUR_MS) {
    const target = climate.target.get(time);
    if (target && target.availableAt <= block.to && target.availableAt < (guarded.get(time) ?? Number.POSITIVE_INFINITY)) {
      targets.push(target);
    }
  }
  return { climate, targets };
}

function forecastEvidence(
  hours: AnalysisHours,
  policy: ClimateModelPolicy,
  signal?: AbortSignal,
): ForecastEvidence[] {
  const predictor = new CausalClimatePredictor(hours.climate, policy);
  return hours.targets.flatMap((target) => {
    signal?.throwIfAborted();
    const predicted = predictor.predict(target.time);
    if (predicted === null || !Number.isFinite(predicted)) return [];
    return [{ target, predicted, ...climateBaselines(hours.climate.target, target.time) }];
  });
}

type PairedForecast = ForecastEvidence & { persistence: number; seasonal: number };

function pairedForecast(row: ForecastEvidence): row is PairedForecast {
  return row.persistence !== null && row.seasonal !== null;
}

function pairedSkill(rows: PairedForecast[], eligibleHours: number): PairedSkill {
  const modelMae = mean(rows.map(({ target, predicted }) => Math.abs(target.value - predicted)));
  const persistenceMae = mean(rows.map(({ target, persistence }) => Math.abs(target.value - persistence)));
  const seasonalMae = mean(rows.map(({ target, seasonal }) => Math.abs(target.value - seasonal)));
  const baseline = persistenceMae !== null && seasonalMae !== null ? Math.min(persistenceMae, seasonalMae) : null;
  // A periodic series can leave tiny roundoff in a numerically perfect baseline.
  const roundoff = 16 * Number.EPSILON * Math.max(1, maximum(rows.map(({ target }) => Math.abs(target.value))) ?? 0);
  return {
    pairedHours: rows.length, eligibleHours, modelMae, persistenceMae, seasonalMae,
    gainAgainstBestBaseline: baseline !== null && baseline > roundoff && modelMae !== null ? 1 - modelMae / baseline : null,
  };
}

function enoughOverlap(skill: PairedSkill): boolean {
  return skill.eligibleHours > 0 && skill.pairedHours / skill.eligibleHours >= MIN_HOURLY_OVERLAP;
}

function selectionResults(hours: AnalysisHours, policies: ClimateModelPolicy[], signal?: AbortSignal): CandidateResult[] {
  const candidates = policies.map((policy) => ({
    policy, rows: forecastEvidence(hours, policy, signal).filter(pairedForecast),
  })).filter(({ rows }) => hours.targets.length > 0 && rows.length / hours.targets.length >= MIN_HOURLY_OVERLAP);
  const intersection = candidates.reduce<Set<number> | null>((common, candidate) =>
    new Set(candidate.rows.map((row) => row.target.time).filter((time) => !common || common.has(time))), null);
  return candidates.map(({ policy, rows }) => ({
    policy, skill: pairedSkill(rows.filter((row) => intersection?.has(row.target.time)), hours.targets.length),
  })).sort((left, right) => (left.skill.modelMae ?? Number.POSITIVE_INFINITY) - (right.skill.modelMae ?? Number.POSITIVE_INFINITY));
}

function residualEvidence(rows: ForecastEvidence[]): ResidualEvidence[] {
  return rows.map(({ target, predicted }) => ({ time: target.time, availableAt: target.availableAt, error: target.value - predicted }));
}

function rangeSkill(
  rows: ForecastEvidence[],
  calibration: EvaluationResult["calibration"],
  eligibleHours: number,
): RangeSkill {
  if (!calibration) return {
    eligibleHours, scoredHours: 0, insideHours: 0, coverage: null, width: null, leaveOneDayOut: null,
  };
  const days = new Map<number, { scored: number; inside: number }>();
  let insideHours = 0;
  for (const { target, predicted } of rows) {
    const key = Math.floor(target.time / (24 * HOUR_MS));
    const day = days.get(key) ?? { scored: 0, inside: 0 };
    const inside = Number(Math.abs(target.value - predicted - calibration.bias) <= calibration.threshold);
    day.scored += 1;
    day.inside += inside;
    insideHours += inside;
    days.set(key, day);
  }
  const leaveOneOut = days.size >= 2
    ? [...days.values()].map((day) => (insideHours - day.inside) / (rows.length - day.scored))
    : [];
  return {
    eligibleHours, scoredHours: rows.length, insideHours,
    coverage: rows.length ? insideHours / rows.length : null, width: 2 * calibration.threshold,
    leaveOneDayOut: leaveOneOut.length
      ? { days: days.size, low: minimum(leaveOneOut)!, high: maximum(leaveOneOut)! }
      : null,
  };
}

function evaluateHoldout(input: {
  calibrationHours: AnalysisHours; finalHours: AnalysisHours; candidate: ClimateModelPolicy;
  from: number; metric: AdaptiveMetric; signal?: AbortSignal;
}): EvaluationResult {
  const { calibrationHours, finalHours, candidate, from, metric, signal } = input;
  const calibration = calibrateResiduals({
    errors: residualEvidence(forecastEvidence(calibrationHours, candidate, signal)), predictedAt: from, metric,
  });
  const finalRows = forecastEvidence(finalHours, candidate, signal);
  return {
    holdout: pairedSkill(finalRows.filter(pairedForecast), finalHours.targets.length),
    range: rangeSkill(finalRows, calibration, finalHours.targets.length),
    calibration,
  };
}

function evaluationFailure(evaluation: EvaluationResult) {
  if (!enoughOverlap(evaluation.holdout)) return "holdout-overlap";
  if ((evaluation.holdout.gainAgainstBestBaseline ?? -Infinity) < MIN_SKILL_GAIN) return "holdout-forecast-skill";
  if (!evaluation.calibration) return "insufficient-calibration";
  if ((evaluation.range.coverage ?? 0) < MIN_RANGE_COVERAGE) return "holdout-range-coverage";
  return null;
}

/** Retrospective technical screen. Event and prospective rollout gates are evaluated separately. */
export function qualifyAdaptiveClimateModel(input: QualificationInput) {
  if (!Number.isSafeInteger(input.evaluatedAt) || !Number.isSafeInteger(input.policy.trustworthyFrom)
    || input.evidence.length + (input.outdoor?.length ?? 0) + (input.contextTransitions?.length ?? 0) > MAX_INPUTS) {
    throw new RangeError("Adaptive climate qualification requires a bounded, timestamped input");
  }
  input.signal?.throwIfAborted();
  const readiness = auditAdaptiveReadiness({ ...input, byBlockBoundary: true });
  const details = {
    algorithmVersion: ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, advisoryEligible: false as const, blocks: readiness.blocks,
  };
  if (readiness.state === "collecting") {
    return { ...details, state: "collecting" as const, reason: "evidence-coverage" as const, candidates: [], evaluation: null };
  }
  const climate = { target: evidenceByHour(input.evidence, input.policy), outdoor: outdoorHours(input.outdoor ?? []) };
  const guarded = guardAvailability(input.contextTransitions ?? []);
  const selection = readiness.blocks[1]!;
  const candidates = selectionResults(
    analysisHours(climate, selection, guarded), tuneClimatePolicies(climate, input.metric, selection.from), input.signal,
  );
  const chosen = candidates[0];
  if (!chosen || !enoughOverlap(chosen.skill)) {
    return { ...details, state: "rejected" as const, reason: "selection-overlap" as const, candidates, evaluation: null };
  }
  const evaluation = evaluateHoldout({
    calibrationHours: analysisHours(climate, readiness.blocks[2]!, guarded),
    finalHours: analysisHours(climate, readiness.blocks[3]!, guarded),
    candidate: chosen.policy, from: readiness.blocks[3]!.from, metric: input.metric,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const reason = evaluationFailure(evaluation);
  return { ...details, state: reason ? "rejected" as const : "technical-pass" as const, reason, candidates, evaluation };
}
