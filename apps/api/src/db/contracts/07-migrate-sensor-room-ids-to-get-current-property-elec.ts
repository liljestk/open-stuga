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
import { DEFAULT_COLLECTION_LIMIT, DEFAULT_PROPERTY_ID, ElectricityPricePointRow, PropertyElectricityConfigRow, PropertyRow, boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { ClimateDataValidationError, parseJson } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { electricityConfigFromRow, propertyFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateSensorRoomIds(): void;
    seed(): void;
    close(): void;
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    assertTelemetryResourceIdAvailable(
        resourceType: "property" | "house" | "sensor",
        resourceId: string,
      ): void;
    createProperty(input: PropertyCreateInput): Property;
    getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null;
    listPropertyElectricityConfigs(): PropertyElectricityConfig[];
    updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null;
    storePropertyElectricityPrices(propertyId: string, prices: Array<{
            startAt: string;
            endAt: string;
            rawPriceCentsPerKwh: number;
        }>, fetchedAt: string): void;
    setPropertyElectricityFetchError(propertyId: string, message: string): void;
    listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
    getCurrentPropertyElectricityPrice(propertyId: string, at?: string): PropertyElectricityPricePoint | null;
  }

  interface ClimateDatabaseCore {
    seed(): void;
    close(): void;
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    createProperty(input: PropertyCreateInput): Property;
    getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null;
    listPropertyElectricityConfigs(): PropertyElectricityConfig[];
    updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null;
    storePropertyElectricityPrices(propertyId: string, prices: Array<{
            startAt: string;
            endAt: string;
            rawPriceCentsPerKwh: number;
        }>, fetchedAt: string): void;
    setPropertyElectricityFetchError(propertyId: string, message: string): void;
    listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
    getCurrentPropertyElectricityPrice(propertyId: string, at?: string): PropertyElectricityPricePoint | null;
  }
}
