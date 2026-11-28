import { qualifiedName } from "../schema.js";
import type { QueryControl } from "../types.js";
import type { TimeseriesStoreInternals } from "./core.js";

const mutationSources = [
  { event: "INSERT", rows: "NEW TABLE AS new_samples", days: "SELECT observed_at FROM new_samples WHERE data_mode IN ('demo','live')" },
  { event: "UPDATE", rows: "OLD TABLE AS old_samples NEW TABLE AS new_samples", days: `SELECT observed_at FROM old_samples WHERE data_mode IN ('demo','live')
        UNION ALL SELECT observed_at FROM new_samples WHERE data_mode IN ('demo','live')` },
] as const;

const verifiedAggregateTriggers = [...mutationSources.map(({ event }) => `verified_aggregates_${event.toLowerCase()}`),
  "verified_aggregates_delete", "verified_aggregates_truncate"];

export async function freshnessReady(store: TimeseriesStoreInternals, control: QueryControl, aggregate?: string): Promise<boolean> {
  const values = [
    qualifiedName(store.schema, "verified_measurement_aggregate_days"),
    qualifiedName(store.schema, "measurement_samples"),
    verifiedAggregateTriggers,
    qualifiedName(store.schema, "verified_measurement_aggregate_epoch"),
    ...(aggregate === undefined ? [] : [qualifiedName(store.schema, aggregate)]),
  ];
  const relationCheck = aggregate === undefined ? "" : "AND to_regclass($5) IS NOT NULL";
  const result = await store.__query<{ configured: boolean }>(`SELECT to_regclass($1) IS NOT NULL
    AND to_regclass($4) IS NOT NULL AND (
      SELECT count(*) = cardinality($3::TEXT[]) FROM pg_trigger
      WHERE tgrelid = to_regclass($2) AND tgname = ANY($3::TEXT[]) AND tgenabled IN ('O', 'A')
    ) ${relationCheck} AS configured`, values, control);
  return result.rows[0]?.configured === true;
}

export function verifiedAggregateFreshnessSql(schema: string): string {
  const days = qualifiedName(schema, "verified_measurement_aggregate_days");
  const epoch = qualifiedName(schema, "verified_measurement_aggregate_epoch");
  const samples = qualifiedName(schema, "measurement_samples");
  const createTrigger = ({ name, event, referencing, body }: {
    name: string; event: string; referencing: string; body: string;
  }) => {
    const procedure = qualifiedName(schema, name);
    return `CREATE OR REPLACE FUNCTION ${procedure}() RETURNS trigger LANGUAGE plpgsql AS $freshness$
      BEGIN
        ${body};
        RETURN NULL;
      END;
      $freshness$;
      CREATE OR REPLACE TRIGGER ${name} AFTER ${event} ON ${samples} ${referencing}
        FOR EACH STATEMENT EXECUTE FUNCTION ${procedure}();`;
  };
  return `CREATE TABLE IF NOT EXISTS ${days} (
    day_start DATE PRIMARY KEY,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    archive_generation UUID,
    delete_epoch UUID
  );
  CREATE TABLE IF NOT EXISTS ${epoch} (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    revision UUID NOT NULL DEFAULT gen_random_uuid()
  );
  INSERT INTO ${epoch} (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  ${mutationSources.map(({ event, rows, days: changed }) =>
    createTrigger({ name: `verified_aggregates_${event.toLowerCase()}`, event, referencing: `REFERENCING ${rows}`, body: `
      INSERT INTO ${days} (day_start)
      SELECT DISTINCT (observed_at AT TIME ZONE 'UTC')::DATE FROM (${changed}) changed
      ORDER BY 1
      ON CONFLICT (day_start) DO UPDATE SET revision = gen_random_uuid(), archive_generation = NULL` })).join("\n")}
  ${["DELETE", "TRUNCATE"].map((event) => createTrigger({
    name: `verified_aggregates_${event.toLowerCase()}`, event, referencing: "",
    // Timescale does not expose a transition table for DELETE.
    body: `UPDATE ${epoch} SET revision = gen_random_uuid() WHERE id = 1`,
  })).join("\n")}
  UPDATE ${days} SET archive_generation = NULL WHERE archive_generation IS NOT NULL;`;
}

export const requestedFullUtcDaysSql = `WITH bounds AS (
    SELECT $1::TIMESTAMPTZ AT TIME ZONE 'UTC' AS from_utc,
      $2::TIMESTAMPTZ AT TIME ZONE 'UTC' AS to_utc
  ), range AS (
    SELECT from_utc::DATE + CASE WHEN from_utc::TIME = TIME '00:00' THEN 0 ELSE 1 END AS start_day,
      to_utc::DATE AS end_day FROM bounds
  )
  SELECT start_day + count.day AS day_start FROM range
  CROSS JOIN LATERAL generate_series(0, end_day - start_day - 1) AS count(day)`;
