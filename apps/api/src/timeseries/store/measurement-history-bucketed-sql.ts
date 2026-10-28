import { measurementAnalyticsAggregateName, qualifiedName, type MeasurementAnalyticsBaseBucket } from "../schema.js";

const EPOCH = "TIMESTAMPTZ '1970-01-01 00:00:00+00'";

export type BucketedHistoryBase = Exclude<MeasurementAnalyticsBaseBucket, "1d">;

/**
 * The widest analytics aggregate whose buckets nest inside the requested
 * output buckets, or null when only raw samples bin exactly. The day
 * aggregate refreshes a day behind, so day buckets use hours instead of
 * scanning that much raw tail.
 */
export function bucketedHistoryBase(bucketSeconds: number): BucketedHistoryBase | null {
  if (bucketSeconds % 3_600 === 0) return "1h";
  if (bucketSeconds % 300 === 0) return "5m";
  if (bucketSeconds % 60 === 0) return "1m";
  return null;
}

function syntheticFilter(excludeSynthetic: boolean, alias = ""): string {
  return excludeSynthetic ? `AND ${alias}source NOT IN ('mock', 'replay')` : "";
}

/**
 * Bound parameters for both statements: `$1` sensor, `$2` metric, `$3`
 * inclusive start, `$4` inclusive end, `$5` output bucket seconds and `$6`
 * the number of newest non-empty buckets to return.
 *
 * Groups every raw sample in the range. Reads that return metadata use it,
 * because the continuous aggregates do not carry the latest row's payload.
 */
export function rawBucketedHistorySql(schema: string, options: {
  excludeSynthetic: boolean;
  includeMetadata: boolean;
}): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const filter = syntheticFilter(options.excludeSynthetic);
  // Chart DTOs do not expose metadata. Avoid decompressing that wide column
  // for every historical row just to discard the returned latest payloads.
  const metadataColumn = options.includeMetadata ? ", metadata" : "";
  const metadataResult = options.includeMetadata ? "latest.metadata" : "'{}'::JSONB AS metadata";
  return `WITH source_rows AS (
      SELECT value, observed_at,
        date_bin(make_interval(secs => $5::INT), observed_at, ${EPOCH}) AS bucket_start
      FROM ${measurements}
      WHERE sensor_id = $1 AND metric = $2
        AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
        ${filter}
    ), recent_buckets AS (
      SELECT bucket_start, AVG(value)::DOUBLE PRECISION AS value,
        COUNT(*) AS sample_count,
        MAX(observed_at) AS latest_at
      FROM source_rows
      GROUP BY bucket_start
      ORDER BY bucket_start DESC
      LIMIT $6
    ), latest_rows AS (
      -- Read provenance once for the returned timestamps. Per-bucket
      -- lookups repeatedly decompress the same historical chunks.
      SELECT DISTINCT ON (observed_at) observed_at, canonical_unit,
        source, quality${metadataColumn}
      FROM ${measurements}
      WHERE sensor_id = $1 AND metric = $2
        AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
        AND observed_at IN (SELECT latest_at FROM recent_buckets)
        ${filter}
      ORDER BY observed_at DESC, source DESC
    )
    SELECT $1::TEXT AS sensor_id, $2::TEXT AS metric, bucket.value,
      latest.canonical_unit, bucket.bucket_start AS observed_at, latest.source,
      -- Distinct sources already imply multiple samples. Counting them
      -- would force a sort over the dense input instead of bucket hashing.
      CASE WHEN bucket.sample_count > 1
        THEN 'estimated' ELSE latest.quality END AS quality,
      ${metadataResult}
    FROM recent_buckets bucket
    JOIN latest_rows latest ON latest.observed_at = bucket.latest_at
    ORDER BY bucket.bucket_start ASC`;
}

/**
 * Same parameters as {@link rawBucketedHistorySql}, plus `$7` the width of
 * `base`, which must divide `$5`. Returns the same rows without metadata.
 *
 * Complete base buckets come from the materialized analytics aggregate. Raw
 * samples fill the partial edge buckets, history the aggregate has not
 * reached, and its newest bucket, which may have been materialized before its
 * last observation arrived. As in `mergeableAnalyticsSql`, this relies on
 * contiguous refresh windows. Sums and counts merge exactly, so each bucket
 * keeps the raw mean, and the group holding the newest (observed_at, source)
 * pair, unique under the primary key, supplies the provenance.
 */
