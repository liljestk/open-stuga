import {
  isOneOf,
  OBSERVATION_CONFIDENCES,
  OBSERVATION_KINDS,
  OBSERVATION_SEVERITIES,
  OBSERVATION_STATUSES,
  OBSERVATION_TIME_PRECISIONS,
  type ManualObservation,
} from "@climate-twin/contracts";
import type { StugubyHomeObservation } from "@climate-twin/stuguby-protocol";

/** A peer observation narrowed to the values this installation stores. */
export interface PeerObservation {
  /** Copied into both a new and an updated local observation. */
  content: Pick<ManualObservation, "kind" | "severity" | "note" | "x" | "y" | "occurredAt">
    & Partial<Pick<ManualObservation, "timePrecision" | "validFrom" | "validTo" | "confidence">>;
  /** Lifecycle fields that only an update of an existing observation carries. */
  lifecycle: Partial<Pick<ManualObservation, "status" | "resolutionNote">>;
}

/**
 * A peer's observation when every enumerated field is a value this
 * installation knows; null when the peer sent anything else, so the record is
 * rejected or skipped instead of stored under a type it does not satisfy.
 */
export function peerObservation(item: StugubyHomeObservation): PeerObservation | null {
  const { kind, severity, timePrecision, confidence, status } = item;
  if (!isOneOf(kind, OBSERVATION_KINDS) || !isOneOf(severity, OBSERVATION_SEVERITIES)) return null;
  if (timePrecision !== undefined && !isOneOf(timePrecision, OBSERVATION_TIME_PRECISIONS)) return null;
  if (confidence !== undefined && !isOneOf(confidence, OBSERVATION_CONFIDENCES)) return null;
  if (status !== undefined && !isOneOf(status, OBSERVATION_STATUSES)) return null;
  return {
    content: {
      kind,
      severity,
      note: item.note,
      x: item.x,
      y: item.y,
      occurredAt: item.occurredAt,
      ...(timePrecision ? { timePrecision } : {}),
      ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
      ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
      ...(confidence ? { confidence } : {}),
    },
    lifecycle: {
      ...(status ? { status } : {}),
      ...(item.resolutionNote !== undefined ? { resolutionNote: item.resolutionNote } : {}),
    },
  };
}
