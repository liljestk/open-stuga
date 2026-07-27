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
import { DEFAULT_PROPERTY_ID } from "../support/01-json-value-to-area-equipment-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  migrateCoreAndResourceSchema(): void {
      this.db.exec(CORE_SCHEMA_SQL);
      const orphanedMaintenanceRevision = this.db.prepare(`
              SELECT revision.maintenance_task_id, revision.revision
              FROM maintenance_task_revisions AS revision
              LEFT JOIN maintenance_tasks AS task ON task.id = revision.maintenance_task_id
              WHERE task.id IS NULL
              ORDER BY revision.maintenance_task_id, revision.revision
              LIMIT 1
            `).get() as { maintenance_task_id: string; revision: number } | undefined;
      if (orphanedMaintenanceRevision) {
              throw new Error(
                `ORPHANED_MAINTENANCE_REVISION: maintenance task ${orphanedMaintenanceRevision.maintenance_task_id} `
                + `is missing for revision ${orphanedMaintenanceRevision.revision}`,
              );
            }
      // Older builds allowed more than one unresolved row per rule/sensor.
            // Resolve all but the newest before enforcing the durable invariant.
            this.db.exec(`
              UPDATE alert_events AS candidate
              SET resolved_at = candidate.started_at
              WHERE candidate.resolved_at IS NULL AND EXISTS (
                SELECT 1 FROM alert_events AS newer
                WHERE newer.rule_id = candidate.rule_id
                  AND newer.sensor_id = candidate.sensor_id
                  AND newer.resolved_at IS NULL
                  AND (newer.started_at > candidate.started_at
                    OR (newer.started_at = candidate.started_at AND newer.id > candidate.id))
              );
              CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_one_active
                ON alert_events(rule_id, sensor_id) WHERE resolved_at IS NULL;
            `);
      const outdoorColumns = this.db.prepare("PRAGMA table_info(outdoor_temperature_samples)")
            .all() as unknown as Array<{ name: string }>;
      if (!outdoorColumns.some((column) => column.name === "conditions_json")) {
            this.db.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN conditions_json TEXT");
          }
      const electricityPriceColumns = this.db.prepare("PRAGMA table_info(electricity_price_points)")
            .all() as unknown as Array<{ name: string }>;
      if (!electricityPriceColumns.some((column) => column.name === "margin_cents_per_kwh")) {
            this.db.exec("ALTER TABLE electricity_price_points ADD COLUMN margin_cents_per_kwh REAL NOT NULL DEFAULT 0");
            this.db.exec(`UPDATE electricity_price_points
              SET margin_cents_per_kwh = COALESCE((SELECT config.margin_cents_per_kwh
                FROM property_electricity_configs AS config
                WHERE config.property_id = electricity_price_points.property_id), 0)`);
          }
      const openingStateColumns = this.db.prepare("PRAGMA table_info(opening_state_observations)")
            .all() as unknown as Array<{ name: string }>;
      if (!openingStateColumns.some((column) => column.name === "connection_id")) {
            this.db.exec("ALTER TABLE opening_state_observations ADD COLUMN connection_id TEXT");
          }
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_opening_state_source_time
              ON opening_state_observations(house_id, floor_id, element_id, source, observed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_opening_state_provider_time
              ON opening_state_observations(house_id, floor_id, element_id, source, external_id, connection_id, observed_at DESC);
          `);
      const propertyColumns = this.db.prepare("PRAGMA table_info(properties)").all() as unknown as Array<{ name: string }>;
      if (!propertyColumns.some((column) => column.name === "stugby_json")) {
            this.db.exec("ALTER TABLE properties ADD COLUMN stugby_json TEXT");
          }
      const houseColumns = this.db.prepare("PRAGMA table_info(houses)").all() as unknown as Array<{ name: string }>;
      const migrationTimestamp = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO properties
            (id, name, description, location_json, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)`)
            .run(DEFAULT_PROPERTY_ID, "My property", migrationTimestamp, migrationTimestamp);
      this.db.prepare(`INSERT OR IGNORE INTO property_electricity_configs
            (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
             contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
            SELECT id, 'porssisahko', ?, 1, 0, 'spot', NULL, NULL, NULL, NULL, NULL, ? FROM properties`)
            .run(DEFAULT_ELECTRICITY_PRICE_ENDPOINT, migrationTimestamp);
      if (!houseColumns.some((column) => column.name === "property_id")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN property_id TEXT REFERENCES properties(id) ON DELETE RESTRICT");
          }
      this.db.prepare(`UPDATE houses SET property_id = ?
            WHERE property_id IS NULL OR trim(property_id) = ''
              OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = houses.property_id)`)
            .run(DEFAULT_PROPERTY_ID);
      if (!houseColumns.some((column) => column.name === "location_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN location_json TEXT");
          }
      if (!houseColumns.some((column) => column.name === "map_placement_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN map_placement_json TEXT");
          }
      if (!houseColumns.some((column) => column.name === "orientation_degrees")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360)");
          }
      if (!houseColumns.some((column) => column.name === "stugby_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN stugby_json TEXT");
          }
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_houses_property_name ON houses(property_id, name, id);
            DROP TRIGGER IF EXISTS require_house_property_insert;
            CREATE TRIGGER require_house_property_insert
              BEFORE INSERT ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
                OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
              BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
            DROP TRIGGER IF EXISTS require_house_property_update;
            CREATE TRIGGER require_house_property_update
              BEFORE UPDATE OF property_id ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
                OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
              BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
          `);
      const propertyAreaColumns = this.db.prepare("PRAGMA table_info(property_areas)").all() as unknown as Array<{ name: string }>;
      if (!propertyAreaColumns.some((column) => column.name === "location_json")) {
            this.db.exec("ALTER TABLE property_areas ADD COLUMN location_json TEXT");
          }
      const sensorColumns = this.db.prepare("PRAGMA table_info(sensors)").all() as unknown as Array<{ name: string }>;
      if (!sensorColumns.some((column) => column.name === "measurement_entity_ids_json")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN measurement_entity_ids_json TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "tp_link_device_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_device_id TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "tp_link_connection_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_connection_id TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "room_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN room_id TEXT");
          }
      const tapoExportColumns = this.db.prepare("PRAGMA table_info(tapo_history_export_jobs)")
            .all() as unknown as Array<{ name: string }>;
      if (!tapoExportColumns.some((column) => column.name === "time_zone")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'");
            this.db.exec(`UPDATE tapo_history_export_jobs
              SET time_zone = COALESCE((
                SELECT house.timezone FROM sensors AS sensor
                JOIN houses AS house ON house.id = sensor.house_id
                WHERE sensor.id = tapo_history_export_jobs.sensor_id
              ), 'UTC')`);
          }
      if (!tapoExportColumns.some((column) => column.name === "submitted_at")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN submitted_at TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "deployment_fingerprint")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN deployment_fingerprint TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "acceptance_revision")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN acceptance_revision TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_artifact_sha256")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_sha256 TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_artifact_bytes")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_bytes INTEGER");
          }
      if (!tapoExportColumns.some((column) => column.name === "parser_version")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN parser_version TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_schema_signature")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_schema_signature TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "expected_schema_signature")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN expected_schema_signature TEXT");
          }
      const tapoApprovalColumns = this.db.prepare("PRAGMA table_info(tapo_history_canary_approvals)")
            .all() as unknown as Array<{ name: string }>;
      if (!tapoApprovalColumns.some((column) => column.name === "acceptance_revision")) {
            this.db.exec(`ALTER TABLE tapo_history_canary_approvals
              ADD COLUMN acceptance_revision TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
          }
      if (!tapoApprovalColumns.some((column) => column.name === "schema_signature")) {
            this.db.exec(`ALTER TABLE tapo_history_canary_approvals
              ADD COLUMN schema_signature TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
            // An approval created before schema fencing cannot safely authorize a
            // future vendor CSV. The completed canary remains available for audit.
            this.db.exec("DELETE FROM tapo_history_canary_approvals");
          }
      this.migrateSensorRoomIds();
    },
});
