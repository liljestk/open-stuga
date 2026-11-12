import type { AdaptiveHourlyEvidence } from "@climate-twin/contracts";

const HOUR = 3_600_000;
const CHANGE_HOUR = 400;

/** Frozen synthetic cases; these are software fixtures, not measured household efficacy. */
export function adaptiveEvaluationScenarios() {
  const normal = (): AdaptiveHourlyEvidence[] => Array.from({ length: 28 * 24 }, (_, hour) => ({
    time: hour * HOUR, availableAt: (hour + 1) * HOUR,
    value: 20 + Math.sin(2 * Math.PI * hour / 24),
    coverage: 1, quality: "good", source: "observed", epochId: "synthetic-epoch", archiveComplete: true,
  }));
  const departure = normal();
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) departure[hour]!.value += 3;
  const spike = normal();
  spike[CHANGE_HOUR]!.value += 3;
  const outage = normal();
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) outage[hour]!.quality = "stale";
  const late = normal();
  for (let hour = CHANGE_HOUR; hour < CHANGE_HOUR + 12; hour += 1) {
    late[hour]!.availableAt += 48 * HOUR;
    late[hour]!.value += 3;
  }
  return [
    { id: "daily-cycle", evidence: normal(), expectedEvent: null },
    { id: "sustained-step", evidence: departure, expectedEvent: { from: CHANGE_HOUR * HOUR, to: (CHANGE_HOUR + 12) * HOUR } },
    { id: "isolated-spike", evidence: spike, expectedEvent: null },
    { id: "source-outage", evidence: outage, expectedEvent: null },
    { id: "late-recovery", evidence: late, expectedEvent: null },
  ];
}
