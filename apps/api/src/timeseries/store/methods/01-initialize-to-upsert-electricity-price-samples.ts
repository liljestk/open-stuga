import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_BUCKETS,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  measurementAggregateName,
  qualifiedName,
  quoteIdentifier,
  validateSchemaName,
} from "../../schema.js";
import type {
  AggregateRefreshQuery,
  ArchiveCheckpoint,
  ArchiveTableName,
  BatchWriteResult,
  ColdStorageMode,
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetryHealth,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { ContinuousAggregateRow, ExtensionRow, ProcedureFeatureRow, RelationKindRow, abortError, describeError, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

registerTimeseriesStoreMethods({
  async initialize(this: TimeseriesStoreInternals, control: QueryControl = {}): Promise<TelemetrySchemaInitResult> {
      if (this[timeseriesStoreState].initializePromise) return this[timeseriesStoreState].initializePromise;
      const pending = this.__initialize(control);
      this[timeseriesStoreState].initializePromise = pending;
      try {
        return await pending;
      } catch (error) {
        if (this[timeseriesStoreState].initializePromise === pending) this[timeseriesStoreState].initializePromise = null;
        throw error;
      }
    },
  /**
     * Allows a supervising worker to retry capability provisioning after a
     * resolved-but-incomplete initialization (for example, a transient DDL
     * timeout). In-flight queries are not cancelled.
     */
  invalidateInitialization(this: TimeseriesStoreInternals): void {
      this[timeseriesStoreState].initializePromise = null;
    },
  async __initialize(this: TimeseriesStoreInternals, control: QueryControl): Promise<TelemetrySchemaInitResult> {
      for (const sql of buildBaseSchemaSql(this.schema)) await this.__query(sql, [], control);

      const warnings: string[] = [];
      try {
        await this.__query("CREATE EXTENSION IF NOT EXISTS timescaledb", [], control);
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        warnings.push(`TimescaleDB extension could not be enabled: ${describeError(error)}`);
      }

      const extension = await this.__query<ExtensionRow>(`SELECT (
          SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
        ) AS timescale_version`, [], control);
      const timescaleVersion = extension.rows[0]?.timescale_version ?? null;
      const hypertables: string[] = [];

      if (timescaleVersion) {
        for (const definition of HYPERTABLE_DEFINITIONS) {
          try {
            await this.__query(
              `SELECT create_hypertable(
                $1::REGCLASS,
                $2,
                chunk_time_interval => $3::INTERVAL,
                if_not_exists => TRUE,
                migrate_data => TRUE,
                create_default_indexes => FALSE
              )`,
              [qualifiedName(this.schema, definition.table), definition.timeColumn, definition.chunkInterval],
              control,
            );
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Could not convert ${definition.table} to a hypertable: ${describeError(error)}`);
          }
        }
        for (const definition of HYPERTABLE_DEFINITIONS) {
          try {
            const validation = await this.__query<{ configured: boolean }>(`SELECT EXISTS (
                SELECT 1
                FROM timescaledb_information.hypertables hypertable
                JOIN timescaledb_information.dimensions dimension
                  ON dimension.hypertable_schema = hypertable.hypertable_schema
                 AND dimension.hypertable_name = hypertable.hypertable_name
                WHERE hypertable.hypertable_schema = $1
                  AND hypertable.hypertable_name = $2
                  AND dimension.column_name = $3
                  AND dimension.time_interval = $4::INTERVAL
              ) AS configured`, [this.schema, definition.table, definition.timeColumn, definition.chunkInterval], control);
            if (validation.rows[0]?.configured === true) hypertables.push(definition.table);
            else warnings.push(`Hypertable validation failed for ${definition.table}`);
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Could not validate ${definition.table} hypertable: ${describeError(error)}`);
          }
        }
      }

      const features = timescaleVersion
        ? await this.__detectTimescaleFeatures(control)
        : { columnstore_available: false, compression_available: false, continuous_policy_available: false };
      const coldStorageMode = await this.__configureColdStorage(hypertables, features, warnings, control);
      const aggregateMode = hypertables.includes("measurement_samples")
        ? await this.__configureContinuousAggregates(features.continuous_policy_available, warnings, control)
        : await this.__configureFallbackAggregates(warnings, control);

      return {
        schema: this.schema,
        timescaleAvailable: timescaleVersion !== null,
        timescaleVersion,
        hypertables,
        aggregateMode,
        coldStorageMode,
        warnings,
      };
    },
  async __detectTimescaleFeatures(this: TimeseriesStoreInternals, control: QueryControl): Promise<ProcedureFeatureRow> {
      const result = await this.__query<ProcedureFeatureRow>(`SELECT
        EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_columnstore_policy') AS columnstore_available,
        EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_compression_policy') AS compression_available,
        EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_continuous_aggregate_policy') AS continuous_policy_available`, [], control);
      return result.rows[0] ?? {
        columnstore_available: false,
        compression_available: false,
        continuous_policy_available: false,
      };
    },
  async __configureColdStorage(this: TimeseriesStoreInternals,
      hypertables: readonly string[],
      features: ProcedureFeatureRow,
      warnings: string[],
      control: QueryControl,
    ): Promise<ColdStorageMode> {
      if (hypertables.length === 0) return "none";
      const definitions = HYPERTABLE_DEFINITIONS.filter(({ table }) => hypertables.includes(table));

      if (features.columnstore_available) {
        let configured = 0;
        for (const definition of definitions) {
          try {
            await this.__query(`ALTER TABLE ${qualifiedName(this.schema, definition.table)} SET (
              timescaledb.enable_columnstore = true,
              timescaledb.segmentby = '${definition.segmentBy}',
              timescaledb.orderby = '${definition.orderBy}'
            )`, [], control);
            await this.__query(
              "CALL add_columnstore_policy($1::REGCLASS, after => $2::INTERVAL, if_not_exists => TRUE)",
              [qualifiedName(this.schema, definition.table), definition.coldAfter],
              control,
            );
            configured += 1;
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Columnstore setup failed for ${definition.table}: ${describeError(error)}`);
          }
        }
        if (configured > 0) return "columnstore";
      }

      if (features.compression_available) {
        let configured = 0;
        for (const definition of definitions) {
          try {
            await this.__query(`ALTER TABLE ${qualifiedName(this.schema, definition.table)} SET (
              timescaledb.compress = true,
              timescaledb.compress_segmentby = '${definition.segmentBy}',
              timescaledb.compress_orderby = '${definition.orderBy}'
            )`, [], control);
            await this.__query(
              "SELECT add_compression_policy($1::REGCLASS, $2::INTERVAL, if_not_exists => TRUE)",
              [qualifiedName(this.schema, definition.table), definition.coldAfter],
              control,
            );
            configured += 1;
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Compression setup failed for ${definition.table}: ${describeError(error)}`);
          }
        }
        if (configured > 0) return "compression";
      }
      return "none";
    },
  async __configureContinuousAggregates(this: TimeseriesStoreInternals,
      policyAvailable: boolean,
      warnings: string[],
      control: QueryControl,
    ): Promise<"continuous" | "view" | "unavailable"> {
      try {
        for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
          const name = measurementAggregateName(bucket);
          // Timescale 2.28 exposes a continuous aggregate as relkind = 'v', the
          // same pg_class kind as our plain-PostgreSQL fallback. Only the
          // Timescale catalog can distinguish the two safely.
          if (await this.__isContinuousAggregate(name, control)) continue;
          const kind = await this.__relationKind(name, control);
          if (kind === "v") await this.__query(`DROP VIEW ${qualifiedName(this.schema, name)}`, [], control);
          else if (kind !== null) {
            throw new Error(`Cannot replace ${name}: unexpected relation kind ${kind}`);
          }
          await this.__query(buildContinuousAggregateSql(this.schema, bucket), [], control);
        }
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        warnings.push(`Continuous aggregate setup failed: ${describeError(error)}`);
        return this.__configureFallbackAggregates(warnings, control, true);
      }

      if (policyAvailable) {
        const policies = [
          ["5m", "30 days", "5 minutes", "5 minutes"],
          ["1h", "1 year", "1 hour", "1 hour"],
          ["1d", "10 years", "1 day", "1 day"],
        ] as const;
        for (const [bucket, startOffset, endOffset, scheduleInterval] of policies) {
          try {
            await this.__query(`SELECT add_continuous_aggregate_policy(
                $1::REGCLASS,
                start_offset => $2::INTERVAL,
                end_offset => $3::INTERVAL,
                schedule_interval => $4::INTERVAL,
                if_not_exists => TRUE
              )`, [
              qualifiedName(this.schema, measurementAggregateName(bucket)),
              startOffset,
              endOffset,
              scheduleInterval,
            ], control);
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Refresh policy setup failed for ${bucket} aggregates: ${describeError(error)}`);
          }
        }
      }
      return "continuous";
    },
  async __configureFallbackAggregates(this: TimeseriesStoreInternals,
      warnings: string[],
      control: QueryControl,
      preserveContinuousAggregates = false,
    ): Promise<"continuous" | "view" | "unavailable"> {
      try {
        let retainedContinuousAggregate = false;
        for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
          const name = measurementAggregateName(bucket);
          if (preserveContinuousAggregates && await this.__isContinuousAggregate(name, control)) {
            retainedContinuousAggregate = true;
            continue;
          }
          const kind = await this.__relationKind(name, control);
          if (kind !== null && kind !== "v") {
            throw new Error(`Cannot replace ${name}: unexpected relation kind ${kind}`);
          }
          await this.__query(buildFallbackAggregateSql(this.schema, bucket), [], control);
        }
        return retainedContinuousAggregate ? "continuous" : "view";
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        warnings.push(`PostgreSQL aggregate view setup failed: ${describeError(error)}`);
        return "unavailable";
      }
    },
  async __relationKind(this: TimeseriesStoreInternals, relation: string, control: QueryControl): Promise<string | null> {
      const result = await this.__query<RelationKindRow>(`SELECT c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`, [this.schema, relation], control);
      return result.rows[0]?.relkind ?? null;
    },
  async __isContinuousAggregate(this: TimeseriesStoreInternals, relation: string, control: QueryControl): Promise<boolean> {
      const result = await this.__query<ContinuousAggregateRow>(`SELECT EXISTS (
          SELECT 1
          FROM timescaledb_information.continuous_aggregates
          WHERE view_schema = $1 AND view_name = $2
        ) AS configured`, [this.schema, relation], control);
      return result.rows[0]?.configured === true;
    },
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
});
