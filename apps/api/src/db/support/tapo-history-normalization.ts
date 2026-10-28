import type { TapoHistoryExportJobStatus } from "../tapo-history-export-types.js";
import { ClimateDataValidationError } from "./validation-errors.js";

export const TAPO_HISTORY_EXPORT_TRANSITIONS: Readonly<Record<TapoHistoryExportJobStatus, readonly TapoHistoryExportJobStatus[]>> = {
  queued: ["cancelled"],
  claimed: ["running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  running: ["waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  "waiting-email": ["needs-attention", "completed", "failed", "cancelled"],
  "needs-attention": ["queued", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export function normalizedTapoHistoryTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_TIMESTAMP", `${field} must be an ISO date-time`);
  }
  return new Date(parsed).toISOString();
}

export function normalizedTapoHistoryText(value: string, field: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > maximum) {
    throw new ClimateDataValidationError(
      422,
      "INVALID_TAPO_EXPORT_FIELD",
      `${field} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return normalized;
}

export function normalizedSha256(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_FIELD", `${field} must be a lowercase SHA-256 hex digest`);
  }
  return normalized;
}
