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
import type { TapoHistoryExportEnqueueResult, TapoHistoryExportJob, TapoHistoryExportJobFilter, TapoHistoryExportJobInput, TapoHistoryExportJobRow } from "../tapo-history-export-types.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { TAPO_HISTORY_EXPORT_TRANSITIONS, normalizedSha256, normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, tapoHistoryExportJobFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    enqueueTapoHistoryExportJob(input: TapoHistoryExportJobInput, createdAt?: string): TapoHistoryExportEnqueueResult;
    getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null;
    getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null;
    listTapoHistoryExportJobs(filter?: TapoHistoryExportJobFilter): TapoHistoryExportJob[];
    hasOpenTapoHistoryCanary(): boolean;
    countWaitingTapoHistoryExportEmails(): number;
    hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean;
    approveTapoHistoryDeploymentFromCanary(canaryJobId: string, acceptanceRevision: string, approvedAt?: string): void;
    revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number;
    revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number;
    tapoHistoryCanaryRenewalTarget(deploymentFingerprint: string, acceptanceRevision: string, approvedNotAfter: string): TapoHistoryExportJob | null;
  }

  interface ClimateDatabaseCore {
    enqueueTapoHistoryExportJob(input: TapoHistoryExportJobInput, createdAt?: string): TapoHistoryExportEnqueueResult;
    getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null;
    getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null;
    listTapoHistoryExportJobs(filter?: TapoHistoryExportJobFilter): TapoHistoryExportJob[];
    hasOpenTapoHistoryCanary(): boolean;
    countWaitingTapoHistoryExportEmails(): number;
    hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean;
    approveTapoHistoryDeploymentFromCanary(canaryJobId: string, acceptanceRevision: string, approvedAt?: string): void;
    revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number;
    revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number;
    tapoHistoryCanaryRenewalTarget(deploymentFingerprint: string, acceptanceRevision: string, approvedNotAfter: string): TapoHistoryExportJob | null;
  }
}
