import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  SECURITY_AUDIT_SUBJECT_TYPES,
  fixedPlanElementOpeningState,
} from "@climate-twin/contracts";
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
import { HEAT_PUMP_MEASUREMENT_DEFINITIONS } from "../../heat-pump-measurements.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { MIN_SEED_OUTDOOR_READINGS } from "../support/01-json-value-to-area-equipment-row.js";
import { parseJson } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { outdoorLocationKey } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

/** Derived from the contract so the table can never accept fewer subjects than the code records. */
const SECURITY_AUDIT_SUBJECT_TYPE_LIST = SECURITY_AUDIT_SUBJECT_TYPES.map((subject) => `'${subject}'`).join(", ");

registerDatabaseMethods({
  migrateMeasurementAndActionSchema(): void {
      const measurementColumns = new Set((this.db.prepare("PRAGMA table_info(measurement_definitions)").all() as Array<{ name: string }>).map((column) => column.name));
      const measurementColumnMigrations = [
            ["dimension", "ALTER TABLE measurement_definitions ADD COLUMN dimension TEXT NOT NULL DEFAULT 'finite_scalar'"],
            ["allowed_units_json", "ALTER TABLE measurement_definitions ADD COLUMN allowed_units_json TEXT NOT NULL DEFAULT '[]'"],
            ["kind", "ALTER TABLE measurement_definitions ADD COLUMN kind TEXT NOT NULL DEFAULT 'gauge'"],
            ["default_aggregation", "ALTER TABLE measurement_definitions ADD COLUMN default_aggregation TEXT NOT NULL DEFAULT 'mean'"],
            ["generic_history_enabled", "ALTER TABLE measurement_definitions ADD COLUMN generic_history_enabled INTEGER NOT NULL DEFAULT 1"],
            ["generic_stats_enabled", "ALTER TABLE measurement_definitions ADD COLUMN generic_stats_enabled INTEGER NOT NULL DEFAULT 1"],
          ] as const;
      for (const [column, sql] of measurementColumnMigrations) {
            if (!measurementColumns.has(column)) this.db.exec(sql);
          }
      const definitionsWithoutAllowedUnits = this.db.prepare(
            "SELECT id, unit FROM measurement_definitions WHERE allowed_units_json = '[]'",
          ).all() as Array<{ id: string; unit: string }>;
      const backfillAllowedUnits = this.db.prepare(
            "UPDATE measurement_definitions SET allowed_units_json = ? WHERE id = ?",
          );
      for (const definition of definitionsWithoutAllowedUnits) {
            backfillAllowedUnits.run(JSON.stringify([definition.unit]), definition.id);
          }
      const insertDefinition = this.db.prepare(`INSERT OR IGNORE INTO measurement_definitions
            (id, labels_json, unit, dimension, allowed_units_json, kind, default_aggregation,
             generic_history_enabled, generic_stats_enabled, precision, valid_min, valid_max, display_min, display_max,
             interpolation_delta, color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
      insertDefinition.run("temperature", JSON.stringify({ en: "Temperature", fi: "Lämpötila" }), "°C", "temperature", JSON.stringify(["°C", "°F"]), "gauge", "mean", 1, -80, 100, 15, 30, 2, "thermal", 1, 1);
      insertDefinition.run("humidity", JSON.stringify({ en: "Humidity", fi: "Ilmankosteus" }), "%", "relative_humidity", JSON.stringify(["%"]), "gauge", "mean", 0, 0, 100, 20, 80, 10, "humidity", 1, 1);
      insertDefinition.run("co2", JSON.stringify({ en: "Carbon dioxide", fi: "Hiilidioksidi" }), "ppm", "co2_concentration", JSON.stringify(["ppm"]), "gauge", "mean", 0, 0, 10_000, 400, 2_000, 250, "air-quality", 1, 1);
      insertDefinition.run("power", JSON.stringify({ en: "Power", fi: "Teho" }), "W", "power", JSON.stringify(["W", "kW"]), "rate", "time_weighted_mean", 1, null, null, 0, 10_000, 500, "sequential", 0, 0);
      insertDefinition.run("energy", JSON.stringify({ en: "Energy (cumulative)", fi: "Energia (kumulatiivinen)" }), "kWh", "energy", JSON.stringify(["Wh", "kWh"]), "cumulative_counter", "delta", 3, 0, null, 0, null, 1, "sequential", 0, 0);
      insertDefinition.run("electricity_price", JSON.stringify({ en: "Electricity price", fi: "Sähkön hinta" }), "€/kWh", "finite_scalar", JSON.stringify(["€/kWh"]), "gauge", "mean", 4, null, null, -0.5, 1, 0.05, "sequential", 0, 0);
      for (const definition of HEAT_PUMP_MEASUREMENT_DEFINITIONS) {
        insertDefinition.run(
          definition.id,
          JSON.stringify(definition.labels) ?? "{}",
          definition.unit,
          definition.dimension ?? "finite_scalar",
          JSON.stringify(definition.allowedUnits ?? [definition.unit]),
          definition.kind ?? "gauge",
          definition.defaultAggregation ?? "mean",
          definition.precision,
          definition.validMin,
          definition.validMax,
          definition.displayMin,
          definition.displayMax,
          definition.interpolationDelta,
          definition.colorScale,
          definition.spatialInterpolation ? 1 : 0,
          definition.forecastSupported ? 1 : 0,
        );
      }
      const updateBuiltinAnalytics = this.db.prepare(`UPDATE measurement_definitions SET
            dimension = ?, allowed_units_json = ?, kind = ?, default_aggregation = ?,
            generic_history_enabled = 1, generic_stats_enabled = 1 WHERE id = ?`);
      updateBuiltinAnalytics.run("temperature", JSON.stringify(["°C", "°F"]), "gauge", "mean", "temperature");
      updateBuiltinAnalytics.run("relative_humidity", JSON.stringify(["%"]), "gauge", "mean", "humidity");
      updateBuiltinAnalytics.run("co2_concentration", JSON.stringify(["ppm"]), "gauge", "mean", "co2");
      updateBuiltinAnalytics.run("power", JSON.stringify(["W", "kW"]), "rate", "time_weighted_mean", "power");
      updateBuiltinAnalytics.run("energy", JSON.stringify(["Wh", "kWh"]), "cumulative_counter", "delta", "energy");
      updateBuiltinAnalytics.run("finite_scalar", JSON.stringify(["€/kWh"]), "gauge", "mean", "electricity_price");
      this.db.exec(`
            CREATE TABLE IF NOT EXISTS action_playbooks (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT NOT NULL,
              instructions_json TEXT NOT NULL,
              metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
              goal TEXT NOT NULL CHECK(goal IN ('decrease', 'increase', 'below', 'above')),
              minimum_improvement REAL NOT NULL DEFAULT 0 CHECK(minimum_improvement >= 0),
              target_value REAL,
              wait_seconds INTEGER NOT NULL CHECK(wait_seconds BETWEEN 0 AND 604800),
              verification_window_seconds INTEGER NOT NULL CHECK(verification_window_seconds BETWEEN 60 AND 2592000),
              enabled INTEGER NOT NULL DEFAULT 1,
              built_in INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              CHECK((goal IN ('below', 'above') AND target_value IS NOT NULL) OR goal IN ('decrease', 'increase'))
            );
            CREATE TABLE IF NOT EXISTS action_runs (
              id TEXT PRIMARY KEY,
              playbook_id TEXT NOT NULL REFERENCES action_playbooks(id) ON DELETE RESTRICT,
              alert_event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
              maintenance_task_id TEXT REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
              sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE RESTRICT,
              metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
              status TEXT NOT NULL CHECK(status IN ('active', 'waiting', 'verified', 'not-improved', 'cancelled')),
              started_at TEXT NOT NULL,
              action_completed_at TEXT,
              verify_after TEXT,
              verification_deadline TEXT,
              baseline_value REAL NOT NULL,
              baseline_timestamp TEXT NOT NULL,
              result_value REAL,
              result_timestamp TEXT,
              improvement REAL,
              sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
              operator_note TEXT,
              verification_note TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_action_runs_sensor_status
              ON action_runs(sensor_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_action_runs_alert
              ON action_runs(alert_event_id, updated_at DESC) WHERE alert_event_id IS NOT NULL;
            CREATE TABLE IF NOT EXISTS data_audit_events (
              id TEXT PRIMARY KEY,
              event_type TEXT NOT NULL,
              detail_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_data_audit_events_created ON data_audit_events(created_at DESC);
            CREATE TABLE IF NOT EXISTS security_audit_events (
              id TEXT PRIMARY KEY,
              event_type TEXT NOT NULL,
              outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied')),
              actor_user_id TEXT,
              actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'admin', 'member', 'guest', 'service')),
              subject_type TEXT NOT NULL CHECK(subject_type IN (${SECURITY_AUDIT_SUBJECT_TYPE_LIST})),
              subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
              details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_security_audit_events_created
              ON security_audit_events(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_security_audit_events_type_created
              ON security_audit_events(event_type, created_at DESC);
            INSERT OR IGNORE INTO action_playbooks(
              id, name, description, instructions_json, metric, goal, minimum_improvement, target_value,
              wait_seconds, verification_window_seconds, enabled, built_in, created_at, updated_at
            ) VALUES
              ('playbook-humidity-ventilate', 'Ventilate and verify',
               'Reduce persistent indoor humidity with a short, controlled ventilation period.',
               '["Check that outdoor conditions make ventilation appropriate","Open the relevant vents or windows for 15–20 minutes","Close them again and mark the action complete"]',
               'humidity', 'decrease', 3, NULL, 1200, 1800, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              ('playbook-co2-ventilate', 'Refresh indoor air and verify',
               'Reduce elevated carbon dioxide without claiming occupancy or air-flow certainty.',
               '["Open normal ventilation paths","Ventilate for 15–20 minutes","Close openings and mark the action complete"]',
               'co2', 'decrease', 150, NULL, 1200, 1800, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              ('playbook-temperature-heat', 'Restore safe temperature and verify',
               'Inspect heating and safely raise a low indoor temperature.',
               '["Check the heater or heat-pump status","Confirm doors and windows are closed","Apply a safe heating adjustment and mark the action complete"]',
               'temperature', 'increase', 1, NULL, 1800, 3600, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              ('playbook-power-baseload', 'Inspect unusual baseload',
               'Identify and reduce unexpected continuous power use without switching equipment automatically.',
               '["Check the listed plugs and appliances","Turn off only equipment that is safe to stop","Mark the action complete after the load change"]',
               'power', 'decrease', 50, NULL, 300, 900, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          `);
      this.migrateOutdoorLocationKeys();
      this.migrateSensorMeasurementBindings();
      const readingIdentityMigration = this.db.prepare("SELECT value FROM metadata WHERE key = 'reading_identity_v1'").get();
      if (!readingIdentityMigration) {
            if (!this.db.prepare("SELECT value FROM metadata WHERE key = 'reading_identity_v1'").get()) {
              this.db.exec(`
                DELETE FROM readings
                WHERE id NOT IN (SELECT MAX(id) FROM readings GROUP BY sensor_id, timestamp, source);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_identity
                  ON readings(sensor_id, timestamp, source);
                INSERT INTO metadata(key, value) VALUES ('reading_identity_v1', 'complete');
              `);
            }
          }
    },
  migrateRevisionActors(): void {
      const actorExpression = `CASE actor
        WHEN 'hosted-user' THEN 'workspace-user'
        WHEN 'hosted-service' THEN 'system-service'
        WHEN 'local-migration' THEN 'system-service'
        ELSE actor END`;
      const observationSchema = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observation_revisions'",
      ).get() as { sql: string } | undefined;
      const legacyObservationActor = observationSchema && this.db.prepare(`SELECT 1 FROM observation_revisions
        WHERE actor IN ('hosted-user', 'hosted-service', 'local-migration') LIMIT 1`).get();
      if (observationSchema && (!observationSchema.sql.includes("workspace-user")
        || !observationSchema.sql.includes("system-service") || legacyObservationActor)) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS prevent_observation_revision_insert_collision;
          DROP TRIGGER IF EXISTS prevent_observation_revision_update;
          DROP TRIGGER IF EXISTS prevent_observation_revision_delete;
          DROP TABLE IF EXISTS observation_revisions_next;
          CREATE TABLE observation_revisions_next (
            observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            changed_at TEXT NOT NULL,
            actor TEXT NOT NULL CHECK (actor IN (
              'local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service'
            )),
            changed_fields_json TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            PRIMARY KEY (observation_id, revision)
          );
          INSERT INTO observation_revisions_next
            (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
          SELECT observation_id, revision, changed_at, ${actorExpression}, changed_fields_json, snapshot_json
            FROM observation_revisions;
          DROP TABLE observation_revisions;
          ALTER TABLE observation_revisions_next RENAME TO observation_revisions;
          CREATE INDEX idx_observation_revisions_changed
            ON observation_revisions(observation_id, changed_at, revision);
          CREATE TRIGGER prevent_observation_revision_insert_collision
            BEFORE INSERT ON observation_revisions
            WHEN EXISTS (SELECT 1 FROM observation_revisions
              WHERE observation_id = NEW.observation_id AND revision = NEW.revision)
            BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
          CREATE TRIGGER prevent_observation_revision_update
            BEFORE UPDATE ON observation_revisions
            BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
          CREATE TRIGGER prevent_observation_revision_delete
            BEFORE DELETE ON observation_revisions
            WHEN EXISTS (SELECT 1 FROM observations WHERE id = OLD.observation_id)
            BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
        `);
      }
      const maintenanceSchema = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_task_revisions'",
      ).get() as { sql: string } | undefined;
      const legacyMaintenanceActor = maintenanceSchema && this.db.prepare(`SELECT 1 FROM maintenance_task_revisions
        WHERE actor IN ('hosted-user', 'hosted-service', 'local-migration') LIMIT 1`).get();
      if (maintenanceSchema && (!maintenanceSchema.sql.includes("workspace-user")
        || !maintenanceSchema.sql.includes("system-service") || legacyMaintenanceActor)) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_insert_collision;
          DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_update;
          DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_delete;
          DROP TABLE IF EXISTS maintenance_task_revisions_next;
          CREATE TABLE maintenance_task_revisions_next (
            maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            changed_at TEXT NOT NULL,
            actor TEXT NOT NULL CHECK (actor IN (
              'local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service'
            )),
            changed_fields_json TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            PRIMARY KEY (maintenance_task_id, revision)
          );
          INSERT INTO maintenance_task_revisions_next
            (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
          SELECT maintenance_task_id, revision, changed_at, ${actorExpression}, changed_fields_json, snapshot_json
            FROM maintenance_task_revisions;
          DROP TABLE maintenance_task_revisions;
          ALTER TABLE maintenance_task_revisions_next RENAME TO maintenance_task_revisions;
          CREATE INDEX idx_maintenance_task_revisions_changed
            ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
          CREATE TRIGGER prevent_maintenance_task_revision_insert_collision
            BEFORE INSERT ON maintenance_task_revisions
            WHEN EXISTS (SELECT 1 FROM maintenance_task_revisions
              WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision)
            BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
          CREATE TRIGGER prevent_maintenance_task_revision_update
            BEFORE UPDATE ON maintenance_task_revisions
            BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
          CREATE TRIGGER prevent_maintenance_task_revision_delete
            BEFORE DELETE ON maintenance_task_revisions
            WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
            BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
        `);
      }
    },
  /**
   * Widens the security audit subject constraint to every subject the code records.
   * Databases created before system update, storage, and Cloudflare auditing existed
   * still carry the original four-value CHECK, which rejected those inserts and failed
   * the whole request.
   */
  migrateSecurityAuditSubjectTypes(): void {
      const schema = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_events'",
      ).get() as { sql: string } | undefined;
      if (!schema) return;
      if (SECURITY_AUDIT_SUBJECT_TYPES.every((subject) => schema.sql.includes(`'${subject}'`))) return;
      this.immediateTransaction(() => {
        const currentSchema = this.db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_events'",
        ).get() as { sql: string } | undefined;
        if (!currentSchema
          || SECURITY_AUDIT_SUBJECT_TYPES.every((subject) => currentSchema.sql.includes(`'${subject}'`))) return;
        this.db.exec(`
          DROP TABLE IF EXISTS security_audit_events_next;
          CREATE TABLE security_audit_events_next (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied')),
            actor_user_id TEXT,
            actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'admin', 'member', 'guest', 'service')),
            subject_type TEXT NOT NULL CHECK(subject_type IN (${SECURITY_AUDIT_SUBJECT_TYPE_LIST})),
            subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
            details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
            created_at TEXT NOT NULL
          );
          INSERT INTO security_audit_events_next
            (id, event_type, outcome, actor_user_id, actor_role, subject_type, subject_id, details_json, created_at)
          SELECT id, event_type, outcome, actor_user_id, actor_role, subject_type, subject_id, details_json, created_at
            FROM security_audit_events;
          DROP TABLE security_audit_events;
          ALTER TABLE security_audit_events_next RENAME TO security_audit_events;
          CREATE INDEX IF NOT EXISTS idx_security_audit_events_created
            ON security_audit_events(created_at DESC, id DESC);
          CREATE INDEX IF NOT EXISTS idx_security_audit_events_type_created
            ON security_audit_events(event_type, created_at DESC);
        `);
      });
    },
  migrateOutdoorLocationKeys(): void {
      const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'outdoor_location_keys_v2'").get();
      if (migrated) return;
      this.immediateTransaction(() => {
        if (this.db.prepare("SELECT value FROM metadata WHERE key = 'outdoor_location_keys_v2'").get()) return;
        const houses = this.db.prepare("SELECT id, location_json FROM houses").all() as unknown as Array<{
          id: string;
          location_json: string | null;
        }>;
        const rekey = this.db.prepare(`UPDATE OR REPLACE outdoor_temperature_samples
          SET location_key = ? WHERE house_id = ? AND location_key = ?`);
        const prune = this.db.prepare(`DELETE FROM outdoor_temperature_samples
          WHERE house_id = ? AND location_key <> ?`);
        for (const house of houses) {
          let location: HouseLocation | undefined;
          try {
            location = house.location_json ? JSON.parse(house.location_json) as HouseLocation : undefined;
          } catch {
            location = undefined;
          }
          const allowedKey = outdoorLocationKey(location);
          if (location) {
            const legacyKey = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
            rekey.run(allowedKey, house.id, legacyKey);
          }
          // Removes precise historical coordinates and every superseded location.
          prune.run(house.id, allowedKey);
        }
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('outdoor_location_keys_v2', 'complete')").run();
      });
    },
  backfillLegacyMeasurements(): void {
      const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get();
      if (migrated) return;
      this.immediateTransaction(() => {
        if (this.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get()) return;
        this.db.exec(`
          INSERT OR IGNORE INTO measurement_samples
            (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
          SELECT sensor_id, 'temperature', temperature, '°C', timestamp, source, quality FROM readings;
          INSERT OR IGNORE INTO measurement_samples
            (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
          SELECT sensor_id, 'humidity', humidity, '%', timestamp, source, quality FROM readings;
          INSERT OR IGNORE INTO sensor_recorded_measurements(sensor_id, metric)
            SELECT DISTINCT sensor_id, metric FROM measurement_samples
            WHERE source NOT IN ('mock', 'replay');
          INSERT INTO metadata(key, value) VALUES ('measurement_eav_v2', 'complete');
        `);
      });
    },
  /**
     * Gives the bundled demo an explicitly synthetic outdoor boundary so the physics UI is testable.
     * It is never used for a geolocated house and is labelled `mock` in every result.
     */
  backfillSeedOutdoorTemperature(): void {
      const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_outdoor_temperature_v1'").get();
      if (migrated) return;
      this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_outdoor_temperature_v1'").get()) return;
      const house = this.getHouse("house-main");
      const existing = house
        ? this.db.prepare("SELECT 1 FROM outdoor_temperature_samples WHERE house_id = ? LIMIT 1").get(house.id)
        : null;
      if (house && !house.location && !existing) {
        const readings = this.db.prepare(`SELECT timestamp, temperature FROM readings
          WHERE sensor_id = 'sensor-01' AND source = 'mock' ORDER BY timestamp ASC, id ASC`)
          .all() as unknown as Array<{ timestamp: string; temperature: number }>;
        if (readings.length > MIN_SEED_OUTDOOR_READINGS) {
          const tauHours = 8;
          const liftC = 16;
          const insert = this.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
            (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
            VALUES (?, ?, ?, ?, 'mock', ?, NULL, ?)`);
          let lastOutdoorC = readings[0]?.temperature ?? 0;
          for (let index = 0; index < readings.length - 1; index += 1) {
            const current = readings[index];
            const next = readings[index + 1];
            if (!current || !next) continue;
            const dtHours = (Date.parse(next.timestamp) - Date.parse(current.timestamp)) / 3_600_000;
            if (!(dtHours > 0)) continue;
            const memory = Math.exp(-dtHours / tauHours);
            lastOutdoorC = (next.temperature - memory * current.temperature) / (1 - memory) - liftC;
            insert.run(house.id, outdoorLocationKey(), current.timestamp, lastOutdoorC, current.timestamp, "Synthetic demo boundary");
          }
          const latest = readings.at(-1);
          if (latest) insert.run(house.id, outdoorLocationKey(), latest.timestamp, lastOutdoorC, latest.timestamp, "Synthetic demo boundary");
        }
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_outdoor_temperature_v1', 'complete')").run();
      });
    },
  migrateSensorMeasurementBindings(): void {
      const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_measurement_bindings_v2'").get();
      if (migrated) return;
      this.immediateTransaction(() => {
        if (this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_measurement_bindings_v2'").get()) return;
        const rows = this.db.prepare(`SELECT id, measurement_entity_ids_json, temperature_entity_id, humidity_entity_id
          FROM sensors`).all() as unknown as Array<{
            id: string;
            measurement_entity_ids_json: string | null;
            temperature_entity_id: string | null;
            humidity_entity_id: string | null;
          }>;
        const insert = this.db.prepare(`INSERT OR IGNORE INTO sensor_measurement_bindings(sensor_id, metric, entity_id)
          VALUES (?, ?, ?)`);
        for (const row of rows) {
          const bindings = row.measurement_entity_ids_json ? parseJson<Record<string, string>>(row.measurement_entity_ids_json) : {};
          if (row.temperature_entity_id) bindings.temperature ??= row.temperature_entity_id;
          if (row.humidity_entity_id) bindings.humidity ??= row.humidity_entity_id;
          for (const [metric, entityId] of Object.entries(bindings)) {
            if (this.getMeasurementDefinition(metric)) insert.run(row.id, metric, entityId);
          }
        }
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_measurement_bindings_v2', 'complete')").run();
      });
    },
});
