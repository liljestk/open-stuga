import { median, medianAbsoluteDeviation, mean, quantile } from "@climate-twin/analytics-kernel";
import {
  ADAPTIVE_DEFAULTS, type AdaptiveEvaluation, type AdaptiveModelFamily,
} from "@climate-twin/contracts";
import { fitProfileForecaster, fitThermalForecaster, lookup, restoreForecaster } from "../forecast/models.js";
import type { AdaptiveAnalysis, AdaptiveFitInput, AdaptiveFitResult, AdaptiveHour, AdaptiveStoredStream } from "./evidence.js";
import { DAY, HOUR } from "./evidence.js";

/** All candidates are made before the target; qualification uses this ledger, never a refit into the past. */
export function predictAdaptiveHour(input: AdaptiveFitInput): AdaptiveFitResult {
  const past = input.hours.filter(h => h.value !== null && h.time <= input.until && h.availableAt <= input.until && !h.guarded);
  const latest = past.at(-1);
  const targetTime = input.targetTime ?? Math.floor(input.until / HOUR) * HOUR + HOUR;
  const anchor = input.anchorBefore ? past.filter(h => h.time < input.anchorBefore!).at(-1) : latest;
  if (!latest || !anchor || anchor.value === null || input.until >= targetTime || latest.time < targetTime - HOUR) return {};
  const horizon = Math.round((targetTime - anchor.time) / HOUR);
  if (horizon < 1 || horizon > 168) return {};
  const cutoff = input.frozenAt ?? Math.floor(latest.time / DAY) * DAY;
  const history = past.filter(h => h.time >= cutoff - 14 * DAY && h.time <= anchor.time).map(h => ({ time: h.time, value: h.value! }));
  const outdoor = lookup(past.flatMap(h => h.outdoor === null ? [] : [{ time: h.time, value: h.outdoor }]));
  const previous = past.flatMap(h => Object.values(h.predictions)).filter(p => p.cutoff === cutoff && p.parameters);
  const profile = previous.find(p => p.parameters?.kind === "daily-profile")?.parameters;
  const thermal = previous.find(p => p.parameters?.kind === "thermal-relaxation")?.parameters;
  const candidates = [profile ? restoreForecaster(profile, history, outdoor) : fitProfileForecaster(history, cutoff),
    input.metric !== "temperature" ? null : thermal ? restoreForecaster(thermal, history, outdoor) : fitThermalForecaster(history, outdoor, cutoff)];
  const result: AdaptiveFitResult = {};
  for (const model of candidates) {
    const value = model?.forecast(anchor.time, anchor.value, horizon)?.at(-1);
    if (model && value !== undefined && Number.isFinite(value)) {
      result[model.kind] = { value, madeAt: input.until, cutoff, ...(model.snapshot ? { parameters: model.snapshot } : {}) };
    }
  }
  return result;
}

function error(h: AdaptiveHour, family: AdaptiveModelFamily): number | null {
  const p = h.predictions[family];
  return h.value !== null && p && p.madeAt < h.time && p.cutoff < h.time
    && h.availableAt >= h.time && !h.guarded ? h.value - p.value : null;
}
function candidateErrors(hours: AdaptiveHour[], family: AdaptiveModelFamily): number[] {
  return hours.flatMap(h => { const e = error(h, family); return e === null ? [] : [e]; });
}
function chooseFamily(hours: AdaptiveHour[]): AdaptiveModelFamily | null {
  let best: AdaptiveModelFamily | null = null;
  let loss = Infinity;
  for (const family of ["daily-profile", "thermal-relaxation"] as const) {
    const errors = candidateErrors(hours, family);
    if (errors.length < 120) continue;
    const mae = mean(errors.map(Math.abs))!;
    if (mae < loss) { best = family; loss = mae; }
  }
  return best;
}