export function aggregateBucketedHistorySql(schema: string, base: BucketedHistoryBase, options: {
  excludeSynthetic: boolean;
}): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const aggregate = qualifiedName(schema, measurementAnalyticsAggregateName(base));
  const filter = syntheticFilter(options.excludeSynthetic, "sample.");
  // Timestamps have microsecond resolution, so this is the inclusive end.
  const endExclusive = "($4::TIMESTAMPTZ + INTERVAL '1 microsecond')";
  // Redundant with the exact windows below, but constant, so the planner
  // skips chunks outside the request instead of planning the whole history.
  const requested = (column: string) => `AND sample.${column} >= $3::TIMESTAMPTZ AND sample.${column} <= $4::TIMESTAMPTZ`;
  const probe = (order: "ASC" | "DESC") => `
        SELECT sample.bucket_start FROM ${aggregate} sample
        WHERE sample.sensor_id = $1 AND sample.metric = $2
          AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
          ${requested("bucket_start")} ${filter}
        ORDER BY sample.bucket_start ${order} LIMIT 1`;
  return `WITH bounds AS (
      SELECT date_bin($7::INTERVAL, $3::TIMESTAMPTZ, ${EPOCH}) AS from_bucket,
        date_bin($7::INTERVAL, ${endExclusive}, ${EPOCH}) AS to_bucket
    ), limits AS (
      SELECT CASE WHEN from_bucket = $3::TIMESTAMPTZ THEN from_bucket
          ELSE from_bucket + $7::INTERVAL END AS full_from,
        to_bucket AS full_to
      FROM bounds
    ), coverage AS (
      SELECT first_bucket.bucket_start AS cached_from, last_bucket.bucket_start AS cached_to
      FROM limits
      LEFT JOIN LATERAL (${probe("ASC")}
      ) first_bucket ON TRUE
      LEFT JOIN LATERAL (${probe("DESC")}
      ) last_bucket ON TRUE
    ), raw_windows AS (
      -- Separate ranges let the raw index seek to each uncached boundary.
      SELECT $3::TIMESTAMPTZ AS raw_from, COALESCE(cached_from, ${endExclusive}) AS raw_to
      FROM coverage
      UNION ALL
      SELECT cached_to, ${endExclusive} FROM coverage WHERE cached_to IS NOT NULL
    ), source_rows AS (
      -- Each read stays parameterized by its window (OFFSET 0), so Timescale
      -- prunes chunks at run time. A plain join let the planner decompress
      -- the series' whole raw history and filter it afterwards.
      SELECT cached.*
      FROM coverage
      CROSS JOIN LATERAL (
        SELECT sample.bucket_start AS observed_at, sample.sample_count, sample.sum_value,
          sample.last_at, sample.source, sample.quality, sample.canonical_unit
        FROM ${aggregate} sample
        WHERE sample.sensor_id = $1 AND sample.metric = $2
          AND sample.bucket_start >= coverage.cached_from AND sample.bucket_start < coverage.cached_to
          ${requested("bucket_start")} ${filter}
        OFFSET 0
      ) cached
      UNION ALL
      SELECT uncached.*
      FROM raw_windows boundary
      CROSS JOIN LATERAL (
        SELECT sample.observed_at, 1::BIGINT AS sample_count, sample.value AS sum_value,
          sample.observed_at AS last_at, sample.source, sample.quality, sample.canonical_unit
        FROM ${measurements} sample
        WHERE sample.sensor_id = $1 AND sample.metric = $2
          AND sample.observed_at >= boundary.raw_from AND sample.observed_at < boundary.raw_to
          ${requested("observed_at")} ${filter}
        OFFSET 0
      ) uncached
      WHERE boundary.raw_from < boundary.raw_to
    ), source_groups AS (
      -- One row per output bucket and provenance group keeps the rows read
      -- twice below small without sorting the dense input.
      SELECT date_bin(make_interval(secs => $5::INT), observed_at, ${EPOCH}) AS bucket_start,
        source, quality, canonical_unit,
        SUM(sample_count)::BIGINT AS sample_count,
        SUM(sum_value)::DOUBLE PRECISION AS sum_value,
        MAX(last_at) AS last_at
      FROM source_rows
      GROUP BY 1, source, quality, canonical_unit
    ), recent_buckets AS (
      SELECT bucket_start,
        SUM(sum_value) / SUM(sample_count)::DOUBLE PRECISION AS value,
        SUM(sample_count) AS sample_count,
        MAX(last_at) AS latest_at
      FROM source_groups
      GROUP BY bucket_start
      ORDER BY bucket_start DESC
      LIMIT $6
    ), latest_rows AS (
      SELECT DISTINCT ON (candidate.bucket_start) candidate.bucket_start,
        candidate.source, candidate.quality, candidate.canonical_unit
      FROM source_groups candidate
      JOIN recent_buckets bucket
        ON bucket.bucket_start = candidate.bucket_start AND bucket.latest_at = candidate.last_at
      ORDER BY candidate.bucket_start, candidate.source DESC
    )
    SELECT $1::TEXT AS sensor_id, $2::TEXT AS metric, bucket.value,
      latest.canonical_unit, bucket.bucket_start AS observed_at, latest.source,
      CASE WHEN bucket.sample_count > 1
        THEN 'estimated' ELSE latest.quality END AS quality,
      '{}'::JSONB AS metadata
    FROM recent_buckets bucket
    JOIN latest_rows latest ON latest.bucket_start = bucket.bucket_start
    ORDER BY bucket.bucket_start ASC`;
}
