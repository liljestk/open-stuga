import type { DatabaseSync } from "node:sqlite";

const table = "measurement_samples";
const stagingTable = "measurement_samples_mode_next";
export const MEASUREMENT_MODE_IDENTITY_MARKER = "measurement_mode_identity_v1";
const legacyIdentity = /,\s*UNIQUE\s*\(\s*sensor_id\s*,\s*metric\s*,\s*timestamp\s*,\s*source\s*\)/iu;
const measurementCreate = /^CREATE TABLE (?:IF NOT EXISTS )?"?measurement_samples"?\s*\(/iu;
const naturalKey = ["sensor_id", "metric", "timestamp", "source"];
const identities = [
  { name: "measurement_samples_unclassified_identity", columns: naturalKey, predicate: "data_mode IS NULL" },
  { name: "measurement_samples_verified_identity", columns: [...naturalKey, "data_mode"], predicate: "data_mode IS NOT NULL" },
];

function scalarPragma(database: DatabaseSync, name: "foreign_keys" | "legacy_alter_table"): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<typeof name, number> | undefined;
  return Number(row?.[name]);
}

function quoting(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function assertMeasurementReferences(database: DatabaseSync): void {
  const dependents = database.prepare(`SELECT DISTINCT object.name FROM sqlite_schema object
    JOIN pragma_foreign_key_list(object.name) reference
    WHERE object.type = 'table' AND reference."table" = 'measurement_samples'`).all() as { name: string }[];
  for (const name of [table, ...dependents.map((item) => item.name)]) {
    if (database.prepare(`PRAGMA foreign_key_check(${quoting(name)})`).get()) {
      throw new Error(`Measurement mode identity migration found a foreign-key violation in ${name}`);
    }
  }
}

/** Rebuild a stopped SQLite copy while preserving the measurement IDs used by archive watermarks and alerts. */
export function prepareMeasurementModeIdentity(database: DatabaseSync): void {
  const foreignKeys = scalarPragma(database, "foreign_keys");
  const legacyAlter = scalarPragma(database, "legacy_alter_table");
  database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
  try {
    if (scalarPragma(database, "foreign_keys") !== 0) throw new Error("Measurement mode preparation requires its own transaction");
    database.exec("BEGIN IMMEDIATE");
    try {
      rebuildMeasurements(database);
      assertMeasurementReferences(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.exec(`PRAGMA legacy_alter_table = ${legacyAlter}; PRAGMA foreign_keys = ${foreignKeys}`);
  }
}

function rebuildMeasurements(database: DatabaseSync): void {
  const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const columns = database.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
  if (!columns.some(({ name }) => name === "data_mode") || !columns.some(({ name }) => name === "recorded_at")) {
    throw new Error("Measurement mode identity preparation requires the telemetry mode and recording-time schema");
  }
  if (!schema || !measurementCreate.test(schema.sql) || !legacyIdentity.test(schema.sql)) {
    const marker = database.prepare("SELECT value FROM metadata WHERE key = ?")
      .get(MEASUREMENT_MODE_IDENTITY_MARKER) as { value: string } | undefined;
    if (marker?.value === "1") {
      assertMeasurementModeIdentity(database);
      return;
    }
    throw new Error("Measurement mode identity preparation found an incompatible measurement schema");
  }
  const dependentSql = database.prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name = ?
    AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid`).all(table) as { sql: string }[];
  const sequenceQuery = database.prepare("SELECT CAST(seq AS INTEGER) AS seq FROM sqlite_sequence WHERE name = ?");
  sequenceQuery.setReadBigInts(true);
  const priorSequence = (sequenceQuery.get(table) as { seq: bigint } | undefined)?.seq;
  const columnNames = columns.map(({ name }) => quoting(name)).join(", ");
  database.exec(schema.sql.replace(measurementCreate, `CREATE TABLE ${stagingTable} (`).replace(legacyIdentity, ""));
  database.exec(`INSERT INTO ${stagingTable} (${columnNames}) SELECT ${columnNames} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${stagingTable} RENAME TO ${table};`);
  if (typeof priorSequence === "bigint") {
    const count = database.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?").run(priorSequence, table).changes;
    if (Number(count) === 0) database.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(table, priorSequence);
  }
  for (const { sql } of dependentSql) database.exec(sql);
  for (const index of identities) {
    database.exec(`CREATE UNIQUE INDEX ${index.name} ON ${table} (${index.columns.join(", ")}) WHERE ${index.predicate}`);
  }
  assertMeasurementModeIdentity(database);
  database.prepare("INSERT INTO metadata(key, value) VALUES (?, '1')").run(MEASUREMENT_MODE_IDENTITY_MARKER);
}

function assertMeasurementModeIdentity(database: DatabaseSync): void {
  const indexes = database.prepare('SELECT name, "unique", partial FROM pragma_index_list(?)')
    .all(table) as { name: string; unique: number; partial: number }[];
  const columns = database.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno");
  const definition = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?");
  const key = (name: string) => (columns.all(name) as { name: string }[]).map((column) => column.name).join(",");
  if (indexes.some((index) => index.unique === 1 && index.partial === 0 && key(index.name) === naturalKey.join(","))) {
    throw new Error("Measurement mode identity indexes could not be verified");
  }
  for (const index of identities) {
    const registered = indexes.some((item) => item.name === index.name && item.unique === 1 && item.partial === 1);
    const row = definition.get(index.name) as { sql: string | null } | undefined;
    if (!registered || key(index.name) !== index.columns.join(",")
      || !row?.sql?.endsWith(`WHERE ${index.predicate}`)) {
      throw new Error(`Measurement mode identity index ${index.name} could not be verified`);
    }
  }
}
