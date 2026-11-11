import { isRecord, isNumber, isString } from "./response-guards.js";
import { isOneOf } from "./literal-values.js";
import {
  ADAPTIVE_METRICS, ADAPTIVE_MODES, ADAPTIVE_STATES, ADAPTIVE_REVIEW_DISPOSITIONS,
  type AdaptiveSettings, type AdaptiveFinding, type AdaptiveStream, type AdaptiveSnapshot,
  type AdaptiveFindingDetail, type AdaptiveReview, type AdaptiveEvaluation,
  ADAPTIVE_MONITORING_VERSION, type AdaptivePromotionReceipt,
} from "./adaptive-monitoring.js";

const nullableString = (v: unknown) => v === null || isString(v);
const nullableNumber = (v: unknown) => v === null || isNumber(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const stamp = (v: unknown) => isString(v) && Number.isFinite(Date.parse(v));
const integer = (v: unknown) => isNumber(v) && Number.isSafeInteger(v) && v >= 0;

export function isAdaptiveSettings(v: unknown): v is AdaptiveSettings {
  return isRecord(v) && integer(v.revision) && isOneOf(v.mode, ADAPTIVE_MODES)
    && nullableString(v.enabledAt) && nullableString(v.promotionReceiptId)
    && Array.isArray(v.referenceGroups) && v.referenceGroups.every(g => isRecord(g)
      && isString(g.sensorId) && strings(g.peerIds) && typeof g.designatedReference === "boolean");
}
function evaluation(v: unknown): v is AdaptiveEvaluation {
  return isRecord(v) && isOneOf(v.model, ["daily-profile", "thermal-relaxation", "reference-offset"])
    && stamp(v.evaluatedAt) && stamp(v.trainingCutoff) && integer(v.calibrationHours)
    && integer(v.holdoutHours) && nullableNumber(v.coverage) && nullableNumber(v.mae)
    && nullableNumber(v.baselineMae) && typeof v.qualified === "boolean" && isString(v.reason);
}
export function isAdaptiveStream(v: unknown): v is AdaptiveStream {
  return isRecord(v) && ["id", "sensorId", "sensorName", "floorId", "room", "epoch", "reason"].every(k => isString(v[k]))
    && stamp(v.epochStartedAt) && isOneOf(v.metric, ADAPTIVE_METRICS)
    && isOneOf(v.kind, ["climate-departure", "sensor-comparison"]) && isOneOf(v.state, ADAPTIVE_STATES)
    && integer(v.usableHours) && nullableString(v.evaluatedThrough)
    && (v.evaluation === null || evaluation(v.evaluation));
}
function review(v: unknown): v is AdaptiveReview {
  return isRecord(v) && isString(v.id) && integer(v.revision) && isString(v.note)
    && stamp(v.recordedAt) && isOneOf(v.disposition, ADAPTIVE_REVIEW_DISPOSITIONS);
}
export function isAdaptiveFinding(v: unknown): v is AdaptiveFinding {
  return isRecord(v) && ["id", "houseId", "propertyId", "sensorId", "sensorName", "floorId", "room",
    "epoch", "unit", "modelId"].every(k => isString(v[k])) && integer(v.revision)
    && isOneOf(v.metric, ADAPTIVE_METRICS) && isOneOf(v.kind, ["climate-departure", "sensor-comparison"])
    && isOneOf(v.direction, ["high", "low"]) && v.severity === "notice"
    && isOneOf(v.state, ["candidate", "presented", "resolved", "expired"])
    && ["firstEvidenceAt", "lastEvidenceAt", "recordedAt"].every(k => stamp(v[k]))
    && isOneOf(v.freshness, ["fresh", "stale"])
    && ["observed", "expected", "low", "high", "coverage"].every(k => isNumber(v[k]))
    && strings(v.sourceIds) && strings(v.contextGaps) && (v.review === null || review(v.review));
}
export function isAdaptivePage<T>(v: unknown, guard: (item: unknown) => item is T): v is { items: T[]; nextCursor: string | null } {
  return isRecord(v) && Array.isArray(v.items) && v.items.every(guard) && nullableString(v.nextCursor);
}
export function isAdaptiveSnapshot(v: unknown): v is AdaptiveSnapshot {
  return isRecord(v) && v.apiVersion === "1.0" && isOneOf(v.dataMode, ["live", "demo"])
    && isString(v.houseId) && stamp(v.generatedAt) && stamp(v.evaluatedAt)
    && isOneOf(v.completeness, ["complete", "partial", "unavailable"])
    && Array.isArray(v.warnings) && v.warnings.every(w => isRecord(w) && isString(w.code) && isString(w.message))
    && isRecord(v.provenance) && isString(v.provenance.algorithmKey) && isString(v.provenance.algorithmVersion)
    && stamp(v.provenance.evaluatedAt) && strings(v.provenance.sourceIds)
    && isAdaptiveSettings(v.settings) && isOneOf(v.state, ADAPTIVE_STATES) && isString(v.reason)
    && nullableString(v.evaluatedThrough) && isAdaptivePage(v.streams, isAdaptiveStream)
    && isAdaptivePage(v.findings, isAdaptiveFinding) && isRecord(v.counts)
    && ["streams", "ready", "findings"].every(k => integer(v.counts && isRecord(v.counts) ? v.counts[k] : undefined));
}
export function isAdaptiveFindingDetail(v: unknown): v is AdaptiveFindingDetail {
  return isRecord(v) && isAdaptiveFinding(v.finding) && isAdaptivePage(v.revisions, isAdaptiveFinding);
}
export function isAdaptivePromotionReceipt(v: unknown): v is AdaptivePromotionReceipt {
  return isRecord(v) && isString(v.id) && v.algorithmVersion === ADAPTIVE_MONITORING_VERSION
    && isString(v.configurationDigest) && isOneOf(v.dataMode, ["live", "demo"])
    && ["homeWeeks", "homes"].every(k => isNumber(v[k]) && Number(v[k]) >= 0)
    && ["reviewedFraction", "baselineImprovement", "recall", "scoredFraction"].every(k =>
      isNumber(v[k]) && Number(v[k]) >= 0 && Number(v[k]) <= 1)
    && isNumber(v.falseEpisodesPerHomeWeek) && v.falseEpisodesPerHomeWeek >= 0
    && typeof v.resourceBudgetsPassed === "boolean" && typeof v.heatingActiveAndInactive === "boolean"
    && Array.isArray(v.capabilities) && v.capabilities.every(c => isRecord(c)
      && isOneOf(c.kind, ["climate-departure", "sensor-comparison"]) && isOneOf(c.metric, ADAPTIVE_METRICS)
      && integer(c.reviewedEvents));
}
