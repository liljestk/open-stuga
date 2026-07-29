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
import { ElectricityPriceArchiveRecord, ElectricityPricePointRow, OpeningStateArchiveRecord, OpeningStateObservationRow, TelemetryArchiveDirtyRow, TelemetryArchiveMutableTable, TelemetryArchiveRow, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import { MeasurementSampleRow, OutdoorTemperatureRow, ReadingRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { measurementSampleFromRow, readingFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { outdoorTemperatureFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  insertReading(reading: Reading): boolean {
      const inserted = this.insertLegacyReadingUnchecked(reading);
      if (inserted) {
        const values: Record<string, number> = {
          ...(reading.measurements ?? {}),
          temperature: reading.temperature,
          humidity: reading.humidity,
        };
        for (const [metric, value] of Object.entries(values)) {
          const definition = this.getMeasurementDefinition(metric);
          if (!definition) continue;
          this.insertMeasurementSample({
            sensorId: reading.sensorId,
            metric,
            value,
            canonicalUnit: definition.unit,
            timestamp: reading.timestamp,
            source: reading.source,
            quality: reading.quality,
          });
        }
      }
      return inserted;
    },
  insertLegacyReading(reading: Reading): boolean {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources([reading.source]);
        return this.insertLegacyReadingUnchecked(reading);
      });
    },
  upsertLegacyReading(reading: Reading): boolean {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources([reading.source]);
        const result = this.db.prepare(`INSERT INTO readings
          (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sensor_id, timestamp, source) DO UPDATE SET
            temperature = excluded.temperature,
            humidity = excluded.humidity,
            battery = excluded.battery,
            quality = excluded.quality`)
          .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
        return Number(result.changes) > 0;
      });
    },
  insertLegacyReadingUnchecked(reading: Reading): boolean {
      const result = this.db.prepare(`INSERT OR IGNORE INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
      return Number(result.changes) > 0;
    },
  insertReadings(readings: Reading[]): Reading[] {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources(readings.map((reading) => reading.source));
        const inserted: Reading[] = [];
        for (const reading of readings) {
          if (this.insertReading(reading)) inserted.push(reading);
        }
        return inserted;
      });
    },
  latestReadings(sensorIds?: string[]): Reading[] {
      const filter = sensorIds?.length ? `WHERE s.id IN (${sensorIds.map(() => "?").join(",")})` : "";
      const rows = this.db.prepare(`SELECT reading.sensor_id, reading.timestamp, reading.temperature,
          reading.humidity, reading.battery, reading.source, reading.quality
        FROM sensors s JOIN readings reading ON reading.id = (
          SELECT latest.id FROM readings latest WHERE latest.sensor_id = s.id
          ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
        )
        ${filter}
        ORDER BY reading.sensor_id`)
        .all(...(sensorIds ?? [])) as unknown as ReadingRow[];
      return rows.map(readingFromRow);
    },
  getLatestReading(sensorId: string): Reading | null {
      const row = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM readings WHERE sensor_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId) as unknown as ReadingRow | undefined;
      return row ? readingFromRow(row) : null;
    },
  history(sensorIds: string[], from: string, to: string, limit = 20_000): Reading[] {
      if (sensorIds.length === 0) return [];
      const placeholders = sensorIds.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM (
          SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
          FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp DESC, id DESC LIMIT ?
        ) ORDER BY timestamp ASC, id ASC`).all(...sensorIds, from, to, limit) as unknown as ReadingRow[];
      return rows.map(readingFromRow);
    },
  historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit = 20_000): Reading[] {
      if (sensorIds.length === 0) return [];
      const placeholders = sensorIds.map(() => "?").join(",");
      const rows = this.db.prepare(`WITH source_rows AS (
          SELECT id, sensor_id, timestamp, source,
            CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
            temperature, humidity
          FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
        ), recent_buckets AS (
          SELECT sensor_id, bucket_epoch, AVG(temperature) AS temperature, AVG(humidity) AS humidity,
            COUNT(*) AS sample_count, COUNT(DISTINCT source) AS source_count
          FROM source_rows WHERE bucket_epoch IS NOT NULL
          GROUP BY sensor_id, bucket_epoch ORDER BY bucket_epoch DESC, sensor_id LIMIT ?
        ), chronological_rows AS (
          SELECT id, sensor_id, bucket_epoch,
            ROW_NUMBER() OVER (PARTITION BY sensor_id, bucket_epoch ORDER BY timestamp DESC, id DESC) AS position
          FROM source_rows WHERE bucket_epoch IS NOT NULL
        )
        SELECT recent_buckets.sensor_id, recent_buckets.bucket_epoch, recent_buckets.temperature,
          recent_buckets.humidity, recent_buckets.sample_count, recent_buckets.source_count,
          latest.battery, latest.source, latest.quality
        FROM recent_buckets
        JOIN chronological_rows ON chronological_rows.sensor_id = recent_buckets.sensor_id
          AND chronological_rows.bucket_epoch = recent_buckets.bucket_epoch AND chronological_rows.position = 1
        JOIN readings AS latest ON latest.id = chronological_rows.id
        ORDER BY recent_buckets.bucket_epoch ASC, recent_buckets.sensor_id`)
        .all(bucketSeconds, bucketSeconds, ...sensorIds, from, to, limit) as Array<{
          sensor_id: string;
          bucket_epoch: number;
          temperature: number;
          humidity: number;
          sample_count: number;
          source_count: number;
          battery: number | null;
          source: Reading["source"];
          quality: Reading["quality"];
        }>;
      return rows.map((row) => ({
        sensorId: row.sensor_id,
        timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
        temperature: row.temperature,
        humidity: row.humidity,
        battery: row.battery,
        source: row.source,
        quality: row.sample_count > 1 || row.source_count > 1 ? "estimated" : row.quality,
      }));
    },
  /**
     * Monotonic pages for the optional durable telemetry archive. The SQLite
     * database remains the crash-safe local buffer until the remote checkpoint
     * has advanced beyond each row.
     */
  measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const rows = this.db.prepare(`SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE id > ? ORDER BY id LIMIT ?`)
        .all(afterRowId, pageSize) as unknown as (MeasurementSampleRow & { id: number })[];
      return rows.map((row) => ({ rowId: row.id, record: measurementSampleFromRow(row) }));
    },
  readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const recentClause = since ? "AND timestamp >= ?" : "";
      const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
      const rows = this.db.prepare(`SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM readings WHERE id > ? ${recentClause} ORDER BY id LIMIT ?`)
        .all(...parameters) as unknown as (ReadingRow & { id: number })[];
      return rows.map((row) => ({ rowId: row.id, record: readingFromRow(row) }));
    },
  outdoorTemperatureArchivePage(
      afterRowId: number,
      limit: number,
      since?: string,
    ): TelemetryArchiveRow<OutdoorTemperatureSample>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const recentClause = since ? "AND sample.timestamp >= ?" : "";
      const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
      const rows = this.db.prepare(`SELECT archive.archive_id AS archive_row_id, sample.house_id,
          sample.location_key, sample.timestamp, sample.temperature_c, sample.source, sample.fetched_at,
          sample.station_id, sample.station_name, sample.conditions_json
        FROM telemetry_archive_row_ids AS archive
        JOIN outdoor_temperature_samples AS sample
          ON sample.house_id = json_extract(archive.natural_key, '$[0]')
          AND sample.location_key = json_extract(archive.natural_key, '$[1]')
          AND sample.timestamp = json_extract(archive.natural_key, '$[2]')
          AND sample.source = json_extract(archive.natural_key, '$[3]')
        WHERE archive.table_name = 'outdoor_temperature_samples'
          AND archive.archive_id > ? ${recentClause}
        ORDER BY archive.archive_id LIMIT ?`)
        .all(...parameters) as unknown as (OutdoorTemperatureRow & { archive_row_id: number })[];
      return rows.map((row) => ({ rowId: row.archive_row_id, record: outdoorTemperatureFromRow(row) }));
    },
  electricityPriceArchivePage(
      afterRowId: number,
      limit: number,
      since?: string,
    ): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const recentClause = since ? "AND price.start_at >= ?" : "";
      const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
        const rows = this.db.prepare(`SELECT archive.archive_id AS archive_row_id, price.property_id,
          price.start_at, price.end_at, price.raw_price_cents_per_kwh, price.margin_cents_per_kwh, price.fetched_at
        FROM telemetry_archive_row_ids AS archive
        JOIN electricity_price_points AS price
          ON price.property_id = json_extract(archive.natural_key, '$[0]')
          AND price.start_at = json_extract(archive.natural_key, '$[1]')
        WHERE archive.table_name = 'electricity_price_samples'
          AND archive.archive_id > ? ${recentClause}
        ORDER BY archive.archive_id LIMIT ?`)
        .all(...parameters) as unknown as (ElectricityPricePointRow & { archive_row_id: number })[];
      return rows.map((row) => ({
        rowId: row.archive_row_id,
        record: {
          propertyId: row.property_id,
          startAt: row.start_at,
          endAt: row.end_at,
          rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
          marginCentsPerKwh: row.margin_cents_per_kwh,
          source: "sqlite",
          fetchedAt: row.fetched_at,
        },
      }));
    },
  openingStateArchivePage(
      afterRowId: number,
      limit: number,
      since?: string,
    ): TelemetryArchiveRow<OpeningStateArchiveRecord>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const recentClause = since ? "AND observation.observed_at >= ?" : "";
      const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
      const rows = this.db.prepare(`SELECT archive.archive_id AS archive_row_id, observation.*
        FROM telemetry_archive_row_ids AS archive
        JOIN opening_state_observations AS observation
          ON observation.id = json_extract(archive.natural_key, '$[0]')
        WHERE archive.table_name = 'opening_state_samples'
          AND archive.archive_id > ? ${recentClause}
        ORDER BY archive.archive_id LIMIT ?`)
        .all(...parameters) as unknown as (OpeningStateObservationRow & {
          archive_row_id: number;
          created_at: string;
        })[];
      return rows.map((row) => ({
        rowId: row.archive_row_id,
        record: {
          observationId: row.id,
          houseId: row.house_id,
          floorId: row.floor_id,
          elementId: row.element_id,
          state: row.state,
          openFraction: row.open_fraction,
          source: row.source,
          observedAt: row.observed_at,
          validUntil: row.valid_until,
          externalId: row.external_id,
          connectionId: row.connection_id,
          recordedAt: row.created_at,
        },
      }));
    },
  readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, reading.sensor_id, reading.timestamp,
          reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality
        FROM telemetry_archive_dirty_rows AS dirty
        JOIN readings AS reading
          ON reading.sensor_id = json_extract(dirty.natural_key, '$[0]')
          AND reading.timestamp = json_extract(dirty.natural_key, '$[1]')
          AND reading.source = json_extract(dirty.natural_key, '$[2]')
        WHERE dirty.table_name = 'legacy_readings'
        ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (ReadingRow & { dirty_id: number; version: number })[];
      return rows.map((row) => ({ dirtyId: row.dirty_id, version: row.version, record: readingFromRow(row) }));
    },
  outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, sample.house_id, sample.location_key,
          sample.timestamp, sample.temperature_c, sample.source, sample.fetched_at, sample.station_id, sample.station_name,
          sample.conditions_json
        FROM telemetry_archive_dirty_rows AS dirty
        JOIN outdoor_temperature_samples AS sample
          ON sample.house_id = json_extract(dirty.natural_key, '$[0]')
          AND sample.location_key = json_extract(dirty.natural_key, '$[1]')
          AND sample.timestamp = json_extract(dirty.natural_key, '$[2]')
          AND sample.source = json_extract(dirty.natural_key, '$[3]')
        WHERE dirty.table_name = 'outdoor_temperature_samples'
        ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (OutdoorTemperatureRow & { dirty_id: number; version: number })[];
      return rows.map((row) => ({ dirtyId: row.dirty_id, version: row.version, record: outdoorTemperatureFromRow(row) }));
    },
  electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[] {
      const pageSize = this.telemetryArchivePageSize(limit);
      const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, price.property_id, price.start_at, price.end_at,
          price.raw_price_cents_per_kwh, price.margin_cents_per_kwh, price.fetched_at
        FROM telemetry_archive_dirty_rows AS dirty
        JOIN electricity_price_points AS price
          ON price.property_id = json_extract(dirty.natural_key, '$[0]')
          AND price.start_at = json_extract(dirty.natural_key, '$[1]')
        WHERE dirty.table_name = 'electricity_price_samples'
        ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (ElectricityPricePointRow & { dirty_id: number; version: number })[];
      return rows.map((row) => ({
        dirtyId: row.dirty_id,
        version: row.version,
        record: {
          propertyId: row.property_id,
          startAt: row.start_at,
          endAt: row.end_at,
          rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
          marginCentsPerKwh: row.margin_cents_per_kwh,
          source: "sqlite",
          fetchedAt: row.fetched_at,
        },
      }));
    },
  acknowledgeTelemetryArchiveDirtyRows(
      table: TelemetryArchiveMutableTable,
      rows: Array<{ dirtyId: number; version: number }>,
    ): number {
      if (rows.length === 0) return 0;
      if (rows.length > 10_000 || rows.some(({ dirtyId, version }) => !Number.isSafeInteger(dirtyId)
        || dirtyId < 1 || !Number.isSafeInteger(version) || version < 1)) {
        throw new RangeError("Telemetry archive dirty row versions are invalid");
      }
      const remove = this.db.prepare(`DELETE FROM telemetry_archive_dirty_rows
        WHERE table_name = ? AND dirty_id = ? AND version = ?`);
      return this.immediateTransaction(() => rows.reduce(
        (deleted, row) => deleted + Number(remove.run(table, row.dirtyId, row.version).changes),
        0,
      ));
    },
  /** Cheap change token used to prove an archive pass observed a stable buffer. */
  telemetryArchiveStateToken(): string {
      const row = this.db.prepare(`SELECT
          COALESCE((SELECT MAX(id) FROM measurement_samples), 0) AS measurement_max,
          COALESCE((SELECT MAX(id) FROM readings), 0) AS reading_max,
          COALESCE((SELECT MAX(archive_id) FROM telemetry_archive_row_ids
            WHERE table_name = 'outdoor_temperature_samples'), 0) AS outdoor_max,
          COALESCE((SELECT MAX(archive_id) FROM telemetry_archive_row_ids
            WHERE table_name = 'electricity_price_samples'), 0) AS electricity_max,
          COALESCE((SELECT MAX(archive_id) FROM telemetry_archive_row_ids
            WHERE table_name = 'opening_state_samples'), 0) AS opening_max,
          COALESCE((SELECT MAX(id) FROM heat_pump_state_history), 0) AS heat_pump_max,
          COALESCE((SELECT COUNT(*) FROM telemetry_archive_dirty_rows), 0) AS dirty_count,
          COALESCE((SELECT MAX(dirty_id) FROM telemetry_archive_dirty_rows), 0) AS dirty_max,
          COALESCE((SELECT SUM(version) FROM telemetry_archive_dirty_rows), 0) AS dirty_versions`)
        .get() as Record<string, number>;
      return [
        row.measurement_max,
        row.reading_max,
        row.outdoor_max,
        row.electricity_max,
        row.opening_max,
        row.heat_pump_max,
        row.dirty_count,
        row.dirty_max,
        row.dirty_versions,
      ].join(":");
    },
  /** True when a destructive control-plane mutation would erase real telemetry from SQLite. */
  hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean {
      const selected = scope === "sensor"
        ? this.db.prepare(`SELECT
            EXISTS(SELECT 1 FROM measurement_samples
              WHERE sensor_id = ? AND source NOT IN ('mock', 'replay'))
            OR EXISTS(SELECT 1 FROM readings
              WHERE sensor_id = ? AND source NOT IN ('mock', 'replay')) AS found`).get(resourceId, resourceId)
        : scope === "house-location"
          ? this.db.prepare(`SELECT EXISTS(SELECT 1 FROM outdoor_temperature_samples
              WHERE house_id = ? AND source <> 'mock') AS found`).get(resourceId)
          : scope === "house"
            ? this.db.prepare(`SELECT
                EXISTS(SELECT 1 FROM measurement_samples sample JOIN sensors sensor ON sensor.id = sample.sensor_id
                  WHERE sensor.house_id = ? AND sample.source NOT IN ('mock', 'replay'))
                OR EXISTS(SELECT 1 FROM readings reading JOIN sensors sensor ON sensor.id = reading.sensor_id
                  WHERE sensor.house_id = ? AND reading.source NOT IN ('mock', 'replay'))
                OR EXISTS(SELECT 1 FROM outdoor_temperature_samples
                  WHERE house_id = ? AND source <> 'mock')
                OR EXISTS(SELECT 1 FROM opening_state_observations WHERE house_id = ?)
                OR EXISTS(SELECT 1 FROM heat_pump_state_history WHERE house_id = ?) AS found`)
              .get(resourceId, resourceId, resourceId, resourceId, resourceId)
            : this.db.prepare(`SELECT
                EXISTS(SELECT 1 FROM measurement_samples sample
                  JOIN sensors sensor ON sensor.id = sample.sensor_id
                  JOIN houses house ON house.id = sensor.house_id
                  WHERE house.property_id = ? AND sample.source NOT IN ('mock', 'replay'))
                OR EXISTS(SELECT 1 FROM readings reading
                  JOIN sensors sensor ON sensor.id = reading.sensor_id
                  JOIN houses house ON house.id = sensor.house_id
                  WHERE house.property_id = ? AND reading.source NOT IN ('mock', 'replay'))
                OR EXISTS(SELECT 1 FROM outdoor_temperature_samples sample
                  JOIN houses house ON house.id = sample.house_id
                  WHERE house.property_id = ? AND sample.source <> 'mock')
                OR EXISTS(SELECT 1 FROM electricity_price_points WHERE property_id = ?)
                OR EXISTS(SELECT 1 FROM opening_state_observations observation
                  JOIN houses house ON house.id = observation.house_id
                  WHERE house.property_id = ?)
                OR EXISTS(SELECT 1 FROM heat_pump_state_history state
                  JOIN houses house ON house.id = state.house_id
                  WHERE house.property_id = ?) AS found`)
              .get(resourceId, resourceId, resourceId, resourceId, resourceId, resourceId);
      return Number((selected as { found: number } | undefined)?.found ?? 0) === 1;
    },
});
