import { measurementAnalyticsAggregateName, qualifiedName, type MeasurementAnalyticsBaseBucket } from "../schema.js";
import { MEASUREMENT_ORDERED_ROLLUP_VERSION } from "./methods/measurement-ordered-rollups.js";

/**
 * Bound parameters, referenced by position across every CTE below:
 *
 * - `$1` JSONB array of `{ sensor_id, metric, aggregation }` request rows
 * - `$2` inclusive range start (TIMESTAMPTZ)
 * - `$3` exclusive range end (TIMESTAMPTZ)
 * - `$4` accepted quality states (TEXT[])
 * - `$5` target output bucket width (INTERVAL)
 * - `$6` exclude synthetic sources when true (BOOLEAN)
 * - `$7` width of the pre-materialized base aggregate (INTERVAL)
 *
 * Note that `$5` and `$7` are both intervals and are easy to transpose: `$7`
 * bounds which rows may come from the continuous aggregate, while `$5` is the
 * bucket the caller asked for.
 */
export function mergeableAnalyticsSql(schema: string, base: MeasurementAnalyticsBaseBucket): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const aggregate = qualifiedName(schema, measurementAnalyticsAggregateName(base));
  return `WITH requested_series AS (
      SELECT DISTINCT sensor_id, metric, aggregation
      FROM jsonb_to_recordset($1::JSONB)
        AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)
    ), bounds AS (
      SELECT date_bin($7::INTERVAL, $2::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin($7::INTERVAL, $3::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), limits AS (
      SELECT CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket ELSE from_bucket + $7::INTERVAL END AS full_from,
        to_bucket AS full_to
      FROM bounds
    ), aggregate_interior_bounds AS (
      SELECT requested.sensor_id, requested.metric,
        first_bucket.bucket_start AS first_bucket, last_bucket.bucket_start AS last_bucket
      FROM requested_series requested
      CROSS JOIN limits
      LEFT JOIN LATERAL (
        SELECT sample.bucket_start FROM ${aggregate} sample
        WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
          AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
          AND sample.quality = ANY($4::TEXT[])
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.bucket_start ASC LIMIT 1
      ) first_bucket ON TRUE
      LEFT JOIN LATERAL (
        SELECT sample.bucket_start FROM ${aggregate} sample
        WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
          AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
          AND sample.quality = ANY($4::TEXT[])
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.bucket_start DESC LIMIT 1
      ) last_bucket ON TRUE
    ), coverage AS (
      -- Read the materialized interior and only scan raw observations outside
      -- it. A lagging final bucket must not turn seven cached days into a full
      -- raw scan. Keep the newest aggregate bucket in the raw tail, because it
      -- may have been materialized before its last observation arrived.
      -- As before, this relies on contiguous aggregate refresh windows.
      SELECT aggregate.sensor_id, aggregate.metric,
        aggregate.first_bucket AS cached_from,
        aggregate.last_bucket AS cached_to
      FROM aggregate_interior_bounds aggregate
    ), raw_windows AS (
      -- Separate ranges let the raw index seek to each uncached boundary.
      SELECT sensor_id, metric, $2::TIMESTAMPTZ AS raw_from,
        LEAST($3::TIMESTAMPTZ, COALESCE(cached_from, $3::TIMESTAMPTZ)) AS raw_to
      FROM coverage
      UNION ALL
      SELECT sensor_id, metric, GREATEST($2::TIMESTAMPTZ, cached_to), $3::TIMESTAMPTZ
      FROM coverage WHERE cached_to IS NOT NULL
    ), source_rows AS (
      SELECT sample.sensor_id, sample.metric, sample.bucket_start AS observed_bucket,
        sample.source, sample.quality, sample.canonical_unit,
        sample.sample_count, sample.sum_value, sample.minimum, sample.maximum,
        sample.first_value, sample.first_at, sample.last_value, sample.last_at
      FROM ${aggregate} sample
      JOIN requested_series requested
        ON requested.sensor_id = sample.sensor_id AND requested.metric = sample.metric
      JOIN coverage
        ON coverage.sensor_id = sample.sensor_id AND coverage.metric = sample.metric
      CROSS JOIN limits
      WHERE sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
        AND sample.bucket_start >= coverage.cached_from AND sample.bucket_start < coverage.cached_to
        AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
      UNION ALL
      SELECT sample.sensor_id, sample.metric,
        date_bin($7::INTERVAL, sample.observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        sample.source, sample.quality, sample.canonical_unit,
        1::BIGINT, sample.value, sample.value, sample.value,
        sample.value, sample.observed_at, sample.value, sample.observed_at
      FROM raw_windows boundary
      JOIN ${measurements} sample
        ON sample.sensor_id = boundary.sensor_id AND sample.metric = boundary.metric
          AND sample.observed_at >= boundary.raw_from AND sample.observed_at < boundary.raw_to
      WHERE boundary.raw_from < boundary.raw_to
        AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
    ), series_counts AS (
      SELECT requested.sensor_id, requested.metric, requested.aggregation,
        COALESCE(min(source.canonical_unit) FILTER (WHERE source.quality = ANY($4::TEXT[])), '') AS canonical_unit,
        COALESCE(max(source.canonical_unit) FILTER (WHERE source.quality = ANY($4::TEXT[])), '') AS canonical_unit_max,
        COALESCE(sum(source.sample_count) FILTER (WHERE source.quality = ANY($4::TEXT[])), 0)::BIGINT AS included_sample_count,
        COALESCE(sum(source.sample_count) FILTER (WHERE NOT (source.quality = ANY($4::TEXT[]))), 0)::BIGINT AS excluded_sample_count,
        GREATEST(1.0, EXTRACT(EPOCH FROM ($3::TIMESTAMPTZ - $2::TIMESTAMPTZ))
          / GREATEST(1, COALESCE(sum(source.sample_count) FILTER (WHERE source.quality = ANY($4::TEXT[])), 0)))::DOUBLE PRECISION AS cadence_seconds,
        TRUE AS coverage_complete
      FROM requested_series requested
      JOIN coverage USING (sensor_id, metric)
      LEFT JOIN source_rows source
        ON source.sensor_id = requested.sensor_id AND source.metric = requested.metric
      GROUP BY requested.sensor_id, requested.metric, requested.aggregation
    ), included AS (
      SELECT *, date_bin($5::INTERVAL, observed_bucket, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start
      FROM source_rows WHERE quality = ANY($4::TEXT[])
    ), bucket_aggregates AS (
      SELECT sensor_id, metric, bucket_start,
        sum(sample_count)::BIGINT AS bucket_sample_count,
        sum(sum_value)::DOUBLE PRECISION AS sum_value,
        min(minimum)::DOUBLE PRECISION AS minimum,
        max(maximum)::DOUBLE PRECISION AS maximum,
        (array_agg(last_value ORDER BY last_at DESC, source DESC))[1]::DOUBLE PRECISION AS last_value,
        sum(sample_count) FILTER (WHERE quality = 'estimated')::BIGINT AS estimated_sample_count,
        sum(sample_count) FILTER (WHERE quality = 'stale')::BIGINT AS stale_sample_count
      FROM included GROUP BY sensor_id, metric, bucket_start
    )
    SELECT counts.sensor_id, counts.metric, counts.canonical_unit,
      counts.canonical_unit = counts.canonical_unit_max AS unit_consistent,
      counts.coverage_complete, counts.included_sample_count, counts.excluded_sample_count,
      counts.cadence_seconds, buckets.bucket_start,
      CASE counts.aggregation
        WHEN 'mean' THEN buckets.sum_value / NULLIF(buckets.bucket_sample_count, 0)
        WHEN 'sum' THEN buckets.sum_value
        WHEN 'last' THEN buckets.last_value
        WHEN 'min' THEN buckets.minimum
        WHEN 'max' THEN buckets.maximum
      END::DOUBLE PRECISION AS rollup_value,
      buckets.minimum, buckets.maximum, buckets.bucket_sample_count,
      COALESCE(buckets.estimated_sample_count, 0)::BIGINT AS estimated_sample_count,
      COALESCE(buckets.stale_sample_count, 0)::BIGINT AS stale_sample_count,
      0::BIGINT AS counter_reset_count
    FROM series_counts counts
    LEFT JOIN bucket_aggregates buckets USING (sensor_id, metric)
    ORDER BY counts.sensor_id, counts.metric, buckets.bucket_start`;
}

