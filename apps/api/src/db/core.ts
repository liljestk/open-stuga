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
} from "../notification-snapshot.js";
import type { APNSDestination } from "../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord, PowerCostAggregateQuery } from "../timeseries/types.js";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../method-registry.js";
import { CORE_SCHEMA_SQL } from "./migrations/core-schema.js";

export interface DatabaseInternals {
  readonly db: DatabaseSync;
  transaction<T>(operation: () => T): T;
  immediateTransaction<T>(operation: () => T): T;
}

export type DatabaseMethodSet = RegisteredMethodSet<DatabaseInternals>;

export interface ClimateDatabaseCore {
  migrateEquipmentPlacementTable(): void;
  purgeSourceLabelledDemoTelemetry(): void;
  purgeSharedHomeLocalState(houseId?: string): void;
  backfillLegacyMeasurements(): void;
  backfillSeedOutdoorTemperature(): void;
}

export class ClimateDatabaseCore {
  readonly db: DatabaseSync;
  #transactionDepth = 0;
  constructor(path: string, seed = true, options: { readOnly?: boolean } = {}) {
      if (options.readOnly) {
        if (path === ":memory:") throw new Error("A read-only ClimateDatabase requires an existing database file");
        this.db = new DatabaseSync(path, { readOnly: true });
        this.db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        return;
      }
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.migrateEquipmentPlacementTable();
      this.migrate();
      const realDataMode = this.isRealDataMode();
      // Never seed a database that has crossed the one-way boundary, including
      // partially restored databases whose seed metadata is missing.
      if (seed && !realDataMode) this.seed();
      // A persisted real-data latch is authoritative even if the database was
      // modified outside the application while it was stopped.
      if (realDataMode) this.purgeSourceLabelledDemoTelemetry();
      this.purgeSharedHomeLocalState();
      this.backfillLegacyMeasurements();
      if (seed && !realDataMode) this.backfillSeedOutdoorTemperature();
      // Preserve the same fail-closed cleanup if initialization ever crosses
      // the one-way boundary, without rescanning an already-real database.
      if (!realDataMode && this.isRealDataMode()) this.purgeSourceLabelledDemoTelemetry();
    }
  transaction<T>(operation: () => T): T {
      return this.immediateTransaction(operation);
    }
  private immediateTransaction<T>(operation: () => T): T {
      if (this.#transactionDepth > 0) return operation();
      this.db.exec("BEGIN IMMEDIATE");
      this.#transactionDepth += 1;
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    }
}

type DatabasePublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<ClimateDatabaseCore, DatabaseInternals>
>;

export function registerDatabaseMethods(methods: DatabaseMethodSet): void {
  installRegisteredMethods("ClimateDatabase", ClimateDatabaseCore.prototype, methods);
}
