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
import { AlertTransition, DueAlertCondition, NotificationChannel, NotificationOutboxItem, boundedCollectionLimit } from "../support/01-json-value-to-area-equipment-row.js";
import { AlertEventRow, AlertRuleRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { eventFromRow, ruleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    enqueueOperationalNotification(input: {
            subjectKind: Extract<NotificationSubjectKind, "maintenance" | "action-run">;
            subjectId: string;
            stage: Extract<NotificationDeliveryStage, "due" | "verification">;
            sequence?: number;
            policy?: AlertDeliveryPolicy;
            severity?: "info" | "warning" | "critical";
            webhookEnabled: boolean;
            telegramEnabled: boolean;
            config?: import("../../config.js").AppConfig;
            type: "maintenance.due" | "action.verification";
            text: string;
            data: unknown;
            now?: Date;
        }): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
  }

  interface ClimateDatabaseCore {
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    enqueueOperationalNotification(input: {
            subjectKind: Extract<NotificationSubjectKind, "maintenance" | "action-run">;
            subjectId: string;
            stage: Extract<NotificationDeliveryStage, "due" | "verification">;
            sequence?: number;
            policy?: AlertDeliveryPolicy;
            severity?: "info" | "warning" | "critical";
            webhookEnabled: boolean;
            telegramEnabled: boolean;
            config?: import("../../config.js").AppConfig;
            type: "maintenance.due" | "action.verification";
            text: string;
            data: unknown;
            now?: Date;
        }): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
  }
}
