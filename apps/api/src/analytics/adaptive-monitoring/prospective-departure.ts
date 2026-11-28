import type { AdaptiveMetric, AdaptiveResidualCalibration } from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";
import { advanceDeparture, calibrateResiduals, initialDepartureState, interruptDeparture, type ResidualEvidence } from "./residual-policy.js";
import type { ClimateContextGuard } from "./climate-context.js";

export const FROZEN_MODEL_LIFETIME_MS = 168 * HOUR_MS;

export type EpisodeState = "candidate" | "stale" | "resolved" | "expired";
type Direction = "higher" | "lower";

export interface DetectorState {
  departure: ReturnType<typeof initialDepartureState>;
  frozen: { calibration: AdaptiveResidualCalibration; issuedAt: number; detectedAt: number } | null;
  episodeState: EpisodeState | null;
  expired: boolean;
}

export interface DetectorHour {
  hour: number;
  issuedAt: number | null;
  frozenAt: number | null;
  error: number | null;
  issue: "missing-prediction" | "missing-observation" | null;
}

interface EpisodeRevision { state: EpisodeState; direction: Direction }

export function initialDetectorState(): DetectorState {
  return { departure: initialDepartureState(), frozen: null, episodeState: null, expired: false };
}

function transitionEpisode(state: DetectorState, direction: Direction | null, change: EpisodeState): EpisodeRevision | null {
  if (!direction || state.episodeState === change) return null;
  state.episodeState = change;
  return { state: change, direction };
}

export function detectProspectiveDeparture(input: {
  state: DetectorState;
  sample: DetectorHour;
  now: number;
  metric: AdaptiveMetric;
  history: readonly ResidualEvidence[];
  guard?: ClimateContextGuard;
}) {
  const { state, sample, now, metric, history } = input;
  if (state.expired || (state.departure.frozenAt !== null && sample.hour - state.departure.frozenAt >= FROZEN_MODEL_LIFETIME_MS)) {
    state.expired = true;
    return { calibration: state.frozen?.calibration ?? null, admitted: false, reason: "expired-model",
      revision: transitionEpisode(state, state.departure.direction, "expired") };
  }
  if (input.guard) {
    interruptDeparture(state.departure);
    return { calibration: state.frozen?.calibration ?? null, admitted: false, reason: "context-guard",
      revision: transitionEpisode(state, state.departure.direction, "stale") };
  }
  const inconsistentFreeze = state.frozen && sample.issuedAt !== null && sample.issuedAt >= state.frozen.detectedAt
    && sample.frozenAt !== state.frozen.issuedAt;
  if (sample.issue || inconsistentFreeze || sample.error === null || sample.issuedAt === null) {
    interruptDeparture(state.departure);
    return { calibration: state.frozen?.calibration ?? null, admitted: false,
      reason: sample.issue ?? (inconsistentFreeze ? "awaiting-frozen-forecast" : "missing-observation"),
      revision: transitionEpisode(state, state.departure.direction, "stale") };
  }
  const calibration = state.frozen?.calibration ?? calibrateResiduals({ errors: history, predictedAt: sample.issuedAt, metric });
  if (!calibration) return { calibration: null, admitted: true, reason: "insufficient-calibration", revision: null };
  const priorDirection = state.departure.direction;
  const wasFrozen = state.frozen !== null;
  const transition = advanceDeparture(state.departure, {
    time: sample.hour, centeredError: sample.error - calibration.bias, threshold: calibration.threshold,
  });
  if (!wasFrozen && state.departure.frozenAt !== null) state.frozen = { calibration, issuedAt: sample.issuedAt, detectedAt: now };
  if (state.departure.frozenAt === null) state.frozen = null;
  const revision = transition.resolved
    ? transitionEpisode(state, priorDirection, "resolved")
    : transitionEpisode(state, state.departure.direction, "candidate");
  const admitted = !wasFrozen && state.frozen === null;
  return { calibration, admitted, reason: admitted ? "calibrated" : "frozen-calibration", revision };
}
