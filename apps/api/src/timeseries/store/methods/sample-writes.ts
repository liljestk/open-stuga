import { TELEMETRY_TABLES, qualifiedName, SOURCE_TAGGED_TELEMETRY_TABLES, quoteIdentifier } from "../../schema.js";
import type { BatchWriteResult, ElectricityPriceRecord, HeatPumpStateRecord, LegacyReadingRecord, MeasurementSampleRecord, OpeningStateRecord, OutdoorTemperatureRecord, QueryControl } from "../../types.js";
import { SqlValue } from "../support/row-types.js";
import { timestamp } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertHeatPumpStateSamples(samples: readonly HeatPumpStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    __writeBatches<T>(
        table: (typeof TELEMETRY_TABLES)[number],
        columns: readonly string[],
        conflictColumns: readonly string[],
        updateColumns: readonly string[],
        records: readonly T[],
        valuesFor: (record: T) => readonly SqlValue[],
        control: QueryControl,
        markOrderedRollups?: boolean,
      ): Promise<BatchWriteResult>;
    deleteTelemetrySources(sources: readonly string[], control?: QueryControl): Promise<number>;
    enforceRealDataBoundary(sourceId: string, activatedAt: string, control?: QueryControl): Promise<number>;
  }

  interface TimeseriesStoreCore {
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertHeatPumpStateSamples(samples: readonly HeatPumpStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    deleteTelemetrySources(sources: readonly string[], control?: QueryControl): Promise<number>;
    enforceRealDataBoundary(sourceId: string, activatedAt: string, control?: QueryControl): Promise<number>;
  }
}

