import { qualifiedName } from "../schema.js";
import { MEASUREMENT_ORDERED_ROLLUP_VERSION } from "./methods/measurement-ordered-rollups.js";

type CostMetric = "energy" | "power";

/**
 * Builds an exact adaptive time axis. Price-stable hours use hourly states,
 * hours cut by a price edge fall back to 15-minute states, and only affected
 * quarters fall back to minute states. Partial minutes, the active UTC day,
 * and off-minute price edges stay raw.
 */
function costPlanningCtes(schema: string): string {
  const prices = qualifiedName(schema, "electricity_price_samples");
  return `latest_prices AS (
      (SELECT DISTINCT ON (starts_at)
        starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh
      FROM ${prices}
      WHERE property_id = $4
        AND starts_at >= $2::TIMESTAMPTZ AND starts_at < $3::TIMESTAMPTZ
        AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
      ORDER BY starts_at, ingested_at DESC, source DESC)
      UNION ALL
      (SELECT starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh
      FROM ${prices}
      WHERE property_id = $4 AND starts_at < $2::TIMESTAMPTZ
        AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
      ORDER BY starts_at DESC, ingested_at DESC, source DESC LIMIT 1)
    ), price_intervals AS (
      SELECT starts_at,
        LEAST(ends_at, COALESCE(lead(starts_at) OVER (ORDER BY starts_at), ends_at)) AS ends_at,
        raw_price_cents_per_kwh, margin_cents_per_kwh
      FROM latest_prices
    ), query_price_intervals AS (
      SELECT GREATEST(starts_at, $2::TIMESTAMPTZ) AS starts_at,
        LEAST(ends_at, $3::TIMESTAMPTZ) AS ends_at,
        raw_price_cents_per_kwh, margin_cents_per_kwh
      FROM price_intervals
      WHERE starts_at < $3::TIMESTAMPTZ AND ends_at > $2::TIMESTAMPTZ
    ), price_hour_slices AS MATERIALIZED (
      SELECT hour.hour_start,
        GREATEST(price.starts_at, hour.hour_start) AS slice_start,
        LEAST(price.ends_at, hour.hour_start + INTERVAL '1 hour') AS slice_end,
        price.raw_price_cents_per_kwh, price.margin_cents_per_kwh
      FROM query_price_intervals price
      CROSS JOIN LATERAL generate_series(
        date_bin(INTERVAL '1 hour', price.starts_at,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(INTERVAL '1 hour', price.ends_at - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '1 hour'
      ) AS hour(hour_start)
    ), price_boundaries AS (
      SELECT starts_at AS boundary_at FROM price_intervals
      UNION SELECT ends_at FROM price_intervals
    ), minute_bounds AS (
      SELECT date_bin(INTERVAL '1 minute', $2::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
        date_bin(INTERVAL '1 minute', $3::TIMESTAMPTZ,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
    ), limits AS (
      SELECT from_bucket, to_bucket,
        CASE WHEN from_bucket = $2::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + INTERVAL '1 minute' END AS full_from,
        to_bucket AS full_to
      FROM minute_bounds
    ), raw_ranges AS (
      SELECT from_bucket AS range_start,
        LEAST(full_from, $3::TIMESTAMPTZ + INTERVAL '1 microsecond') AS range_end
      FROM limits WHERE $2::TIMESTAMPTZ < full_from
      UNION ALL
      SELECT full_to, $3::TIMESTAMPTZ + INTERVAL '1 microsecond'
      FROM limits WHERE full_to <= $3::TIMESTAMPTZ
      UNION ALL
      SELECT GREATEST($2::TIMESTAMPTZ, date_bin(INTERVAL '1 day', clock_timestamp(),
          TIMESTAMPTZ '1970-01-01 00:00:00+00')),
        $3::TIMESTAMPTZ + INTERVAL '1 microsecond'
      WHERE $3::TIMESTAMPTZ >= date_bin(INTERVAL '1 day', clock_timestamp(),
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
      UNION ALL
      SELECT GREATEST(date_bin(INTERVAL '1 minute', boundary_at,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'), $2::TIMESTAMPTZ),
        LEAST(date_bin(INTERVAL '1 minute', boundary_at,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') + INTERVAL '1 minute',
          $3::TIMESTAMPTZ + INTERVAL '1 microsecond')
      FROM price_boundaries
      WHERE boundary_at > $2::TIMESTAMPTZ AND boundary_at < $3::TIMESTAMPTZ
        AND boundary_at <> date_bin(INTERVAL '1 minute', boundary_at,
          TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ), hour_boundary_units AS (
      SELECT DISTINCT date_bin(INTERVAL '1 hour', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00') AS unit_start
      FROM price_boundaries
      WHERE boundary_at <> date_bin(INTERVAL '1 hour', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ), quarter_boundary_units AS (
      SELECT DISTINCT date_bin(INTERVAL '15 minutes', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00') AS unit_start
      FROM price_boundaries
      WHERE boundary_at <> date_bin(INTERVAL '15 minutes', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ), minute_boundary_units AS (
      SELECT DISTINCT date_bin(INTERVAL '1 minute', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00') AS unit_start
      FROM price_boundaries
      WHERE boundary_at <> date_bin(INTERVAL '1 minute', boundary_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ), hour_slots AS (
      SELECT slot.unit_start
      FROM limits
      CROSS JOIN LATERAL generate_series(
        CASE WHEN date_bin(INTERVAL '1 hour', full_from,
            TIMESTAMPTZ '1970-01-01 00:00:00+00') = full_from THEN full_from
          ELSE date_bin(INTERVAL '1 hour', full_from,
            TIMESTAMPTZ '1970-01-01 00:00:00+00') + INTERVAL '1 hour' END,
        date_bin(INTERVAL '1 hour', full_to - INTERVAL '1 hour',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '1 hour'
      ) AS slot(unit_start)
      WHERE full_to - full_from >= INTERVAL '1 hour'
    ), hour_units AS (
      SELECT slot.unit_start
      FROM hour_slots slot
      LEFT JOIN hour_boundary_units boundary USING (unit_start)
      WHERE boundary.unit_start IS NULL AND NOT EXISTS (
        SELECT 1 FROM raw_ranges range
        WHERE range.range_start < slot.unit_start + INTERVAL '1 hour'
          AND range.range_end > slot.unit_start
      )
    ), quarter_windows AS (
      SELECT slot.unit_start
      FROM limits
      CROSS JOIN LATERAL generate_series(
        date_bin(INTERVAL '15 minutes', full_from,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(INTERVAL '15 minutes', full_to - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '15 minutes'
      ) AS slot(unit_start)
      WHERE full_to > full_from
    ), quarter_units AS (
      SELECT slot.unit_start
      FROM quarter_windows slot
      CROSS JOIN limits
      LEFT JOIN quarter_boundary_units boundary USING (unit_start)
      LEFT JOIN hour_units parent ON parent.unit_start = date_bin(INTERVAL '1 hour', slot.unit_start,
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
      WHERE parent.unit_start IS NULL AND boundary.unit_start IS NULL
        AND slot.unit_start >= limits.full_from
        AND slot.unit_start + INTERVAL '15 minutes' <= limits.full_to
        AND NOT EXISTS (
          SELECT 1 FROM raw_ranges range
          WHERE range.range_start < slot.unit_start + INTERVAL '15 minutes'
            AND range.range_end > slot.unit_start
        )
    ), quarter_gaps AS (
      SELECT quarter_window.unit_start
      FROM quarter_windows quarter_window
      LEFT JOIN hour_units hour ON hour.unit_start = date_bin(INTERVAL '1 hour', quarter_window.unit_start,
        TIMESTAMPTZ '1970-01-01 00:00:00+00')
      LEFT JOIN quarter_units quarter ON quarter.unit_start = quarter_window.unit_start
      WHERE hour.unit_start IS NULL AND quarter.unit_start IS NULL
    ), minute_units AS (
      SELECT minute.unit_start
      FROM quarter_gaps gap
      CROSS JOIN LATERAL generate_series(
        gap.unit_start, gap.unit_start + INTERVAL '14 minutes', INTERVAL '1 minute'
      ) AS minute(unit_start)
      CROSS JOIN limits
      LEFT JOIN minute_boundary_units boundary ON boundary.unit_start = minute.unit_start
      WHERE boundary.unit_start IS NULL
        AND minute.unit_start >= limits.full_from
        AND minute.unit_start + INTERVAL '1 minute' <= limits.full_to
        AND NOT EXISTS (
          SELECT 1 FROM raw_ranges range
          WHERE range.range_start < minute.unit_start + INTERVAL '1 minute'
            AND range.range_end > minute.unit_start
        )
    ), selected_units AS (
      SELECT unit_start, 3600::INTEGER AS bucket_seconds FROM hour_units
      UNION ALL SELECT unit_start, 900::INTEGER FROM quarter_units
      UNION ALL SELECT unit_start, 60::INTEGER FROM minute_units
    )`;
}

