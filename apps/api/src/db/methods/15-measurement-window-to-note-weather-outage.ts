import type { LocalBucketQuery } from "../../timeseries/local-telemetry-worker-thread.js";
import type { MeasurementHistoryBucketedMultiQuery, MeasurementWindowQuery, ThermalHistoryWindowQuery } from "../../timeseries/types.js";
import type {
  MeasurementSample,
  OutdoorTemperatureSample,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import type { MeasurementCoverageRecord } from "../../timeseries/types.js";
import { MeasurementSampleRow, OutdoorTemperatureRow, WeatherOutageRecord, WeatherOutageRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { measurementSampleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { outdoorLocationKey, outdoorTemperatureFromRow, weatherOutageFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";
import { compareCodeUnits } from "../../text-order.js";

registerDatabaseMethods({
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
  upsertOutdoorTemperatureSample(
      sample: OutdoorTemperatureSample,
      options: { deferDerivedInvalidation?: boolean } = {},
    ): OutdoorTemperatureSample {
      if (![sample.temperatureC, Date.parse(sample.timestamp), Date.parse(sample.fetchedAt)].every(Number.isFinite)) {
        throw new ClimateDataValidationError(400, "INVALID_OUTDOOR_SAMPLE", "Outdoor temperature and timestamps must be finite");
      }
      if (!this.getHouse(sample.houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
      }
      return this.immediateTransaction(() => {
        if (sample.source === "mock" && this.isRealDataMode()) {
          throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Synthetic outdoor samples are permanently disabled in real-data mode");
        }
        if (sample.source !== "mock" && !this.isRealDataMode()) this.activateRealDataMode();
        this.db.prepare(`INSERT INTO outdoor_temperature_samples
          (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name, conditions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(house_id, location_key, timestamp, source) DO UPDATE SET
            temperature_c = excluded.temperature_c,
            fetched_at = excluded.fetched_at,
            station_id = excluded.station_id,
            station_name = excluded.station_name,
            conditions_json = excluded.conditions_json`)
          .run(sample.houseId, sample.locationKey, sample.timestamp, sample.temperatureC, sample.source,
            sample.fetchedAt, sample.stationId, sample.stationName,
            sample.conditions ? JSON.stringify(sample.conditions) : null);
        if (!options.deferDerivedInvalidation) {
          this.invalidateDerivedAnalyticsHistory(sample.houseId, sample.timestamp, sample.timestamp);
        }
        return sample;
      });
    },
  /**
     * Persist a live boundary only while its opaque location key still matches
     * the house's current weather location. The check happens before the
     * irreversible real-data latch in `upsertOutdoorTemperatureSample`.
     */
  upsertCurrentOutdoorTemperatureSample(
      sample: OutdoorTemperatureSample,
      options: { deferDerivedInvalidation?: boolean } = {},
    ): OutdoorTemperatureSample {
      const house = this.getHouse(sample.houseId);
      if (!house) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
      }
      if (sample.locationKey !== outdoorLocationKey(house.location)) {
        throw new ClimateDataValidationError(
          409,
          "WEATHER_REQUEST_SUPERSEDED",
          "House location changed while weather was loading; the old-location observation was discarded",
        );
      }
      return this.upsertOutdoorTemperatureSample(sample, options);
    },
  outdoorTemperatureHistory(
      houseId: string,
      locationKey: string,
      from: string,
      to: string,
      limit = 20_000,
    ): OutdoorTemperatureSample[] {
      if (!this.getHouse(houseId)) return [];
      const rows = this.db.prepare(`SELECT house_id, location_key, timestamp, temperature_c, source, fetched_at,
        station_id, station_name, conditions_json FROM (
          SELECT rowid, house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name,
            conditions_json
          FROM outdoor_temperature_samples
          WHERE house_id = ? AND location_key = ? AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp DESC, rowid DESC LIMIT ?
        ) ORDER BY timestamp ASC, rowid ASC`)
        .all(houseId, locationKey, from, to, limit) as unknown as OutdoorTemperatureRow[];
      return rows.map(outdoorTemperatureFromRow);
    },
  outdoorTemperatureGaps(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      from: string,
      to: string,
      minimumGapMs: number,
      limit = 100,
    ): HistoricalTelemetryGap[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const thresholdSeconds = Math.max(1, minimumGapMs / 1_000);
      const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
      const rows = this.db.prepare(`WITH sample_times AS (
          SELECT DISTINCT timestamp FROM outdoor_temperature_samples
          WHERE house_id = ? AND location_key = ? AND source LIKE ?
            AND timestamp >= ? AND timestamp <= ?
        ), ordered AS (
          SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
          FROM sample_times
        )
        SELECT previous_timestamp AS started_at, timestamp AS ended_at,
          (julianday(timestamp) - julianday(previous_timestamp)) * 86400000.0 AS duration_ms
        FROM ordered
        WHERE previous_timestamp IS NOT NULL
          AND (julianday(timestamp) - julianday(previous_timestamp)) * 86400.0 >= ?
        ORDER BY previous_timestamp LIMIT ?`)
        .all(houseId, locationKey, sourcePrefix, from, to, thresholdSeconds, safeLimit) as unknown as Array<{
          started_at: string;
          ended_at: string;
          duration_ms: number;
        }>;
      return rows.map((row) => ({
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: Math.max(0, Math.round(row.duration_ms)),
      }));
    },
  latestOutdoorTemperatureTimestamp(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
    ): string | null {
      if (!this.getHouse(houseId)) return null;
      const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
      const row = this.db.prepare(`SELECT timestamp FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key = ? AND source LIKE ?
        ORDER BY timestamp DESC LIMIT 1`)
        .get(houseId, locationKey, sourcePrefix) as { timestamp?: string } | undefined;
      return row?.timestamp ?? null;
    },
  noteHistoricalWeatherObservationGap(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      startedAt: string,
      endedAt: string,
      detectedAt = new Date().toISOString(),
    ): WeatherOutageRecord {
      if (!this.getHouse(houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
      }
      const existing = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND provider = ?
          AND component = 'observation' AND backfill_from = ? AND backfill_to = ?
        ORDER BY id DESC LIMIT 1`)
        .get(houseId, locationKey, provider, startedAt, endedAt) as unknown as WeatherOutageRow | undefined;
      if (existing) return weatherOutageFromRow(existing);
      const result = this.db.prepare(`INSERT INTO weather_outages
        (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
         backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
        VALUES (?, ?, ?, 'observation', ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL)`)
        .run(
          houseId,
          locationKey,
          provider,
          startedAt,
          detectedAt,
          endedAt,
          "A historical observation gap was found in stored weather telemetry",
          startedAt,
          endedAt,
        );
      const inserted = this.db.prepare("SELECT * FROM weather_outages WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as unknown as WeatherOutageRow;
      return weatherOutageFromRow(inserted);
    },
  noteWeatherOutage(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      component: WeatherOutageComponent,
      error: string,
      detectedAt = new Date().toISOString(),
    ): WeatherOutageRecord {
      if (!this.getHouse(houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
      }
      this.db.prepare(`INSERT INTO weather_outages
        (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
         backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'not-needed', NULL, NULL, 0, NULL, NULL)
        ON CONFLICT(house_id, location_key, provider, component) WHERE ended_at IS NULL DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          last_error = excluded.last_error`)
        .run(houseId, locationKey, provider, component, detectedAt, detectedAt, error);
      const row = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND provider = ? AND component = ? AND ended_at IS NULL`)
        .get(houseId, locationKey, provider, component) as unknown as WeatherOutageRow;
      return weatherOutageFromRow(row);
    },
});
