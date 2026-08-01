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
import { MAINTENANCE_TASK_CHANGED_FIELDS } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor, StaticParameterRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { AssetRecord, ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { canonicalMaintenanceLifecycle, canonicalMaintenanceObservationIds, maintenanceDate } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import { parameterFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
    maintenanceTaskObservationIds(maintenanceTaskId: string): string[];
    replaceMaintenanceTaskObservationLinks(maintenanceTaskId: string, observationIds: string[]): void;
    insertMaintenanceTaskRevision(
        task: MaintenanceTask,
        actor: MaintenanceTaskRevisionActor,
        changedFields: MaintenanceTaskChangedField[],
      ): void;
    ensureScopeMoveCanDetachHouses(where: string, values: string[], propertyId: string): void;
    maintenanceTasksBeforeScopeMove(where: string, values: string[]): MaintenanceTask[];
    recordScopeMoveMaintenanceRevisions(
        previousTasks: readonly MaintenanceTask[],
        actor?: MaintenanceTaskRevisionActor,
      ): void;
    validateMaintenanceTask(task: MaintenanceTask, retainedHiddenHouseId?: string | null): void;
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }
}
