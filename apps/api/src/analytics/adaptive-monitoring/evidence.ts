import type { AdaptiveHourlyEvidence } from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";

export interface EvidencePolicy {
  epochId: string;
  dataMode: "live" | "demo";
  trustworthyFrom: number;
}

export function eligibleHourlyEvidence(point: AdaptiveHourlyEvidence, policy: EvidencePolicy): boolean {
  return Number.isSafeInteger(point.time) && point.time % HOUR_MS === 0
    && Number.isFinite(point.availableAt) && point.availableAt >= point.time + HOUR_MS
    && Number.isFinite(point.value) && point.coverage >= 0.8 && point.coverage <= 1
    && point.quality === "good" && point.archiveComplete
    && point.source === (policy.dataMode === "live" ? "observed" : "demo")
    && point.epochId === policy.epochId && point.time >= policy.trustworthyFrom;
}

/** Conflicting or repeated hours are withheld; physical-source deduplication is upstream. */
export function evidenceByHour(points: readonly AdaptiveHourlyEvidence[], policy: EvidencePolicy) {
  const seen = new Set<number>();
  const result = new Map<number, AdaptiveHourlyEvidence>();
  for (const point of points) {
    if (seen.has(point.time)) {
      result.delete(point.time);
      continue;
    }
    seen.add(point.time);
    if (eligibleHourlyEvidence(point, policy)) result.set(point.time, point);
  }
  return result;
}

/** Four fixed chronological weeks, with no borrowing coverage between blocks. */
export function auditAdaptiveReadiness(input: {
  evidence: readonly AdaptiveHourlyEvidence[];
  policy: EvidencePolicy;
  evaluatedAt: number;
}) {
  const byHour = evidenceByHour(input.evidence, input.policy);
  const start = Math.ceil(input.policy.trustworthyFrom / HOUR_MS) * HOUR_MS;
  const blocks = ["fit", "selection", "calibration", "evaluation"].map((name, index) => {
    const from = start + index * 168 * HOUR_MS;
    const to = from + 168 * HOUR_MS;
    let usableHours = 0;
    for (let time = from; time < to; time += HOUR_MS) {
      const point = byHour.get(time);
      if (point && point.availableAt <= input.evaluatedAt) usableHours += 1;
    }
    return { name, from, to, usableHours, coverage: usableHours / 168, closed: to <= input.evaluatedAt };
  });
  return {
    state: blocks.every((block) => block.closed && block.coverage >= 0.8) ? "evaluation-ready" as const : "collecting" as const,
    advisoryEligible: false as const,
    blocks,
  };
}
