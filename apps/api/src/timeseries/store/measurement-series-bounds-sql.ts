import { qualifiedName } from "../schema.js";

/** Internal SQL fragments only. Two indexed seeks avoid scanning retained history. */
export function measurementSeriesBoundsSql(schema: string, input: {
  requested: string;
  until: string;
  qualities: string;
  excludeSynthetic: string;
}): string {
  const measurements = qualifiedName(schema, "measurement_samples");
  const probe = (order: "ASC" | "DESC") => `
    SELECT sample.observed_at FROM ${measurements} sample
    WHERE sample.sensor_id = requested.sensor_id AND sample.metric = requested.metric
      AND sample.observed_at <= ${input.until}
      AND sample.quality = ANY(${input.qualities})
      AND (NOT ${input.excludeSynthetic} OR sample.source NOT IN ('mock', 'replay'))
    ORDER BY sample.observed_at ${order} LIMIT 1`;
  return `SELECT requested.*, first_sample.observed_at AS first_at, last_sample.observed_at AS last_at
    FROM ${input.requested} requested
    LEFT JOIN LATERAL (${probe("ASC")}) first_sample ON TRUE
    LEFT JOIN LATERAL (${probe("DESC")}) last_sample ON TRUE`;
}
