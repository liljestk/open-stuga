import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_ANALYTICS_BUCKETS,
  MEASUREMENT_BUCKETS,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  buildMeasurementAnalyticsAggregateSql,
  measurementAnalyticsAggregateName,
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
  HeatPumpStateRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  OpeningStateRecord,
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
            await this.__query(
              "SELECT set_chunk_time_interval($1::REGCLASS, $2::INTERVAL)",
              [qualifiedName(this.schema, definition.table), definition.chunkInterval],
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
      if (timescaleVersion) await this.__assertNoRawRetentionPolicy(control);
      const coldStorageMode = await this.__configureColdStorage(hypertables, features, warnings, control);
      const aggregateMode = hypertables.includes("measurement_samples")
        ? await this.__configureContinuousAggregates(features, warnings, control)
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
  async __assertNoRawRetentionPolicy(this: TimeseriesStoreInternals, control: QueryControl): Promise<void> {
      const result = await this.__query<{ configured: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM timescaledb_information.jobs
          WHERE proc_name = 'policy_retention'
            AND hypertable_schema = $1
            AND hypertable_name = ANY($2::TEXT[])
        ) AS configured`, [this.schema, [...TELEMETRY_TABLES]], control);
      if (result.rows[0]?.configured === true) {
        throw new Error("Raw telemetry retention policy detected; Stugu requires lossless raw history");
      }
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
              [
                qualifiedName(this.schema, definition.table),
                this[timeseriesStoreState].coldStorageAfterDays === null
                  ? definition.coldAfter
                  : `${this[timeseriesStoreState].coldStorageAfterDays} days`,
              ],
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
              [
                qualifiedName(this.schema, definition.table),
                this[timeseriesStoreState].coldStorageAfterDays === null
                  ? definition.coldAfter
                  : `${this[timeseriesStoreState].coldStorageAfterDays} days`,
              ],
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
      features: ProcedureFeatureRow,
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
        for (const bucket of Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as Array<keyof typeof MEASUREMENT_ANALYTICS_BUCKETS>) {
          const name = measurementAnalyticsAggregateName(bucket);
          if (await this.__isContinuousAggregate(name, control)) continue;
          const kind = await this.__relationKind(name, control);
          if (kind !== null) throw new Error(`Cannot replace ${name}: unexpected relation kind ${kind}`);
          await this.__query(buildMeasurementAnalyticsAggregateSql(this.schema, bucket), [], control);
        }
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        warnings.push(`Continuous aggregate setup failed: ${describeError(error)}`);
        throw new Error(
          "Timescale continuous aggregates are required for bounded telemetry analytics",
          { cause: error },
        );
      }

      if (features.columnstore_available) {
        const columnstore: ReadonlyArray<readonly [string, string, string]> = [
          [measurementAggregateName("5m"), "sensor_id,metric", "30 days"],
          [measurementAggregateName("1h"), "sensor_id,metric", "30 days"],
          [measurementAggregateName("1d"), "sensor_id,metric", "30 days"],
          [measurementAnalyticsAggregateName("1m"), "sensor_id,metric,source,quality,canonical_unit", "1 day"],
          [measurementAnalyticsAggregateName("5m"), "sensor_id,metric,source,quality,canonical_unit", "7 days"],
          [measurementAnalyticsAggregateName("1h"), "sensor_id,metric,source,quality,canonical_unit", "30 days"],
          [measurementAnalyticsAggregateName("1d"), "sensor_id,metric,source,quality,canonical_unit", "90 days"],
        ] as const;
        for (const [aggregate, segmentBy, after] of columnstore) {
          try {
            await this.__query(`ALTER MATERIALIZED VIEW ${qualifiedName(this.schema, aggregate)} SET (
              timescaledb.enable_columnstore = true,
              timescaledb.segmentby = '${segmentBy}',
              timescaledb.orderby = 'bucket_start DESC'
            )`, [], control);
            await this.__query(
              "CALL add_columnstore_policy($1::REGCLASS, after => $2::INTERVAL, if_not_exists => TRUE)",
              [qualifiedName(this.schema, aggregate), after],
              control,
            );
          } catch (error) {
            if (control.signal?.aborted) throw abortError(control.signal);
            warnings.push(`Columnstore setup failed for ${aggregate}: ${describeError(error)}`);
          }
        }
      }

      if (!features.continuous_policy_available) {
        throw new Error("Timescale continuous aggregate refresh policies are required for bounded telemetry analytics");
      }
      const policies: ReadonlyArray<readonly [string, string | null, string, string]> = [
        [measurementAggregateName("5m"), null, "5 minutes", "5 minutes"],
        [measurementAggregateName("1h"), null, "1 hour", "1 hour"],
        [measurementAggregateName("1d"), null, "1 day", "1 day"],
        [measurementAnalyticsAggregateName("1m"), null, "1 minute", "1 minute"],
        [measurementAnalyticsAggregateName("5m"), null, "5 minutes", "5 minutes"],
        [measurementAnalyticsAggregateName("1h"), null, "1 hour", "15 minutes"],
        [measurementAnalyticsAggregateName("1d"), null, "1 day", "1 hour"],
      ] as const;
      const restoredLegacyPolicyAggregates = new Set([
        measurementAggregateName("5m"),
        measurementAggregateName("1h"),
        measurementAggregateName("1d"),
      ]);
      const policyFailures: string[] = [];
      for (const [aggregate, startOffset, endOffset, scheduleInterval] of policies) {
        try {
          if (restoredLegacyPolicyAggregates.has(aggregate)) {
            const legacyPolicy = await this.__query<{ configured: boolean }>(`SELECT EXISTS (
                SELECT 1
                FROM timescaledb_information.jobs
                WHERE proc_name = 'policy_refresh_continuous_aggregate'
                  AND proc_schema IN ('_timescaledb_functions', '_timescaledb_internal')
                  AND hypertable_schema = $1
                  AND hypertable_name = $2
                  AND config ->> 'start_offset' IS NOT NULL
              ) AS configured`, [this.schema, aggregate], control);
            if (legacyPolicy.rows[0]?.configured === true) {
              await this.__query(
                "SELECT remove_continuous_aggregate_policy($1::REGCLASS, if_exists => TRUE)",
                [qualifiedName(this.schema, aggregate)],
                control,
              );
            }
          }
          await this.__query(`SELECT add_continuous_aggregate_policy(
              $1::REGCLASS,
              start_offset => $2::INTERVAL,
              end_offset => $3::INTERVAL,
              schedule_interval => $4::INTERVAL,
              if_not_exists => TRUE
            )`, [
            qualifiedName(this.schema, aggregate),
            startOffset,
            endOffset,
            scheduleInterval,
          ], control);
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          const warning = `Refresh policy setup failed for ${aggregate}: ${describeError(error)}`;
          warnings.push(warning);
          policyFailures.push(warning);
        }
      }
      if (policyFailures.length > 0) {
        throw new Error(
          `Only ${policies.length - policyFailures.length} of ${policies.length} required telemetry refresh policies were configured`,
        );
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
});
