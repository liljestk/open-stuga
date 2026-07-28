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
import { NotificationChannel, OBSERVATION_CHANGED_FIELDS, boundedCollectionLimit } from "../support/01-json-value-to-area-equipment-row.js";
import { ActionPlaybookRow, ActionRunRow, LocalObservationRevisionActor, ObservationRevisionRow, ObservationRow, StoredObservation } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { actionPlaybookFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { actionRunFromRow, canonicalObservationCreateTime, observationFromRow, observationRevisionFromRow } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pendingNotificationCount(): number;
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
  }

  interface ClimateDatabaseCore {
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pendingNotificationCount(): number;
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
  }
}
