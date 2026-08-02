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
import { TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS } from "../support/01-json-value-to-area-equipment-row.js";
import { AlertRuleRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ruleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  migrateSensorAndNotificationSchema(): void {
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sensors_house_floor_room
              ON sensors(house_id, floor_id, room_id) WHERE room_id IS NOT NULL;
            DROP TRIGGER IF EXISTS validate_sensor_room_insert;
            CREATE TRIGGER validate_sensor_room_insert
              BEFORE INSERT ON sensors
              WHEN NEW.room_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                FROM houses AS house, json_each(house.floors_json) AS floor,
                  json_each(json_extract(floor.value, '$.rooms')) AS room
                WHERE house.id = NEW.house_id
                  AND json_extract(floor.value, '$.id') = NEW.floor_id
                  AND json_extract(room.value, '$.id') = NEW.room_id
                  AND json_extract(room.value, '$.name') = NEW.room
              )
              BEGIN SELECT RAISE(ABORT, 'SENSOR_ROOM_MISMATCH'); END;
            DROP TRIGGER IF EXISTS validate_sensor_room_update;
            CREATE TRIGGER validate_sensor_room_update
              BEFORE UPDATE OF house_id, floor_id, room_id, room ON sensors
              WHEN NEW.room_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                FROM houses AS house, json_each(house.floors_json) AS floor,
                  json_each(json_extract(floor.value, '$.rooms')) AS room
                WHERE house.id = NEW.house_id
                  AND json_extract(floor.value, '$.id') = NEW.floor_id
                  AND json_extract(room.value, '$.id') = NEW.room_id
                  AND json_extract(room.value, '$.name') = NEW.room
              )
              BEGIN SELECT RAISE(ABORT, 'SENSOR_ROOM_MISMATCH'); END;
            DROP TRIGGER IF EXISTS prevent_house_room_orphaned_sensor;
            CREATE TRIGGER prevent_house_room_orphaned_sensor
              BEFORE UPDATE OF floors_json ON houses
              WHEN EXISTS (
                SELECT 1 FROM sensors AS sensor
                WHERE sensor.house_id = OLD.id AND sensor.room_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM json_each(NEW.floors_json) AS floor,
                      json_each(json_extract(floor.value, '$.rooms')) AS room
                    WHERE json_extract(floor.value, '$.id') = sensor.floor_id
                      AND json_extract(room.value, '$.id') = sensor.room_id
                  )
              )
              BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_SENSOR_ROOM'); END;
            DROP TRIGGER IF EXISTS sync_sensor_room_labels_after_house_layout_update;
            CREATE TRIGGER sync_sensor_room_labels_after_house_layout_update
              AFTER UPDATE OF floors_json ON houses
              BEGIN
                UPDATE sensors
                SET room = (
                  SELECT json_extract(room.value, '$.name')
                  FROM json_each(NEW.floors_json) AS floor,
                    json_each(json_extract(floor.value, '$.rooms')) AS room
                  WHERE json_extract(floor.value, '$.id') = sensors.floor_id
                    AND json_extract(room.value, '$.id') = sensors.room_id
                  LIMIT 1
                )
                WHERE house_id = NEW.id AND room_id IS NOT NULL;
              END;
          `);
      const alertRuleColumns = this.db.prepare("PRAGMA table_info(alert_rules)").all() as unknown as Array<{ name: string }>;
      if (!alertRuleColumns.some((column) => column.name === "telegram_enabled")) {
            this.db.exec("ALTER TABLE alert_rules ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 0");
          }
      if (!alertRuleColumns.some((column) => column.name === "retired_at")) {
            this.db.exec("ALTER TABLE alert_rules ADD COLUMN retired_at TEXT");
          }
      if (!alertRuleColumns.some((column) => column.name === "delivery_policy_json")) {
            this.db.exec("ALTER TABLE alert_rules ADD COLUMN delivery_policy_json TEXT NOT NULL DEFAULT '{}'");
          }
      const sensorGapColumns = this.db.prepare("PRAGMA table_info(sensor_data_gaps)")
            .all() as unknown as Array<{ name: string }>;
      if (!sensorGapColumns.some((column) => column.name === "recoverable_until")) {
            this.db.exec("ALTER TABLE sensor_data_gaps ADD COLUMN recoverable_until TEXT");
          }
      if (!sensorGapColumns.some((column) => column.name === "recovery_completeness")) {
            this.db.exec(`ALTER TABLE sensor_data_gaps ADD COLUMN recovery_completeness TEXT NOT NULL DEFAULT 'unknown'
              CHECK (recovery_completeness IN ('unknown', 'none', 'partial', 'complete'))`);
          }
      // Direct TP-Link climate history retains 95 fifteen-minute intervals.
      // Other adapters/fallbacks own their retention, so NULL remains explicitly
      // unknown rather than implying unlimited or six-month recovery.
      const tpLinkRetentionMinutes = TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS / 60_000;
      this.db.prepare(`UPDATE sensor_data_gaps
        SET recoverable_until = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, ?)
        WHERE source = 'tp-link' AND metric IN ('temperature', 'humidity')
          AND EXISTS (
            SELECT 1 FROM sensors AS sensor
            WHERE sensor.id = sensor_data_gaps.sensor_id
              AND (upper(sensor.model) LIKE '%T310%' OR upper(sensor.model) LIKE '%T315%')
          )
          AND recoverable_until IS NULL`)
        .run(`+${tpLinkRetentionMinutes} minutes`);
      this.db.exec(`UPDATE sensor_data_gaps SET recovery_completeness = CASE
          WHEN recovery_state = 'complete' AND recovered_points > 0 THEN 'complete'
          WHEN recovered_points > 0 THEN 'partial'
          WHEN recovery_state IN ('complete', 'partial', 'failed', 'not-supported') THEN 'none'
          ELSE 'unknown'
        END
        WHERE recovery_completeness = 'unknown';`);
      let notificationOutboxColumns = this.db.prepare("PRAGMA table_info(notification_outbox)")
            .all() as unknown as Array<{ name: string }>;
      if (!notificationOutboxColumns.some((column) => column.name === "payload_json")) {
            this.db.exec("ALTER TABLE notification_outbox ADD COLUMN payload_json TEXT");
          }
      if (!notificationOutboxColumns.some((column) => column.name === "destination_ref")) {
            this.db.exec("ALTER TABLE notification_outbox ADD COLUMN destination_ref TEXT");
          }
      if (!notificationOutboxColumns.some((column) => column.name === "abandoned_at")) {
            this.db.exec("ALTER TABLE notification_outbox ADD COLUMN abandoned_at TEXT");
          }
      const listLegacyNotifications = this.db.prepare(`SELECT id, event_id, channel FROM notification_outbox
            WHERE (payload_json IS NULL OR destination_ref IS NULL) AND id > ? ORDER BY id LIMIT 500`);
      let legacyNotificationCursor = "";
      while (true) {
        const legacyNotifications = listLegacyNotifications.all(legacyNotificationCursor) as Array<{
          id: string;
          event_id: string;
          channel: "webhook" | "telegram";
        }>;
        if (legacyNotifications.length === 0) break;
        for (const queued of legacyNotifications) {
            const event = this.getAlertEvent(queued.event_id);
            const ruleRow = event
              ? this.db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(event.ruleId) as unknown as AlertRuleRow | undefined
              : undefined;
            const rule = ruleRow ? ruleFromRow(ruleRow) : null;
            const sensor = event ? this.getSensor(event.sensorId) : null;
            const house = sensor ? this.getHouse(sensor.houseId) : null;
            const bindings: AlertNotificationBindings = {
              houseLabel: house?.name ?? null,
              sensorLabel: sensor?.name ?? null,
              webhookDestinations: [{
                destinationId: "primary",
                destinationRef: legacyNotificationDestinationRef("webhook"),
              }],
              telegramDestinationRef: legacyNotificationDestinationRef("telegram"),
              apnsProviderRef: legacyNotificationDestinationRef("apns"),
              apnsEnabled: false,
            };
            const payloadJson = event && rule
              ? notificationSnapshot(queued.channel, event, rule, bindings).payloadJson
              : JSON.stringify({ version: 1, legacyEventId: queued.event_id, unavailable: true });
            this.db.prepare(`UPDATE notification_outbox SET payload_json = ?, destination_ref = ? WHERE id = ?`)
              .run(payloadJson, legacyNotificationDestinationRef(queued.channel), queued.id);
        }
        legacyNotificationCursor = legacyNotifications.at(-1)!.id;
      }
      if (!notificationOutboxColumns.some((column) => column.name === "subject_kind")) {
            this.db.exec(`
              DROP TRIGGER IF EXISTS require_notification_outbox_snapshot_insert;
              DROP TRIGGER IF EXISTS preserve_notification_outbox_snapshot_update;
              CREATE TABLE notification_outbox_next (
                id TEXT PRIMARY KEY,
                subject_kind TEXT NOT NULL CHECK(subject_kind IN ('alert', 'maintenance', 'action-run', 'system')),
                subject_id TEXT NOT NULL,
                event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
                stage TEXT NOT NULL CHECK(stage IN ('initial', 'escalation', 'reminder', 'due', 'verification', 'resolved')),
                sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0),
                channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram', 'apns')),
                destination_id TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 100),
                available_at TEXT NOT NULL,
                locked_at TEXT,
                lock_token TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                delivered_at TEXT,
                payload_json TEXT NOT NULL,
                destination_ref TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                dead_lettered_at TEXT,
                abandoned_at TEXT,
                UNIQUE(subject_kind, subject_id, stage, sequence, channel, destination_id)
              );
              INSERT INTO notification_outbox_next(
                id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
                attempts, max_attempts, available_at, locked_at, lock_token, last_error,
                created_at, delivered_at, payload_json, destination_ref, policy_json,
                dead_lettered_at, abandoned_at
              )
              SELECT queued.id, 'alert', queued.event_id, queued.event_id, 'initial', 0, queued.channel, 'primary',
                queued.attempts, 8, queued.available_at, queued.locked_at, queued.lock_token, queued.last_error,
                queued.created_at, queued.delivered_at, queued.payload_json, queued.destination_ref,
                COALESCE((
                  SELECT rule.delivery_policy_json
                  FROM alert_events event JOIN alert_rules rule ON rule.id = event.rule_id
                  WHERE event.id = queued.event_id
                ), '{}'), NULL, queued.abandoned_at
              FROM notification_outbox queued;
              DROP TABLE notification_outbox;
              ALTER TABLE notification_outbox_next RENAME TO notification_outbox;
            `);
            notificationOutboxColumns = this.db.prepare("PRAGMA table_info(notification_outbox)")
              .all() as unknown as Array<{ name: string }>;
          }
      const notificationOutboxSql = (this.db.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'notification_outbox'",
          ).get() as { sql: string } | undefined)?.sql ?? "";
      if (!notificationOutboxSql.includes("'apns'")
        || !notificationOutboxSql.includes("'system'")
        || !notificationOutboxSql.includes("'resolved'")) {
            this.db.exec(`
              DROP TRIGGER IF EXISTS require_notification_outbox_snapshot_insert;
              DROP TRIGGER IF EXISTS preserve_notification_outbox_snapshot_update;
              CREATE TABLE notification_outbox_apns (
                id TEXT PRIMARY KEY,
                subject_kind TEXT NOT NULL CHECK(subject_kind IN ('alert', 'maintenance', 'action-run', 'system')),
                subject_id TEXT NOT NULL,
                event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
                stage TEXT NOT NULL CHECK(stage IN ('initial', 'escalation', 'reminder', 'due', 'verification', 'resolved')),
                sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0),
                channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram', 'apns')),
                destination_id TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 100),
                available_at TEXT NOT NULL,
                locked_at TEXT,
                lock_token TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                delivered_at TEXT,
                payload_json TEXT NOT NULL,
                destination_ref TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                dead_lettered_at TEXT,
                abandoned_at TEXT,
                UNIQUE(subject_kind, subject_id, stage, sequence, channel, destination_id)
              );
              INSERT INTO notification_outbox_apns (
                id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
                attempts, max_attempts, available_at, locked_at, lock_token, last_error,
                created_at, delivered_at, payload_json, destination_ref, policy_json,
                dead_lettered_at, abandoned_at
              )
              SELECT id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
                attempts, max_attempts, available_at, locked_at, lock_token, last_error,
                created_at, delivered_at, payload_json, destination_ref, policy_json,
                dead_lettered_at, abandoned_at
              FROM notification_outbox;
              DROP TABLE notification_outbox;
              ALTER TABLE notification_outbox_apns RENAME TO notification_outbox;
            `);
          }
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
            ON notification_outbox(delivered_at, dead_lettered_at, available_at, locked_at)`);
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_notification_outbox_delivered
              ON notification_outbox(delivered_at) WHERE delivered_at IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_notification_outbox_dead_lettered
              ON notification_outbox(dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_notification_outbox_abandoned
              ON notification_outbox(abandoned_at) WHERE abandoned_at IS NOT NULL;
          `);
      this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS require_notification_outbox_snapshot_insert
              BEFORE INSERT ON notification_outbox
              WHEN NEW.payload_json IS NULL OR NEW.payload_json = '' OR NEW.destination_ref IS NULL OR NEW.destination_ref = ''
              BEGIN SELECT RAISE(ABORT, 'NOTIFICATION_SNAPSHOT_REQUIRED'); END;
            CREATE TRIGGER IF NOT EXISTS preserve_notification_outbox_snapshot_update
              BEFORE UPDATE OF subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
                max_attempts, payload_json, destination_ref, policy_json ON notification_outbox
              WHEN NEW.subject_kind IS NOT OLD.subject_kind OR NEW.subject_id IS NOT OLD.subject_id
                OR NEW.event_id IS NOT OLD.event_id OR NEW.stage IS NOT OLD.stage OR NEW.sequence IS NOT OLD.sequence
                OR NEW.channel IS NOT OLD.channel OR NEW.destination_id IS NOT OLD.destination_id
                OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.payload_json IS NOT OLD.payload_json
                OR NEW.destination_ref IS NOT OLD.destination_ref OR NEW.policy_json IS NOT OLD.policy_json
              BEGIN SELECT RAISE(ABORT, 'NOTIFICATION_SNAPSHOT_IMMUTABLE'); END;
            CREATE TRIGGER IF NOT EXISTS preserve_alert_rule_history_before_delete
              BEFORE DELETE ON alert_rules
              WHEN EXISTS (SELECT 1 FROM alert_events WHERE rule_id = OLD.id)
              BEGIN SELECT RAISE(ABORT, 'ALERT_RULE_HISTORY_EXISTS'); END;
            CREATE TRIGGER IF NOT EXISTS preserve_alert_sensor_history_before_delete
              BEFORE DELETE ON sensors
              WHEN EXISTS (SELECT 1 FROM alert_events WHERE sensor_id = OLD.id)
              BEGIN SELECT RAISE(ABORT, 'ALERT_SENSOR_HISTORY_EXISTS'); END;
          `);
    },
});
