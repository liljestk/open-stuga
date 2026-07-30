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
import { ElectricityPriceArchiveRecord, ElectricityPricePointRow, OpeningStateArchiveRecord, TelemetryArchiveDirtyRow, TelemetryArchiveMutableTable, TelemetryArchiveRow, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import { MeasurementSampleRow, OutdoorTemperatureRow, ReadingRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { measurementSampleFromRow, readingFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { outdoorTemperatureFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    insertReading(reading: Reading, enqueueAlertEvaluation?: boolean): boolean;
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertLegacyReadingUnchecked(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
  }

  interface ClimateDatabaseCore {
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
  }
}
