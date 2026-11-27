import { maximum, median, medianAbsoluteDeviation, minimum, quantile } from "@climate-twin/analytics-kernel";
import { HOUR_MS } from "../forecast/models.js";

export const REFERENCE_COMPARISON_VERSION = "adaptive-reference-comparison/v1";
export const REFERENCE_DAY_HOURS = 24;
const WEEK_HOURS = 168;
const MIN_PAIRED_COVERAGE = 0.8;

export interface ReferencePair {
  hour: number;
  availableAt: number;
  offset: number;
  spread: number;
}

export interface ReferenceCalibration {
  offset: number;
  scale: number;
  threshold: number;
  peerSpreadLimit: number;
  pairedHours: number;
  holdoutCoverage: number;
}

export interface ReferenceQualification {
  calibration: ReferenceCalibration | null;
  usableHours: number[];
}

export function pairTemperatures(input: {
  hour: number; availableAt: number; target: number; references: number[];
}): ReferencePair {
  return {
    hour: input.hour, availableAt: input.availableAt,
    offset: input.target - median(input.references)!,
    spread: maximum(input.references)! - minimum(input.references)!,
  };
}

export function peersAgree(pair: ReferencePair, limit: number): boolean {
  return pair.spread <= limit + 1e-9;
}

export function qualifyReferencePairs(pairs: ReferencePair[], from: number): ReferenceQualification {
  const weeks = Array.from({ length: 4 }, (_, index) => {
    const start = from + index * WEEK_HOURS * HOUR_MS;
    const end = start + WEEK_HOURS * HOUR_MS;
    return pairs.filter((pair) => pair.hour >= start && pair.hour < end && pair.availableAt <= end);
  });
  const [fit, selection, training, holdout] = weeks as [ReferencePair[], ReferencePair[], ReferencePair[], ReferencePair[]];
  const spreads = fit.map((pair) => pair.spread);
  const center = median(spreads);
  if (center === null) return { calibration: null, usableHours: weeks.map((week) => week.length) };
  const peerSpreadLimit = Math.max(quantile(spreads, 0.99)!, center + 4 * 1.4826 * medianAbsoluteDeviation(spreads, center)!);
  const agreed = [selection, training, holdout].map((week) => week.filter((pair) => peersAgree(pair, peerSpreadLimit)));
  const usableHours = [fit.length, ...agreed.map((week) => week.length)];
  const calibrationPairs = agreed[1]!;
  if (usableHours.some((count) => count / WEEK_HOURS < MIN_PAIRED_COVERAGE) || calibrationPairs.length < 120) {
    return { calibration: null, usableHours };
  }
  const offsets = calibrationPairs.map((pair) => pair.offset);
  const offset = median(offsets)!;
  const scale = 1.4826 * medianAbsoluteDeviation(offsets, offset)!;
  const threshold = Math.max(0.7, 4 * scale);
  const evaluation = agreed[2]!;
  const holdoutCoverage = evaluation.filter((pair) => Math.abs(pair.offset - offset) <= threshold).length / evaluation.length;
  return {
    usableHours,
    calibration: holdoutCoverage >= 0.95
      ? { offset, scale, threshold, peerSpreadLimit, pairedHours: calibrationPairs.length, holdoutCoverage }
      : null,
  };
}

export type ReferenceDirection = "higher" | "lower";
export type ReferenceState = "normal" | "candidate" | "stale" | "resolved" | "collecting";

export function assessReferenceDay(input: {
  hour: number; pairs: ReferencePair[]; calibration: ReferenceCalibration; active: ReferenceDirection | null;
}): { state: ReferenceState; direction: ReferenceDirection | null; offsetChange: number | null } {
  const { hour, pairs, calibration, active } = input;
  const present = new Set(pairs.map((pair) => pair.hour));
  let gap = 0;
  let longest = 0;
  for (let offset = REFERENCE_DAY_HOURS - 1; offset >= 0; offset--) {
    gap = present.has(hour - offset * HOUR_MS) ? 0 : gap + 1;
    longest = Math.max(longest, gap);
  }
  if (!present.has(hour) || present.size < 18 || longest > 2) {
    return { state: active ? "stale" : "collecting", direction: active, offsetChange: null };
  }
  const offsetChange = median(pairs.map((pair) => pair.offset))! - calibration.offset;
  if (active) {
    return Math.abs(offsetChange) <= calibration.threshold / 2
      ? { state: "resolved", direction: active, offsetChange }
      : { state: "candidate", direction: active, offsetChange };
  }
  return Math.abs(offsetChange) > calibration.threshold
    ? { state: "candidate", direction: offsetChange > 0 ? "higher" : "lower", offsetChange }
    : { state: "normal", direction: null, offsetChange };
}
