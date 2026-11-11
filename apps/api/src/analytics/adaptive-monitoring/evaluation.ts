import { ADAPTIVE_MONITORING_VERSION, type AdaptiveKind, type AdaptiveMetric } from "@climate-twin/contracts";
import { mean, median } from "@climate-twin/analytics-kernel";
import { yieldToEventLoop } from "../../timeseries/read-support.js";
import { analyseAdaptiveHour, predictAdaptiveHour } from "./policy.js";
import { HOUR, type AdaptiveAnalysis, type AdaptiveHour, type AdaptiveStoredStream } from "./evidence.js";
import { adaptiveDigest } from "./store.js";
import { adaptiveConfigurationDigest } from "./scope.js";

export interface AdaptiveScenario {
  name: string;
  kind: AdaptiveKind;
  metric: AdaptiveMetric;
  start: number;
  values: Array<{ value: number | null; outdoor: number | null; peer: number | null; guarded: boolean }>;
  events: Array<{ startHour: number; endHour: number }>;
}
export function adaptiveEvaluationScenarios(): AdaptiveScenario[] {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const scenarios: AdaptiveScenario[] = [];
  for (const kind of ["climate-departure", "sensor-comparison"] as const) {
    for (const changed of [false, true]) {
      const values = Array.from({ length: 50 * 24 }, (_, index) => {
        const outside = -5 + 5 * Math.sin(index / 180);
        const peer = 21 + Math.sin(index * Math.PI / 12) + 0.004 * index + outside / 8;
        const event = changed && index >= 40 * 24 && index < 42 * 24;
        return { value: peer + Math.sin(index * 1.71) * 0.02 + (event ? 1.6 : 0),
          outdoor: outside, peer: kind === "sensor-comparison" ? peer : null, guarded: index >= 35 * 24 && index < 35 * 24 + 2 };
      });
      scenarios.push({ name: `${kind}-${changed ? "sustained-change" : "ordinary-weather"}`, kind,
        metric: "temperature", start, values, events: changed ? [{ startHour: 40 * 24, endHour: 42 * 24 }] : [] });
    }
  }
  return scenarios;
}
function initialStream(scenario: AdaptiveScenario): AdaptiveStoredStream {
  return { houseId: "synthetic-home", fingerprint: adaptiveDigest(scenario.name),
    stream: { id: "synthetic-stream", sensorId: "synthetic-sensor", sensorName: "Synthetic thermometer", floorId: "ground",
      room: "Sample room", metric: scenario.metric, kind: scenario.kind, epoch: "synthetic-only",
      epochStartedAt: new Date(scenario.start).toISOString(), state: "collecting", reason: "new-evidence-epoch",
      usableHours: 0, evaluatedThrough: null, evaluation: null },
    runtime: { selected: null, frozenAt: null, calibrationBefore: null, modelId: null } };
}
interface EvaluationProgress {
  active: boolean; detected: number[]; baseline: number[]; baselineActive: boolean; eligible: number; scored: number; errors: number[];
}
function recordProgress(progress: EvaluationProgress, input: { analysis: AdaptiveAnalysis; current: AdaptiveHour; index: number }): void {
  const { analysis, current, index } = input;
  if (analysis.direction && !progress.active) { progress.detected.push(index); progress.active = true; }
  if (analysis.recovered || analysis.state === "stale") progress.active = false;
  if (index < 28 * 24 || current.guarded || current.value === null) return;
  progress.eligible += 1;
  if (analysis.hour.score) {
    progress.scored += 1;
    progress.errors.push(Math.abs(analysis.hour.score.residual));
  }
  const fixed = current.seasonal !== null && Math.abs(current.value - current.seasonal) > 1;
  if (fixed && !progress.baselineActive) progress.baseline.push(index);
  progress.baselineActive = fixed;
}
async function evaluateScenario(scenario: AdaptiveScenario) {
  let stored = initialStream(scenario);
  const hours: AdaptiveHour[] = [];
  let predictions: AdaptiveHour["predictions"] = {};
  const progress: EvaluationProgress = { active: false, detected: [], baseline: [], baselineActive: false, eligible: 0, scored: 0, errors: [] };
  for (let index = 0; index < scenario.values.length; index += 1) {
    const value = scenario.values[index]!;
    const time = scenario.start + (index + 1) * HOUR;
    const availableAt = time + 5 * 60_000;
    const current: AdaptiveHour = { time, availableAt, ...value, coverage: value.value === null ? 0 : 1, sources: ["synthetic"],
      predictions, persistence: hours.at(-1)?.value ?? null, seasonal: hours.at(-24)?.value ?? null,
      score: null, excluded: false };
    const analysis = analyseAdaptiveHour(stored, { hours, current });
    recordProgress(progress, { analysis, current, index });
    hours.push(analysis.hour);
    stored = { ...stored, runtime: analysis.runtime, stream: { ...stored.stream, evaluation: analysis.evaluation } };
    predictions = scenario.kind === "climate-departure" ? predictAdaptiveHour({
      metric: scenario.metric, hours, until: availableAt, frozenAt: analysis.runtime.frozenAt,
      anchorBefore: analysis.runtime.calibrationBefore, targetTime: time + HOUR }) : {};
    if (index % 24 === 0) await yieldToEventLoop();
  }
  const { detected, baseline, eligible, scored, errors } = progress;
  const trueDetections = scenario.events.flatMap(event => {
    const detection = detected.find(i => i >= event.startHour && i < event.endHour);
    return detection === undefined ? [] : [detection - event.startHour];
  });
  const falseEpisodes = detected.filter(i => !scenario.events.some(e => i >= e.startHour && i < e.endHour)).length;
  const eligibleWeeks = eligible / (7 * 24);
  return { name: scenario.name, kind: scenario.kind, metric: scenario.metric,
    eligibleHours: eligible, scoredHours: scored, scoredFraction: eligible ? scored / eligible : 0,
    events: scenario.events.length, detectedEvents: trueDetections.length, episodes: detected.length,
    recall: scenario.events.length ? trueDetections.length / scenario.events.length : null,
    medianDelayHours: median(trueDetections), falseEpisodes, falseEpisodesPerHomeWeek: eligibleWeeks ? falseEpisodes / eligibleWeeks : null,
    fixedSeasonalBaselineEpisodes: baseline.length, mae: mean(errors), finalQualification: stored.stream.evaluation };
}
/** Synthetic results are engineering evidence only and can never authorize advisory mode. */
export async function evaluateAdaptiveMonitoring(scenarios = adaptiveEvaluationScenarios()) {
  const results = [];
  for (const scenario of scenarios) results.push(await evaluateScenario(scenario));
  return { schemaVersion: "1.0", kind: "synthetic-evaluation", algorithmVersion: ADAPTIVE_MONITORING_VERSION,
    configurationDigest: adaptiveConfigurationDigest(), datasetDigest: adaptiveDigest(scenarios),
    generatedAt: new Date().toISOString(), canPromote: false, results };
}
