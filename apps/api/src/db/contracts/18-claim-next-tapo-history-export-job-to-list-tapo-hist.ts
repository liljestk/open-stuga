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
import { ClimateDataValidationError, TapoHistoryClaimOptions, TapoHistoryExportClaim, TapoHistoryExportJob, TapoHistoryExportJobRow, TapoHistoryExportProvider, TapoHistoryExportTransition } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { TAPO_HISTORY_EXPORT_TRANSITIONS, normalizedSha256, normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, tapoHistoryExportJobFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    claimNextTapoHistoryExportJob(leaseOwner: string, claimedAt: string, leaseUntil: string, providers?: readonly TapoHistoryExportProvider[], reclaimNotAfter?: string, options?: TapoHistoryClaimOptions): TapoHistoryExportClaim | null;
    expireExhaustedTapoHistoryExportLeases(now?: string, reclaimNotAfter?: string): number;
    heartbeatTapoHistoryExportJob(id: string, leaseToken: string, heartbeatAt: string, leaseUntil: string): TapoHistoryExportJob | null;
    rotateTapoHistoryExportRecipient(id: string, leaseToken: string, expectedRecipient: string, rotatedAt?: string): TapoHistoryExportJob | null;
    transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null;
    cancelTapoHistoryExportJob(id: string, cancelledAt?: string): TapoHistoryExportJob | null;
    requeueTapoHistoryExportJob(id: string, availableAt?: string, resetAttempts?: boolean): TapoHistoryExportJob | null;
    attachTapoHistoryExportMailboxMessage(id: string, mailboxMessageId: string, receivedAt?: string): TapoHistoryExportJob | null;
    listTapoHistoryExportMailboxMessageIds(jobId?: string): string[];
  }

  interface ClimateDatabaseCore {
    claimNextTapoHistoryExportJob(leaseOwner: string, claimedAt: string, leaseUntil: string, providers?: readonly TapoHistoryExportProvider[], reclaimNotAfter?: string, options?: TapoHistoryClaimOptions): TapoHistoryExportClaim | null;
    expireExhaustedTapoHistoryExportLeases(now?: string, reclaimNotAfter?: string): number;
    heartbeatTapoHistoryExportJob(id: string, leaseToken: string, heartbeatAt: string, leaseUntil: string): TapoHistoryExportJob | null;
    rotateTapoHistoryExportRecipient(id: string, leaseToken: string, expectedRecipient: string, rotatedAt?: string): TapoHistoryExportJob | null;
    transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null;
    cancelTapoHistoryExportJob(id: string, cancelledAt?: string): TapoHistoryExportJob | null;
    requeueTapoHistoryExportJob(id: string, availableAt?: string, resetAttempts?: boolean): TapoHistoryExportJob | null;
    attachTapoHistoryExportMailboxMessage(id: string, mailboxMessageId: string, receivedAt?: string): TapoHistoryExportJob | null;
    listTapoHistoryExportMailboxMessageIds(jobId?: string): string[];
  }
}
