import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADAPTIVE_MONITORING_VERSION } from "@climate-twin/contracts";
import { replayAdaptiveBaseline } from "../apps/api/src/analytics/adaptive-monitoring/replay.js";
import { adaptiveEvaluationScenarios } from "../apps/api/src/analytics/adaptive-monitoring/scenarios.js";

const scenarios = adaptiveEvaluationScenarios();
const results = scenarios.flatMap((scenario) => (["persistence", "same-hour-yesterday"] as const).map((baseline) => {
  const replay = replayAdaptiveBaseline({
    evidence: scenario.evidence,
    policy: { epochId: "synthetic-epoch", dataMode: "live", trustworthyFrom: 0 },
    metric: "temperature", baseline, from: 0, to: 28 * 24 * 3_600_000,
  });
  const opened = replay.points.filter((point, index) => point.episode === "candidate"
    && replay.points[index - 1]?.episode !== "candidate" && replay.points[index - 1]?.episode !== "stale");
  const event = scenario.expectedEvent;
  const detected = event ? opened.some((point) => point.time >= event.from && point.time < event.to) : false;
  return {
    scenario: scenario.id, baseline,
    scoredHours: replay.scoredHours, abstainedHours: replay.abstainedHours,
    candidateEpisodes: replay.candidateEpisodes,
    syntheticEventCount: event ? 1 : 0, detectedSyntheticEvents: detected ? 1 : 0,
    unmatchedEpisodes: opened.filter((point) => !event || point.time < event.from || point.time >= event.to).length,
    firstDetectionDelayHours: event && detected ? (opened.find((point) => point.time >= event.from && point.time < event.to)!.time - event.from) / 3_600_000 : null,
  };
}));

const receipt = {
  algorithmVersion: ADAPTIVE_MONITORING_VERSION,
  fixtureVersion: "adaptive-scenarios/v1",
  datasetDigest: createHash("sha256").update(JSON.stringify(scenarios)).digest("hex"),
  purpose: "synthetic-software-baseline",
  advisoryEligible: false,
  limitations: ["No appliance evidence, human reviews, learned-model qualification or prospective accuracy claim.",
    "Fixed baselines only; event labels refer solely to the predefined synthetic changes."],
  results,
};

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
  throw new Error("Usage: npm run evaluate:adaptive -- [--output PATH]");
}
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (args[1]) writeFileSync(resolve(args[1]), serialized, { flag: "wx" });
process.stdout.write(serialized);
