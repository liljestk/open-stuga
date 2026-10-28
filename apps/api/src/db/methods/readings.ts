import type { Reading } from "@climate-twin/contracts";
import { TelemetryArchiveWatermarks } from "../support/record-types.js";
import { ReadingRow } from "../support/row-types.js";
import { readingFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";

declare module "../core.js" {
  interface DatabaseInternals {
    insertReading(reading: Reading, enqueueAlertEvaluation?: boolean): boolean;
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertLegacyReadingUnchecked(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
  }

  interface ClimateDatabaseCore {
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
  }
}

registerDatabaseMethods({
  insertReading(reading: Reading, enqueueAlertEvaluation = false): boolean {
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
          }, false, enqueueAlertEvaluation);
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
      if (!this.getSensor(reading.sensorId)) return false;
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
      if (!this.getSensor(reading.sensorId)) return false;
      const result = this.db.prepare(`INSERT OR IGNORE INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
      return Number(result.changes) > 0;
    },
  insertReadings(readings: Reading[], options: { enqueueAlertEvaluation?: boolean } = {}): Reading[] {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources(readings.map((reading) => reading.source));
        const inserted: Reading[] = [];
        for (const reading of readings) {
          if (this.insertReading(reading, options.enqueueAlertEvaluation)) inserted.push(reading);
        }
        return inserted;
      });
    },
  latestReadings(sensorIds?: string[]): Reading[] {
      const filter = sensorIds?.length ? `AND s.id IN (${sensorIds.map(() => "?").join(",")})` : "";
      const rows = this.db.prepare(`SELECT reading.sensor_id, reading.timestamp, reading.temperature,
          reading.humidity, reading.battery, reading.source, reading.quality
        FROM sensors s JOIN houses AS house ON house.id = s.house_id
        JOIN readings reading ON reading.id = (
          SELECT latest.id FROM readings latest WHERE latest.sensor_id = s.id
          ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
        )
        WHERE house.deleted_at IS NULL ${filter}
        ORDER BY reading.sensor_id`)
        .all(...(sensorIds ?? [])) as unknown as ReadingRow[];
      return rows.map(readingFromRow);
    },
  getLatestReading(sensorId: string): Reading | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM readings WHERE sensor_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId) as unknown as ReadingRow | undefined;
      return row ? readingFromRow(row) : null;
    },
  history(sensorIds: string[], from: string, to: string, limit = 20_000): Reading[] {
      const visibleSensorIds = sensorIds.filter((id) => Boolean(this.getSensor(id)));
      if (visibleSensorIds.length === 0) return [];
      const placeholders = visibleSensorIds.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM (
          SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
          FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp DESC, id DESC LIMIT ?
        ) ORDER BY timestamp ASC, id ASC`).all(...visibleSensorIds, from, to, limit) as unknown as ReadingRow[];
      return rows.map(readingFromRow);
    },
  historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit = 20_000): Reading[] {
      const visibleSensorIds = sensorIds.filter((id) => Boolean(this.getSensor(id)));
      if (visibleSensorIds.length === 0) return [];
      const placeholders = visibleSensorIds.map(() => "?").join(",");
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
        .all(bucketSeconds, bucketSeconds, ...visibleSensorIds, from, to, limit) as Array<{
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
      this.db.prepare(`DELETE FROM opening_state_current_candidates
        WHERE effective_until_ceiling IS NOT NULL AND effective_until_ceiling <= ?`)
        .run(new Date().toISOString());
      const openingStatement = archivedThrough
        ? this.db.prepare(`DELETE FROM opening_state_observations WHERE rowid IN (
            SELECT observation.rowid
            FROM telemetry_archive_row_ids AS archive
            JOIN opening_state_observations AS observation
              ON observation.id = json_extract(archive.natural_key, '$[0]')
            WHERE archive.table_name = 'opening_state_samples'
              AND observation.observed_at < ? AND archive.archive_id <= ?
              AND NOT EXISTS (
                SELECT 1 FROM opening_state_current_candidates candidate
                WHERE candidate.observation_id = observation.id
              )
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
              AND NOT EXISTS (
                SELECT 1 FROM opening_state_current_candidates candidate
                WHERE candidate.observation_id = observation.id
              )
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
});
