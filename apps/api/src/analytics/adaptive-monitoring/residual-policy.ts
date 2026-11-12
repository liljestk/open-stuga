import { median, medianAbsoluteDeviation, quantile } from "@climate-twin/analytics-kernel";
import { ADAPTIVE_MATERIALITY, type AdaptiveMetric, type AdaptiveResidualCalibration } from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";

export interface ResidualEvidence {
  time: number;
  availableAt: number;
  error: number;
}

/** Only earlier outcomes known at prediction time may calibrate that prediction. */
export function calibrateResiduals(input: {
  errors: readonly ResidualEvidence[];
  predictedAt: number;
  metric: AdaptiveMetric;
}): AdaptiveResidualCalibration | null {
  const errors = input.errors.filter((point) => point.time < input.predictedAt
    && point.time >= input.predictedAt - 168 * HOUR_MS
    && point.availableAt <= input.predictedAt && Number.isFinite(point.error))
    .map((point) => point.error);
  if (errors.length < 120) return null;
  const bias = median(errors)!;
  const centered = errors.map((error) => error - bias);
  const scale = 1.4826 * medianAbsoluteDeviation(centered)!;
  return {
    bias,
    scale,
    threshold: Math.max(quantile(centered.map(Math.abs), 0.99)!, 3 * scale, ADAPTIVE_MATERIALITY[input.metric]),
    count: errors.length,
  };
}

export interface DepartureState {
  recent: Array<{ time: number; direction: "higher" | "lower" | null }>;
  direction: "higher" | "lower" | null;
  frozenAt: number | null;
  recoveringHours: number;
}

export function initialDepartureState(): DepartureState {
  return { recent: [], direction: null, frozenAt: null, recoveringHours: 0 };
}

/** Missing hours reset continuity but preserve an unresolved departure. */
export function interruptDeparture(state: DepartureState): void {
  state.recent = [];
  state.recoveringHours = 0;
}

export function advanceDeparture(state: DepartureState, input: {
  time: number;
  centeredError: number;
  threshold: number;
}) {
  const last = state.recent.at(-1);
  if (last && input.time - last.time !== HOUR_MS) interruptDeparture(state);
  const direction = Math.abs(input.centeredError) > input.threshold
    ? input.centeredError > 0 ? "higher" as const : "lower" as const : null;
  if (direction && state.frozenAt === null) state.frozenAt = input.time;
  state.recent.push({ time: input.time, direction });
  state.recent = state.recent.slice(-3);
  const opened = state.direction === null && direction !== null
    && state.recent.filter((point) => point.direction === direction).length >= 2;
  if (opened) state.direction = direction;
  state.recoveringHours = Math.abs(input.centeredError) <= 0.6 * input.threshold
    ? state.recoveringHours + 1 : 0;
  const resolved = state.recoveringHours >= 3;
  const wasActive = state.direction !== null;
  if (resolved) Object.assign(state, initialDepartureState());
  return { opened, resolved: resolved && wasActive, direction };
}
