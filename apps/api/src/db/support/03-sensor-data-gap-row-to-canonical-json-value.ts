import { HttpError } from "../../http-error.js";
import type { SecurityAuditEvent, Sensor, SensorDataGapCompleteness, SensorDataGapSource, SensorDataGapState } from "@climate-twin/contracts";
import { SecurityAuditEventRow } from "./01-json-value-to-area-equipment-row.js";

export interface SensorDataGapRow {
  id: number;
  sensor_id: string;
  metric: string;
  source: SensorDataGapSource;
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  recovery_state: SensorDataGapState;
  recoverable_until: string | null;
  recovery_completeness: SensorDataGapCompleteness;
  recovered_points: number;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  recovery_error: string | null;
}

export interface SensorDataGapRecord {
  id: number;
  sensorId: string;
  metric: string;
  source: SensorDataGapSource;
  startedAt: string;
  detectedAt: string;
  endedAt: string | null;
  recoveryState: SensorDataGapState;
  recoverableUntil: string | null;
  recoveryCompleteness: SensorDataGapCompleteness;
  recoveredPoints: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  recoveryError: string | null;
}

export class ClimateDataValidationError extends HttpError {
  declare readonly status: 400 | 404 | 409 | 422;

  constructor(status: 400 | 404 | 409 | 422, code: string, message: string) {
    super(status, code, message);
    this.name = "ClimateDataValidationError";
  }
}

export type SensorUpdate = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  /** Set null to remove a persisted direct TP-Link child-device binding. */
  tpLinkDeviceId?: string | null;
  /** Set null to remove the house-scoped TP-Link connection binding. */
  tpLinkConnectionId?: string | null;
};

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function securityAuditEventFromRow(row: SecurityAuditEventRow): SecurityAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    outcome: row.outcome,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    details: parseJson<SecurityAuditEvent["details"]>(row.details_json),
    createdAt: row.created_at,
  };
}

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };
