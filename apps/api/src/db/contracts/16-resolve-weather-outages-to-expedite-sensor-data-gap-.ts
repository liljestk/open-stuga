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
import { TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS } from "../support/01-json-value-to-area-equipment-row.js";
import { SensorDataGapSource, SensorDataGapState, WeatherOutageRecord, WeatherOutageRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { ClimateDataValidationError, SensorDataGapRecord, SensorDataGapRow } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, sensorDataGapFromRow, weatherOutageFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
    sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[];
    measurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    unrecordedMeasurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, candidates: HistoricalTelemetryGap[], limit?: number): HistoricalTelemetryGap[];
    noteHistoricalSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, endedAt: string, detectedAt?: string): SensorDataGapRecord;
    rearmSensorDataGapRecovery(id: number, availableAt?: string, resetAttempts?: boolean): SensorDataGapRecord | null;
    rearmNotSupportedSensorDataGaps(source: SensorDataGapSource, capabilityRevision: string, availableAt?: string): number;
    rearmRetainedTpLinkClimateHistoryGaps(capabilityRevision: string, availableAt?: string): number;
    rearmEligibleNotSupportedTapoGaps(sensorId: string | null, metric: string | null): number;
    openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null;
    noteSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, detectedAt?: string): SensorDataGapRecord;
    resolveSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, endedAt?: string): SensorDataGapRecord | null;
    sensorDataGap(id: number): SensorDataGapRecord | null;
    listSensorDataGaps(sensorId?: string, limit?: number): SensorDataGapRecord[];
    listHouseSensorDataGaps(houseId: string, sensorId?: string, limit?: number): SensorDataGapRecord[];
    recoverableSensorDataGaps(now?: string, limit?: number): SensorDataGapRecord[];
    claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null;
    updateSensorDataGapRecovery(id: number, state: Exclude<SensorDataGapState, "open" | "pending" | "running">, recoveredPoints: number, attemptedAt: string, error: string | null, nextAttemptAt?: string | null): void;
    expediteSensorDataGapRecovery(sensorId: string, source: SensorDataGapSource, from: string, to: string, now?: string): number;
  }

  interface ClimateDatabaseCore {
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
    sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[];
    measurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    unrecordedMeasurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, candidates: HistoricalTelemetryGap[], limit?: number): HistoricalTelemetryGap[];
    noteHistoricalSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, endedAt: string, detectedAt?: string): SensorDataGapRecord;
    rearmSensorDataGapRecovery(id: number, availableAt?: string, resetAttempts?: boolean): SensorDataGapRecord | null;
    rearmNotSupportedSensorDataGaps(source: SensorDataGapSource, capabilityRevision: string, availableAt?: string): number;
    rearmRetainedTpLinkClimateHistoryGaps(capabilityRevision: string, availableAt?: string): number;
    openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null;
    noteSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, detectedAt?: string): SensorDataGapRecord;
    resolveSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, endedAt?: string): SensorDataGapRecord | null;
    sensorDataGap(id: number): SensorDataGapRecord | null;
    listSensorDataGaps(sensorId?: string, limit?: number): SensorDataGapRecord[];
    listHouseSensorDataGaps(houseId: string, sensorId?: string, limit?: number): SensorDataGapRecord[];
    recoverableSensorDataGaps(now?: string, limit?: number): SensorDataGapRecord[];
    claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null;
    updateSensorDataGapRecovery(id: number, state: Exclude<SensorDataGapState, "open" | "pending" | "running">, recoveredPoints: number, attemptedAt: string, error: string | null, nextAttemptAt?: string | null): void;
    expediteSensorDataGapRecovery(sensorId: string, source: SensorDataGapSource, from: string, to: string, now?: string): number;
  }
}
