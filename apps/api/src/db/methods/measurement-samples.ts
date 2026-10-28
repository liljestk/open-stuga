import type { MeasurementSample, SensorDataGapSource } from "@climate-twin/contracts";
import { DEMO_TELEMETRY_SOURCES } from "../support/domain-limits.js";
import { MeasurementSampleRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { measurementSampleFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import type { LocalBucketQuery } from "../../timeseries/local-telemetry-worker-thread.js";
import type { MeasurementHistoryBucketedMultiQuery, MeasurementWindowQuery, ThermalHistoryWindowQuery, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { compareCodeUnits } from "../../text-order.js";

declare module "../core.js" {
  interface DatabaseInternals {
    insertMeasurementSample(
        sample: MeasurementSample,
        deduplicateAcrossSources?: boolean,
        enqueueAlertEvaluation?: boolean,
        deferDerivedInvalidation?: boolean,
      ): boolean;
    insertMeasurementSamples(samples: MeasurementSample[], options?: {
            deduplicateAcrossSources?: boolean;
            enqueueAlertEvaluation?: boolean;
        }): MeasurementSample[];
    latestMeasurementSamples(houseId?: string): MeasurementSample[];
    getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null;
    measurementSampleAtOrBefore(sensorId: string, metric: string, source: SensorDataGapSource, timestamp: string): MeasurementSample | null;
    measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number,
      before?: { timestamp: string; source: string }): MeasurementSample[];
    measurementWindow(query: MeasurementWindowQuery): MeasurementSample[];
    measurementWindowPage(sensorIds: string[], metrics: string[], from: string, to: string, limit: number, before?: {
            timestamp: string;
            id: number;
        } | null): {
        samples: MeasurementSample[];
        next: {
            timestamp: string;
            id: number;
        } | null;
    };
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(query: LocalBucketQuery): MeasurementSample[];
    measurementHistoryBucketedMulti(query: MeasurementHistoryBucketedMultiQuery): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(query: ThermalHistoryWindowQuery): MeasurementSample[];
    thermalClimateHistory(query: ThermalHistoryWindowQuery): MeasurementSample[];
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
  }

  interface ClimateDatabaseCore {
    insertMeasurementSamples(samples: MeasurementSample[], options?: {
            deduplicateAcrossSources?: boolean;
            enqueueAlertEvaluation?: boolean;
        }): MeasurementSample[];
    latestMeasurementSamples(houseId?: string): MeasurementSample[];
    getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null;
    measurementSampleAtOrBefore(sensorId: string, metric: string, source: SensorDataGapSource, timestamp: string): MeasurementSample | null;
    measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number,
      before?: { timestamp: string; source: string }): MeasurementSample[];
    measurementWindow(query: MeasurementWindowQuery): MeasurementSample[];
    measurementWindowPage(sensorIds: string[], metrics: string[], from: string, to: string, limit: number, before?: {
            timestamp: string;
            id: number;
        } | null): {
        samples: MeasurementSample[];
        next: {
            timestamp: string;
            id: number;
        } | null;
    };
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(query: LocalBucketQuery): MeasurementSample[];
    measurementHistoryBucketedMulti(query: MeasurementHistoryBucketedMultiQuery): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(query: ThermalHistoryWindowQuery): MeasurementSample[];
    thermalClimateHistory(query: ThermalHistoryWindowQuery): MeasurementSample[];
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
  }
}

registerDatabaseMethods({
  insertMeasurementSample(
      sample: MeasurementSample,
      deduplicateAcrossSources = false,
      enqueueAlertEvaluation = false,
      deferDerivedInvalidation = false,
    ): boolean {
      const sensor = this.getSensor(sample.sensorId);
      if (!sensor) return false;
      if (deduplicateAcrossSources && this.db.prepare(`SELECT 1 FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND timestamp = ? LIMIT 1`)
        .get(sample.sensorId, sample.metric, sample.timestamp)) return false;
      const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
      if (Number(result.changes) === 0) return false;
      if (!DEMO_TELEMETRY_SOURCES.has(sample.source)) {
        this.db.prepare("INSERT OR IGNORE INTO sensor_recorded_measurements(sensor_id, metric) VALUES (?, ?)")
          .run(sample.sensorId, sample.metric);
      }
      if (enqueueAlertEvaluation) {
        this.db.prepare("INSERT INTO alert_evaluation_queue(measurement_sample_id) VALUES (?)")
          .run(result.lastInsertRowid);
      }
      if (!deferDerivedInvalidation) {
        this.invalidateDerivedAnalyticsHistory(sensor.houseId, sample.timestamp, sample.timestamp);
      }
      return true;
    },
  insertMeasurementSamples(
      samples: MeasurementSample[],
      options: { deduplicateAcrossSources?: boolean; enqueueAlertEvaluation?: boolean } = {},
    ): MeasurementSample[] {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources(samples.map((sample) => sample.source));
        const inserted: MeasurementSample[] = [];
        for (const sample of samples) {
          if (this.insertMeasurementSample(
            sample,
            options.deduplicateAcrossSources,
            options.enqueueAlertEvaluation,
            true,
          )) inserted.push(sample);
        }
        const intervals = new Map<string, { from: string; to: string }>();
        for (const sample of inserted) {
          const sensor = this.getSensor(sample.sensorId);
          if (!sensor) continue;
          const interval = intervals.get(sensor.houseId);
          if (!interval) intervals.set(sensor.houseId, { from: sample.timestamp, to: sample.timestamp });
          else {
            if (sample.timestamp < interval.from) interval.from = sample.timestamp;
            if (sample.timestamp > interval.to) interval.to = sample.timestamp;
          }
        }
        for (const [houseId, interval] of intervals) {
          this.invalidateDerivedAnalyticsHistory(houseId, interval.from, interval.to);
        }
        return inserted;
      });
    },
  latestMeasurementSamples(houseId?: string): MeasurementSample[] {
      const where = houseId ? "WHERE s.house_id = ? AND house.deleted_at IS NULL" : "WHERE house.deleted_at IS NULL";
      const rows = this.db.prepare(`SELECT ms.sensor_id, ms.metric, ms.value, ms.canonical_unit,
          ms.timestamp, ms.source, ms.quality
        FROM sensors s JOIN houses AS house ON house.id = s.house_id
        CROSS JOIN measurement_definitions definition
        JOIN measurement_samples ms ON ms.id = (
          SELECT latest.id FROM measurement_samples latest
          WHERE latest.sensor_id = s.id AND latest.metric = definition.id
          ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
        )
        ${where}
        ORDER BY ms.sensor_id, ms.metric`)
        .all(...(houseId ? [houseId] : [])) as unknown as MeasurementSampleRow[];
      return rows.map(measurementSampleFromRow);
    },
  getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? ORDER BY timestamp DESC, id DESC LIMIT 1`)
        .get(sensorId, metric) as unknown as MeasurementSampleRow | undefined;
      return row ? measurementSampleFromRow(row) : null;
    },
  measurementSampleAtOrBefore(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      timestamp: string,
    ): MeasurementSample | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND source = ? AND timestamp <= ?
        ORDER BY timestamp DESC, id DESC LIMIT 1`)
        .get(sensorId, metric, source, timestamp) as unknown as MeasurementSampleRow | undefined;
      return row ? measurementSampleFromRow(row) : null;
    },
  measurementHistory(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    limit = 20_000,
    before?: { timestamp: string; source: string },
  ): MeasurementSample[] {
      if (!this.getSensor(sensorId)) return [];
      const cursor = before
        ? "AND (timestamp < ? OR (timestamp = ? AND source < ?))"
        : "";
      const parameters: Array<string | number> = [sensorId, metric, from, to];
      if (before) parameters.push(before.timestamp, before.timestamp, before.source);
      parameters.push(limit);
      const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
        SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
          ${cursor}
        ORDER BY timestamp DESC, source DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, source ASC, id ASC`).all(...parameters) as unknown as MeasurementSampleRow[];
      return rows.map(measurementSampleFromRow);
    },
  /**
     * Read-only, batched multi-sensor window used by optional derived engines.
     * It deliberately returns the existing sparse metric contract rather than
     * manufacturing paired climate readings in the core repository.
     */
  measurementWindow({ sensorIds, metrics, from, to, limit = 100_000 }: MeasurementWindowQuery): MeasurementSample[] {
      const visibleSensorIds = sensorIds.filter((id) => Boolean(this.getSensor(id)));
      if (visibleSensorIds.length === 0 || metrics.length === 0) return [];
      if (!Number.isInteger(limit) || limit < 1 || limit > 250_000) {
        throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Measurement window limit must be an integer from 1 to 250000");
      }
      const sensorPlaceholders = visibleSensorIds.map(() => "?").join(",");
      const metricPlaceholders = metrics.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
        SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples
        WHERE sensor_id IN (${sensorPlaceholders}) AND metric IN (${metricPlaceholders})
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, id ASC`)
        .all(...visibleSensorIds, ...metrics, from, to, limit) as unknown as MeasurementSampleRow[];
      return rows.map(measurementSampleFromRow);
    },
  /**
     * One descending page of `measurementWindow`. The (timestamp, id) cursor is
     * a total order over immutable rows, so a caller can assemble a large
     * window from bounded statements — yielding between pages — instead of one
     * synchronous statement that blocks the event loop for the whole window.
     */
  measurementWindowPage(
      sensorIds: string[],
      metrics: string[],
      from: string,
      to: string,
      limit: number,
      before: { timestamp: string; id: number } | null = null,
    ): { samples: MeasurementSample[]; next: { timestamp: string; id: number } | null } {
      const visibleSensorIds = sensorIds.filter((id) => Boolean(this.getSensor(id)));
      if (visibleSensorIds.length === 0 || metrics.length === 0) return { samples: [], next: null };
      if (!Number.isInteger(limit) || limit < 1 || limit > 250_000) {
        throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Measurement window limit must be an integer from 1 to 250000");
      }
      const sensorPlaceholders = visibleSensorIds.map(() => "?").join(",");
      const metricPlaceholders = metrics.map(() => "?").join(",");
      const cursorClause = before ? "AND (timestamp, id) < (?, ?)" : "";
      const cursorParameters = before ? [before.timestamp, before.id] : [];
      const rows = this.db.prepare(`SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples
        WHERE sensor_id IN (${sensorPlaceholders}) AND metric IN (${metricPlaceholders})
          AND timestamp >= ? AND timestamp <= ? ${cursorClause}
        ORDER BY timestamp DESC, id DESC LIMIT ?`)
        .all(...visibleSensorIds, ...metrics, from, to, ...cursorParameters, limit + 1) as unknown as (MeasurementSampleRow & { id: number })[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        samples: page.map(measurementSampleFromRow),
        next: hasMore && last ? { timestamp: last.timestamp, id: last.id } : null,
      };
    },
  measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[] {
      const visibleSensorIds = [...new Set(sensorIds)].filter((id) => Boolean(this.getSensor(id))).sort(compareCodeUnits);
      const requestedMetrics = [...new Set(metrics)].sort(compareCodeUnits);
      if (visibleSensorIds.length === 0 || requestedMetrics.length === 0) return [];
      // A MIN/MAX GROUP BY over the requested pairs walks every matching index
      // entry, so its runtime grows with retained history and the statement
      // blocks the event loop for the whole scan. Probing each boundary
      // separately keeps every statement a single covering-index descent, so
      // the call stays O(pairs) regardless of how much telemetry is retained.
      const earliest = this.db.prepare(
        "SELECT MIN(timestamp) AS boundary FROM measurement_samples WHERE sensor_id = ? AND metric = ?",
      );
      const latest = this.db.prepare(
        "SELECT MAX(timestamp) AS boundary FROM measurement_samples WHERE sensor_id = ? AND metric = ?",
      );
      const records: MeasurementCoverageRecord[] = [];
      for (const sensorId of visibleSensorIds) {
        for (const metric of requestedMetrics) {
          const start = (earliest.get(sensorId, metric) as { boundary: string | null }).boundary;
          if (start === null) continue;
          const end = (latest.get(sensorId, metric) as { boundary: string | null }).boundary;
          records.push({ sensorId, metric, start, end: end ?? start });
        }
      }
      return records;
    },
  measurementHistoryBucketed({
      sensorId, metric, from, to, bucketSeconds, limit = 20_000, excludeSynthetic = false, toExclusive = false,
    }: LocalBucketQuery): MeasurementSample[] {
      if (!this.getSensor(sensorId)) return [];
      const sourceFilter = excludeSynthetic ? "AND source NOT IN ('mock', 'replay')" : "";
      // An exclusive upper bound lets chunked callers tile a long window into
      // adjacent statements without counting a boundary row twice.
      const rows = this.db.prepare(`WITH source_rows AS (
          SELECT timestamp,
            CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch, value
          FROM measurement_samples
          WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp ${toExclusive ? "<" : "<="} ?
            ${sourceFilter}
        ), recent_buckets AS (
          SELECT bucket_epoch, AVG(value) AS value, COUNT(*) AS sample_count,
            MAX(timestamp) AS latest_at
          FROM source_rows WHERE bucket_epoch IS NOT NULL
          GROUP BY bucket_epoch ORDER BY bucket_epoch DESC LIMIT ?
        )
        SELECT recent_buckets.bucket_epoch, recent_buckets.value, recent_buckets.sample_count,
          latest.canonical_unit, latest.source, latest.quality
        FROM recent_buckets
        -- Resolve only the returned buckets' provenance through the existing
        -- sensor/metric/timestamp index, without ranking every dense sample.
        JOIN measurement_samples AS latest ON latest.id = (
          SELECT id FROM measurement_samples
          WHERE sensor_id = ? AND metric = ? AND timestamp = recent_buckets.latest_at
            ${sourceFilter}
          ORDER BY source DESC, id DESC LIMIT 1
        )
        ORDER BY recent_buckets.bucket_epoch ASC`)
        .all(bucketSeconds, bucketSeconds, sensorId, metric, from, to, limit, sensorId, metric) as Array<{
          bucket_epoch: number;
          value: number;
          sample_count: number;
          canonical_unit: string;
          source: MeasurementSample["source"];
          quality: MeasurementSample["quality"];
        }>;
      return rows.map((row) => ({
        sensorId,
        metric,
        value: row.value,
        canonicalUnit: row.canonical_unit,
        timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
        source: row.source,
        quality: row.sample_count > 1 ? "estimated" : row.quality,
      }));
    },
  measurementHistoryBucketedMulti({
      sensorIds, metrics, from, to, bucketSeconds, limitPerSeries = 20_000,
    }: MeasurementHistoryBucketedMultiQuery): MeasurementSample[] {
      const uniqueSensorIds = [...new Set(sensorIds)].filter((id) => Boolean(this.getSensor(id)));
      const uniqueMetrics = [...new Set(metrics)];
      if (uniqueSensorIds.length === 0 || uniqueMetrics.length === 0) return [];
      if (!Number.isInteger(bucketSeconds) || bucketSeconds < 1 || bucketSeconds > 86_400) {
        throw new ClimateDataValidationError(400, "INVALID_BUCKET", "Bucket size must be an integer from 1 to 86400 seconds");
      }
      if (!Number.isInteger(limitPerSeries) || limitPerSeries < 1 || limitPerSeries > 20_000) {
        throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Per-series bucket limit must be an integer from 1 to 20000");
      }
      const sensorPlaceholders = uniqueSensorIds.map(() => "?").join(",");
      const metricPlaceholders = uniqueMetrics.map(() => "?").join(",");
      const rows = this.db.prepare(`WITH source_rows AS (
          SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality,
            CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch
          FROM measurement_samples
          WHERE sensor_id IN (${sensorPlaceholders}) AND metric IN (${metricPlaceholders})
            AND timestamp >= ? AND timestamp <= ?
        ), bucket_stats AS (
          SELECT sensor_id, metric, bucket_epoch, AVG(value) AS value,
            COUNT(*) AS sample_count, COUNT(DISTINCT source) AS source_count
          FROM source_rows WHERE bucket_epoch IS NOT NULL
          GROUP BY sensor_id, metric, bucket_epoch
        ), ranked_buckets AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY sensor_id, metric ORDER BY bucket_epoch DESC
            ) AS bucket_position
          FROM bucket_stats
        ), latest_rows AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY sensor_id, metric, bucket_epoch
              ORDER BY timestamp DESC, id DESC
            ) AS latest_position
          FROM source_rows WHERE bucket_epoch IS NOT NULL
        )
        SELECT bucket.sensor_id, bucket.metric, bucket.bucket_epoch, bucket.value,
          bucket.sample_count, bucket.source_count,
          latest.canonical_unit, latest.source, latest.quality
        FROM ranked_buckets AS bucket
        JOIN latest_rows AS latest
          ON latest.sensor_id = bucket.sensor_id
          AND latest.metric = bucket.metric
          AND latest.bucket_epoch = bucket.bucket_epoch
          AND latest.latest_position = 1
        WHERE bucket.bucket_position <= ?
        ORDER BY bucket.bucket_epoch ASC, bucket.sensor_id ASC, bucket.metric ASC`)
        .all(
          bucketSeconds,
          bucketSeconds,
          ...uniqueSensorIds,
          ...uniqueMetrics,
          from,
          to,
          limitPerSeries,
        ) as Array<{
          sensor_id: string; metric: string; bucket_epoch: number; value: number;
          sample_count: number; source_count: number; canonical_unit: string;
          source: MeasurementSample["source"];
          quality: MeasurementSample["quality"];
        }>;
      return rows.map((row) => ({
        sensorId: row.sensor_id,
        metric: row.metric,
        value: row.value,
        canonicalUnit: row.canonical_unit,
        timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
        source: row.source,
        quality: row.sample_count > 1 || row.source_count > 1 ? "estimated" : row.quality,
      }));
    },
  sensorMeasurementPage(sensorId: string, before: { timestamp: string; id: number } | null, limit = 100): {
      samples: MeasurementSample[];
      nextCursor: string | null;
    } {
      if (!this.getSensor(sensorId)) return { samples: [], nextCursor: null };
      const cursorClause = before ? "AND (timestamp, id) < (?, ?)" : "";
      const parameters = before
        ? [sensorId, before.timestamp, before.id, limit + 1]
        : [sensorId, limit + 1];
      const rows = this.db.prepare(`SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? ${cursorClause}
        ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...parameters) as unknown as (MeasurementSampleRow & { id: number })[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        samples: page.map(measurementSampleFromRow),
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.timestamp, last.id])).toString("base64url") : null,
      };
    },
  /**
     * Bounded, quality-weighted temperature buckets for synchronous thermal fitting.
     * Aggregation happens in SQLite so dense 2-10 second telemetry never enters the
     * Node calibration loop or consumes the raw-row limit before covering 7 days.
     */
  thermalTemperatureHistory({
      sensorId, from, to, bucketMinutes = 5, limitPerMetric: limit = 5_000,
    }: ThermalHistoryWindowQuery): MeasurementSample[] {
      if (!this.getSensor(sensorId)) return [];
      if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
        throw new ClimateDataValidationError(400, "INVALID_BUCKET_SIZE", "Thermal bucket size must be 1 to 60 minutes");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
        throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Thermal history limit must be 1 to 20000");
      }
      const bucketSeconds = bucketMinutes * 60;
      const rows = this.db.prepare(`WITH source_rows AS (
          SELECT
            CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
            value,
            canonical_unit,
            source,
            quality,
            CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END AS sample_weight
          FROM measurement_samples
          WHERE sensor_id = ? AND metric = 'temperature' AND timestamp >= ? AND timestamp <= ?
            AND quality <> 'stale' AND source <> 'replay'
        ), recent_buckets AS (
          SELECT
            bucket_epoch,
            SUM(value * sample_weight) / SUM(sample_weight) AS value,
            MAX(canonical_unit) AS canonical_unit,
            MIN(source) AS source,
            MAX(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS has_good
          FROM source_rows
          WHERE bucket_epoch IS NOT NULL
          GROUP BY bucket_epoch
          ORDER BY bucket_epoch DESC
          LIMIT ?
        )
        SELECT bucket_epoch, value, canonical_unit, source, has_good
        FROM recent_buckets ORDER BY bucket_epoch ASC`)
        .all(bucketSeconds, bucketSeconds, sensorId, from, to, limit) as unknown as Array<{
          bucket_epoch: number;
          value: number;
          canonical_unit: string;
          source: MeasurementSample["source"];
          has_good: number;
        }>;
      return rows.map((row) => ({
        sensorId,
        metric: "temperature",
        value: row.value,
        canonicalUnit: row.canonical_unit,
        timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
        source: row.source,
        quality: row.has_good ? "good" : "estimated",
      }));
    },
  /**
     * Bounded, aligned temperature and humidity buckets for moisture-response fitting.
     * Each metric receives its own limit so dense temperature telemetry cannot crowd
     * humidity out of the requested evidence window.
     */
  thermalClimateHistory({
      sensorId, from, to, bucketMinutes = 5, limitPerMetric = 5_000,
    }: ThermalHistoryWindowQuery): MeasurementSample[] {
      if (!this.getSensor(sensorId)) return [];
      if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
        throw new ClimateDataValidationError(400, "INVALID_BUCKET_SIZE", "Climate bucket size must be 1 to 60 minutes");
      }
      if (!Number.isInteger(limitPerMetric) || limitPerMetric < 1 || limitPerMetric > 20_000) {
        throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Climate history limit must be 1 to 20000 per metric");
      }
      const bucketSeconds = bucketMinutes * 60;
      const rows = this.db.prepare(`WITH source_rows AS (
          SELECT
            metric,
            CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
            value,
            canonical_unit,
            source,
            quality,
            CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END AS sample_weight
          FROM measurement_samples
          WHERE sensor_id = ? AND metric IN ('temperature', 'humidity')
            AND timestamp >= ? AND timestamp <= ?
            AND quality <> 'stale' AND source <> 'replay'
        ), aggregated AS (
          SELECT
            metric,
            bucket_epoch,
            SUM(value * sample_weight) / SUM(sample_weight) AS value,
            MAX(canonical_unit) AS canonical_unit,
            MIN(source) AS source,
            MAX(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS has_good
          FROM source_rows
          WHERE bucket_epoch IS NOT NULL
          GROUP BY metric, bucket_epoch
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY metric ORDER BY bucket_epoch DESC
          ) AS bucket_rank
          FROM aggregated
        )
        SELECT metric, bucket_epoch, value, canonical_unit, source, has_good
        FROM ranked WHERE bucket_rank <= ?
        ORDER BY bucket_epoch ASC, metric ASC`)
        .all(bucketSeconds, bucketSeconds, sensorId, from, to, limitPerMetric) as unknown as Array<{
          metric: MeasurementSample["metric"];
          bucket_epoch: number;
          value: number;
          canonical_unit: string;
          source: MeasurementSample["source"];
          has_good: number;
        }>;
      return rows.map((row) => ({
        sensorId,
        metric: row.metric,
        value: row.value,
        canonicalUnit: row.canonical_unit,
        timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
        source: row.source,
        quality: row.has_good ? "good" : "estimated",
      }));
    },
  latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT timestamp FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND source = ?
        ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId, metric, source) as { timestamp?: string } | undefined;
      return row?.timestamp ?? null;
    },
});
