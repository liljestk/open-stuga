import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { qualifiedName } from "../../schema.js";
import { measurementSeriesBoundsSql } from "../measurement-series-bounds-sql.js";
import type {
  MeasurementAnalyticsSeriesQuery,
  MeasurementOrderedRollupWorkResult,
  QueryControl,
} from "../../types.js";
import { timeoutValue } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

export const MEASUREMENT_ORDERED_ROLLUP_VERSION = 2;
const WORK_STATEMENT_TIMEOUT_MS = 120_000;

interface ClaimedRollupRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  day_start: string | Date;
  bucket_seconds: string | number;
  quality_mask: string | number;
  source_scope: "all" | "real";
  current_seq: string | number;
}

function messageFor(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

registerTimeseriesStoreMethods({
  async enqueueMeasurementOrderedRollups(
    this: TimeseriesStoreInternals,
    series: readonly MeasurementAnalyticsSeriesQuery[],
    from: string,
    to: string,
    qualityMask: number,
    sourceScope: "all" | "real",
    bucketSeconds: 60 | 900 | 3600 | 86400,
    control: QueryControl = {},
    dayStarts?: readonly string[],
  ): Promise<number> {
    const ordered = series.filter(({ aggregation }) => (
      aggregation === "delta" || aggregation === "time_weighted_mean"
    ));
    if (ordered.length === 0) return 0;
    for (const { metric } of ordered) this[timeseriesStoreState].orderedMetrics.add(metric);
    const result = await this.__query(`WITH requested AS (
        SELECT DISTINCT sensor_id, metric
        FROM jsonb_to_recordset($1::JSONB) AS item(sensor_id TEXT, metric TEXT)
      ), measurement_bounds AS (${measurementSeriesBoundsSql(this.schema, {
        requested: "requested", until: "$3::TIMESTAMPTZ",
        qualities: "ARRAY[CASE WHEN ($4::INTEGER & 1) <> 0 THEN 'good' END, CASE WHEN ($4::INTEGER & 2) <> 0 THEN 'estimated' END, CASE WHEN ($4::INTEGER & 4) <> 0 THEN 'stale' END]::TEXT[]",
        excludeSynthetic: "($5::TEXT = 'real')",
      })}
      ), history_limits AS (
        SELECT *, GREATEST($2::TIMESTAMPTZ, first_at) AS history_from,
          LEAST($3::TIMESTAMPTZ,
            last_at + CASE WHEN metric = 'power' THEN INTERVAL '15 minutes' ELSE INTERVAL '0' END
              + INTERVAL '1 microsecond',
            date_bin(INTERVAL '1 day', clock_timestamp(),
              TIMESTAMPTZ '1970-01-01 00:00:00+00')) AS history_to
        FROM measurement_bounds WHERE first_at IS NOT NULL AND last_at IS NOT NULL
      ), days AS (
        SELECT DISTINCT requested.sensor_id, requested.metric, selected_day.day_start
        FROM history_limits requested
        CROSS JOIN LATERAL (
          SELECT generated.day_start
          FROM generate_series(
            date_bin(INTERVAL '1 day', requested.history_from,
              TIMESTAMPTZ '1970-01-01 00:00:00+00'),
            date_bin(INTERVAL '1 day', requested.history_to - INTERVAL '1 microsecond',
              TIMESTAMPTZ '1970-01-01 00:00:00+00'),
            INTERVAL '24 hours'
          ) AS generated(day_start)
          WHERE $7::TIMESTAMPTZ[] IS NULL AND requested.history_from < requested.history_to
          UNION ALL
          SELECT date_bin(INTERVAL '1 day', explicit_day,
            TIMESTAMPTZ '1970-01-01 00:00:00+00')
          FROM unnest(COALESCE($7::TIMESTAMPTZ[], ARRAY[]::TIMESTAMPTZ[])) AS explicit_day
        ) AS selected_day
      ), generations AS (
        INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} AS generation
          (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
        SELECT sensor_id, metric, day_start, 1, 0, clock_timestamp() FROM days
        ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
          synced_seq = CASE WHEN EXISTS (
            SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
            WHERE dirty.sensor_id = generation.sensor_id
              AND dirty.metric = generation.metric
              AND dirty.day_start = generation.day_start
              AND dirty.bucket_seconds = $6::INTEGER
              AND dirty.quality_mask = $4::SMALLINT
              AND dirty.source_scope = $5::TEXT
          ) THEN generation.synced_seq
          ELSE LEAST(generation.synced_seq, GREATEST(0, generation.current_seq - 1)) END,
          updated_at = clock_timestamp()
        RETURNING sensor_id, metric, day_start, current_seq
      )
      INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty
        (sensor_id, metric, day_start, bucket_seconds, quality_mask, source_scope,
          current_seq, clean_seq, updated_at)
      SELECT sensor_id, metric, day_start, $6::INTEGER, $4::SMALLINT, $5::TEXT,
        current_seq, 0, clock_timestamp() FROM generations
      ON CONFLICT (sensor_id, metric, day_start, bucket_seconds, quality_mask, source_scope) DO UPDATE SET
        current_seq = GREATEST(dirty.current_seq, EXCLUDED.current_seq)`, [
      JSON.stringify(ordered.map(({ sensorId, metric }) => ({ sensor_id: sensorId, metric }))),
      from,
      to,
      qualityMask,
      sourceScope,
      bucketSeconds,
      dayStarts ? [...dayStarts] : null,
    ], control);
    return result.rowCount ?? 0;
  },

  async rebuildNextMeasurementOrderedRollup(
    this: TimeseriesStoreInternals,
    control: QueryControl = {},
  ): Promise<MeasurementOrderedRollupWorkResult> {
    const metrics = [...this[timeseriesStoreState].orderedMetrics];
    if (metrics.length === 0) return { processed: false };
    const requestedTimeoutMs = timeoutValue(control.timeoutMs, WORK_STATEMENT_TIMEOUT_MS);
    const workTimeoutMs = requestedTimeoutMs === 0
      ? 0
      : Math.min(requestedTimeoutMs, WORK_STATEMENT_TIMEOUT_MS);
    await this.__query(`WITH candidate AS (
        SELECT sensor_id, metric, day_start, current_seq
        FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")}
        WHERE current_seq <> synced_seq AND metric = ANY($1::TEXT[])
        ORDER BY updated_at, day_start, sensor_id, metric
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), variants AS (
        UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty SET
          current_seq = GREATEST(dirty.current_seq, candidate.current_seq),
          lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        FROM candidate
        WHERE dirty.sensor_id = candidate.sensor_id
          AND dirty.metric = candidate.metric
          AND dirty.day_start = candidate.day_start
        RETURNING 1
      )
      UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} generation SET
        synced_seq = generation.current_seq
      FROM candidate
      WHERE generation.sensor_id = candidate.sensor_id
        AND generation.metric = candidate.metric
        AND generation.day_start = candidate.day_start
        AND generation.current_seq = candidate.current_seq`, [metrics], control);
    const leaseToken = randomUUID();
    const claim = await this.__query<ClaimedRollupRow>(`WITH candidate AS (
        SELECT dirty.sensor_id, dirty.metric, dirty.day_start, dirty.bucket_seconds,
          dirty.quality_mask, dirty.source_scope,
          GREATEST(dirty.current_seq, generation.current_seq) AS current_seq
        FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
        JOIN ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} generation
          USING (sensor_id, metric, day_start)
        WHERE GREATEST(dirty.current_seq, generation.current_seq) <> dirty.clean_seq
          AND dirty.metric = ANY($1::TEXT[])
          AND dirty.day_start < date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')
          AND (dirty.lease_until IS NULL OR dirty.lease_until < clock_timestamp())
        ORDER BY dirty.bucket_seconds DESC, dirty.day_start, dirty.updated_at, dirty.sensor_id, dirty.metric
        FOR UPDATE OF dirty SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty SET
        current_seq = GREATEST(dirty.current_seq, candidate.current_seq),
        lease_token = $2,
        lease_until = clock_timestamp() + INTERVAL '5 minutes',
        attempt_count = dirty.attempt_count + 1,
        last_error = NULL
      FROM candidate
      WHERE dirty.sensor_id = candidate.sensor_id
        AND dirty.metric = candidate.metric
        AND dirty.day_start = candidate.day_start
        AND dirty.bucket_seconds = candidate.bucket_seconds
        AND dirty.quality_mask = candidate.quality_mask
        AND dirty.source_scope = candidate.source_scope
      RETURNING dirty.sensor_id, dirty.metric, dirty.day_start, dirty.bucket_seconds,
        dirty.quality_mask, dirty.source_scope, dirty.current_seq`, [metrics, leaseToken], control);
    const row = claim.rows[0];
    if (!row) return { processed: false };

    const sensorId = row.sensor_id;
    const metric = row.metric;
    const dayStart = new Date(row.day_start).toISOString();
    const bucketSeconds = Number(row.bucket_seconds);
    const qualityMask = Number(row.quality_mask);
    const sourceScope = row.source_scope;
    const generation = Number(row.current_seq);
    const client = await this.__connect(control.signal);
    let generatedRows = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${workTimeoutMs}ms`]);
      await client.query(`CREATE TEMP TABLE IF NOT EXISTS stugu_ordered_rollup_stage
        (LIKE ${qualifiedName(this.schema, "measurement_ordered_rollups")} INCLUDING DEFAULTS)
        ON COMMIT PRESERVE ROWS`);
      await client.query("TRUNCATE stugu_ordered_rollup_stage");
      const staged = await client.query(`WITH filtered AS (
          SELECT sample.*
          FROM ${qualifiedName(this.schema, "measurement_samples")} AS sample
          WHERE sample.sensor_id = $1 AND sample.metric = $2
            AND sample.observed_at >= $3::TIMESTAMPTZ
            AND sample.observed_at < $3::TIMESTAMPTZ + INTERVAL '24 hours'
            AND (CASE sample.quality WHEN 'good' THEN 1 WHEN 'estimated' THEN 2
              WHEN 'stale' THEN 4 ELSE 0 END & $6::SMALLINT) <> 0
            AND ($7::TEXT = 'all' OR sample.source NOT IN ('mock', 'replay'))
        ), deduplicated AS (
          SELECT DISTINCT ON (observed_at) * FROM filtered
          ORDER BY observed_at, ingested_at DESC, source DESC
        ), bucketed AS (
          SELECT sample.*,
            $8::INTEGER AS bucket_seconds,
            date_bin(make_interval(secs => $8::INTEGER), sample.observed_at,
              TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start
          FROM deduplicated AS sample
        ), ordered AS (
          SELECT bucketed.*,
            lag(value) OVER sequence AS previous_value,
            lead(observed_at) OVER sequence AS next_at
          FROM bucketed
          WINDOW sequence AS (
            PARTITION BY bucket_seconds, bucket_start
            ORDER BY observed_at, source
          )
        )
        INSERT INTO stugu_ordered_rollup_stage (
          algorithm_version, sensor_id, metric, day_start, bucket_start,
          bucket_seconds, quality_mask, source_scope, generation, sample_count, sum_value,
          minimum, maximum, first_at, first_source, first_value,
          last_at, last_source, last_value, internal_positive_delta,
          internal_counter_consumption, counter_reset_count,
          weighted_value_seconds, weighted_seconds, maximum_internal_interval_seconds,
          estimated_sample_count, stale_sample_count, canonical_unit_min, canonical_unit_max
        )
        SELECT $4::INTEGER, sensor_id, metric, $3::TIMESTAMPTZ, bucket_start,
          bucket_seconds, $6::SMALLINT, $7::TEXT, $5::BIGINT, count(*)::BIGINT,
          sum(value)::DOUBLE PRECISION, min(value)::DOUBLE PRECISION, max(value)::DOUBLE PRECISION,
          min(observed_at), (array_agg(source ORDER BY observed_at, source))[1],
          (array_agg(value ORDER BY observed_at, source))[1]::DOUBLE PRECISION,
          max(observed_at), (array_agg(source ORDER BY observed_at DESC, source DESC))[1],
          (array_agg(value ORDER BY observed_at DESC, source DESC))[1]::DOUBLE PRECISION,
          COALESCE(sum(CASE WHEN previous_value IS NULL OR value < previous_value
            THEN 0 ELSE value - previous_value END), 0)::DOUBLE PRECISION,
          COALESCE(sum(CASE WHEN previous_value IS NULL THEN 0
            WHEN value >= previous_value THEN value - previous_value
            ELSE GREATEST(0, value) END), 0)::DOUBLE PRECISION,
          count(*) FILTER (WHERE previous_value IS NOT NULL AND value < previous_value)::BIGINT,
          COALESCE(sum(value * EXTRACT(EPOCH FROM (next_at - observed_at)))
            FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION,
          COALESCE(sum(EXTRACT(EPOCH FROM (next_at - observed_at)))
            FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION,
          COALESCE(max(EXTRACT(EPOCH FROM (next_at - observed_at)))
            FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION,
          count(*) FILTER (WHERE quality = 'estimated')::BIGINT,
          count(*) FILTER (WHERE quality = 'stale')::BIGINT,
          min(canonical_unit), max(canonical_unit)
        FROM ordered
        GROUP BY sensor_id, metric, bucket_seconds, bucket_start`, [
        sensorId, metric, dayStart, MEASUREMENT_ORDERED_ROLLUP_VERSION, generation,
        qualityMask, sourceScope, bucketSeconds,
      ]);
      generatedRows = staged.rowCount ?? 0;
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${workTimeoutMs}ms`]);
      const current = await client.query<ClaimedRollupRow>(`SELECT dirty.sensor_id, dirty.metric, dirty.day_start,
          dirty.bucket_seconds, dirty.quality_mask, dirty.source_scope,
          GREATEST(dirty.current_seq, generation.current_seq) AS current_seq
        FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
        JOIN ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} generation
          USING (sensor_id, metric, day_start)
        WHERE dirty.sensor_id = $1 AND dirty.metric = $2 AND dirty.day_start = $3::TIMESTAMPTZ
          AND dirty.bucket_seconds = $4::INTEGER AND dirty.quality_mask = $5::SMALLINT
          AND dirty.source_scope = $6 AND dirty.lease_token = $7
        FOR UPDATE OF dirty`, [sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope, leaseToken]);
      if (Number(current.rows[0]?.current_seq) !== generation) {
        await client.query(`UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")}
          SET lease_token = NULL, lease_until = NULL
          WHERE sensor_id = $1 AND metric = $2 AND day_start = $3::TIMESTAMPTZ
            AND bucket_seconds = $4::INTEGER AND quality_mask = $5::SMALLINT
            AND source_scope = $6 AND lease_token = $7`,
        [sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope, leaseToken]);
        await client.query("COMMIT");
        return { processed: true, sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope, generatedRows, stale: true };
      }
      await client.query(`DELETE FROM ${qualifiedName(this.schema, "measurement_ordered_rollups")}
        WHERE algorithm_version = $1 AND sensor_id = $2 AND metric = $3
          AND day_start = $4::TIMESTAMPTZ AND bucket_seconds = $5::INTEGER
          AND quality_mask = $6::SMALLINT AND source_scope = $7`, [
        MEASUREMENT_ORDERED_ROLLUP_VERSION, sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope,
      ]);
      await client.query(`INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollups")}
        SELECT * FROM stugu_ordered_rollup_stage`);
      await client.query(`UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")}
        SET clean_seq = current_seq, lease_token = NULL, lease_until = NULL,
          attempt_count = 0, last_error = NULL, updated_at = clock_timestamp()
        WHERE sensor_id = $1 AND metric = $2 AND day_start = $3::TIMESTAMPTZ
          AND bucket_seconds = $4::INTEGER AND quality_mask = $5::SMALLINT
          AND source_scope = $6 AND lease_token = $7 AND current_seq = $8::BIGINT`, [
        sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope, leaseToken, generation,
      ]);
      await client.query("COMMIT");
      return { processed: true, sensorId, metric, dayStart, bucketSeconds, qualityMask, sourceScope, generatedRows, stale: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await this.__query(`UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")}
        SET lease_token = NULL, lease_until = NULL, last_error = $5, updated_at = clock_timestamp()
        WHERE sensor_id = $1 AND metric = $2 AND day_start = $3::TIMESTAMPTZ
          AND bucket_seconds = $6::INTEGER AND quality_mask = $7::SMALLINT
          AND source_scope = $8 AND lease_token = $4`, [
        sensorId, metric, dayStart, leaseToken, messageFor(error), bucketSeconds, qualityMask, sourceScope,
      ], control).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
});
