import { measurementAnalyticsAggregateName, qualifiedName } from "../schema.js";
import { measurementSeriesBoundsSql } from "./measurement-series-bounds-sql.js";
import { MEASUREMENT_ORDERED_ROLLUP_VERSION } from "./methods/measurement-ordered-rollups.js";

function cachedOrderedRanges(schema: string): string {
  const dirty = qualifiedName(schema, "measurement_ordered_rollup_dirty");
  const generations = qualifiedName(schema, "measurement_ordered_rollup_generations");
  const rollups = qualifiedName(schema, "measurement_ordered_rollups");
  return `ordered_bounds AS (
      SELECT date_bin(make_interval(secs => $8::INTEGER), $2::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin(make_interval(secs => $8::INTEGER), $3::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), ordered_limits AS (
      SELECT CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + make_interval(secs => $8::INTEGER) END AS full_from,
        to_bucket AS full_to
      FROM ordered_bounds
    ), measurement_bounds AS (${measurementSeriesBoundsSql(schema, {
      requested: "requested_series", until: "$3::TIMESTAMPTZ",
      qualities: "$4::TEXT[]", excludeSynthetic: "$6::BOOLEAN",
    })}
    ), history_limits AS (
      SELECT bounds.sensor_id, bounds.metric,
        GREATEST(ordered_limits.full_from, bounds.first_at) AS history_from,
        LEAST(ordered_limits.full_to,
          bounds.last_at + CASE WHEN bounds.metric = 'power' THEN INTERVAL '15 minutes' ELSE INTERVAL '0' END
            + INTERVAL '1 microsecond',
          date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')) AS history_to
      FROM measurement_bounds bounds
      CROSS JOIN ordered_limits
      WHERE bounds.first_at IS NOT NULL AND bounds.last_at IS NOT NULL
    ), required_days AS (
      SELECT requested.sensor_id, requested.metric, generated.day_start
      FROM history_limits requested
      CROSS JOIN LATERAL generate_series(
        date_bin(INTERVAL '1 day', requested.history_from,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(INTERVAL '1 day', requested.history_to - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '1 day'
      ) AS generated(day_start)
      WHERE requested.history_from < requested.history_to
    ), pending AS (
      SELECT requested.sensor_id, requested.metric,
        count(*) FILTER (WHERE required.day_start IS NOT NULL AND (
          dirty.sensor_id IS NULL OR generation.sensor_id IS NULL
          OR GREATEST(dirty.current_seq, generation.current_seq) <> dirty.clean_seq
          OR dirty.sealed_until IS NOT NULL
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
    ), preparation AS MATERIALIZED (
      -- The enqueue prepares every day this read needs, plus the active day
      -- once history reaches it so the worker can seal it. When those
      -- variants already exist and are clean, the caller skips that write.
      -- Materialized for the reason given at count_coverage.
      SELECT pending.sensor_id, pending.metric, pending.pending_days > 0 OR (
          bounds.first_at IS NOT NULL AND bounds.last_at IS NOT NULL
          AND LEAST($3::TIMESTAMPTZ,
            bounds.last_at + CASE WHEN bounds.metric = 'power' THEN INTERVAL '15 minutes' ELSE INTERVAL '0' END
              + INTERVAL '1 microsecond',
            date_bin(INTERVAL '1 day', clock_timestamp(),
              TIMESTAMPTZ '1970-01-01 00:00:00+00') + INTERVAL '1 day')
            > GREATEST($2::TIMESTAMPTZ, bounds.first_at, date_bin(INTERVAL '1 day', clock_timestamp(),
              TIMESTAMPTZ '1970-01-01 00:00:00+00'))
          AND NOT EXISTS (
            SELECT 1 FROM ${dirty} dirty
            WHERE dirty.sensor_id = bounds.sensor_id AND dirty.metric = bounds.metric
              AND dirty.day_start = date_bin(INTERVAL '1 day', clock_timestamp(),
                TIMESTAMPTZ '1970-01-01 00:00:00+00')
              AND dirty.bucket_seconds = $8::INTEGER
              AND dirty.quality_mask = $7::SMALLINT
              AND dirty.source_scope = CASE WHEN $6::BOOLEAN THEN 'real' ELSE 'all' END
          )
        ) AS required
      FROM pending
      JOIN measurement_bounds bounds USING (sensor_id, metric)
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
      FROM requested_series requested
      CROSS JOIN ordered_limits
      -- OFFSET 0 keeps each series/range read parameterized so compressed
      -- chunks can be pruned before joining generation metadata.
      CROSS JOIN LATERAL (
        SELECT rollup.* FROM ${rollups} rollup
        WHERE rollup.sensor_id = requested.sensor_id AND rollup.metric = requested.metric
          AND rollup.algorithm_version = ${MEASUREMENT_ORDERED_ROLLUP_VERSION}
          AND rollup.quality_mask = $7::SMALLINT
          AND rollup.source_scope = CASE WHEN $6::BOOLEAN THEN 'real' ELSE 'all' END
          AND rollup.bucket_seconds = $8::INTEGER
          AND rollup.bucket_start >= ordered_limits.full_from
          AND rollup.bucket_start < ordered_limits.full_to
          AND rollup.day_start <= date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')
        OFFSET 0
      ) rollup
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
        -- A past day needs whole-day states; the active day's sealed states
        -- cover only buckets that closed before its seal.
        AND CASE WHEN dirty.day_start < date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')
          THEN dirty.sealed_until IS NULL
          ELSE rollup.bucket_start + make_interval(secs => $8::INTEGER) <= dirty.sealed_until END
    ), active_seals AS (
      SELECT requested.sensor_id, requested.metric, (
        SELECT dirty.sealed_until FROM ${dirty} dirty
        JOIN ${generations} generation
          ON generation.sensor_id = dirty.sensor_id AND generation.metric = dirty.metric
          AND generation.day_start = dirty.day_start
        WHERE dirty.sensor_id = requested.sensor_id AND dirty.metric = requested.metric
          AND dirty.day_start = date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')
          AND dirty.bucket_seconds = $8::INTEGER
          AND dirty.quality_mask = $7::SMALLINT
          AND dirty.source_scope = CASE WHEN $6::BOOLEAN THEN 'real' ELSE 'all' END
          AND dirty.sealed_until IS NOT NULL
          AND GREATEST(dirty.current_seq, generation.current_seq) = dirty.clean_seq
      ) AS sealed_until
      FROM requested_series requested
    ), edge_and_current_ranges AS (
      -- Disjoint windows keep the raw read limited to the two partial buckets
      -- and the active day's open tail. An OR over the complete history
      -- prevents Timescale from pruning historical chunks before applying the
      -- boundary filter.
      SELECT seal.sensor_id, seal.metric, $2::TIMESTAMPTZ AS raw_from,
        LEAST(ordered_limits.full_from, ordered_limits.full_to, $3::TIMESTAMPTZ) AS raw_to
      FROM ordered_limits CROSS JOIN active_seals seal
      UNION ALL
      SELECT seal.sensor_id, seal.metric, GREATEST(ordered_limits.full_from, $2::TIMESTAMPTZ,
          COALESCE(seal.sealed_until, date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00'))),
        LEAST(ordered_limits.full_to, $3::TIMESTAMPTZ)
      FROM ordered_limits CROSS JOIN active_seals seal
      UNION ALL
      SELECT seal.sensor_id, seal.metric, GREATEST(ordered_limits.full_to, $2::TIMESTAMPTZ), $3::TIMESTAMPTZ
      FROM ordered_limits CROSS JOIN active_seals seal
    )`;
}

