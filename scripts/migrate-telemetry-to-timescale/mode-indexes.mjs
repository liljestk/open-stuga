import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openReadOnlySqlite } from "../sqlite-snapshot-utils.mjs";
import { q } from "./configuration.mjs";
import { acquireTelemetryMigrationLock, loadPgClient, redactConnectionText } from "./source-state.mjs";

const predicate = "data_mode IS NOT NULL";
const series = [
  { local: "measurement_samples", archive: "measurement_samples", keys: ["sensor_id", "metric"] },
  { local: "readings", archive: "legacy_readings", keys: ["sensor_id"] },
  { local: "outdoor_temperature_samples", archive: "outdoor_temperature_samples", keys: ["house_id", "location_key"] },
];

function indexSpecifications(engine) {
  return series.map((definition) => ({
    name: `${definition[engine]}_verified_mode_time_idx`,
    table: definition[engine],
    columns: [...definition.keys, "data_mode", engine === "local" ? "timestamp" : "observed_at"],
  }));
}

function indexSql(index, target) {
  return `CREATE INDEX ${q(index.name)} ON ${target} (${index.columns.map(q).join(", ")}) WHERE ${predicate}`;
}

function assertColumns(actual, index, engine) {
  if (!index.columns.every((column) => actual.includes(column))) {
    throw new Error(`${engine} table ${index.table} needs the telemetry mode schema upgrade before index preparation`);
  }
}

function assertIndex(matches, index, engine) {
  if (!matches) throw new Error(`${engine} index ${index.name} has an incompatible definition`);
}

function sqliteIndexes(database) {
  const columns = database.prepare("SELECT name FROM pragma_table_info(?)");
  const index = database.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = ?");
  const keys = database.prepare('SELECT name, coll FROM pragma_index_xinfo(?) WHERE "key" = 1 ORDER BY seqno');
  const properties = database.prepare('SELECT partial FROM pragma_index_list(?) WHERE name = ?');
  return indexSpecifications("local").map((item) => {
    assertColumns(columns.all(item.table).map(({ name }) => name), item, "SQLite");
    const existing = index.get(item.name);
    if (existing) {
      const actualKeys = keys.all(item.name);
      assertIndex(
        existing.tbl_name === item.table && properties.get(item.table, item.name)?.partial === 1
          && /^CREATE\s+INDEX\b/iu.test(existing.sql)
          && /\bWHERE\s+"?data_mode"?\s+IS\s+NOT\s+NULL\s*$/iu.test(existing.sql)
          && actualKeys.every(({ coll }) => coll === "BINARY")
          && actualKeys.map(({ name }) => name).join("\0") === item.columns.join("\0"),
        item, "SQLite",
      );
    }
    return { ...item, present: Boolean(existing) };
  });
}

async function archiveIndexes(client, schema) {
  const indexes = indexSpecifications("archive");
  const tables = indexes.map(({ table }) => table);
  const attributes = await client.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = ANY($2::TEXT[])`, [schema, tables]);
  const catalog = await client.query(`SELECT index_relation.relname AS name, table_relation.relname AS table_name,
    detail.indisvalid AND detail.indisready AS valid,
    pg_get_indexdef(detail.indexrelid) AS definition
    FROM pg_class index_relation
    JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
    JOIN pg_index detail ON detail.indexrelid = index_relation.oid
    JOIN pg_class table_relation ON table_relation.oid = detail.indrelid
    WHERE namespace.nspname = $1 AND index_relation.relname = ANY($2::TEXT[])`,
  [schema, indexes.map(({ name }) => name)]);
  return indexes.map((item) => {
    const names = attributes.rows.filter(({ table_name }) => table_name === item.table).map(({ column_name }) => column_name);
    assertColumns(names, item, "PostgreSQL");
    const existing = catalog.rows.find(({ name }) => name === item.name);
    if (existing) {
      assertIndex(
        existing.table_name === item.table && existing.valid && existing.definition.startsWith("CREATE INDEX ")
          && existing.definition.endsWith(` USING btree (${item.columns.join(", ")}) WHERE (${predicate})`),
        item, "PostgreSQL",
      );
    }
    return { ...item, present: Boolean(existing) };
  });
}

function assertComplete(indexes, engine) {
  const missing = indexes.filter(({ present }) => !present).map(({ name }) => name);
  if (missing.length) throw new Error(`${engine} is missing mode indexes: ${missing.join(", ")}`);
}

function prepareSqliteIndexes(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const index of sqliteIndexes(database)) {
      if (!index.present) database.exec(indexSql(index, q(index.table)));
    }
    assertComplete(sqliteIndexes(database), "SQLite");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function prepareArchiveIndexes(client, { schema, maintenanceTimeoutMs }, indexes) {
  if (indexes.every(({ present }) => present)) return;
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [`${maintenanceTimeoutMs}ms`]);
    for (const index of indexes) {
      if (!index.present) await client.query(indexSql(index, `${q(schema)}.${q(index.table)}`));
    }
    assertComplete(await archiveIndexes(client, schema), "PostgreSQL");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function maintainTelemetryModeIndexes(database, client, options) {
  const sqlite = sqliteIndexes(database);
  const archive = await archiveIndexes(client, options.schema);
  if (options.verifyOnly) {
    assertComplete(sqlite, "SQLite");
    assertComplete(archive, "PostgreSQL");
  } else {
    // Each store commits independently. If interrupted, the next run validates
    // what was committed and builds only the remaining indexes.
    await prepareArchiveIndexes(client, options, archive);
    if (sqlite.some(({ present }) => !present)) prepareSqliteIndexes(database);
  }
  const report = (indexes) => indexes.map(({ name, present }) => ({ name, result: present ? "present" : "created" }));
  return { sqlite: report(sqlite), archive: report(archive) };
}

export async function runModeIndexMaintenance(options) {
  if (!existsSync(options.source)) throw new Error(`SQLite database does not exist: ${options.source}`);
  const database = options.verifyOnly ? openReadOnlySqlite(options.source) : new DatabaseSync(options.source);
  let client;
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    client = await loadPgClient(options.pgClientConfig);
    await acquireTelemetryMigrationLock(client, options.schema);
    const report = await maintainTelemetryModeIndexes(database, client, options);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    const message = redactConnectionText(error instanceof Error ? error.message : String(error), options.connectionSecrets);
    throw new Error(message, { cause: error });
  } finally {
    try {
      database.close();
    } finally {
      await client?.end();
    }
  }
}
