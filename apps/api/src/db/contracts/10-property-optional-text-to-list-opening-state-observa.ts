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
import { DEFAULT_PROPERTY_ID, EQUIPMENT_STATUSES, HouseRow, MAX_COLLECTION_LIMIT, MAX_PROPERTY_AREA_VERTICES, OpeningStateObservationRow, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, PropertyMigrationResult } from "../support/01-json-value-to-area-equipment-row.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { houseFromRow, openingStateObservationFromRow, roomPolygonSelfIntersects } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    propertyOptionalText(value: string | null, field: string, maximumLength: number): string | null;
    equipmentLinkUrl(value: string): string;
    nextUpdatedAt(previous: string): string;
    validatePropertyArea(area: PropertyArea): void;
    validateAreaEquipment(equipment: AreaEquipment, retainedHiddenHouseId?: string | null): void;
    validatePropertyNote(note: PropertyNote, retainedHiddenHouseId?: string | null): void;
    ensureDefaultProperty(): Property;
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
    listOpeningStateObservations(houseId: string, limit?: number, at?: string | number | Date): OpeningStateObservation[];
  }

  interface ClimateDatabaseCore {
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
    listOpeningStateObservations(houseId: string, limit?: number, at?: string | number | Date): OpeningStateObservation[];
  }
}
