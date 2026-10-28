import { randomUUID } from "node:crypto";
import type { MeasurementSample, Reading, OutdoorTemperatureSample } from "@climate-twin/contracts";
import { TelemetryArchiveTable, TelemetryArchiveWatermarks, ElectricityPriceArchiveRecord, OpeningStateArchiveRecord, TelemetryArchiveDirtyRow, TelemetryArchiveMutableTable, TelemetryArchiveRow, TelemetryCascadeScope } from "../support/record-types.js";
import { ElectricityPricePointRow, OpeningStateObservationRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { measurementSampleFromRow, readingFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { MeasurementSampleRow, OutdoorTemperatureRow, ReadingRow } from "../support/row-types.js";
import { outdoorTemperatureFromRow } from "../support/row-mappers.js";

declare module "../core.js" {
  interface DatabaseInternals {
    telemetryArchiveSourceId(): string;
    telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number;
    saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void;
    telemetryArchiveDirtyCount(): number;
    telemetryArchiveWatermarks(): TelemetryArchiveWatermarks;
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
    requireImmutableTelemetryLineage(
        scope: Exclude<TelemetryCascadeScope, "house-location">,
        resourceId: string,
      ): void;
    telemetryArchivePageSize(limit: number): number;
  }

  interface ClimateDatabaseCore {
    telemetryArchiveSourceId(): string;
    telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number;
    saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void;
    telemetryArchiveDirtyCount(): number;
    telemetryArchiveWatermarks(): TelemetryArchiveWatermarks;
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
  }
}

registerDatabaseMethods({
  /** Stable identity used only to checkpoint this SQLite telemetry buffer. */
  telemetryArchiveSourceId(): string {
      const key = "telemetry_archive_source_id";
      const existing = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
      if (existing?.value) return existing.value;
      const sourceId = randomUUID();
      this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(key, sourceId);
      return (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string }).value;
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
        heat_pump_state_samples: this.telemetryArchiveCheckpoint("heat_pump_state_samples"),
      };
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
});
