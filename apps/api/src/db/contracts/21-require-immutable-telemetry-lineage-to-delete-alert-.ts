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
import { MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER, TelemetryArchiveWatermarks, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import { AlertRuleRow, IOSNotificationRegistrationRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { iosNotificationRegistrationFromRow, ruleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    requireImmutableTelemetryLineage(
        scope: Exclude<TelemetryCascadeScope, "house-location">,
        resourceId: string,
      ): void;
    telemetryArchivePageSize(limit: number): number;
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
  }
}
