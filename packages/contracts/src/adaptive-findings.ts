import { ADAPTIVE_METRICS, type AdaptiveMetric } from "./adaptive-monitoring.js";
import { isOneOf } from "./literal-values.js";

export const ADAPTIVE_FINDING_STATES = ["candidate", "stale", "resolved", "expired"] as const;
export type AdaptiveFindingState = (typeof ADAPTIVE_FINDING_STATES)[number];
export const ADAPTIVE_REVIEW_DISPOSITIONS = ["useful", "not-useful", "expected-change", "uncertain"] as const;
export const ADAPTIVE_REVIEW_NOTE_LIMIT = 1000;
export const ADAPTIVE_REVIEW_KEY_LIMIT = 128;
export type AdaptiveReviewDisposition = (typeof ADAPTIVE_REVIEW_DISPOSITIONS)[number];

export interface AdaptiveFindingReviewWrite {
  baseRevision: number;
  idempotencyKey: string;
  disposition: AdaptiveReviewDisposition;
  note?: string;
  reportedRecovery?: boolean;
}

export interface AdaptiveFindingReview {
  id: string;
  findingId: string;
  findingRevision: number;
  disposition: AdaptiveReviewDisposition;
  note: string | null;
  reportedRecovery: boolean;
  supersedesReviewId: string | null;
  recordedAt: string;
}

export interface AdaptiveFindingRevision {
  revision: number;
  state: AdaptiveFindingState;
  evidenceAt: string;
  recordedAt: string;
}

export interface AdaptiveShadowFinding extends AdaptiveFindingRevision {
  id: string;
  epochId: string;
  epochCurrent: boolean;
  houseId: string;
  propertyId: string;
  sensorId: string;
  kind: "climate" | "sensor-comparison";
  metric: AdaptiveMetric;
  direction: "higher" | "lower";
  severity: "notice";
}

export interface AdaptiveFindingsPage {
  items: AdaptiveShadowFinding[];
  nextCursor: string | null;
}

export interface AdaptiveFindingDetail {
  finding: AdaptiveShadowFinding;
  revisions: { items: AdaptiveFindingRevision[]; nextBeforeRevision: number | null };
  latestReview: AdaptiveFindingReview | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function date(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRevision(value: unknown): value is AdaptiveFindingRevision {
  return record(value) && positiveInteger(value.revision) && isOneOf(value.state, ADAPTIVE_FINDING_STATES)
    && date(value.evidenceAt) && date(value.recordedAt);
}

function isFinding(value: unknown): value is AdaptiveShadowFinding {
  if (!record(value)) return false;
  return isOneOf(value.kind, ["climate", "sensor-comparison"]) && isOneOf(value.metric, ADAPTIVE_METRICS)
    && isOneOf(value.direction, ["higher", "lower"]) && value.severity === "notice" && typeof value.epochCurrent === "boolean"
    && [value.id, value.epochId, value.houseId, value.propertyId, value.sensorId].every((id) => typeof id === "string" && id.length > 0)
    && isRevision(value);
}

export function isAdaptiveFindingsPage(value: unknown): value is AdaptiveFindingsPage {
  return record(value) && Array.isArray(value.items) && value.items.every(isFinding)
    && (value.nextCursor === null || typeof value.nextCursor === "string");
}

export function isAdaptiveFindingDetail(value: unknown): value is AdaptiveFindingDetail {
  if (!record(value) || !record(value.revisions)) return false;
  const { items, nextBeforeRevision } = value.revisions;
  return isFinding(value.finding) && Array.isArray(items) && items.every(isRevision)
    && (nextBeforeRevision === null || positiveInteger(nextBeforeRevision))
    && (value.latestReview === null || isAdaptiveFindingReview(value.latestReview));
}

export function isAdaptiveFindingReview(value: unknown): value is AdaptiveFindingReview {
  return record(value) && typeof value.id === "string" && typeof value.findingId === "string"
    && positiveInteger(value.findingRevision) && isOneOf(value.disposition, ADAPTIVE_REVIEW_DISPOSITIONS)
    && (value.note === null || (typeof value.note === "string" && value.note.length <= ADAPTIVE_REVIEW_NOTE_LIMIT))
    && typeof value.reportedRecovery === "boolean" && date(value.recordedAt)
    && (value.supersedesReviewId === null || typeof value.supersedesReviewId === "string");
}
