import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { LocalCostIsolate } from "../timeseries/local-cost-isolate.js";

export interface DatabaseInternals {
  readonly db: DatabaseSync;
  closeCostReader(): void;
  costAggregateAsync(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
  transaction<T>(operation: () => T): T;
  immediateTransaction<T>(operation: () => T): T;
}

/**
 * Points SQLite's spill files (temp B-trees for large ORDER BY/GROUP BY and
 * index builds) at a directory on the same volume as the database. The
 * hardened containers run with a read-only root filesystem where the only
 * writable fallback in SQLite's built-in search order is a 32 MiB /tmp tmpfs,
 * and a sort that outgrows it fails the whole statement with SQLITE_FULL
 * ("database or disk is full"). SQLite verifies the directory is writable and
 * silently falls back to its built-in order when it is not, so pointing at a
 * directory that cannot be created (for example a read-only data mount) keeps
 * today's behavior. An operator-provided SQLITE_TMPDIR always wins, and the
 * Windows VFS ignores the variable entirely.
 */
export function ensureSqliteSpillDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || process.env.SQLITE_TMPDIR) return;
  const spillDirectory = join(dirname(databasePath), ".sqlite-tmp");
  try {
    mkdirSync(spillDirectory, { recursive: true });
  } catch {
    return;
  }
  process.env.SQLITE_TMPDIR = spillDirectory;
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
  readonly #databasePath: string;
  #costReader: LocalCostIsolate | null = null;
  #transactionDepth = 0;
  constructor(path: string, seed = true, options: { readOnly?: boolean } = {}) {
      this.#databasePath = path;
      if (options.readOnly) {
        if (path === ":memory:") throw new Error("A read-only ClimateDatabase requires an existing database file");
        // Read-only connections still create spill files for large sorts.
        ensureSqliteSpillDirectory(path);
        this.db = new DatabaseSync(path, { readOnly: true });
        this.db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        return;
      }
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      ensureSqliteSpillDirectory(path);
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
  async costAggregateAsync(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
      // In-memory fixtures cannot share a connection with a worker. Appliance
      // and standalone deployments use the file-backed, cancellable reader.
      if (this.#databasePath === ":memory:") {
        query.signal?.throwIfAborted();
        return metric === "energy" ? this.energyCostAggregate(query) : this.powerCostAggregate(query);
      }
      this.#costReader ??= new LocalCostIsolate(this.#databasePath);
      return this.#costReader.read(metric, query);
    }
  closeCostReader(): void {
      this.#costReader?.close();
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
