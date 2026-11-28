import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADAPTIVE_MONITORING_VERSION, type AdaptiveAbstentionReason } from "@climate-twin/contracts";
import { replayAdaptiveBaseline } from "../apps/api/src/analytics/adaptive-monitoring/replay.js";
import { adaptiveEvaluationScenarios } from "../apps/api/src/analytics/adaptive-monitoring/scenarios.js";
import { ADAPTIVE_CLIMATE_QUALIFICATION_VERSION, qualifyAdaptiveClimateModel } from "../apps/api/src/analytics/adaptive-monitoring/climate-qualification.js";
import { HOUR_MS } from "../apps/api/src/analytics/forecast/models.js";

const args = process.argv.slice(2);
const qualifyClimate = args[0] === "--climate-qualification";
if (qualifyClimate) args.shift();
if (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
  throw new Error("Usage: npm run evaluate:adaptive -- [--climate-qualification] [--output PATH]");
}
const scenarios = adaptiveEvaluationScenarios();
const results = (qualifyClimate ? [] : scenarios).flatMap((scenario) => (["persistence", "same-hour-yesterday"] as const).map((baseline) => {
  const replay = replayAdaptiveBaseline({
    evidence: scenario.evidence,
    policy: { epochId: "synthetic-epoch", dataMode: "live", trustworthyFrom: 0 },
    metric: scenario.metric, baseline, from: 0, to: scenario.evidence.length * HOUR_MS,
    ...(scenario.contextTransitions ? { contextTransitions: scenario.contextTransitions } : {}),
  });
  const opened = replay.points.filter((point, index) => point.episode === "candidate"
    && replay.points[index - 1]?.episode !== "candidate" && replay.points[index - 1]?.episode !== "stale");
  const event = scenario.expectedEvent;
  const firstDetection = event && opened.find((point) => point.time >= event.from && point.time < event.to);
  const abstentionsByReason: Partial<Record<AdaptiveAbstentionReason, number>> = {};
  for (const point of replay.points) {
    if (point.reason) abstentionsByReason[point.reason] = (abstentionsByReason[point.reason] ?? 0) + 1;
  }
  return {
    scenario: scenario.id, baseline, metric: scenario.metric,
    scoredHours: replay.scoredHours, abstainedHours: replay.abstainedHours, abstentionsByReason,
    candidateEpisodes: replay.candidateEpisodes,
    syntheticEventCount: event ? 1 : 0, detectedSyntheticEvents: firstDetection ? 1 : 0,
    unmatchedEpisodes: opened.filter((point) => !event || point.time < event.from || point.time >= event.to).length,
    // A target can only be scored after its UTC hour closes.
    firstDetectionDelayHours: event && firstDetection ? (firstDetection.time + HOUR_MS - event.from) / HOUR_MS : null,
  };
}));

const baselineReceipt = {
  algorithmVersion: ADAPTIVE_MONITORING_VERSION,
  fixtureVersion: "adaptive-scenarios/v2",
  datasetDigest: createHash("sha256").update(JSON.stringify(scenarios)).digest("hex"),
  purpose: "synthetic-software-baseline",
  advisoryEligible: false,
  limitations: ["No appliance evidence, human reviews, learned-model qualification or prospective accuracy claim.",
    "Fixed baselines only; event labels refer solely to the predefined synthetic changes."],
  results,
};

function climateReceipt() {
  const drift = {
    ...scenarios[0]!,
    id: "gradual-trend",
    evidence: scenarios[0]!.evidence.map((point, index) => ({
      ...point, value: point.value + index / 48, availableAt: point.availableAt + 2_000,
    })),
  };
  const fixtures = [...scenarios, drift];
  return {
    algorithmVersion: ADAPTIVE_CLIMATE_QUALIFICATION_VERSION,
    fixtureVersion: "adaptive-climate-scenarios/v1",
    datasetDigest: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"),
    purpose: "synthetic-climate-technical-screen",
    advisoryEligible: false,
    limitations: ["Synthetic point forecasts and reference ranges only. Event utility and prospective rollout require independent evidence."],
    results: fixtures.map((scenario) => ({
      scenario: scenario.id,
      metric: scenario.metric,
      ...qualifyAdaptiveClimateModel({
        evidence: scenario.evidence, metric: scenario.metric, evaluatedAt: scenario.evidence.length * HOUR_MS,
        policy: { epochId: "synthetic-epoch", dataMode: "live", trustworthyFrom: 0 },
        ...(scenario.contextTransitions ? {
          contextTransitions: scenario.contextTransitions.map((occurredAt) => ({ occurredAt, availableAt: occurredAt })),
        } : {}),
      }),
    })),
  };
}

const receipt = qualifyClimate ? climateReceipt() : baselineReceipt;
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (args[1]) writeFileSync(resolve(args[1]), serialized, { flag: "wx" });
process.stdout.write(serialized);
