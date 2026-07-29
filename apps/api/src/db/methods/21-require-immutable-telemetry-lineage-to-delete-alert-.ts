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
import { MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER, TelemetryArchiveWatermarks, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import { AlertRuleRow, IOSNotificationRegistrationRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { iosNotificationRegistrationFromRow, ruleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  requireImmutableTelemetryLineage(
      scope: Exclude<TelemetryCascadeScope, "house-location">,
      resourceId: string,
    ): void {
      if (!this.hasRealTelemetryForCascade(scope, resourceId)) return;
      throw new ClimateDataValidationError(
        409,
        "TELEMETRY_LINEAGE_REQUIRED",
        "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
      );
    },
  telemetryArchivePageSize(limit: number): number {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new RangeError("Telemetry archive page size must be an integer from 1 to 10000");
      }
      return limit;
    },
  purgeReadingsBefore(
      timestamp: string,
      batchSize = 5_000,
      archivedThrough?: TelemetryArchiveWatermarks,
    ): number {
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
        throw new ClimateDataValidationError(400, "INVALID_BATCH_SIZE", "Retention batch size must be an integer from 1 to 50000");
      }
      const deleteBatches = (table: "measurement_samples" | "readings"): number => {
        const archiveTable = table === "readings" ? "legacy_readings" : table;
        const watermarkClause = archivedThrough ? "AND candidate.id <= ?" : "";
        const partition = table === "measurement_samples" ? "sensor_id, metric" : "sensor_id";
        const statement = this.db.prepare(`DELETE FROM ${table} WHERE id IN (
          SELECT candidate.id FROM ${table} candidate WHERE candidate.timestamp < ? ${watermarkClause}
            AND candidate.id != (
              SELECT latest.id FROM ${table} latest
              WHERE ${partition.split(", ").map((column) => `latest.${column} = candidate.${column}`).join(" AND ")}
              ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
            )
          ORDER BY candidate.timestamp, candidate.id LIMIT ?
        )`);
        let deleted = 0;
        while (true) {
          const parameters = archivedThrough
            ? [timestamp, archivedThrough[archiveTable], batchSize]
            : [timestamp, batchSize];
          const changes = Number(statement.run(...parameters).changes);
          deleted += changes;
          if (changes < batchSize) return deleted;
        }
      };
      const outdoorStatement = archivedThrough
        ? this.db.prepare(`DELETE FROM outdoor_temperature_samples WHERE rowid IN (
            SELECT sample.rowid
            FROM telemetry_archive_row_ids AS archive
            JOIN outdoor_temperature_samples AS sample
              ON sample.house_id = json_extract(archive.natural_key, '$[0]')
              AND sample.location_key = json_extract(archive.natural_key, '$[1]')
              AND sample.timestamp = json_extract(archive.natural_key, '$[2]')
              AND sample.source = json_extract(archive.natural_key, '$[3]')
            WHERE archive.table_name = 'outdoor_temperature_samples'
              AND sample.timestamp < ? AND archive.archive_id <= ?
              AND sample.rowid != (
                SELECT latest.rowid FROM outdoor_temperature_samples latest
                WHERE latest.house_id = sample.house_id AND latest.location_key = sample.location_key
                ORDER BY latest.timestamp DESC, latest.rowid DESC LIMIT 1
              )
            ORDER BY sample.timestamp, archive.archive_id LIMIT ?
          )`)
        : this.db.prepare(`DELETE FROM outdoor_temperature_samples WHERE rowid IN (
            SELECT sample.rowid FROM outdoor_temperature_samples sample WHERE sample.timestamp < ?
              AND sample.rowid != (
                SELECT latest.rowid FROM outdoor_temperature_samples latest
                WHERE latest.house_id = sample.house_id AND latest.location_key = sample.location_key
                ORDER BY latest.timestamp DESC, latest.rowid DESC LIMIT 1
              )
            ORDER BY sample.timestamp, sample.rowid LIMIT ?
          )`);
      let outdoorDeleted = 0;
      while (true) {
        const parameters = archivedThrough
          ? [timestamp, archivedThrough.outdoor_temperature_samples, batchSize]
          : [timestamp, batchSize];
        const changes = Number(outdoorStatement.run(...parameters).changes);
        outdoorDeleted += changes;
        if (changes < batchSize) break;
      }
      const electricityStatement = archivedThrough
        ? this.db.prepare(`DELETE FROM electricity_price_points WHERE rowid IN (
            SELECT price.rowid
            FROM telemetry_archive_row_ids AS archive
            JOIN electricity_price_points AS price
              ON price.property_id = json_extract(archive.natural_key, '$[0]')
              AND price.start_at = json_extract(archive.natural_key, '$[1]')
            WHERE archive.table_name = 'electricity_price_samples'
              AND price.end_at < ? AND archive.archive_id <= ?
            ORDER BY price.end_at, archive.archive_id LIMIT ?
          )`)
        : this.db.prepare(`DELETE FROM electricity_price_points WHERE rowid IN (
            SELECT rowid FROM electricity_price_points
            WHERE end_at < ? ORDER BY end_at, rowid LIMIT ?
          )`);
      let electricityDeleted = 0;
      while (!archivedThrough || archivedThrough.electricity_price_samples !== undefined) {
        const parameters = archivedThrough
          ? [timestamp, archivedThrough.electricity_price_samples, batchSize]
          : [timestamp, batchSize];
        const changes = Number(electricityStatement.run(...parameters).changes);
        electricityDeleted += changes;
        if (changes < batchSize) break;
      }
      const openingStatement = archivedThrough
        ? this.db.prepare(`DELETE FROM opening_state_observations WHERE rowid IN (
            SELECT observation.rowid
            FROM telemetry_archive_row_ids AS archive
            JOIN opening_state_observations AS observation
              ON observation.id = json_extract(archive.natural_key, '$[0]')
            WHERE archive.table_name = 'opening_state_samples'
              AND observation.observed_at < ? AND archive.archive_id <= ?
              AND observation.id != (
                SELECT latest.id FROM opening_state_observations latest
                WHERE latest.house_id = observation.house_id
                  AND latest.floor_id = observation.floor_id
                  AND latest.element_id = observation.element_id
                  AND latest.source = observation.source
                  AND COALESCE(latest.external_id, '') = COALESCE(observation.external_id, '')
                  AND COALESCE(latest.connection_id, '') = COALESCE(observation.connection_id, '')
                ORDER BY latest.observed_at DESC, latest.id DESC LIMIT 1
              )
            ORDER BY observation.observed_at, archive.archive_id LIMIT ?
          )`)
        : this.db.prepare(`DELETE FROM opening_state_observations WHERE rowid IN (
            SELECT observation.rowid FROM opening_state_observations observation
            WHERE observation.observed_at < ?
              AND observation.id != (
                SELECT latest.id FROM opening_state_observations latest
                WHERE latest.house_id = observation.house_id
                  AND latest.floor_id = observation.floor_id
                  AND latest.element_id = observation.element_id
                  AND latest.source = observation.source
                  AND COALESCE(latest.external_id, '') = COALESCE(observation.external_id, '')
                  AND COALESCE(latest.connection_id, '') = COALESCE(observation.connection_id, '')
                ORDER BY latest.observed_at DESC, latest.id DESC LIMIT 1
              )
            ORDER BY observation.observed_at, observation.rowid LIMIT ?
          )`);
      let openingDeleted = 0;
      while (!archivedThrough || archivedThrough.opening_state_samples !== undefined) {
        const parameters = archivedThrough
          ? [timestamp, archivedThrough.opening_state_samples, batchSize]
          : [timestamp, batchSize];
        const changes = Number(openingStatement.run(...parameters).changes);
        openingDeleted += changes;
        if (changes < batchSize) break;
      }
      const heatPumpStatement = this.db.prepare(`DELETE FROM heat_pump_state_history
        WHERE id IN (
          SELECT id FROM heat_pump_state_history
          WHERE observed_at < ? ${archivedThrough ? "AND id <= ?" : ""}
          ORDER BY observed_at, id LIMIT ?
        )`);
      let heatPumpDeleted = 0;
      while (!archivedThrough || archivedThrough.heat_pump_state_samples !== undefined) {
        const parameters = archivedThrough
          ? [timestamp, archivedThrough.heat_pump_state_samples, batchSize]
          : [timestamp, batchSize];
        const changes = Number(heatPumpStatement.run(...parameters).changes);
        heatPumpDeleted += changes;
        if (changes < batchSize) break;
      }
      return deleteBatches("measurement_samples") + deleteBatches("readings")
        + outdoorDeleted + electricityDeleted + openingDeleted + heatPumpDeleted;
    },
  saveIOSNotificationRegistration(
      userId: string,
      id: string,
      input: IOSNotificationRegistrationInput,
      now = new Date(),
    ): IOSNotificationRegistration {
      return this.immediateTransaction(() => {
        const existing = this.db.prepare(
          "SELECT user_id, enabled FROM ios_notification_registrations WHERE id = ?",
        ).get(id) as { user_id: string; enabled: number } | undefined;
        if (existing && existing.user_id !== userId) {
          throw new ClimateDataValidationError(409, "IOS_REGISTRATION_CONFLICT", "Notification registration is already owned by another account");
        }
        const normalizedToken = input.deviceToken.trim().toLowerCase();
        const tokenOwner = this.db.prepare(`SELECT id, user_id FROM ios_notification_registrations
          WHERE environment = ? AND device_token = ?`).get(input.environment, normalizedToken) as {
            id: string;
            user_id: string;
          } | undefined;
        if (tokenOwner && tokenOwner.id !== id) {
          // Possession of the current opaque APNs token lets the signed-in
          // installation retire a stale registration left by an expired session
          // or an account switch on the same device.
          this.db.prepare("DELETE FROM ios_notification_registrations WHERE id = ?").run(tokenOwner.id);
        }
        if ((!existing || existing.enabled !== 1)
          && Number((this.db.prepare(`SELECT COUNT(*) AS count
            FROM ios_notification_registrations WHERE user_id = ? AND enabled = 1`)
            .get(userId) as { count: number }).count) >= MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER) {
          throw new ClimateDataValidationError(
            409,
            "IOS_REGISTRATION_LIMIT",
            `An account can enable at most ${MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER} iOS notification registrations`,
          );
        }
        const timestamp = now.toISOString();
        this.db.prepare(`INSERT INTO ios_notification_registrations(
            id, user_id, device_token, environment, minimum_severity, include_details,
            enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            device_token = excluded.device_token,
            environment = excluded.environment,
            minimum_severity = excluded.minimum_severity,
            include_details = excluded.include_details,
            enabled = 1,
            updated_at = excluded.updated_at`)
          .run(
            id,
            userId,
            normalizedToken,
            input.environment,
            input.minimumSeverity,
            input.includeDetails ? 1 : 0,
            timestamp,
            timestamp,
          );
        this.db.prepare(
          "DELETE FROM ios_notification_subscriptions WHERE registration_id = ?",
        ).run(id);
        const subscribe = this.db.prepare(`INSERT INTO ios_notification_subscriptions(
          registration_id, house_id
        ) VALUES (?, ?)`);
        for (const houseId of [...new Set(input.homeIds)].sort()) {
          subscribe.run(id, houseId);
        }
        return this.getIOSNotificationRegistration(userId, id)!;
      });
    },
  getIOSNotificationRegistration(
      userId: string,
      id: string,
    ): IOSNotificationRegistration | null {
      const row = this.db.prepare(`SELECT * FROM ios_notification_registrations
        WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as IOSNotificationRegistrationRow | undefined;
      if (!row) return null;
      const homeIds = (this.db.prepare(`SELECT house_id FROM ios_notification_subscriptions
        WHERE registration_id = ? ORDER BY house_id`).all(id) as Array<{ house_id: string }>)
        .map((item) => item.house_id);
      return iosNotificationRegistrationFromRow(row, homeIds);
    },
  deleteIOSNotificationRegistration(userId: string, id: string): boolean {
      return Number(this.db.prepare(`DELETE FROM ios_notification_registrations
        WHERE id = ? AND user_id = ?`).run(id, userId).changes) === 1;
    },
  disableIOSNotificationRegistration(id: string): boolean {
      return Number(this.db.prepare(`UPDATE ios_notification_registrations
        SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1`)
        .run(new Date().toISOString(), id).changes) === 1;
    },
  getIOSPushDestination(id: string): APNSDestination | null {
      const row = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        WHERE registration.id = ? AND registration.enabled = 1`).get(id) as {
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        } | undefined;
      return row ? {
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      } : null;
    },
  getIOSPushDestinationForAlert(
      id: string,
      eventId: string,
    ): APNSDestination | null {
      const row = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        JOIN alert_events event ON event.id = ?
        JOIN sensors sensor ON sensor.id = event.sensor_id
        JOIN houses house ON house.id = sensor.house_id
        JOIN ios_notification_subscriptions subscription
          ON subscription.registration_id = registration.id
          AND subscription.house_id = house.id
        WHERE registration.id = ? AND registration.enabled = 1
          AND event.acknowledged_at IS NULL AND event.resolved_at IS NULL
          AND CASE registration.minimum_severity
            WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
            <= CASE event.severity
              WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
          AND (
            member.role != 'guest'
            OR EXISTS (
              SELECT 1 FROM local_guest_access_grants grant_row
              WHERE grant_row.subject_type = 'member'
                AND grant_row.subject_key = registration.user_id
                AND (
                  (grant_row.scope_type = 'property' AND grant_row.scope_id = house.property_id)
                  OR (grant_row.scope_type = 'house' AND grant_row.scope_id = house.id)
                )
            )
          )
        LIMIT 1`).get(eventId, id) as {
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        } | undefined;
      return row ? {
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      } : null;
    },
  listIOSPushDestinations(
      houseId: string,
      severity: AlertEvent["severity"],
    ): APNSDestination[] {
      const rows = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN ios_notification_subscriptions subscription
          ON subscription.registration_id = registration.id
        JOIN houses house ON house.id = subscription.house_id
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        WHERE subscription.house_id = ? AND registration.enabled = 1
          AND CASE registration.minimum_severity
            WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
            <= CASE ? WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
          AND (
            member.role != 'guest'
            OR EXISTS (
              SELECT 1 FROM local_guest_access_grants grant_row
              WHERE grant_row.subject_type = 'member'
                AND grant_row.subject_key = registration.user_id
                AND (
                  (grant_row.scope_type = 'property' AND grant_row.scope_id = house.property_id)
                  OR (grant_row.scope_type = 'house' AND grant_row.scope_id = house.id)
                )
            )
          )
        ORDER BY registration.id`).all(houseId, severity) as Array<{
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        }>;
      return rows.map((row) => ({
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      }));
    },
  listAlertRules(): AlertRule[] {
      return (this.db.prepare("SELECT * FROM alert_rules WHERE retired_at IS NULL ORDER BY name")
        .all() as unknown as AlertRuleRow[]).map(ruleFromRow);
    },
  getAlertRule(id: string): AlertRule | null {
      const row = this.db.prepare("SELECT * FROM alert_rules WHERE id = ? AND retired_at IS NULL")
        .get(id) as unknown as AlertRuleRow | undefined;
      return row ? ruleFromRow(row) : null;
    },
  saveAlertRule(input: Omit<AlertRule, "id"> & { id?: string }): AlertRule {
      const deliveryPolicy = normalizeAlertDeliveryPolicy(input.deliveryPolicy);
      const rule: AlertRule = {
        ...input,
        id: input.id ?? randomUUID(),
        deliveryPolicy,
      };
      this.db.prepare(`INSERT INTO alert_rules
        (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled,
         telegram_enabled, delivery_policy_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rule.id, rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds,
          rule.severity, rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
          policyJson(deliveryPolicy));
      return rule;
    },
  updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null {
      return this.immediateTransaction(() => {
        const current = this.getAlertRule(id);
        if (!current) return null;
        const deliveryPolicy = normalizeAlertDeliveryPolicy(patch.deliveryPolicy ?? current.deliveryPolicy);
        const rule: AlertRule = {
          ...current,
          ...patch,
          id,
          deliveryPolicy,
        };
        this.db.prepare(`UPDATE alert_rules SET name = ?, sensor_id = ?, metric = ?, operator = ?, threshold = ?,
          duration_seconds = ?, severity = ?, enabled = ?, webhook_enabled = ?, telegram_enabled = ?,
          delivery_policy_json = ? WHERE id = ?`)
          .run(rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds, rule.severity,
            rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
            policyJson(deliveryPolicy), id);
        if (Object.keys(patch).some((key) => !["name", "severity", "webhookEnabled", "telegramEnabled"].includes(key))) {
          this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
        }
        return rule;
      });
    },
  deleteAlertRule(id: string): boolean {
      return this.immediateTransaction(() => {
        const retiredAt = new Date().toISOString();
        const retired = Number(this.db.prepare(`UPDATE alert_rules SET retired_at = ?, enabled = 0
          WHERE id = ? AND retired_at IS NULL`).run(retiredAt, id).changes) > 0;
        if (!retired) return false;
        this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
        this.db.prepare(`UPDATE alert_events SET resolved_at = COALESCE(
          resolved_at, CASE WHEN started_at > ? THEN started_at ELSE ? END
        ) WHERE rule_id = ?`).run(retiredAt, retiredAt, id);
        return true;
      });
    },
});