registerTimeseriesStoreMethods({
  async upsertMeasurementSamples(this: TimeseriesStoreInternals,
      samples: readonly MeasurementSampleRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "measurement_samples",
        ["sensor_id", "metric", "observed_at", "source", "value", "canonical_unit", "quality", "metadata"],
        ["sensor_id", "metric", "observed_at", "source"],
        ["value", "canonical_unit", "quality", "metadata"],
        samples,
        (sample) => [
          sample.sensorId, sample.metric, sample.timestamp, sample.source, sample.value,
          sample.canonicalUnit, sample.quality, sample.metadata ?? {},
        ],
        control,
        true,
      );
    },
  async upsertLegacyReadings(this: TimeseriesStoreInternals,
      readings: readonly LegacyReadingRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "legacy_readings",
        [
          "sensor_id", "observed_at", "source", "temperature_c", "relative_humidity_pct",
          "battery_pct", "quality", "metadata",
        ],
        ["sensor_id", "observed_at", "source"],
        ["temperature_c", "relative_humidity_pct", "battery_pct", "quality", "metadata"],
        readings,
        (reading) => [
          reading.sensorId, reading.timestamp, reading.source, reading.temperature, reading.humidity,
          reading.battery, reading.quality, reading.metadata ?? {},
        ],
        control,
      );
    },
  async upsertOutdoorTemperatureSamples(this: TimeseriesStoreInternals,
      samples: readonly OutdoorTemperatureRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "outdoor_temperature_samples",
        [
          "house_id", "location_key", "observed_at", "source", "temperature_c", "fetched_at",
          "station_id", "station_name", "metadata",
        ],
        ["house_id", "location_key", "observed_at", "source"],
        ["temperature_c", "fetched_at", "station_id", "station_name", "metadata"],
        samples,
        (sample) => [
          sample.houseId, sample.locationKey, sample.timestamp, sample.source, sample.temperatureC,
          sample.fetchedAt, sample.stationId, sample.stationName, sample.metadata ?? {},
        ],
        control,
      );
    },
  async upsertElectricityPriceSamples(this: TimeseriesStoreInternals,
      samples: readonly ElectricityPriceRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "electricity_price_samples",
        ["property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh", "margin_cents_per_kwh", "fetched_at", "metadata"],
        ["property_id", "starts_at", "source"],
        ["ends_at", "raw_price_cents_per_kwh", "margin_cents_per_kwh", "fetched_at", "metadata"],
        samples,
        (sample) => [
          sample.propertyId, sample.startAt, sample.source, sample.endAt,
          sample.rawPriceCentsPerKwh, sample.marginCentsPerKwh, sample.fetchedAt, sample.metadata ?? {},
        ],
        control,
      );
    },
  async upsertOpeningStateSamples(this: TimeseriesStoreInternals,
      samples: readonly OpeningStateRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "opening_state_samples",
        [
          "observation_id", "house_id", "floor_id", "element_id", "observed_at", "source", "state",
          "open_fraction", "valid_until", "external_id", "connection_id", "recorded_at", "metadata",
        ],
        ["observation_id", "observed_at"],
        [
          "house_id", "floor_id", "element_id", "source", "state", "open_fraction", "valid_until",
          "external_id", "connection_id", "recorded_at", "metadata",
        ],
        samples,
        (sample) => [
          sample.observationId, sample.houseId, sample.floorId, sample.elementId, sample.observedAt,
          sample.source, sample.state, sample.openFraction, sample.validUntil, sample.externalId,
          sample.connectionId, sample.recordedAt, sample.metadata ?? {},
        ],
        control,
      );
    },
  async upsertHeatPumpStateSamples(this: TimeseriesStoreInternals,
      samples: readonly HeatPumpStateRecord[],
      control: QueryControl = {},
    ): Promise<BatchWriteResult> {
      return this.__writeBatches(
        "heat_pump_state_samples",
        [
          "connection_id", "house_id", "equipment_id", "device_id", "name", "brand", "model", "transport",
          "floor_id", "room_id", "x", "y", "z",
          "observed_at", "received_at", "available", "power", "selected_mode",
          "target_temperature_c", "current_temperature_c", "current_temperature_source",
          "current_humidity_percent", "target_humidity_percent",
          "fan_speed", "horizontal_swing", "vertical_swing", "fresh_air", "anion", "sleep", "light",
          "quiet", "turbo", "xfan", "steady_heat", "power_save", "clean_filter", "water_full", "dehumidifier_mode",
          "compressor_frequency_hz", "diagnostics",
          "activity", "activity_evidence",
        ],
        ["connection_id", "observed_at"],
        [
          "house_id", "equipment_id", "device_id", "name", "brand", "model", "transport",
          "floor_id", "room_id", "x", "y", "z", "received_at",
          "available", "power", "selected_mode", "target_temperature_c", "current_temperature_c",
          "current_temperature_source", "current_humidity_percent", "target_humidity_percent",
          "fan_speed", "horizontal_swing", "vertical_swing", "fresh_air", "anion", "sleep", "light",
          "quiet", "turbo", "xfan", "steady_heat", "power_save", "clean_filter", "water_full", "dehumidifier_mode",
          "compressor_frequency_hz", "diagnostics", "activity", "activity_evidence",
        ],
        samples,
        (sample) => [
          sample.connectionId, sample.houseId, sample.equipmentId, sample.deviceId,
          sample.name, sample.brand, sample.model, sample.transport, sample.floorId, sample.roomId,
          sample.x, sample.y, sample.z, sample.observedAt, sample.receivedAt,
          sample.available, sample.power, sample.selectedMode, sample.targetTemperatureC,
          sample.currentTemperatureC, sample.currentTemperatureSource, sample.currentHumidityPercent,
          sample.targetHumidityPercent, sample.fanSpeed, sample.horizontalSwing, sample.verticalSwing,
          sample.freshAir, sample.anion, sample.sleep, sample.light, sample.quiet, sample.turbo,
          sample.xfan, sample.steadyHeat, sample.powerSave, sample.cleanFilter, sample.waterFull,
          sample.dehumidifierMode, sample.compressorFrequencyHz, sample.diagnostics, sample.activity,
          sample.activityEvidence,
        ],
        control,
      );
    },
  async __writeBatches<T>(this: TimeseriesStoreInternals,
      table: (typeof TELEMETRY_TABLES)[number],
      columns: readonly string[],
      conflictColumns: readonly string[],
      updateColumns: readonly string[],
      records: readonly T[],
      valuesFor: (record: T) => readonly SqlValue[],
      control: QueryControl,
      markOrderedRollups = false,
    ): Promise<BatchWriteResult> {
      const state = this[timeseriesStoreState];
      if (records.length === 0) return { attempted: 0, affected: 0 };
      const parameterSafeBatchSize = Math.min(state.batchSize, Math.floor(60_000 / columns.length));
      let affected = 0;

      for (let offset = 0; offset < records.length; offset += parameterSafeBatchSize) {
        const batch = records.slice(offset, offset + parameterSafeBatchSize);
        const values: SqlValue[] = [];
        const tuples = batch.map((record) => {
          const recordValues = valuesFor(record);
          if (recordValues.length !== columns.length) throw new Error(`Invalid value count for ${table}`);
          const placeholders = recordValues.map((value) => {
            values.push(value);
            return `$${values.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        const assignments = updateColumns.map((column) => (
          `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`
        ));
        assignments.push(`${quoteIdentifier("ingested_at")} = clock_timestamp()`);
        const distinctCurrent = updateColumns.map((column) => `current_row.${quoteIdentifier(column)}`).join(", ");
        const distinctIncoming = updateColumns.map((column) => `EXCLUDED.${quoteIdentifier(column)}`).join(", ");
        const insertSql = `INSERT INTO ${qualifiedName(this.schema, table)} AS current_row
          (${columns.map(quoteIdentifier).join(", ")})
          VALUES ${tuples.join(", ")}
          ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET
            ${assignments.join(", ")}
          WHERE ROW(${distinctCurrent}) IS DISTINCT FROM ROW(${distinctIncoming})`;
        let sql = insertSql;
        if (markOrderedRollups) {
          values.push([...state.orderedMetrics]);
          const orderedMetricsParameter = `$${values.length}`;
          sql = `WITH changed AS (
              ${insertSql}
              RETURNING sensor_id, metric, observed_at
            ), changed_days AS MATERIALIZED (
              SELECT sensor_id, metric, date_bin(INTERVAL '1 day', observed_at,
                TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start, min(observed_at) AS first_changed_at
              FROM changed GROUP BY 1, 2, 3
            ), ordered_days AS (
              SELECT day.* FROM changed_days day
              WHERE day.metric = ANY(${orderedMetricsParameter}::TEXT[])
                OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = day.sensor_id AND dirty.metric = day.metric
                    AND dirty.day_start = day.day_start
                )
            ), generations AS (
              INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} AS generation
                (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
              SELECT sensor_id, metric, day_start, 1, 1, clock_timestamp() FROM ordered_days
              ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
                current_seq = generation.current_seq + 1,
                synced_seq = CASE WHEN generation.current_seq <> generation.synced_seq OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = generation.sensor_id
                    AND dirty.metric = generation.metric
                    AND dirty.day_start = generation.day_start
                ) THEN generation.synced_seq ELSE generation.current_seq + 1 END,
                updated_at = clock_timestamp()
              -- Appends at or after the active day's seal extend its open
              -- tail; the locked row's seal is current, so a concurrent
              -- re-seal cannot miss a sample that lands inside it.
              WHERE generation.sealed_until IS NULL OR EXISTS (
                SELECT 1 FROM ordered_days day
                WHERE day.sensor_id = generation.sensor_id AND day.metric = generation.metric
                  AND day.day_start = generation.day_start
                  AND day.first_changed_at < generation.sealed_until
              )
              RETURNING sensor_id, metric, day_start, current_seq
            ), dirtied AS (
              UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty SET
                current_seq = GREATEST(dirty.current_seq, generation.current_seq), lease_token = NULL,
                lease_until = NULL, updated_at = clock_timestamp()
              FROM generations generation
              WHERE dirty.sensor_id = generation.sensor_id
                AND dirty.metric = generation.metric
                AND dirty.day_start = generation.day_start
              RETURNING 1
            )
            SELECT count(*)::BIGINT AS affected FROM changed`;
        }
        const result = await this.__query(sql, values, control);
        const reported = markOrderedRollups
          ? Number((result.rows[0] as { affected?: string | number } | undefined)?.affected ?? result.rowCount ?? 0)
          : result.rowCount ?? 0;
        affected += Number.isFinite(reported) ? reported : 0;
      }
      return { attempted: records.length, affected };
    },
  /** Mirrors SQLite's one-way real-data latch by removing synthetic sources. */
  async deleteTelemetrySources(this: TimeseriesStoreInternals, sources: readonly string[], control: QueryControl = {}): Promise<number> {
      if (sources.length === 0) return 0;
      let deleted = 0;
      for (const table of SOURCE_TAGGED_TELEMETRY_TABLES) {
        if (table === "measurement_samples") {
          const result = await this.__query<{ affected: string | number }>(`WITH removed AS (
              DELETE FROM ${qualifiedName(this.schema, table)}
              WHERE source = ANY($1::TEXT[])
              RETURNING sensor_id, metric, observed_at
            ), removed_days AS MATERIALIZED (
              SELECT DISTINCT sensor_id, metric, date_bin(INTERVAL '1 day', observed_at,
                TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start
              FROM removed
            ), ordered_days AS (
              SELECT day.* FROM removed_days day
              WHERE day.metric = ANY($2::TEXT[])
                OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = day.sensor_id AND dirty.metric = day.metric
                    AND dirty.day_start = day.day_start
                )
            ), generations AS (
              INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} AS generation
                (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
              SELECT sensor_id, metric, day_start, 1, 1, clock_timestamp() FROM ordered_days
              ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
                current_seq = generation.current_seq + 1,
                synced_seq = CASE WHEN generation.current_seq <> generation.synced_seq OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = generation.sensor_id
                    AND dirty.metric = generation.metric
                    AND dirty.day_start = generation.day_start
                ) THEN generation.synced_seq ELSE generation.current_seq + 1 END,
                updated_at = clock_timestamp()
              RETURNING sensor_id, metric, day_start, current_seq
            ), dirtied AS (
              UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty SET
                current_seq = GREATEST(dirty.current_seq, generation.current_seq), lease_token = NULL,
                lease_until = NULL, updated_at = clock_timestamp()
              FROM generations generation
              WHERE dirty.sensor_id = generation.sensor_id
                AND dirty.metric = generation.metric
                AND dirty.day_start = generation.day_start
              RETURNING 1
            ) SELECT count(*)::BIGINT AS affected FROM removed`, [
              [...sources],
              [...this[timeseriesStoreState].orderedMetrics],
            ], control);
          deleted += Number(result.rows[0]?.affected ?? 0);
        } else {
          const result = await this.__query(
            `DELETE FROM ${qualifiedName(this.schema, table)} WHERE source = ANY($1::TEXT[])`,
            [[...sources]],
            control,
          );
          deleted += result.rowCount ?? 0;
        }
      }
      return deleted;
    },
  /** Persistently applies SQLite's one-way transition from demo to real data. */
  async enforceRealDataBoundary(this: TimeseriesStoreInternals,
      sourceId: string,
      activatedAt: string,
      control: QueryControl = {},
    ): Promise<number> {
      const current = await this.__query<{ real_data_activated_at: string | Date }>(`SELECT real_data_activated_at
        FROM ${qualifiedName(this.schema, "archive_source_state")} WHERE source_id = $1`, [sourceId], control);
      if (current.rows[0] && timestamp(current.rows[0].real_data_activated_at) === new Date(activatedAt).toISOString()) return 0;
      const deleted = await this.deleteTelemetrySources(["mock", "replay"], control);
      await this.__query(`INSERT INTO ${qualifiedName(this.schema, "archive_source_state")}
          (source_id, real_data_activated_at, enforced_at)
        VALUES ($1, $2::TIMESTAMPTZ, clock_timestamp())
        ON CONFLICT (source_id) DO UPDATE SET
          real_data_activated_at = EXCLUDED.real_data_activated_at,
          enforced_at = EXCLUDED.enforced_at`, [sourceId, activatedAt], control);
      return deleted;
    },
});
