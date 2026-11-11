import { randomUUID } from "node:crypto";
import { ADAPTIVE_MONITORING_VERSION, type AdaptiveFinding, type AdaptiveSettings, type House } from "@climate-twin/contracts";
import type { AdaptiveAnalysis, AdaptiveStoredStream } from "./evidence.js";
import type { AdaptiveMonitoringStore } from "./store.js";

function advanceEpisode(previous: AdaptiveFinding, input: { analysis: AdaptiveAnalysis; now: string }): AdaptiveFinding {
  const { analysis, now } = input;
  const next = { ...previous, revision: previous.revision + 1, recordedAt: now,
    freshness: analysis.hour.score ? "fresh" as const : "stale" as const,
    state: analysis.state === "stale" ? "expired" as const : analysis.recovered ? "resolved" as const : previous.state };
  if (analysis.hour.score && analysis.hour.value !== null) {
    next.lastEvidenceAt = new Date(analysis.hour.time).toISOString();
    next.observed = analysis.hour.value; next.expected = analysis.hour.score.expected;
    next.low = next.expected - analysis.hour.score.threshold; next.high = next.expected + analysis.hour.score.threshold;
    next.coverage = analysis.hour.coverage;
  }
  return next;
}

export function updateAdaptiveEpisode(store: AdaptiveMonitoringStore, input: {
  stored: AdaptiveStoredStream; analysis: AdaptiveAnalysis; house: House; settings: AdaptiveSettings; mode: string; now: number;
}): void {
  const { stored, analysis, house } = input;
  const row = store.database.db.prepare(`SELECT finding_json FROM adaptive_findings WHERE stream_id=? AND epoch=?
    AND state IN ('candidate','presented') ORDER BY updated_at DESC LIMIT 1`)
    .get(stored.stream.id, stored.stream.epoch) as { finding_json: string } | undefined;
  let previous = row ? JSON.parse(row.finding_json) as AdaptiveFinding : null;
  const now = new Date(input.now).toISOString();
  if (previous && analysis.direction && previous.direction !== analysis.direction) {
    store.saveFinding({ ...previous, revision: previous.revision + 1, state: "expired", recordedAt: now }, stored.stream.id, input.mode);
    previous = null;
  }
  if (previous && !analysis.direction) {
    store.saveFinding(advanceEpisode(previous, { analysis, now }), stored.stream.id, input.mode);
    return;
  }
  if (!analysis.direction || !analysis.hour.score || analysis.hour.value === null) return;
  const receipt = input.settings.promotionReceiptId ? store.receipt(input.settings.promotionReceiptId) : null;
  const promoted = input.settings.mode === "advisory" && receipt?.algorithmVersion === ADAPTIVE_MONITORING_VERSION
    && receipt.capabilities.some(c => c.kind === stored.stream.kind && c.metric === stored.stream.metric);
  const score = analysis.hour.score;
  const first = previous?.firstEvidenceAt ?? new Date(analysis.hour.time).toISOString();
  const finding: AdaptiveFinding = {
    id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, houseId: house.id,
    propertyId: house.propertyId, sensorId: stored.stream.sensorId, sensorName: stored.stream.sensorName,
    floorId: stored.stream.floorId, room: stored.stream.room, epoch: stored.stream.epoch,
    metric: stored.stream.metric, kind: stored.stream.kind, direction: analysis.direction, severity: "notice",
    state: promoted ? "presented" : "candidate", firstEvidenceAt: first,
    lastEvidenceAt: new Date(analysis.hour.time).toISOString(), recordedAt: now, freshness: "fresh",
    observed: analysis.hour.value, expected: score.expected, low: score.expected - score.threshold,
    high: score.expected + score.threshold, unit: store.database.getMeasurementDefinition(stored.stream.metric)?.unit ?? "",
    coverage: analysis.hour.coverage, sourceIds: [stored.stream.sensorId, ...input.settings.referenceGroups
      .filter(g => g.sensorId === stored.stream.sensorId).flatMap(g => g.peerIds)],
    contextGaps: ["unmeasured-occupancy", "unmodelled-heating-effects"],
    modelId: analysis.runtime.modelId ?? "", review: null,
  };
  store.saveFinding(finding, stored.stream.id, input.mode);
}