/** Returns only the UTC day/resolution variants this exact price timeline needs. */
export function measurementCostRollupRequirementsSql(schema: string): string {
  return `WITH ${costPlanningCtes(schema)}
    SELECT date_bin(INTERVAL '1 day', unit_start,
        TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start,
      bucket_seconds
    FROM selected_units
    WHERE $1::TEXT IS NOT NULL
    GROUP BY 1, 2
    ORDER BY bucket_seconds DESC, day_start`;
}

/** Prices exact ordered states without scanning historical raw measurements. */
export function measurementCostRollupSql(schema: string, metric: CostMetric): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const dirty = qualifiedName(schema, "measurement_ordered_rollup_dirty");
  const generations = qualifiedName(schema, "measurement_ordered_rollup_generations");
  const rollups = qualifiedName(schema, "measurement_ordered_rollups");
  const internalConsumption = metric === "energy"
    ? "state.internal_counter_consumption"
    : "state.weighted_value_seconds / 3600000.0";
  const transitionSegments = metric === "energy" ? `
      SELECT GREATEST(previous_last_at, $2::TIMESTAMPTZ) AS window_start,
        first_at AS window_end,
        EXTRACT(EPOCH FROM (first_at - previous_last_at)) * 1000.0 AS full_duration_ms,
        CASE WHEN first_value >= previous_last_value THEN first_value - previous_last_value
          ELSE GREATEST(0, first_value) END
          / NULLIF(EXTRACT(EPOCH FROM (first_at - previous_last_at)) * 1000.0, 0) AS kwh_per_ms
      FROM sequenced
      WHERE previous_last_at IS NOT NULL AND first_at > $2::TIMESTAMPTZ
        AND first_at > previous_last_at AND first_value >= 0 AND previous_last_value >= 0`
    : `
      SELECT GREATEST(previous_last_at, $2::TIMESTAMPTZ) AS window_start,
        LEAST(first_at, $3::TIMESTAMPTZ, previous_last_at + INTERVAL '15 minutes') AS window_end,
        EXTRACT(EPOCH FROM (
          LEAST(first_at, $3::TIMESTAMPTZ, previous_last_at + INTERVAL '15 minutes')
          - GREATEST(previous_last_at, $2::TIMESTAMPTZ)
        )) * 1000.0 AS full_duration_ms,
        previous_last_value / 3600000000.0 AS kwh_per_ms
      FROM sequenced
      WHERE previous_last_at IS NOT NULL AND previous_last_value >= 0
      UNION ALL
      (SELECT GREATEST(last_at, $2::TIMESTAMPTZ),
        LEAST($3::TIMESTAMPTZ, last_at + INTERVAL '15 minutes'),
        EXTRACT(EPOCH FROM (
          LEAST($3::TIMESTAMPTZ, last_at + INTERVAL '15 minutes')
          - GREATEST(last_at, $2::TIMESTAMPTZ)
        )) * 1000.0,
        last_value / 3600000000.0
      FROM states ORDER BY last_at DESC LIMIT 1)`;

  return `WITH ${costPlanningCtes(schema)}, required_variants AS (
      SELECT date_bin(INTERVAL '1 day', unit_start,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start,
        bucket_seconds
      FROM selected_units GROUP BY 1, 2
    ), priced_units AS MATERIALIZED (
      SELECT unit.*,
        date_bin(INTERVAL '1 day', unit.unit_start,
          TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start,
        price.raw_price_cents_per_kwh + price.margin_cents_per_kwh AS price_cents_per_kwh
      FROM selected_units unit
      LEFT JOIN price_hour_slices price
        ON price.hour_start = date_bin(INTERVAL '1 hour', unit.unit_start,
          TIMESTAMPTZ '1970-01-01 00:00:00+00')
        AND price.slice_start <= unit.unit_start
        AND price.slice_end >= unit.unit_start + make_interval(secs => unit.bucket_seconds)
    ), pending AS (
      SELECT count(*) FILTER (WHERE dirty.sensor_id IS NULL OR generation.sensor_id IS NULL
        OR GREATEST(dirty.current_seq, generation.current_seq) <> dirty.clean_seq)::BIGINT AS pending_variants
      FROM required_variants required
      LEFT JOIN ${dirty} dirty
        ON dirty.sensor_id = $1 AND dirty.metric = $6::TEXT
        AND dirty.day_start = required.day_start AND dirty.bucket_seconds = required.bucket_seconds
        AND dirty.quality_mask = 3
        AND dirty.source_scope = CASE WHEN $5::BOOLEAN THEN 'real' ELSE 'all' END
      LEFT JOIN ${generations} generation
        ON generation.sensor_id = dirty.sensor_id AND generation.metric = dirty.metric
        AND generation.day_start = dirty.day_start
    ), closed_states AS (
      SELECT rollup.bucket_start, TRUE AS is_rollup, rollup.bucket_seconds,
        rollup.sample_count, rollup.first_at, rollup.first_value, rollup.last_at, rollup.last_value,
        rollup.internal_counter_consumption, rollup.weighted_value_seconds,
        rollup.weighted_seconds, rollup.maximum_internal_interval_seconds,
        unit.price_cents_per_kwh
      FROM priced_units unit
      JOIN ${rollups} rollup
        ON rollup.sensor_id = $1 AND rollup.metric = $6::TEXT
        AND rollup.bucket_start = unit.unit_start AND rollup.bucket_seconds = unit.bucket_seconds
        AND rollup.day_start = unit.day_start
        AND rollup.quality_mask = 3
        AND rollup.source_scope = CASE WHEN $5::BOOLEAN THEN 'real' ELSE 'all' END
        AND rollup.algorithm_version = ${MEASUREMENT_ORDERED_ROLLUP_VERSION}
      JOIN ${dirty} dirty
        ON dirty.sensor_id = rollup.sensor_id AND dirty.metric = rollup.metric
        AND dirty.day_start = unit.day_start AND dirty.bucket_seconds = unit.bucket_seconds
        AND dirty.quality_mask = rollup.quality_mask AND dirty.source_scope = rollup.source_scope
      JOIN ${generations} generation
        ON generation.sensor_id = dirty.sensor_id AND generation.metric = dirty.metric
        AND generation.day_start = unit.day_start
        AND GREATEST(dirty.current_seq, generation.current_seq) = dirty.clean_seq
        AND rollup.generation = GREATEST(dirty.current_seq, generation.current_seq)
    ), raw_candidates AS (
      SELECT sample.*
      FROM raw_ranges range
      CROSS JOIN LATERAL (
        SELECT sample.* FROM ${measurements} sample
        WHERE sample.sensor_id = $1 AND sample.metric = $6::TEXT
          AND sample.observed_at >= range.range_start AND sample.observed_at < range.range_end
          AND sample.observed_at <= $3::TIMESTAMPTZ
          AND sample.quality IN ('good', 'estimated')
          AND (NOT $5::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
      ) sample
      UNION ALL
      (SELECT sample.* FROM ${measurements} sample
      WHERE sample.sensor_id = $1 AND sample.metric = $6::TEXT
        AND sample.observed_at < $2::TIMESTAMPTZ
        AND sample.quality IN ('good', 'estimated')
        AND (NOT $5::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
      ORDER BY observed_at DESC, ingested_at DESC, source DESC LIMIT 1)
    ), raw_deduplicated AS (
      SELECT DISTINCT ON (observed_at) * FROM raw_candidates
      ORDER BY observed_at, ingested_at DESC, source DESC
    ), raw_states AS (
      SELECT observed_at AS bucket_start, FALSE AS is_rollup, 0::INTEGER AS bucket_seconds,
        1::BIGINT AS sample_count, observed_at AS first_at, value AS first_value,
        observed_at AS last_at, value AS last_value,
        0::DOUBLE PRECISION AS internal_counter_consumption,
        0::DOUBLE PRECISION AS weighted_value_seconds,
        0::DOUBLE PRECISION AS weighted_seconds,
        0::DOUBLE PRECISION AS maximum_internal_interval_seconds,
        NULL::DOUBLE PRECISION AS price_cents_per_kwh
      FROM raw_deduplicated
    ), states AS (
      SELECT * FROM closed_states UNION ALL SELECT * FROM raw_states
    ), sequenced AS (
      SELECT states.*,
        lag(last_at) OVER (ORDER BY first_at, bucket_start) AS previous_last_at,
        lag(last_value) OVER (ORDER BY first_at, bucket_start) AS previous_last_value
      FROM states
    ), internal AS (
      SELECT COALESCE(sum(GREATEST(sample_count - 1, 0)), 0)::BIGINT AS delta_count,
        COALESCE(sum(${internalConsumption}), 0)::DOUBLE PRECISION AS consumption_kwh,
        COALESCE(sum(${internalConsumption}) FILTER (WHERE price_cents_per_kwh IS NOT NULL), 0)::DOUBLE PRECISION
          AS priced_consumption_kwh,
        COALESCE(sum(${internalConsumption} * price_cents_per_kwh / 100.0), 0)::DOUBLE PRECISION AS cost_eur,
        COALESCE(sum(weighted_seconds) * 1000.0, 0)::DOUBLE PRECISION AS total_duration_ms,
        COALESCE(sum(weighted_seconds) FILTER (WHERE price_cents_per_kwh IS NOT NULL) * 1000.0, 0)::DOUBLE PRECISION
          AS priced_duration_ms,
        COALESCE(max(maximum_internal_interval_seconds) * 1000.0, 0)::DOUBLE PRECISION AS maximum_interval_duration_ms,
        min(first_at) FILTER (WHERE sample_count > 1) AS coverage_from,
        max(last_at) FILTER (WHERE sample_count > 1) AS coverage_until
      FROM states state
    ), segment_candidates AS (${transitionSegments}
    ), segments AS (
      SELECT row_number() OVER (ORDER BY window_start, window_end) AS segment_id,
        segment.*, EXTRACT(EPOCH FROM (window_end - window_start)) * 1000.0 AS window_duration_ms
      FROM segment_candidates segment
      WHERE window_end > window_start AND kwh_per_ms >= 0
    ), segment_hours AS (
      SELECT segment.*, hour.hour_start
      FROM segments segment
      CROSS JOIN LATERAL generate_series(
        date_bin(INTERVAL '1 hour', segment.window_start,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(INTERVAL '1 hour', segment.window_end - INTERVAL '1 microsecond',
          TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        INTERVAL '1 hour'
      ) AS hour(hour_start)
    ), segment_allocations AS (
      SELECT segment.kwh_per_ms * EXTRACT(EPOCH FROM (
          LEAST(segment.window_end, price.slice_end)
          - GREATEST(segment.window_start, price.slice_start)
        )) * 1000.0 AS allocated_kwh,
        EXTRACT(EPOCH FROM (
          LEAST(segment.window_end, price.slice_end)
          - GREATEST(segment.window_start, price.slice_start)
        )) * 1000.0 AS overlap_ms,
        price.raw_price_cents_per_kwh + price.margin_cents_per_kwh AS price_cents_per_kwh
      FROM segment_hours segment
      JOIN price_hour_slices price USING (hour_start)
      WHERE price.slice_start < segment.window_end AND price.slice_end > segment.window_start
    ), segment_totals AS (
      SELECT count(*)::BIGINT AS delta_count,
        COALESCE(sum(kwh_per_ms * window_duration_ms), 0)::DOUBLE PRECISION AS consumption_kwh,
        COALESCE(sum(window_duration_ms), 0)::DOUBLE PRECISION AS total_duration_ms,
        COALESCE(max(${metric === "energy" ? "full_duration_ms" : "window_duration_ms"}), 0)::DOUBLE PRECISION
          AS maximum_interval_duration_ms,
        min(window_start) AS coverage_from, max(window_end) AS coverage_until
      FROM segments
    ), allocation_totals AS (
      SELECT COALESCE(sum(allocated_kwh), 0)::DOUBLE PRECISION AS priced_consumption_kwh,
        COALESCE(sum(allocated_kwh * price_cents_per_kwh / 100.0), 0)::DOUBLE PRECISION AS cost_eur,
        COALESCE(sum(overlap_ms), 0)::DOUBLE PRECISION AS priced_duration_ms
      FROM segment_allocations WHERE overlap_ms > 0
    )
    SELECT pending.pending_variants = 0 AS coverage_complete,
      internal.delta_count + segment_totals.delta_count AS delta_count,
      internal.consumption_kwh + segment_totals.consumption_kwh AS consumption_kwh,
      internal.priced_consumption_kwh + allocation_totals.priced_consumption_kwh AS priced_consumption_kwh,
      internal.cost_eur + allocation_totals.cost_eur AS cost_eur,
      internal.total_duration_ms + segment_totals.total_duration_ms AS total_duration_ms,
      internal.priced_duration_ms + allocation_totals.priced_duration_ms AS priced_duration_ms,
      GREATEST(internal.maximum_interval_duration_ms,
        segment_totals.maximum_interval_duration_ms) AS maximum_interval_duration_ms,
      (SELECT min(value) FROM (VALUES (internal.coverage_from), (segment_totals.coverage_from)) AS coverage(value))
        AS coverage_from,
      (SELECT max(value) FROM (VALUES (internal.coverage_until), (segment_totals.coverage_until)) AS coverage(value))
        AS coverage_until
    FROM pending CROSS JOIN internal CROSS JOIN segment_totals CROSS JOIN allocation_totals`;
}