function climateScore(hours: AdaptiveHour[], current: AdaptiveHour, options: {
  family: AdaptiveModelFamily; materiality: number; calibrationBefore: number | null;
}): AdaptiveHour["score"] {
  const end = Math.min(current.time, options.calibrationBefore ?? current.time);
  const errors = candidateErrors(hours.filter(h => h.time < end && h.time >= end - 7 * DAY && !h.excluded), options.family);
  const prediction = current.predictions[options.family];
  if (errors.length < ADAPTIVE_DEFAULTS.calibrationHours || !prediction || current.value === null
    || prediction.madeAt >= current.time || prediction.cutoff >= current.time || current.guarded) return null;
  const bias = median(errors)!;
  const centered = errors.map(e => e - bias);
  const threshold = Math.max(quantile(centered.map(Math.abs), 0.99)!, 3 * 1.4826 * medianAbsoluteDeviation(centered)!, options.materiality);
  const expected = prediction.value + bias;
  return { expected, threshold, residual: current.value - expected };
}
function referenceBaseline(hours: AdaptiveHour[], start: number): AdaptiveStoredStream["runtime"]["referenceBaseline"] {
  const offsets = hours.filter(h => h.time >= start && h.time < start + 14 * DAY && h.value !== null && h.peer !== null && !h.guarded)
    .map(h => h.value! - h.peer!);
  if (offsets.length < 120) return undefined;
  return { offset: median(offsets)!, threshold: Math.max(0.7, 4 * 1.4826 * medianAbsoluteDeviation(offsets)!),
    cutoff: start + 14 * DAY, samples: offsets.length,
    peerSpread: median(hours.filter(h => h.time >= start && h.time < start + 14 * DAY && !h.guarded)
      .flatMap(h => h.peerSpread == null ? [] : [h.peerSpread])) ?? 0 };
}
function peerScore(current: AdaptiveHour, baseline: AdaptiveStoredStream["runtime"]["referenceBaseline"]): AdaptiveHour["score"] {
  if (!baseline || current.value === null || current.peer === null || current.guarded) return null;
  const expected = current.peer + baseline.offset;
  return { expected, threshold: baseline.threshold, residual: current.value - expected };
}
function qualify(hours: AdaptiveHour[], options: {
  start: number; family: AdaptiveModelFamily; currentTime: number; peer: boolean;
}): AdaptiveEvaluation {
  const holdout = hours.filter(h => h.time > options.start + 21 * DAY && h.time <= options.start + 28 * DAY);
  const valid = holdout.filter(h => h.score !== null);
  const modelErrors = valid.map(h => Math.abs(h.score!.residual));
  const persistence = mean(valid.flatMap(h => h.value === null || h.persistence === null ? [] : [Math.abs(h.value - h.persistence)]));
  const seasonal = mean(valid.flatMap(h => h.value === null || h.seasonal === null ? [] : [Math.abs(h.value - h.seasonal)]));
  const baselineMae = persistence === null || seasonal === null ? null : Math.min(persistence, seasonal);
  const mae = mean(modelErrors);
  const coverage = valid.length ? valid.filter(h => Math.abs(h.score!.residual) <= h.score!.threshold).length / valid.length : null;
  const blocks = [0, 7, 14, 21].map(day => hours.filter(h => h.time > options.start + day * DAY
    && h.time <= options.start + (day + 7) * DAY && h.value !== null && !h.guarded).length);
  const enough = options.currentTime >= options.start + 28 * DAY && blocks.every(count => count >= 135) && valid.length >= 135;
  const skill = options.peer || (mae !== null && baselineMae !== null && mae < baselineMae * 0.95);
  const qualified = enough && skill && coverage !== null && coverage >= 0.95;
  return { model: options.family, evaluatedAt: new Date(options.currentTime).toISOString(),
    trainingCutoff: new Date(options.start + 14 * DAY).toISOString(), calibrationHours: hours.filter(h =>
      h.time > options.start + 14 * DAY && h.time <= options.start + 21 * DAY && h.score !== null).length,
    holdoutHours: valid.length, coverage, mae, baselineMae, qualified,
    reason: !enough ? "insufficient-history" : !skill ? "no-skill" : !qualified ? "range-coverage" : "qualified" };
}
function climateSequence(hours: AdaptiveHour[]): { direction: "high" | "low" | null; recovered: boolean } {
  const last = hours.slice(-3);
  if (last.length !== 3 || last.some((h, i) => !h.score || (i > 0 && h.time - last[i - 1]!.time !== HOUR))) {
    return { direction: null, recovered: false };
  }
  const recent = last.at(-1)!.score!;
  const sign = Math.sign(recent.residual);
  const breaches = last.filter(h => Math.sign(h.score!.residual) === sign && Math.abs(h.score!.residual) > h.score!.threshold).length;
  return { direction: Math.abs(recent.residual) > recent.threshold && breaches >= 2 ? sign > 0 ? "high" : "low" : null,
    recovered: last.every(h => Math.abs(h.score!.residual) < 0.6 * h.score!.threshold) };
}
function peerSequence(hours: AdaptiveHour[], now: number): { direction: "high" | "low" | null; recovered: boolean } {
  const recent = hours.filter(h => h.time > now - DAY && h.score !== null);
  if (recent.length < 18 || recent.some((h, i) => i > 0 && h.time - recent[i - 1]!.time > 2 * HOUR)) {
    return { direction: null, recovered: false };
  }
  const residual = median(recent.map(h => h.score!.residual))!;
  const threshold = recent.at(-1)!.score!.threshold;
  return { direction: Math.abs(residual) > threshold ? residual > 0 ? "high" : "low" : null,
    recovered: Math.abs(residual) < threshold / 2 };
}