/**
 * Bound parameters, referenced by position across every CTE below:
 *
 * - `$1` JSONB array of `{ sensor_id, metric, aggregation }` request rows
 * - `$2` inclusive range start (TIMESTAMPTZ)
 * - `$3` exclusive range end (TIMESTAMPTZ)
 * - `$4` accepted quality states (TEXT[])
 * - `$5` target output bucket width (INTERVAL)
 * - `$6` exclude synthetic sources when true (BOOLEAN)
 * - `$7` quality mask identifying a stored rollup variant (SMALLINT)
 * - `$8` width of the stored ordered rollup buckets, in seconds (INTEGER)
 *
 * `$5` and `$8` describe two different bucket widths — `$8` selects which
 * persisted rollup rows are readable, `$5` is the width the caller asked for
 * and is only applied when re-bucketing those rows into the response.
 */
export function orderedAnalyticsSql(schema: string): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const dirty = qualifiedName(schema, "measurement_ordered_rollup_dirty");
  const generations = qualifiedName(schema, "measurement_ordered_rollup_generations");
  const rollups = qualifiedName(schema, "measurement_ordered_rollups");
  const countAggregate = qualifiedName(schema, measurementAnalyticsAggregateName("1h"));
  return `WITH requested_series AS (
      SELECT DISTINCT sensor_id, metric, aggregation
      FROM jsonb_to_recordset($1::JSONB)
        AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)
    ), ordered_bounds AS (
      SELECT date_bin(make_interval(secs => $8::INTEGER), $2::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin(make_interval(secs => $8::INTEGER), $3::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), ordered_limits AS (
      SELECT CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + make_interval(secs => $8::INTEGER) END AS full_from,
        to_bucket AS full_to
      FROM ordered_bounds
    ), hour_bounds AS (
      SELECT date_bin(INTERVAL '1 hour', $2::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin(INTERVAL '1 hour', $3::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), hour_limits AS (
      SELECT CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + INTERVAL '1 hour' END AS full_from,
        LEAST(to_bucket, date_bin(INTERVAL '1 day', clock_timestamp(),
          TIMESTAMPTZ '1970-01-01 00:00:00+00')) AS full_to
      FROM hour_bounds
    ), required_days AS (
      SELECT requested.sensor_id, requested.metric, generated.day_start
      FROM requested_series requested
      CROSS JOIN ordered_limits
      CROSS JOIN LATERAL generate_series(
        date_bin(INTERVAL '1 day', ordered_limits.full_from,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(INTERVAL '1 day', LEAST(ordered_limits.full_to,
          date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')) - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '1 day'
      ) AS generated(day_start)
      WHERE ordered_limits.full_from < LEAST(ordered_limits.full_to,
        date_bin(INTERVAL '1 day', clock_timestamp(),
          TIMESTAMPTZ '1970-01-01 00:00:00+00'))
    ), pending AS (
      SELECT requested.sensor_id, requested.metric,
        count(*) FILTER (WHERE required.day_start IS NOT NULL AND (
          dirty.sensor_id IS NULL OR generation.sensor_id IS NULL
          OR GREATEST(dirty.current_seq, generation.current_seq) <> dirty.clean_seq
        ))::BIGINT AS pending_days
      FROM requested_series requested
      LEFT JOIN required_days required USING (sensor_id, metric)
      LEFT JOIN ${dirty} dirty
        ON dirty.sensor_id = required.sensor_id AND dirty.metric = required.metric
        AND dirty.day_start = required.day_start
        AND dirty.bucket_seconds = $8::INTEGER
        AND dirty.quality_mask = $7::SMALLINT
        AND dirty.source_scope = CASE WHEN $6::BOOLEAN THEN 'real' ELSE 'all' END
      LEFT JOIN ${generations} generation
        ON generation.sensor_id = required.sensor_id AND generation.metric = required.metric
        AND generation.day_start = required.day_start
      GROUP BY requested.sensor_id, requested.metric
    ), closed_states AS (
      SELECT rollup.sensor_id, rollup.metric, rollup.bucket_start,
        rollup.sample_count, rollup.sum_value, rollup.minimum, rollup.maximum,
        rollup.first_at, rollup.first_source, rollup.first_value,
        rollup.last_at, rollup.last_source, rollup.last_value,
        rollup.internal_positive_delta, rollup.internal_counter_consumption,
        rollup.counter_reset_count, rollup.weighted_value_seconds, rollup.weighted_seconds,
        rollup.maximum_internal_interval_seconds,
        rollup.estimated_sample_count, rollup.stale_sample_count,
        rollup.canonical_unit_min, rollup.canonical_unit_max
      FROM ${rollups} rollup
      JOIN requested_series requested
        ON requested.sensor_id = rollup.sensor_id AND requested.metric = rollup.metric
      JOIN ${dirty} dirty
        ON dirty.sensor_id = rollup.sensor_id AND dirty.metric = rollup.metric
        AND dirty.day_start = rollup.day_start
        AND dirty.bucket_seconds = rollup.bucket_seconds
        AND dirty.quality_mask = rollup.quality_mask
        AND dirty.source_scope = rollup.source_scope
      JOIN ${generations} generation
        ON generation.sensor_id = dirty.sensor_id AND generation.metric = dirty.metric
        AND generation.day_start = dirty.day_start
        AND GREATEST(dirty.current_seq, generation.current_seq) = dirty.clean_seq
        AND rollup.generation = GREATEST(dirty.current_seq, generation.current_seq)
      CROSS JOIN ordered_limits
      WHERE rollup.algorithm_version = ${MEASUREMENT_ORDERED_ROLLUP_VERSION}
        AND rollup.quality_mask = $7::SMALLINT
        AND rollup.source_scope = CASE WHEN $6::BOOLEAN THEN 'real' ELSE 'all' END
        AND rollup.bucket_seconds = $8::INTEGER
        AND rollup.bucket_start >= ordered_limits.full_from
        AND rollup.bucket_start < ordered_limits.full_to
        AND rollup.day_start < date_bin(INTERVAL '1 day', clock_timestamp(),
          TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ), edge_and_current_bucketed AS (
      SELECT sample.*,
        date_bin(make_interval(secs => $8::INTEGER), sample.observed_at,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start
      FROM ${measurements} sample
      JOIN requested_series requested
        ON requested.sensor_id = sample.sensor_id AND requested.metric = sample.metric
      CROSS JOIN ordered_limits
      WHERE sample.observed_at >= $2::TIMESTAMPTZ
        AND sample.observed_at < $3::TIMESTAMPTZ
        AND (sample.observed_at < ordered_limits.full_from
          OR sample.observed_at >= ordered_limits.full_to
          OR sample.observed_at >= date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00'))
        AND sample.quality = ANY($4::TEXT[])
        AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
    ), edge_and_current_deduplicated AS (
      SELECT DISTINCT ON (sensor_id, metric, observed_at) *
      FROM edge_and_current_bucketed
      ORDER BY sensor_id, metric, observed_at, ingested_at DESC, source DESC
    ), edge_and_current_ordered AS (
      SELECT edge_and_current_deduplicated.*,
        lag(value) OVER sequence AS previous_value,
        lead(observed_at) OVER sequence AS next_at
      FROM edge_and_current_deduplicated
      WINDOW sequence AS (PARTITION BY sensor_id, metric, bucket_start ORDER BY observed_at)
    ), edge_and_current_states AS (
      SELECT sensor_id, metric, bucket_start, count(*)::BIGINT AS sample_count,
        sum(value)::DOUBLE PRECISION AS sum_value, min(value)::DOUBLE PRECISION AS minimum,
        max(value)::DOUBLE PRECISION AS maximum, min(observed_at) AS first_at,
        (array_agg(source ORDER BY observed_at, source))[1] AS first_source,
        (array_agg(value ORDER BY observed_at, source))[1]::DOUBLE PRECISION AS first_value,
        max(observed_at) AS last_at,
        (array_agg(source ORDER BY observed_at DESC, source DESC))[1] AS last_source,
        (array_agg(value ORDER BY observed_at DESC, source DESC))[1]::DOUBLE PRECISION AS last_value,
        COALESCE(sum(CASE WHEN previous_value IS NULL OR value < previous_value
          THEN 0 ELSE value - previous_value END), 0)::DOUBLE PRECISION AS internal_positive_delta,
        COALESCE(sum(CASE WHEN previous_value IS NULL THEN 0
          WHEN value >= previous_value THEN value - previous_value
          ELSE GREATEST(0, value) END), 0)::DOUBLE PRECISION AS internal_counter_consumption,
        count(*) FILTER (WHERE previous_value IS NOT NULL AND value < previous_value)::BIGINT AS counter_reset_count,
        COALESCE(sum(value * EXTRACT(EPOCH FROM (next_at - observed_at)))
          FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION AS weighted_value_seconds,
        COALESCE(sum(EXTRACT(EPOCH FROM (next_at - observed_at)))
          FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION AS weighted_seconds,
        COALESCE(max(EXTRACT(EPOCH FROM (next_at - observed_at)))
          FILTER (WHERE next_at IS NOT NULL), 0)::DOUBLE PRECISION AS maximum_internal_interval_seconds,
        count(*) FILTER (WHERE quality = 'estimated')::BIGINT AS estimated_sample_count,
        count(*) FILTER (WHERE quality = 'stale')::BIGINT AS stale_sample_count,
        min(canonical_unit) AS canonical_unit_min, max(canonical_unit) AS canonical_unit_max
      FROM edge_and_current_ordered GROUP BY sensor_id, metric, bucket_start
    ), states AS (
      SELECT * FROM closed_states UNION ALL SELECT * FROM edge_and_current_states
    ), aggregate_all_counts AS (
      SELECT aggregate.sensor_id, aggregate.metric, sum(aggregate.sample_count)::BIGINT AS sample_count
      FROM ${countAggregate} aggregate
      JOIN requested_series requested
        ON requested.sensor_id = aggregate.sensor_id AND requested.metric = aggregate.metric
      CROSS JOIN hour_limits
      WHERE aggregate.bucket_start >= hour_limits.full_from
        AND aggregate.bucket_start < hour_limits.full_to
        AND aggregate.quality IN ('good', 'estimated', 'stale')
        AND (NOT $6::BOOLEAN OR aggregate.source NOT IN ('mock', 'replay'))
      GROUP BY aggregate.sensor_id, aggregate.metric
      UNION ALL
      SELECT sample.sensor_id, sample.metric, count(*)::BIGINT
      FROM ${measurements} sample
      JOIN requested_series requested
        ON requested.sensor_id = sample.sensor_id AND requested.metric = sample.metric
      CROSS JOIN hour_limits
      WHERE sample.observed_at >= $2::TIMESTAMPTZ
        AND sample.observed_at < $3::TIMESTAMPTZ
        AND (sample.observed_at < hour_limits.full_from OR sample.observed_at >= hour_limits.full_to)
        AND sample.quality IN ('good', 'estimated', 'stale')
        AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
      GROUP BY sample.sensor_id, sample.metric
    ), raw_count_bounds AS (
      SELECT requested.sensor_id, requested.metric,
        first_sample.observed_at AS first_at, last_sample.observed_at AS last_at
      FROM requested_series requested
      CROSS JOIN hour_limits
      LEFT JOIN LATERAL (
        SELECT sample.observed_at FROM ${measurements} sample
        WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
          AND sample.observed_at >= hour_limits.full_from AND sample.observed_at < hour_limits.full_to
          AND sample.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.observed_at ASC LIMIT 1
      ) first_sample ON TRUE
      LEFT JOIN LATERAL (
        SELECT sample.observed_at FROM ${measurements} sample
        WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
          AND sample.observed_at >= hour_limits.full_from AND sample.observed_at < hour_limits.full_to
          AND sample.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.observed_at DESC LIMIT 1
      ) last_sample ON TRUE
    ), aggregate_count_bounds AS (
      SELECT requested.sensor_id, requested.metric,
        first_bucket.bucket_start AS first_bucket, last_bucket.bucket_start AS last_bucket
      FROM requested_series requested
      CROSS JOIN hour_limits
      LEFT JOIN LATERAL (
        SELECT aggregate.bucket_start FROM ${countAggregate} aggregate
        WHERE aggregate.sensor_id = requested.sensor_id AND aggregate.metric = requested.metric
          AND aggregate.bucket_start >= hour_limits.full_from AND aggregate.bucket_start < hour_limits.full_to
          AND aggregate.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR aggregate.source NOT IN ('mock', 'replay'))
        ORDER BY aggregate.bucket_start ASC LIMIT 1
      ) first_bucket ON TRUE
      LEFT JOIN LATERAL (
        SELECT aggregate.bucket_start FROM ${countAggregate} aggregate
        WHERE aggregate.sensor_id = requested.sensor_id AND aggregate.metric = requested.metric
          AND aggregate.bucket_start >= hour_limits.full_from AND aggregate.bucket_start < hour_limits.full_to
          AND aggregate.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR aggregate.source NOT IN ('mock', 'replay'))
        ORDER BY aggregate.bucket_start DESC LIMIT 1
      ) last_bucket ON TRUE
    ), count_coverage AS (
      SELECT aggregate.sensor_id, aggregate.metric, raw.first_at IS NULL OR (
        aggregate.first_bucket <= date_bin(INTERVAL '1 hour', raw.first_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
        AND aggregate.last_bucket >= date_bin(INTERVAL '1 hour', raw.last_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
      ) AS complete
      FROM raw_count_bounds raw
      JOIN aggregate_count_bounds aggregate USING (sensor_id, metric)
    ), series_counts AS (
      SELECT requested.sensor_id, requested.metric, requested.aggregation,
        COALESCE(min(states.canonical_unit_min), '') AS canonical_unit,
        COALESCE(max(states.canonical_unit_max), '') AS canonical_unit_max,
        COALESCE(sum(states.sample_count), 0)::BIGINT AS included_sample_count,
        GREATEST(0, COALESCE((SELECT sum(aggregate_all_counts.sample_count) FROM aggregate_all_counts
          WHERE aggregate_all_counts.sensor_id = requested.sensor_id
            AND aggregate_all_counts.metric = requested.metric), 0)
          - COALESCE(sum(states.sample_count), 0))::BIGINT AS excluded_sample_count,
        GREATEST(1.0, EXTRACT(EPOCH FROM ($3::TIMESTAMPTZ - $2::TIMESTAMPTZ))
          / GREATEST(1, COALESCE(sum(states.sample_count), 0)))::DOUBLE PRECISION AS cadence_seconds,
        COALESCE(pending.pending_days, 0) = 0 AND bool_and(count_coverage.complete) AS coverage_complete
      FROM requested_series requested
      JOIN pending USING (sensor_id, metric)
      JOIN count_coverage USING (sensor_id, metric)
      LEFT JOIN states ON states.sensor_id = requested.sensor_id AND states.metric = requested.metric
      GROUP BY requested.sensor_id, requested.metric, requested.aggregation, pending.pending_days
    ), sequenced AS (
      SELECT states.*,
        date_bin($5::INTERVAL, states.bucket_start, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS target_bucket,
        lag(states.last_at) OVER sequence AS previous_last_at,
        lag(states.last_value) OVER sequence AS previous_last_value,
        lead(states.first_at) OVER sequence AS next_first_at,
        lag(date_bin($5::INTERVAL, states.bucket_start, TIMESTAMPTZ '1970-01-01 00:00:00+00')) OVER sequence AS previous_target_bucket,
        row_number() OVER (
          PARTITION BY states.sensor_id, states.metric,
            date_bin($5::INTERVAL, states.bucket_start, TIMESTAMPTZ '1970-01-01 00:00:00+00')
          ORDER BY states.bucket_start DESC
        ) AS reverse_bucket_row
      FROM states WINDOW sequence AS (PARTITION BY sensor_id, metric ORDER BY bucket_start)
    ), observed_bucket_aggregates AS (
      SELECT sequenced.sensor_id, sequenced.metric, sequenced.target_bucket AS bucket_start,
        sum(sequenced.sample_count)::BIGINT AS bucket_sample_count,
        sum(sequenced.sum_value)::DOUBLE PRECISION AS sum_value,
        min(sequenced.minimum)::DOUBLE PRECISION AS minimum,
        max(sequenced.maximum)::DOUBLE PRECISION AS maximum,
        (array_agg(sequenced.last_value ORDER BY sequenced.last_at DESC, sequenced.last_source DESC))[1]::DOUBLE PRECISION AS last_value,
        sum(sequenced.internal_positive_delta + CASE
          WHEN sequenced.previous_last_value IS NULL OR sequenced.first_value < sequenced.previous_last_value THEN 0
          ELSE sequenced.first_value - sequenced.previous_last_value END)::DOUBLE PRECISION AS delta_value,
        sum(sequenced.counter_reset_count + CASE WHEN sequenced.previous_last_value IS NOT NULL
          AND sequenced.first_value < sequenced.previous_last_value THEN 1 ELSE 0 END)::BIGINT AS counter_reset_count,
        sum(sequenced.estimated_sample_count)::BIGINT AS estimated_sample_count,
        sum(sequenced.stale_sample_count)::BIGINT AS stale_sample_count,
        sum(sequenced.weighted_value_seconds + CASE
          WHEN sequenced.previous_target_bucket = sequenced.target_bucket THEN
            sequenced.previous_last_value * LEAST(
              GREATEST(EXTRACT(EPOCH FROM (sequenced.first_at - sequenced.previous_last_at)), 0),
              counts.cadence_seconds * 1.5)
          ELSE 0 END + CASE WHEN sequenced.reverse_bucket_row = 1 THEN
            sequenced.last_value * LEAST(
              GREATEST(EXTRACT(EPOCH FROM (sequenced.target_bucket + $5::INTERVAL - sequenced.last_at)), 0),
              counts.cadence_seconds * 1.5)
          ELSE 0 END)::DOUBLE PRECISION AS weighted_value_seconds,
        sum(sequenced.weighted_seconds + CASE
          WHEN sequenced.previous_target_bucket = sequenced.target_bucket THEN LEAST(
            GREATEST(EXTRACT(EPOCH FROM (sequenced.first_at - sequenced.previous_last_at)), 0),
            counts.cadence_seconds * 1.5)
          ELSE 0 END + CASE WHEN sequenced.reverse_bucket_row = 1 THEN LEAST(
            GREATEST(EXTRACT(EPOCH FROM (sequenced.target_bucket + $5::INTERVAL - sequenced.last_at)), 0),
            counts.cadence_seconds * 1.5)
          ELSE 0 END)::DOUBLE PRECISION AS weighted_seconds
      FROM sequenced JOIN series_counts counts USING (sensor_id, metric)
      GROUP BY sequenced.sensor_id, sequenced.metric, sequenced.target_bucket
    ), consumption_boundaries AS (
      -- Index seeks provide consumption anchors without adding out-of-range
      -- observations to sample counts, extrema or ordinary rollup values.
      SELECT requested.sensor_id, requested.metric,
        opening.observed_at AS opening_at, opening.value AS opening_value,
        closing.value AS closing_value,
        COALESCE(last_state.last_at, opening.observed_at) AS closing_previous_at,
        COALESCE(last_state.last_value, opening.value) AS closing_previous_value,
        (SELECT min(first_at) FROM states
          WHERE states.sensor_id = requested.sensor_id AND states.metric = requested.metric) AS first_at
      FROM requested_series requested
      LEFT JOIN LATERAL (
        SELECT observed_at, value FROM ${measurements} sample
        WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
          AND sample.observed_at < $2::TIMESTAMPTZ AND sample.quality = ANY($4::TEXT[])
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock','replay'))
        ORDER BY observed_at DESC, ingested_at DESC, source DESC LIMIT 1
      ) opening ON TRUE
      LEFT JOIN LATERAL (
        SELECT value FROM ${measurements} sample
        WHERE requested.metric = 'energy' AND sample.sensor_id = requested.sensor_id
          AND sample.metric = requested.metric AND sample.observed_at = $3::TIMESTAMPTZ
          AND sample.quality = ANY($4::TEXT[])
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock','replay'))
        ORDER BY ingested_at DESC, source DESC LIMIT 1
      ) closing ON TRUE
      LEFT JOIN LATERAL (
        SELECT last_at, last_value FROM states
        WHERE states.sensor_id = requested.sensor_id AND states.metric = requested.metric
        ORDER BY last_at DESC LIMIT 1
      ) last_state ON TRUE
      WHERE requested.metric IN ('energy','power')
    ), consumption_sequenced AS (
      SELECT sequenced.*,
        COALESCE(previous_last_at, boundary.opening_at) AS consumption_previous_at,
        COALESCE(previous_last_value, boundary.opening_value) AS consumption_previous_value
      FROM sequenced JOIN consumption_boundaries boundary USING (sensor_id,metric)
    ), consumption_parts AS (
      -- Counter increments are retained before any averaging, including resets
      -- within a stored bucket. Power uses <=15-minute states and a bounded
      -- last-value hold; its tails are split across display bucket boundaries.
      SELECT sensor_id, metric, target_bucket AS bucket_start,
        CASE WHEN metric = 'energy' THEN internal_counter_consumption + CASE
          WHEN consumption_previous_value IS NULL THEN 0
          WHEN first_value >= consumption_previous_value THEN first_value - consumption_previous_value
          ELSE GREATEST(0, first_value) END * COALESCE(
            EXTRACT(EPOCH FROM (first_at - GREATEST(consumption_previous_at, $2::TIMESTAMPTZ)))
              / NULLIF(EXTRACT(EPOCH FROM (first_at - consumption_previous_at)), 0), 0)
          WHEN minimum < 0 THEN NULL
          ELSE weighted_value_seconds / 3600000.0 END AS consumption_kwh
      FROM consumption_sequenced WHERE metric IN ('energy', 'power')
      UNION ALL
      SELECT sensor_id, metric,
        date_bin($5::INTERVAL, $3::TIMESTAMPTZ - INTERVAL '1 microsecond', TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        CASE WHEN closing_value >= closing_previous_value THEN closing_value - closing_previous_value
          ELSE closing_value END * EXTRACT(EPOCH FROM (
            $3::TIMESTAMPTZ - GREATEST(closing_previous_at, $2::TIMESTAMPTZ)
          )) / EXTRACT(EPOCH FROM ($3::TIMESTAMPTZ - closing_previous_at))
      FROM consumption_boundaries WHERE metric = 'energy'
        AND closing_value >= 0 AND closing_previous_value >= 0 AND closing_previous_at < $3::TIMESTAMPTZ
      UNION ALL
      SELECT boundary.sensor_id, boundary.metric, bucket.bucket_start,
        CASE WHEN opening_value < 0 THEN NULL ELSE opening_value * EXTRACT(EPOCH FROM (
          LEAST(hold.end_at, bucket.bucket_start + $5::INTERVAL)
            - GREATEST($2::TIMESTAMPTZ, bucket.bucket_start)
        )) / 3600000.0 END
      FROM consumption_boundaries boundary
      CROSS JOIN LATERAL (SELECT LEAST(COALESCE(first_at, $3::TIMESTAMPTZ),
        $3::TIMESTAMPTZ, opening_at + INTERVAL '15 minutes') AS end_at) hold
      CROSS JOIN LATERAL generate_series(
        date_bin($5::INTERVAL, $2::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin($5::INTERVAL, hold.end_at - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'), $5::INTERVAL
      ) AS bucket(bucket_start)
      WHERE boundary.metric = 'power' AND boundary.opening_at IS NOT NULL
        AND hold.end_at > $2::TIMESTAMPTZ
      UNION ALL
      SELECT state.sensor_id, state.metric, bucket.bucket_start,
        CASE WHEN state.last_value < 0 THEN NULL ELSE state.last_value * EXTRACT(EPOCH FROM (
          LEAST(hold.end_at, bucket.bucket_start + $5::INTERVAL)
          - GREATEST(state.last_at, bucket.bucket_start)
        )) / 3600000.0 END
      FROM sequenced state
      CROSS JOIN LATERAL (SELECT LEAST(
        COALESCE(state.next_first_at, $3::TIMESTAMPTZ),
        $3::TIMESTAMPTZ, state.last_at + INTERVAL '15 minutes'
      ) AS end_at) hold
      CROSS JOIN LATERAL generate_series(
        date_bin($5::INTERVAL, state.last_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin($5::INTERVAL, hold.end_at - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'), $5::INTERVAL
      ) AS bucket(bucket_start)
      WHERE state.metric = 'power' AND hold.end_at > state.last_at
    ), consumption_buckets AS (
      SELECT sensor_id, metric, bucket_start,
        -- A signed stored integral cannot recover positive-only usage. Do not
        -- silently sum its remaining positive parts into a plausible total.
        CASE WHEN bool_or(consumption_kwh IS NULL) THEN NULL
          ELSE sum(consumption_kwh) END::DOUBLE PRECISION AS consumption_kwh
      FROM consumption_parts GROUP BY sensor_id, metric, bucket_start
    ), bucket_aggregates AS (
      SELECT COALESCE(observed.sensor_id, consumption.sensor_id) AS sensor_id,
        COALESCE(observed.metric, consumption.metric) AS metric,
        COALESCE(observed.bucket_start, consumption.bucket_start) AS bucket_start,
        observed.bucket_sample_count, observed.sum_value, observed.minimum,
        observed.maximum, observed.last_value, observed.delta_value,
        observed.counter_reset_count, observed.estimated_sample_count,
        observed.stale_sample_count, observed.weighted_value_seconds,
        observed.weighted_seconds, consumption.consumption_kwh
      FROM observed_bucket_aggregates observed
      FULL JOIN consumption_buckets consumption USING (sensor_id, metric, bucket_start)
    )
    SELECT counts.sensor_id, counts.metric, counts.canonical_unit,
      counts.canonical_unit = counts.canonical_unit_max AS unit_consistent,
      counts.coverage_complete, counts.included_sample_count, counts.excluded_sample_count,
      counts.cadence_seconds, buckets.bucket_start,
      CASE counts.aggregation
        WHEN 'mean' THEN buckets.sum_value / NULLIF(buckets.bucket_sample_count, 0)
        WHEN 'sum' THEN buckets.sum_value
        WHEN 'delta' THEN buckets.delta_value
        WHEN 'last' THEN buckets.last_value
        WHEN 'time_weighted_mean' THEN COALESCE(
          buckets.weighted_value_seconds / NULLIF(buckets.weighted_seconds, 0), buckets.last_value)
        WHEN 'min' THEN buckets.minimum
        WHEN 'max' THEN buckets.maximum
      END::DOUBLE PRECISION AS rollup_value,
      buckets.minimum, buckets.maximum, buckets.bucket_sample_count,
      buckets.estimated_sample_count, buckets.stale_sample_count, buckets.counter_reset_count,
      buckets.consumption_kwh
    FROM series_counts counts
    LEFT JOIN bucket_aggregates buckets USING (sensor_id, metric)
    ORDER BY counts.sensor_id, counts.metric, buckets.bucket_start`;
}
