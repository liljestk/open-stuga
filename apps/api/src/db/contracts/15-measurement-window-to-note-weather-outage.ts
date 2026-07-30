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
import { MeasurementSampleRow, OutdoorTemperatureRow, WeatherOutageRecord, WeatherOutageRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { measurementSampleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { outdoorLocationKey, outdoorTemperatureFromRow, weatherOutageFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(sensorId: string, metric: string, from: string, to: string, bucketSeconds: number, limit?: number): MeasurementSample[];
    measurementHistoryBucketedMulti(sensorIds: string[], metrics: string[], from: string, to: string, bucketSeconds: number, limitPerSeries?: number): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number): MeasurementSample[];
    thermalClimateHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number): MeasurementSample[];
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
  }

  interface ClimateDatabaseCore {
    measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(sensorId: string, metric: string, from: string, to: string, bucketSeconds: number, limit?: number): MeasurementSample[];
    measurementHistoryBucketedMulti(sensorIds: string[], metrics: string[], from: string, to: string, bucketSeconds: number, limitPerSeries?: number): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number): MeasurementSample[];
    thermalClimateHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number): MeasurementSample[];
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
  }
}