function cachedOrderedCounts(schema: string): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const countAggregate = qualifiedName(schema, measurementAnalyticsAggregateName("1h"));
  return `hour_bounds AS (
      SELECT date_bin(INTERVAL '1 hour', $2::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin(INTERVAL '1 hour', $3::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), hour_limits AS (
      SELECT CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + INTERVAL '1 hour' END AS full_from,
        to_bucket AS full_to
      FROM hour_bounds
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
    ), count_limits AS (
      -- Hours counted from the 1h aggregate. Past days count whole once
      -- count_coverage confirms both ends. The active day counts up to the
      -- newest materialized bucket, which stays raw because it may have been
      -- materialized before its last observation arrived; as on past days,
      -- this relies on contiguous aggregate refresh windows.
      SELECT bounds.sensor_id, bounds.metric, hour_limits.full_from,
        CASE WHEN bounds.last_bucket >= date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00') THEN bounds.last_bucket
          ELSE LEAST(hour_limits.full_to, date_bin(INTERVAL '1 day', clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00')) END AS full_to
      FROM aggregate_count_bounds bounds
      CROSS JOIN hour_limits
    ), hour_count_ranges AS (
      SELECT limits.sensor_id, limits.metric, $2::TIMESTAMPTZ AS raw_from,
        LEAST(limits.full_from, limits.full_to, $3::TIMESTAMPTZ) AS raw_to
      FROM count_limits limits
      UNION ALL
      SELECT limits.sensor_id, limits.metric, GREATEST(limits.full_to, $2::TIMESTAMPTZ), $3::TIMESTAMPTZ
      FROM count_limits limits
    ), excluded_counts AS (
      -- Rows outside the quality filter, counted as stored like every other
      -- path does; included states are de-duplicated, so subtracting them
      -- from a stored total would report repeated readings as exclusions.
      SELECT aggregate.sensor_id, aggregate.metric,
        COALESCE(sum(aggregate.sample_count) FILTER (WHERE NOT (aggregate.quality = ANY($4::TEXT[]))), 0)::BIGINT AS sample_count
      FROM ${countAggregate} aggregate
      JOIN count_limits limits
        ON limits.sensor_id = aggregate.sensor_id AND limits.metric = aggregate.metric
      WHERE aggregate.bucket_start >= limits.full_from
        AND aggregate.bucket_start < limits.full_to
        AND aggregate.quality IN ('good', 'estimated', 'stale')
        AND (NOT $6::BOOLEAN OR aggregate.source NOT IN ('mock', 'replay'))
      GROUP BY aggregate.sensor_id, aggregate.metric
      UNION ALL
      SELECT sample.sensor_id, sample.metric,
        count(*) FILTER (WHERE NOT (sample.quality = ANY($4::TEXT[])))::BIGINT
      FROM hour_count_ranges boundary
      CROSS JOIN LATERAL (
        SELECT sample.* FROM ${measurements} sample
        WHERE sample.sensor_id = boundary.sensor_id AND sample.metric = boundary.metric
          AND sample.observed_at >= boundary.raw_from AND sample.observed_at < boundary.raw_to
          AND sample.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        OFFSET 0
      ) sample
      WHERE boundary.raw_from < boundary.raw_to
      GROUP BY sample.sensor_id, sample.metric
    ), raw_count_bounds AS (
      SELECT limits.sensor_id, limits.metric,
        first_sample.observed_at AS first_at, last_sample.observed_at AS last_at
      FROM count_limits limits
      LEFT JOIN LATERAL (
        SELECT sample.observed_at FROM ${measurements} sample
        WHERE sample.sensor_id = limits.sensor_id AND sample.metric = limits.metric
          AND sample.observed_at >= limits.full_from AND sample.observed_at < limits.full_to
          AND sample.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.observed_at ASC LIMIT 1
      ) first_sample ON TRUE
      LEFT JOIN LATERAL (
        SELECT sample.observed_at FROM ${measurements} sample
        WHERE sample.sensor_id = limits.sensor_id AND sample.metric = limits.metric
          AND sample.observed_at >= limits.full_from AND sample.observed_at < limits.full_to
          AND sample.quality IN ('good', 'estimated', 'stale')
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ORDER BY sample.observed_at DESC LIMIT 1
      ) last_sample ON TRUE
    ), count_coverage AS MATERIALIZED (
      -- Materialized so its per-series seeks run once per series. Inlined,
      -- PostgreSQL may join it after the states and repeat both raw seeks for
      -- every stored state (25 s instead of 4 s for 30 days on a Pi).
      SELECT aggregate.sensor_id, aggregate.metric, raw.first_at IS NULL OR (
        aggregate.first_bucket <= date_bin(INTERVAL '1 hour', raw.first_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
        AND aggregate.last_bucket >= date_bin(INTERVAL '1 hour', raw.last_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
      ) AS complete
      FROM raw_count_bounds raw
      JOIN aggregate_count_bounds aggregate USING (sensor_id, metric)
    )`;
}

