import {
  ADAPTIVE_METRICS, ADAPTIVE_MODES, ADAPTIVE_REVIEW_DISPOSITIONS,
  type AdaptiveSettingsPatch, type AdaptiveReviewInput, type DataMode,
} from "@climate-twin/contracts";
import { bodyObject, requiredNumber, requiredString, rejectUnknownFields, enumValue, optionalBoolean, optionalString } from "../../request-fields.js";
import { HttpError } from "../../http-error.js";

export const adaptiveDataMode = (value: unknown): DataMode => enumValue(value, ["live", "demo"], "dataMode");
function revision(body: Record<string, unknown>): number {
  const value = requiredNumber(body, "baseRevision");
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a nonnegative integer");
  return value;
}
export function adaptiveSettingsPatch(value: unknown): AdaptiveSettingsPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, ["dataMode", "baseRevision", "mode", "referenceGroups", "resetBaseline", "promotionReceiptId"], "Learning settings");
  const result: AdaptiveSettingsPatch = { dataMode: adaptiveDataMode(body.dataMode), baseRevision: revision(body) };
  if (body.mode !== undefined) result.mode = enumValue(body.mode, ADAPTIVE_MODES, "mode");
  if (body.promotionReceiptId !== undefined) result.promotionReceiptId = requiredString(body, "promotionReceiptId", 200);
  if (body.resetBaseline !== undefined) {
    const reset = bodyObject(body.resetBaseline);
    rejectUnknownFields(reset, ["sensorId", "reason"], "Baseline reset");
    result.resetBaseline = { sensorId: requiredString(reset, "sensorId", 200), reason: requiredString(reset, "reason", 1000) };
  }
  if (body.referenceGroups !== undefined) {
    if (!Array.isArray(body.referenceGroups) || body.referenceGroups.length > 80) throw new HttpError(400, "INVALID_FIELD", "referenceGroups must contain at most 80 groups");
    result.referenceGroups = body.referenceGroups.map(value => {
      const group = bodyObject(value);
      rejectUnknownFields(group, ["sensorId", "peerIds", "designatedReference"], "Reference group");
      if (!Array.isArray(group.peerIds) || !group.peerIds.length || group.peerIds.length > 10
        || group.peerIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) {
        throw new HttpError(400, "INVALID_FIELD", "peerIds must contain one to ten sensor identifiers");
      }
      return { sensorId: requiredString(group, "sensorId", 200), peerIds: group.peerIds as string[],
        designatedReference: optionalBoolean(group, "designatedReference") ?? false };
    });
  }
  return result;
}
export function adaptiveReviewInput(value: unknown): AdaptiveReviewInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, ["dataMode", "baseRevision", "idempotencyKey", "disposition", "note"], "Finding review");
  return { dataMode: adaptiveDataMode(body.dataMode), baseRevision: revision(body),
    idempotencyKey: requiredString(body, "idempotencyKey", 200),
    disposition: enumValue(body.disposition, ADAPTIVE_REVIEW_DISPOSITIONS, "disposition"),
    note: optionalString(body, "note", 2000) ?? "" };
}
export function adaptiveKind(value: unknown) {
  return value === undefined ? undefined : enumValue(value, ["climate-departure", "sensor-comparison"] as const, "kind");
}
export function adaptiveFindingFilter(query: Record<string, unknown>) {
  const metric = query.metric === undefined ? undefined : enumValue(query.metric, ADAPTIVE_METRICS, "metric");
  const state = query.state === undefined ? undefined : enumValue(query.state, ["candidate", "presented", "resolved", "expired"], "state");
  const raw = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(raw) || raw < 1 || raw > 100) throw new HttpError(400, "INVALID_FIELD", "limit must be between 1 and 100");
  const activeOnly = query.activeOnly === undefined ? false : enumValue(query.activeOnly, ["true", "false"], "activeOnly") === "true";
  return { metric, state, kind: adaptiveKind(query.kind), activeOnly, limit: raw };
}
export function adaptiveCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2000) throw new HttpError(400, "INVALID_FIELD", "Invalid continuation cursor");
  return value;
}