function selectedFamily(stored: AdaptiveStoredStream, hours: AdaptiveHour[], time: number) {
  if (stored.stream.kind === "sensor-comparison") return "reference-offset" as const;
  if (stored.runtime.selected) return stored.runtime.selected;
  const start = Date.parse(stored.stream.epochStartedAt);
  if (time < start + 14 * DAY) return null;
  return chooseFamily(hours.filter(h => h.time > start + 7 * DAY && h.time <= start + 14 * DAY));
}
function scoreForStream(stored: AdaptiveStoredStream, input: {
  hours: AdaptiveHour[]; current: AdaptiveHour; selected: AdaptiveModelFamily | null;
}) {
  if (!input.selected) return null;
  if (stored.stream.kind === "sensor-comparison") return peerScore(input.current, stored.runtime.referenceBaseline);
  return climateScore(input.hours, input.current, { family: input.selected,
    materiality: ADAPTIVE_DEFAULTS.materiality[stored.stream.metric], calibrationBefore: stored.runtime.calibrationBefore });
}
function analysisStatus(input: { expired: boolean; guarded: boolean; scored: boolean; ready: boolean; reason: string }) {
  if (input.expired) return { state: "stale" as const, reason: "baseline-review-required" };
  if (input.guarded) return { state: "collecting" as const, reason: "context-guard" };
  if (!input.scored) return { state: "collecting" as const, reason: "insufficient-calibration" };
  return { state: input.ready ? "ready" as const : "collecting" as const, reason: input.reason };
}
function applyFreeze(runtime: AdaptiveStoredStream["runtime"], input: {
  ready: boolean; hour: AdaptiveHour; selected: AdaptiveModelFamily | null; recovered: boolean;
}): boolean {
  const score = input.hour.score;
  const breached = input.ready && score !== null && Math.abs(score.residual) > score.threshold;
  if (breached && runtime.frozenAt === null) {
    runtime.frozenAt = input.hour.predictions[input.selected ?? "daily-profile"]?.cutoff ?? input.hour.time;
    runtime.calibrationBefore = input.hour.time;
  }
  const frozen = runtime.frozenAt !== null;
  input.hour.excluded = frozen;
  if (input.recovered) { runtime.frozenAt = null; runtime.calibrationBefore = null; }
  return frozen;
}
export function analyseAdaptiveHour(stored: AdaptiveStoredStream, input: { hours: AdaptiveHour[]; current: AdaptiveHour }): AdaptiveAnalysis {
  const start = Date.parse(stored.stream.epochStartedAt);
  const peer = stored.stream.kind === "sensor-comparison";
  const selected = selectedFamily(stored, input.hours, input.current.time);
  const runtime = { ...stored.runtime, selected };
  if (peer && !runtime.referenceBaseline && input.current.time >= start + 14 * DAY) {
    const baseline = referenceBaseline(input.hours, start);
    if (baseline) runtime.referenceBaseline = baseline;
  }
  const score = scoreForStream({ ...stored, runtime }, { ...input, selected });
  const hour = { ...input.current, score, excluded: false };
  const hours = [...input.hours.filter(h => h.time !== hour.time), hour];
  let evaluation = selected ? qualify(hours, { start: Math.max(start, hour.time - 28 * DAY), family: selected, currentTime: hour.time, peer }) : null;
  const ready = (stored.stream.evaluation ?? evaluation)?.qualified === true;
  const sequence = !ready ? { direction: null, recovered: false }
    : (peer ? peerSequence(hours, hour.time) : climateSequence(hours));
  const frozen = applyFreeze(runtime, { ready, hour, selected, recovered: sequence.recovered });
  if (frozen) evaluation = stored.stream.evaluation ?? evaluation;
  const expired = runtime.calibrationBefore !== null && hour.time - runtime.calibrationBefore > 7 * DAY;
  const status = analysisStatus({ expired, guarded: hour.guarded, scored: score !== null, ready,
    reason: evaluation?.reason ?? "insufficient-history" });
  return { evaluation, selected, hour, runtime, ...status,
    direction: status.state === "ready" ? sequence.direction : null, recovered: sequence.recovered };
}
