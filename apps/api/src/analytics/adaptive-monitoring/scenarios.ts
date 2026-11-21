import type { AdaptiveHourlyEvidence, AdaptiveMetric } from "@climate-twin/contracts";

const HOUR = 3_600_000;
const CHANGE_HOUR = 400;

interface EvaluationScenario {
  id: string;
  metric: AdaptiveMetric;
  evidence: AdaptiveHourlyEvidence[];
  expectedEvent: { from: number; to: number } | null;
  contextTransitions?: readonly number[];
}

function normal(center = 20, amplitude = 1): AdaptiveHourlyEvidence[] {
  return Array.from({ length: 28 * 24 }, (_, hour) => ({
    time: hour * HOUR, availableAt: (hour + 1) * HOUR,
    value: center + amplitude * Math.sin(2 * Math.PI * hour / 24),
    coverage: 1, quality: "good", source: "observed", epochId: "synthetic-epoch", archiveComplete: true,
  }));
}

function sustainedStep({ metric, center, amplitude, delta }: {
  metric: AdaptiveMetric;
  center: number;
  amplitude: number;
  delta: number;
}): EvaluationScenario {
  const evidence = normal(center, amplitude);
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) evidence[hour]!.value += delta;
  return {
    id: metric === "temperature" ? "sustained-step" : `sustained-${metric}-step`,
    metric, evidence, expectedEvent: { from: CHANGE_HOUR * HOUR, to: (CHANGE_HOUR + 12) * HOUR },
  };
}

/** Frozen synthetic cases; these are software fixtures, not measured household efficacy. */
export function adaptiveEvaluationScenarios(): EvaluationScenario[] {
  const spike = normal();
  spike[CHANGE_HOUR]!.value += 3;
  const outage = normal();
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) outage[hour]!.quality = "stale";
  const late = normal();
  const partialArchive = normal();
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) {
    late[hour]!.availableAt += 48 * HOUR;
    late[hour]!.value += 3;
    partialArchive[hour]!.archiveComplete = false;
    partialArchive[hour]!.value += 3;
  }
  const opening = normal();
  opening[CHANGE_HOUR]!.value -= 3;
  opening[CHANGE_HOUR + 1]!.value -= 3;
  const relocation = normal();
  for (const point of relocation.slice(CHANGE_HOUR)) {
    point.value += 4;
    point.epochId = "synthetic-relocated";
  }
  return [
    { id: "daily-cycle", metric: "temperature", evidence: normal(), expectedEvent: null },
    sustainedStep({ metric: "temperature", center: 20, amplitude: 1, delta: 3 }),
    sustainedStep({ metric: "humidity", center: 46, amplitude: 2, delta: 12 }),
    sustainedStep({ metric: "co2", center: 650, amplitude: 80, delta: 350 }),
    { id: "isolated-spike", metric: "temperature", evidence: spike, expectedEvent: null },
    { id: "source-outage", metric: "temperature", evidence: outage, expectedEvent: null },
    { id: "late-recovery", metric: "temperature", evidence: late, expectedEvent: null },
    { id: "partial-archive", metric: "temperature", evidence: partialArchive, expectedEvent: null },
    { id: "known-opening", metric: "temperature", evidence: opening, expectedEvent: null,
      contextTransitions: [CHANGE_HOUR * HOUR] },
    { id: "sensor-relocation", metric: "temperature", evidence: relocation, expectedEvent: null },
  ];
}