/** Explicit mode only trusts observations that carry that mode, including boundary reads. */
export function orderedAnalyticsSources(schema: string, verifiedMode: boolean) {
  if (!verifiedMode) {
    return {
      modeFilter: "",
      ranges: cachedOrderedRanges(schema),
      cachedStates: "SELECT * FROM closed_states UNION ALL ",
      counts: cachedOrderedCounts(schema),
      coverage: "COALESCE(pending.pending_days, 0) = 0 AND bool_and(count_coverage.complete) AS coverage_complete, preparation.required AS preparation_required",
      coverageJoins: "JOIN pending USING (sensor_id, metric) JOIN preparation USING (sensor_id, metric) JOIN count_coverage USING (sensor_id, metric)",
      coverageGroup: ", pending.pending_days, preparation.required",
    };
  }
  const measurements = qualifiedName(schema, "measurement_samples");
  const modeFilter = "AND sample.data_mode = $7::TEXT";
  return {
    modeFilter,
    ranges: `edge_and_current_ranges AS (
      SELECT sensor_id, metric, $2::TIMESTAMPTZ AS raw_from, $3::TIMESTAMPTZ AS raw_to
      FROM requested_series
    )`,
    cachedStates: "",
    counts: `excluded_counts AS (
      SELECT sample.sensor_id, sample.metric, count(*)::BIGINT AS sample_count
      FROM requested_series requested
      JOIN ${measurements} sample USING (sensor_id, metric)
      WHERE sample.observed_at >= $2::TIMESTAMPTZ AND sample.observed_at < $3::TIMESTAMPTZ
        AND sample.quality IN ('good', 'estimated', 'stale') AND NOT (sample.quality = ANY($4::TEXT[]))
        AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
        ${modeFilter}
      GROUP BY sample.sensor_id, sample.metric
    )`,
    coverage: "TRUE AS coverage_complete, FALSE AS preparation_required",
    coverageJoins: "",
    coverageGroup: "",
  };
}
