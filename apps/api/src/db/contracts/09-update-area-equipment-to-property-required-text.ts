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
import { boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { EquipmentAttachmentDataRow, EquipmentAttachmentRow, EquipmentLinkRow, LocalMaintenanceTaskRevisionActor, PropertyNoteRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { equipmentAttachmentFromRow, equipmentLinkFromRow, propertyNoteFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    updateAreaEquipment(id: string, patch: AreaEquipmentPatch, actor?: LocalMaintenanceTaskRevisionActor): AreaEquipment | null;
    deleteAreaEquipment(id: string): boolean;
    listEquipmentAttachments(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentAttachment[];
    getEquipmentAttachment(id: string): (EquipmentAttachment & {
            data: Uint8Array;
        }) | null;
    createEquipmentAttachment(input: {
            equipmentId: string;
            kind: EquipmentAttachment["kind"];
            name: string;
            mimeType: string;
            data: Uint8Array;
        }): EquipmentAttachment;
    deleteEquipmentAttachment(id: string): boolean;
    listEquipmentLinks(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentLink[];
    getEquipmentLink(id: string): EquipmentLink | null;
    createEquipmentLink(input: EquipmentLinkInput & {
            equipmentId: string;
        }): EquipmentLink;
    updateEquipmentLink(id: string, patch: EquipmentLinkPatch): EquipmentLink | null;
    deleteEquipmentLink(id: string): boolean;
    listPropertyNotes(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): PropertyNote[];
    getPropertyNote(id: string): PropertyNote | null;
    createPropertyNote(input: PropertyNoteInput): PropertyNote;
    updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null;
    deletePropertyNote(id: string): boolean;
    propertyRequiredText(value: string, field: string, maximumLength: number): string;
  }

  interface ClimateDatabaseCore {
    updateAreaEquipment(id: string, patch: AreaEquipmentPatch, actor?: LocalMaintenanceTaskRevisionActor): AreaEquipment | null;
    deleteAreaEquipment(id: string): boolean;
    listEquipmentAttachments(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentAttachment[];
    getEquipmentAttachment(id: string): (EquipmentAttachment & {
            data: Uint8Array;
        }) | null;
    createEquipmentAttachment(input: {
            equipmentId: string;
            kind: EquipmentAttachment["kind"];
            name: string;
            mimeType: string;
            data: Uint8Array;
        }): EquipmentAttachment;
    deleteEquipmentAttachment(id: string): boolean;
    listEquipmentLinks(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentLink[];
    getEquipmentLink(id: string): EquipmentLink | null;
    createEquipmentLink(input: EquipmentLinkInput & {
            equipmentId: string;
        }): EquipmentLink;
    updateEquipmentLink(id: string, patch: EquipmentLinkPatch): EquipmentLink | null;
    deleteEquipmentLink(id: string): boolean;
    listPropertyNotes(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): PropertyNote[];
    getPropertyNote(id: string): PropertyNote | null;
    createPropertyNote(input: PropertyNoteInput): PropertyNote;
    updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null;
    deletePropertyNote(id: string): boolean;
  }
}
