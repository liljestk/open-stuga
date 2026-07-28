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
import { DEMO_TELEMETRY_SOURCES, DemoTelemetryPurgeResult, IntegrationMappingKind, IntegrationMappingSet, IntegrationMappingSetRow, SecurityAuditEventInput, SecurityAuditEventRow, TelemetryArchiveTable, TelemetryArchiveWatermarks, boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { ClimateDataValidationError, parseJson, securityAuditEventFromRow } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { canonicalIntegrationMappingsJson } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  /**
     * SQLite cannot remove the legacy NOT NULL constraint from `area_id` with
     * ALTER TABLE. Rebuild only this table before the normal transactional
     * migration so existing equipment can later target a Home or stay
     * unassigned without manufacturing a fake Property area.
     */
  migrateEquipmentPlacementTable(): void {
      const columns = this.db.prepare("PRAGMA table_info(area_equipment)").all() as unknown as Array<{
        name: string;
        notnull: number;
      }>;
      if (columns.length === 0) return;
      const area = columns.find((column) => column.name === "area_id");
      const hasHouse = columns.some((column) => column.name === "house_id");
      const hasLocation = columns.some((column) => column.name === "location_json");
      if (area?.notnull === 0 && hasHouse && hasLocation) return;

      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(`
          DROP TABLE IF EXISTS area_equipment_location_next;
          CREATE TABLE area_equipment_location_next (
            id TEXT PRIMARY KEY,
            property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
            area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
            house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
            location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
            name TEXT NOT NULL CHECK (length(trim(name)) > 0),
            kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
            manufacturer TEXT,
            model TEXT,
            serial_number TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((area_id IS NOT NULL) + (house_id IS NOT NULL) <= 1)
          );
          INSERT INTO area_equipment_location_next (
            id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          )
          SELECT id, property_id,
            ${hasHouse ? "CASE WHEN house_id IS NULL THEN area_id ELSE NULL END" : "area_id"},
            ${hasHouse ? "house_id" : "NULL"},
            ${hasLocation ? "location_json" : "NULL"},
            name, kind, manufacturer, model, serial_number, status, notes, created_at, updated_at
          FROM area_equipment;
          DROP TABLE area_equipment;
          CREATE TABLE area_equipment (
            id TEXT PRIMARY KEY,
            property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
            area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
            house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
            location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
            name TEXT NOT NULL CHECK (length(trim(name)) > 0),
            kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
            manufacturer TEXT,
            model TEXT,
            serial_number TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((area_id IS NOT NULL) + (house_id IS NOT NULL) <= 1)
          );
          INSERT INTO area_equipment (
            id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          )
          SELECT id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          FROM area_equipment_location_next;
          DROP TABLE area_equipment_location_next;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* The failed statement may already have rolled back. */ }
        throw error;
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON");
      }
    },
  isRealDataMode(): boolean {
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value === "real";
    },
  realDataModeActivatedAt(): string | null {
      if (!this.isRealDataMode()) return null;
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'").get() as { value: string } | undefined)?.value ?? null;
    },
  mockScenarioId(): string | null {
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'mock_scenario_id'").get() as { value: string } | undefined)?.value ?? null;
    },
  recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent {
      const subjectId = input.subjectId.trim();
      if (!subjectId || subjectId.length > 512) throw new Error("Security audit subject id must contain 1 to 512 characters");
      if (input.actorUserId !== null && (!input.actorUserId.trim() || input.actorUserId.length > 200)) {
        throw new Error("Security audit actor id must contain 1 to 200 characters when present");
      }
      const details = input.details ?? {};
      const entries = Object.entries(details);
      if (entries.length > 32 || entries.some(([key, value]) => (
        !key || key.length > 80
        || (typeof value === "string" && value.length > 512)
        || (value !== null && !["string", "number", "boolean"].includes(typeof value))
        || (typeof value === "number" && !Number.isFinite(value))
      ))) {
        throw new Error("Security audit details must contain at most 32 bounded scalar fields");
      }
      const detailsJson = JSON.stringify(details);
      if (Buffer.byteLength(detailsJson, "utf8") > 8_192) throw new Error("Security audit details exceed 8 KiB");
      const event: SecurityAuditEvent = {
        id: randomUUID(),
        eventType: input.eventType,
        outcome: input.outcome ?? "succeeded",
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        subjectType: input.subjectType,
        subjectId,
        details,
        createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
      };
      this.db.prepare(`INSERT INTO security_audit_events
        (id, event_type, outcome, actor_user_id, actor_role, subject_type, subject_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, event.eventType, event.outcome, event.actorUserId, event.actorRole, event.subjectType,
          event.subjectId, detailsJson, event.createdAt);
      return event;
    },
  listSecurityAuditEvents(limit = 100, offset = 0): SecurityAuditEvent[] {
      const rows = this.db.prepare(`SELECT id, event_type, outcome, actor_user_id, actor_role,
          subject_type, subject_id, details_json, created_at
        FROM security_audit_events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset)) as unknown as SecurityAuditEventRow[];
      return rows.map(securityAuditEventFromRow);
    },
  setMockScenarioId(scenario: string): void {
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('mock_scenario_id', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(scenario);
    },
  /** Stable identity used only to checkpoint this SQLite telemetry buffer. */
  telemetryArchiveSourceId(): string {
      const key = "telemetry_archive_source_id";
      const existing = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
      if (existing?.value) return existing.value;
      const sourceId = randomUUID();
      this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(key, sourceId);
      return (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string }).value;
    },
  getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null {
      const row = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
        .get(kind) as unknown as IntegrationMappingSetRow | undefined;
      if (!row) return null;
      let mappings: unknown;
      try {
        mappings = parseJson<unknown>(row.mappings_json);
      } catch {
        throw new Error(`Stored ${kind} integration mappings contain invalid JSON`);
      }
      if (!Array.isArray(mappings)) throw new Error(`Stored ${kind} integration mappings are not an array`);
      const canonicalJson = canonicalIntegrationMappingsJson(mappings);
      if (canonicalJson !== row.mappings_json) throw new Error(`Stored ${kind} integration mappings are not canonical`);
      const actualHash = createHash("sha256").update(row.mappings_json).digest("hex");
      if (actualHash !== row.content_hash) throw new Error(`Stored ${kind} integration mapping hash does not match its content`);
      return {
        kind: row.kind,
        contentHash: row.content_hash,
        revision: row.revision,
        mappings: mappings as T[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  /** Atomically imports a complete validated mapping set; identical content is a no-op. */
  saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T> {
      if (kind !== "home-assistant" && kind !== "tp-link") throw new Error("Unsupported integration mapping kind");
      if (!Array.isArray(mappings)) throw new Error("Integration mappings must be an array");
      const mappingsJson = canonicalIntegrationMappingsJson(mappings);
      const contentHash = createHash("sha256").update(mappingsJson).digest("hex");
      return this.immediateTransaction(() => {
        // Read the raw row here instead of the strict getter so a valid source
        // file can repair malformed JSON, a mismatched hash, or old ordering.
        const current = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
          .get(kind) as unknown as IntegrationMappingSetRow | undefined;
        if (current?.content_hash === contentHash && current.mappings_json === mappingsJson) {
          return this.getIntegrationMappingSet<T>(kind)!;
        }
        const timestamp = new Date().toISOString();
        this.db.prepare(`INSERT INTO integration_mapping_sets
          (kind, content_hash, revision, mappings_json, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?)
          ON CONFLICT(kind) DO UPDATE SET
            content_hash = excluded.content_hash,
            revision = CASE WHEN integration_mapping_sets.revision >= 1
              THEN integration_mapping_sets.revision + 1 ELSE 1 END,
            mappings_json = excluded.mappings_json,
            updated_at = excluded.updated_at`)
          .run(kind, contentHash, mappingsJson, timestamp, timestamp);
        return this.getIntegrationMappingSet<T>(kind)!;
      });
    },
  telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number {
      const key = `telemetry_archive_checkpoint:${table}`;
      const value = (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined)?.value;
      const parsed = Number(value ?? 0);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    },
  saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void {
      if (!Number.isSafeInteger(rowId) || rowId < 0) throw new RangeError("Telemetry archive checkpoint is invalid");
      const current = this.telemetryArchiveCheckpoint(table);
      if (rowId <= current) return;
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(`telemetry_archive_checkpoint:${table}`, String(rowId));
    },
  telemetryArchiveDirtyCount(): number {
      return Number((this.db.prepare("SELECT COUNT(*) AS count FROM telemetry_archive_dirty_rows")
        .get() as { count: number }).count);
    },
  telemetryArchiveWatermarks(): TelemetryArchiveWatermarks {
      return {
        measurement_samples: this.telemetryArchiveCheckpoint("measurement_samples"),
        legacy_readings: this.telemetryArchiveCheckpoint("legacy_readings"),
        outdoor_temperature_samples: this.telemetryArchiveCheckpoint("outdoor_temperature_samples"),
        electricity_price_samples: this.telemetryArchiveCheckpoint("electricity_price_samples"),
        opening_state_samples: this.telemetryArchiveCheckpoint("opening_state_samples"),
      };
    },
  /**
     * Permanently latches this database into real-data mode and removes every
     * persisted value that could have been produced by the demo runtime.
     */
  activateRealDataMode(): DemoTelemetryPurgeResult {
      return this.immediateTransaction(() => {
        const currentMode = (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value;
        const existingActivatedAt = (this.db.prepare(
          "SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'",
        ).get() as { value: string } | undefined)?.value;
        if (currentMode === "real") {
          const activatedAt = existingActivatedAt ?? new Date().toISOString();
          if (!existingActivatedAt) {
            this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
          }
          return {
            activated: false,
            activatedAt,
            readings: 0,
            measurementSamples: 0,
            outdoorTemperatureSamples: 0,
            alertEvents: 0,
          };
        }

        const activatedAt = existingActivatedAt ?? new Date().toISOString();
        const measurementSamples = Number(this.db.prepare(
          "DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')",
        ).run().changes);
        const readings = Number(this.db.prepare(
          "DELETE FROM readings WHERE source IN ('mock', 'replay')",
        ).run().changes);
        const outdoorTemperatureSamples = Number(this.db.prepare(
          "DELETE FROM outdoor_temperature_samples WHERE source = 'mock'",
        ).run().changes);
        // Alert events have no source column. Clear them at the one-way boundary
        // so an event or active condition derived from mock samples cannot cross it.
        const alertEvents = Number(this.db.prepare("DELETE FROM alert_events").run().changes);
        this.db.prepare("DELETE FROM alert_evaluation_state").run();
        this.db.prepare("DELETE FROM analytics_daily_findings").run();
        this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('data_mode', 'real')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
        this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
        return { activated: true, activatedAt, readings, measurementSamples, outdoorTemperatureSamples, alertEvents };
      });
    },
  purgeSourceLabelledDemoTelemetry(): void {
      this.immediateTransaction(() => {
        this.db.prepare("DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')").run();
        this.db.prepare("DELETE FROM readings WHERE source IN ('mock', 'replay')").run();
        this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE source = 'mock'").run();
        this.db.prepare("DELETE FROM analytics_daily_findings WHERE data_mode = 'demo'").run();
      });
    },
  /** Removes every local producer/runtime artifact from active remote Homes. */
  purgeSharedHomeLocalState(houseId?: string): void {
      this.immediateTransaction(() => {
        const houseFilter = houseId ? "AND house.id = ?" : "";
        const sharedSensorIds = `SELECT sensor.id
          FROM sensors sensor
          JOIN houses house ON house.id = sensor.house_id
          WHERE json_extract(house.stugby_json, '$.ownership') = 'shared'
            AND json_extract(house.stugby_json, '$.syncState') <> 'detached' ${houseFilter}`;
        const parameters = houseId ? [houseId] : [];
        this.db.prepare(`DELETE FROM alert_evaluation_state WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM alert_events WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM alert_rules WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_data_gaps WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM tapo_history_export_jobs WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_measurement_bindings WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM measurement_samples
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM readings
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`UPDATE sensors
          SET temperature_entity_id = NULL, humidity_entity_id = NULL, battery_entity_id = NULL,
              tp_link_device_id = NULL, tp_link_connection_id = NULL, measurement_entity_ids_json = '{}'
          WHERE id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM opening_state_observations
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM outdoor_temperature_samples
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM weather_outages
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM analytics_daily_findings
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
      });
    },
  prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void {
      const hasDemo = sources.some((source) => DEMO_TELEMETRY_SOURCES.has(source));
      const hasReal = sources.some((source) => !DEMO_TELEMETRY_SOURCES.has(source));
      if (hasDemo && hasReal) {
        throw new ClimateDataValidationError(409, "MIXED_DATA_MODES", "Demo and real telemetry cannot be ingested in the same batch");
      }
      if (hasDemo && this.isRealDataMode()) {
        throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
      }
      if (hasReal && !this.isRealDataMode()) this.activateRealDataMode();
    },
  migrate(): void {
      this.immediateTransaction(() => {
        this.migrateCoreAndResourceSchema();
        this.migrateSensorAndNotificationSchema();
        this.migrateMaintenanceOwnership();
        this.migratePropertyAndObservationIntegrity();
        this.migrateMeasurementAndActionSchema();
      });
    },
});
