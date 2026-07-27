import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { SecurityAuditEventRow } from "./01-json-value-to-area-equipment-row.js";
import { SensorDataGapSource, SensorDataGapState } from "./02-equipment-attachment-row-to-sensor-data-gap-state.js";

export interface SensorDataGapRow {
  id: number;
  sensor_id: string;
  metric: string;
  source: SensorDataGapSource;
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  recovery_state: SensorDataGapState;
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
  recoveredPoints: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  recoveryError: string | null;
}

export type TapoHistoryExportProvider = "appium" | "private-cloud";

export type TapoHistoryExportJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting-email"
  | "needs-attention"
  | "completed"
  | "failed"
  | "cancelled";

export interface TapoHistoryExportJobRow {
  id: string;
  dedupe_key: string;
  provider: TapoHistoryExportProvider;
  sensor_id: string;
  expected_device_id: string;
  device_name: string;
  time_zone: string;
  metric: string;
  expected_recipient: string | null;
  range_start: string;
  range_end: string;
  interval_minutes: number;
  status: TapoHistoryExportJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  submitted_at: string | null;
  deployment_fingerprint: string | null;
  acceptance_revision: string | null;
  mailbox_message_id: string | null;
  source_artifact_sha256: string | null;
  source_artifact_bytes: number | null;
  parser_version: string | null;
  source_schema_signature: string | null;
  expected_schema_signature: string | null;
  staged_sample_count: number;
  consumed_sample_count: number;
  last_error: string | null;
  attention_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TapoHistoryExportStagedSampleRow {
  id: number;
  job_id: string;
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  timestamp: string;
  source: "tp-link";
  quality: MeasurementSample["quality"];
  source_identity: string;
  created_at: string;
  consumed_at: string | null;
}

export interface TapoHistoryExportJobInput {
  /** Optional caller-generated id, useful when a plus-address must contain the final job id. */
  id?: string;
  provider: TapoHistoryExportProvider;
  sensorId: string;
  expectedDeviceId: string;
  deviceName?: string;
  /** Immutable house-timezone snapshot used for app date selection and CSV parsing. */
  timeZone?: string;
  metric: string;
  expectedRecipient: string | null;
  rangeStart: string;
  rangeEnd: string;
  intervalMinutes: number;
  /** Optional caller-owned idempotency key; otherwise a stable key is derived from the request. */
  dedupeKey?: string;
  maxAttempts?: number;
  availableAt?: string;
}

export interface TapoHistoryExportJob {
  id: string;
  dedupeKey: string;
  /** Acceptance-only jobs are staged for inspection but never reused for gap recovery. */
  canary: boolean;
  provider: TapoHistoryExportProvider;
  sensorId: string;
  expectedDeviceId: string;
  /** Stable-device alias used by the isolated mobile worker protocol. */
  deviceId: string;
  deviceName: string;
  timeZone: string;
  metric: string;
  expectedRecipient: string | null;
  rangeStart: string;
  rangeEnd: string;
  /** Range aliases used by the isolated mobile worker protocol. */
  from: string;
  to: string;
  intervalMinutes: number;
  status: TapoHistoryExportJobStatus;
  attemptCount: number;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  /** API-clock timestamp when the worker confirmed that Tapo accepted this attempt. */
  submittedAt: string | null;
  /** Exact automation deployment that leased this generation; internal audit data. */
  deploymentFingerprint: string | null;
  /** API parser/mailbox acceptance revision snapshotted when this generation was leased. */
  acceptanceRevision: string | null;
  mailboxMessageId: string | null;
  sourceArtifactSha256: string | null;
  sourceArtifactBytes: number | null;
  parserVersion: string | null;
  /** Structural signature of the exact parsed source CSV. */
  sourceSchemaSignature: string | null;
  /** Canary-approved schema snapshot fenced when an ordinary job was leased. */
  expectedSchemaSignature: string | null;
  stagedSampleCount: number;
  consumedSampleCount: number;
  lastError: string | null;
  attentionReason: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TapoHistoryExportClaim {
  job: TapoHistoryExportJob;
  /** Capability token required for worker-owned state changes; deliberately absent from the public job record. */
  leaseToken: string;
}

export interface TapoHistoryExportEnqueueResult {
  job: TapoHistoryExportJob;
  created: boolean;
}

export interface TapoHistoryExportJobFilter {
  statuses?: TapoHistoryExportJobStatus[];
  provider?: TapoHistoryExportProvider;
  sensorId?: string;
  limit?: number;
  oldestFirst?: boolean;
}

export interface TapoHistoryExportStagedSampleInput {
  metric: string;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  /** Stable row identity from the CSV/private response, used to make reparsing idempotent. */
  sourceIdentity: string;
  source?: "tp-link";
  quality?: MeasurementSample["quality"];
}

export interface TapoHistoryExportStagedSample extends MeasurementSample {
  id: number;
  jobId: string;
  source: "tp-link";
  sourceIdentity: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface TapoHistoryExportStagedSampleFilter {
  jobId?: string;
  sensorId?: string;
  metric?: string;
  from?: string;
  to?: string;
  consumed?: boolean;
  limit?: number;
}

export interface TapoHistoryExportTransition {
  status: TapoHistoryExportJobStatus;
  at?: string;
  leaseToken?: string;
  /** Optional mailbox-generation fence for asynchronous poller transitions. */
  expectedRecipient?: string | null;
  /** Optional mailbox-generation fence for asynchronous poller transitions. */
  expectedSubmittedAt?: string | null;
  error?: string | null;
  attentionReason?: string | null;
  /** Retry time used when transitioning to failed or queued. */
  availableAt?: string;
}

export interface TapoHistoryExportStageResult {
  job: TapoHistoryExportJob;
  staged: TapoHistoryExportStagedSample[];
  duplicateCount: number;
}

export interface TapoHistoryExportCompletionOptions {
  mailboxMessageId?: string;
  leaseToken?: string;
  completedAt?: string;
  /** Exact per-attempt mailbox capability observed before the asynchronous fetch. */
  expectedRecipient?: string;
  /** Exact API-clock submission timestamp observed before the asynchronous fetch. */
  expectedSubmittedAt?: string;
  /** SHA-256 of the exact source attachment before parsing. Required for app exports. */
  sourceArtifactSha256?: string;
  /** Exact raw attachment length before parsing. Required for app exports. */
  sourceArtifactBytes?: number;
  /** Versioned parser/schema identity used for this import. Required for app exports. */
  parserVersion?: string;
  /** Canonical structural signature emitted by the parser. Required for app exports. */
  sourceSchemaSignature?: string;
}

export interface TapoHistoryClaimOptions {
  canaryOnly?: boolean;
  preferCanary?: boolean;
  deploymentFingerprint?: string;
  acceptanceRevision?: string;
  requireApprovedTarget?: boolean;
  approvalNotBefore?: string;
  requiredAcceptanceRevision?: string;
  /** Atomic vendor/mailbox traffic slots across claimed, running, and waiting-email Appium jobs. */
  maxOutstandingAppium?: number;
}

export interface HistoricalTelemetryGap {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface AssetRecord {
  id: string;
  houseId: string;
  name: string;
  mimeType: string;
  kind: "floor-plan" | "model-3d" | "other";
  size: number;
  createdAt: string;
}

export class ClimateDataValidationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
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
