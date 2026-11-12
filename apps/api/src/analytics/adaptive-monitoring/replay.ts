import {
  ADAPTIVE_MONITORING_VERSION,
  type AdaptiveHourlyEvidence,
  type AdaptiveMetric,
  type AdaptiveReplayPoint,
  type AdaptiveReplayResult,
  type AdaptiveResidualCalibration,
} from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";
import { evidenceByHour, type EvidencePolicy } from "./evidence.js";
import {
  advanceDeparture, calibrateResiduals, initialDepartureState, interruptDeparture,
  type ResidualEvidence, type DepartureState,
} from "./residual-policy.js";

export interface AdaptiveReplayInput {
  evidence: readonly AdaptiveHourlyEvidence[];
  policy: EvidencePolicy;
  metric: AdaptiveMetric;
  baseline: AdaptiveReplayResult["baseline"];
  from: number;
  to: number;
  /** Known transition instants, never inferred from later outcomes. */
  contextTransitions?: readonly number[];
}

function assertReplayRange(input: AdaptiveReplayInput): void {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to)
    || input.from % HOUR_MS !== 0 || input.to % HOUR_MS !== 0 || input.to <= input.from
    || (input.to - input.from) / HOUR_MS > 50_000 || input.evidence.length > 50_000
    || (input.contextTransitions?.length ?? 0) > 50_000) {
    throw new RangeError("Replay requires a nonempty UTC-hour range and at most 50000 input/output hours");
  }
}

interface ReplayState {
  errors: ResidualEvidence[];
  departure: DepartureState;
  frozenCalibration: AdaptiveResidualCalibration | null;
  candidateEpisodes: number;
  expired: boolean;
}

function abstention(input: {
  expired: boolean;
  guarded: boolean;
  target: AdaptiveHourlyEvidence | undefined;
  predicted: number | null;
  calibration: AdaptiveResidualCalibration | null;
}): AdaptiveReplayPoint["reason"] {
  if (input.expired) return "expired-model";
  if (input.guarded) return "context-guard";
  if (!input.target) return "missing-target";
  if (input.predicted === null) return "insufficient-history";
  if (!input.calibration) return "insufficient-calibration";
  return null;
}

function scorePoint(runtime: ReplayState, point: AdaptiveReplayPoint): void {
  if (point.reason) {
    interruptDeparture(runtime.departure);
    point.episode = runtime.expired ? "expired" : runtime.departure.direction ? "stale" : "none";
    return;
  }
  const transition = advanceDeparture(runtime.departure, {
    time: point.time,
    centeredError: point.observed! - point.predicted! - point.calibration!.bias,
    threshold: point.calibration!.threshold,
  });
  runtime.frozenCalibration = runtime.departure.frozenAt !== null ? point.calibration : null;
  if (transition.opened) runtime.candidateEpisodes += 1;
  point.direction = runtime.departure.direction;
  point.episode = transition.resolved ? "resolved" : runtime.departure.direction ? "candidate" : "none";
}

function replayHour(runtime: ReplayState, input: {
  time: number;
  byHour: ReadonlyMap<number, AdaptiveHourlyEvidence>;
  options: AdaptiveReplayInput;
  guardedHours: ReadonlySet<number>;
}): AdaptiveReplayPoint {
  const { time, byHour, options } = input;
  const recorded = byHour.get(time);
  const target = recorded && recorded.availableAt <= time + HOUR_MS ? recorded : undefined;
  const prior = byHour.get(time - (options.baseline === "persistence" ? 1 : 24) * HOUR_MS);
  const predicted = prior && prior.availableAt <= time ? prior.value : null;
  const calibration = runtime.frozenCalibration ?? calibrateResiduals({ errors: runtime.errors, predictedAt: time, metric: options.metric });
  if (runtime.departure.frozenAt !== null && time - runtime.departure.frozenAt >= 168 * HOUR_MS) runtime.expired = true;
  const guarded = input.guardedHours.has(time);
  const point: AdaptiveReplayPoint = {
    time, predictedAt: time, predicted, observed: target?.value ?? null,
    calibration, direction: runtime.departure.direction, episode: "none",
    reason: abstention({ expired: runtime.expired, guarded, target, predicted, calibration }),
  };
  scorePoint(runtime, point);
  // Score first. A first breach and all frozen/guarded/expired hours are excluded.
  const mayCalibrate = runtime.departure.frozenAt === null && !guarded && !runtime.expired;
  if (target && predicted !== null && mayCalibrate) {
    runtime.errors.push({ time, availableAt: target.availableAt, error: target.value - predicted });
  }
  while (runtime.errors.length && runtime.errors[0]!.time < time - 168 * HOUR_MS) runtime.errors.shift();
  return point;
}

function contextGuardHours(transitions: readonly number[]): Set<number> {
  const guarded = new Set<number>();
  for (const transition of transitions) {
    if (!Number.isSafeInteger(transition)) throw new RangeError("Context transitions must be finite timestamp integers");
    const first = Math.ceil(transition / HOUR_MS) * HOUR_MS;
    guarded.add(first);
    guarded.add(first + HOUR_MS);
  }
  return guarded;
}

/** Fixed causal baselines establish a comparison floor, never a production champion. */
export function replayAdaptiveBaseline(input: AdaptiveReplayInput): AdaptiveReplayResult {
  assertReplayRange(input);
  const byHour = evidenceByHour(input.evidence, input.policy);
  const guardedHours = contextGuardHours(input.contextTransitions ?? []);
  const runtime: ReplayState = {
    errors: [], departure: initialDepartureState(), frozenCalibration: null, candidateEpisodes: 0, expired: false,
  };
  const points: AdaptiveReplayPoint[] = [];
  for (let time = input.from; time < input.to; time += HOUR_MS) {
    points.push(replayHour(runtime, { time, byHour, options: input, guardedHours }));
  }
  const scoredHours = points.filter((point) => point.reason === null).length;
  return {
    algorithmVersion: ADAPTIVE_MONITORING_VERSION, purpose: "retrospective-baseline", advisoryEligible: false,
    baseline: input.baseline, points, scoredHours, abstainedHours: points.length - scoredHours,
    candidateEpisodes: runtime.candidateEpisodes,
  };
}
