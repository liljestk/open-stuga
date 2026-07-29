import { createHash, randomUUID } from "node:crypto";

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { hostname } from "node:os";

import { dirname, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import {
  assertSqliteCheck,
  createVerifiedSqliteSnapshot,
  describeFile,
  hardenPrivateFile,
  openReadOnlySqlite,
  quoteSqliteIdentifier,
} from ".././sqlite-snapshot-utils.mjs";

import { MANIFEST_VERSION, PREFLIGHT_SEMANTICS_VERSION, SOURCE_TABLES, TARGET_PRIMARY_KEYS, TARGET_TABLES, destinationTimestampKey, q } from "./configuration.mjs";

import { finiteNumber } from "./destination-schema.mjs";

import { inventoryTelemetrySource, readManifest, sourceBlockers, writeManifest } from "./source-state.mjs";

export function textValue(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`Source row contains an invalid ${label}`);
  return value;
}

export function timestampValue(value, label) {
  if (destinationTimestampKey(value) === null) {
    throw new Error(`Source row contains an invalid or timezone-ambiguous ${label}`);
  }
  // PostgreSQL parses the original offset and fractional precision. Date.parse
  // is validation only; converting through Date would truncate microseconds.
  return value;
}

export function nullableTimestampValue(value, label) {
  return value === null ? null : timestampValue(value, label);
}

function booleanValue(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "boolean") throw new Error(`Source row contains an invalid ${label}`);
  return value;
}

function choiceValue(value, label, choices, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`Source row contains an invalid ${label}`);
  }
  return value;
}

function heatPumpState(row) {
  let state;
  try {
    state = JSON.parse(textValue(row.state_json, "state_json"));
  } catch {
    throw new Error("Source row contains invalid heat-pump state JSON");
  }
  if (!state || typeof state !== "object"
    || state.connectionId !== row.connection_id
    || state.houseId !== row.house_id
    || destinationTimestampKey(state.observedAt) !== destinationTimestampKey(row.observed_at)
    || destinationTimestampKey(state.receivedAt) !== destinationTimestampKey(row.received_at)) {
    throw new Error("Source heat-pump state does not match its journal identity");
  }
  return state;
}

export function mapRows(table, rows) {
  if (table === "measurement_samples") return rows.map((row) => ({
    sensor_id: textValue(row.sensor_id, "sensor_id"),
    metric: textValue(row.metric, "metric"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    value: finiteNumber(row.value, "value"),
    canonical_unit: textValue(row.canonical_unit, "canonical_unit"),
    quality: textValue(row.quality, "quality"),
    metadata: {},
  }));
  if (table === "readings") return rows.map((row) => ({
    sensor_id: textValue(row.sensor_id, "sensor_id"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    temperature_c: finiteNumber(row.temperature, "temperature"),
    relative_humidity_pct: finiteNumber(row.humidity, "humidity"),
    battery_pct: finiteNumber(row.battery, "battery", true),
    quality: textValue(row.quality, "quality"),
    metadata: {},
  }));
  if (table === "outdoor_temperature_samples") return rows.map((row) => ({
    house_id: textValue(row.house_id, "house_id"),
    location_key: textValue(row.location_key, "location_key"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    temperature_c: finiteNumber(row.temperature_c, "temperature_c"),
    fetched_at: timestampValue(row.fetched_at, "fetched_at"),
    station_id: textValue(row.station_id, "station_id", true),
    station_name: textValue(row.station_name, "station_name", true),
    // Keep the original JSON text until PostgreSQL casts it to JSONB. Parsing
    // through JavaScript would round high-precision JSON numbers.
    conditions_json: textValue(row.conditions_json ?? null, "conditions_json", true),
  }));
  if (table === "electricity_price_points") return rows.map((row) => ({
    property_id: textValue(row.property_id, "property_id"),
    starts_at: timestampValue(row.start_at, "start_at"),
    source: "sqlite",
    ends_at: timestampValue(row.end_at, "end_at"),
    raw_price_cents_per_kwh: finiteNumber(row.raw_price_cents_per_kwh, "raw_price_cents_per_kwh"),
    margin_cents_per_kwh: finiteNumber(row.margin_cents_per_kwh ?? 0, "margin_cents_per_kwh"),
    fetched_at: timestampValue(row.fetched_at, "fetched_at"),
    metadata: {},
  }));
  if (table === "opening_state_observations") return rows.map((row) => ({
    observation_id: textValue(row.id, "id"),
    house_id: textValue(row.house_id, "house_id"),
    floor_id: textValue(row.floor_id, "floor_id"),
    element_id: textValue(row.element_id, "element_id"),
    observed_at: timestampValue(row.observed_at, "observed_at"),
    source: textValue(row.source, "source"),
    state: textValue(row.state, "state"),
    open_fraction: finiteNumber(row.open_fraction, "open_fraction", true),
    valid_until: nullableTimestampValue(row.valid_until, "valid_until"),
    external_id: textValue(row.external_id, "external_id", true),
    connection_id: textValue(row.connection_id, "connection_id", true),
    recorded_at: timestampValue(row.created_at, "created_at"),
    metadata: {},
  }));
  if (table === "heat_pump_state_history") return rows.map((row) => {
    const state = heatPumpState(row);
    return {
      connection_id: textValue(state.connectionId, "connectionId"),
      house_id: textValue(state.houseId, "houseId"),
      equipment_id: textValue(state.equipmentId, "equipmentId", true),
      device_id: textValue(state.deviceId, "deviceId"),
      name: textValue(state.name, "name", true),
      brand: textValue(state.brand, "brand", true),
      model: textValue(state.model, "model", true),
      observed_at: timestampValue(state.observedAt, "observedAt"),
      received_at: timestampValue(state.receivedAt, "receivedAt"),
      available: booleanValue(state.available, "available"),
      power: booleanValue(state.power, "power", true),
      selected_mode: choiceValue(
        state.selectedMode, "selectedMode", ["auto", "cool", "dry", "fan", "heat"], true,
      ),
      target_temperature_c: finiteNumber(state.targetTemperatureC, "targetTemperatureC", true),
      current_temperature_c: finiteNumber(state.currentTemperatureC, "currentTemperatureC", true),
      current_temperature_source: choiceValue(
        state.currentTemperatureSource, "currentTemperatureSource", ["reported", "unavailable"],
      ),
      fan_speed: textValue(state.fanSpeed, "fanSpeed", true),
      horizontal_swing: textValue(state.horizontalSwing, "horizontalSwing", true),
      vertical_swing: textValue(state.verticalSwing, "verticalSwing", true),
      quiet: booleanValue(state.quiet, "quiet", true),
      turbo: booleanValue(state.turbo, "turbo", true),
      xfan: booleanValue(state.xfan, "xfan", true),
      activity: choiceValue(state.activity, "activity", ["off", "unknown"]),
      activity_evidence: choiceValue(
        state.activityEvidence, "activityEvidence", ["protocol", "unavailable"],
      ),
    };
  });
  throw new Error(`Unsupported source table: ${table}`);
}

export function fetchSourceBatch(database, table, cursor, batchSize) {
  if (table === "measurement_samples" || table === "readings" || table === "heat_pump_state_history") {
    const where = cursor === null ? "" : "WHERE id > ?";
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY id LIMIT ?`);
    const rows = cursor === null ? statement.all(batchSize) : statement.all(cursor, batchSize);
    return {
      rows,
      cursor: rows.length === 0 ? cursor : Number(rows.at(-1).id),
    };
  }
  if (table === "outdoor_temperature_samples") {
    const columns = "timestamp, house_id, location_key, source";
    const where = cursor === null ? "" : `WHERE (${columns}) > (?, ?, ?, ?)`;
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY ${columns} LIMIT ?`);
    const parameters = cursor === null
      ? [batchSize]
      : [cursor.timestamp, cursor.houseId, cursor.locationKey, cursor.source, batchSize];
    const rows = statement.all(...parameters);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? cursor : {
        timestamp: last.timestamp,
        houseId: last.house_id,
        locationKey: last.location_key,
        source: last.source,
      },
    };
  }
  if (table === "electricity_price_points") {
    const columns = "start_at, property_id";
    const where = cursor === null ? "" : `WHERE (${columns}) > (?, ?)`;
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY ${columns} LIMIT ?`);
    const parameters = cursor === null ? [batchSize] : [cursor.startAt, cursor.propertyId, batchSize];
    const rows = statement.all(...parameters);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? cursor : { startAt: last.start_at, propertyId: last.property_id },
    };
  }
  if (table === "opening_state_observations") {
    const columns = "observed_at, id";
    const where = cursor === null ? "" : `WHERE (${columns}) > (?, ?)`;
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY ${columns} LIMIT ?`);
    const parameters = cursor === null ? [batchSize] : [cursor.observedAt, cursor.id, batchSize];
    const rows = statement.all(...parameters);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? cursor : { observedAt: last.observed_at, id: last.id },
    };
  }
  throw new Error(`Unsupported source table: ${table}`);
}

export function recordDefinition(table) {
  return {
    measurement_samples: `sensor_id text, metric text, observed_at timestamptz, source text, value double precision,
      canonical_unit text, quality text, metadata jsonb`,
    readings: `sensor_id text, observed_at timestamptz, source text, temperature_c double precision,
      relative_humidity_pct double precision, battery_pct double precision, quality text, metadata jsonb`,
    outdoor_temperature_samples: `house_id text, location_key text, observed_at timestamptz, source text,
      temperature_c double precision, fetched_at timestamptz, station_id text, station_name text, conditions_json text`,
    electricity_price_points: `property_id text, starts_at timestamptz, source text, ends_at timestamptz,
      raw_price_cents_per_kwh double precision, margin_cents_per_kwh double precision,
      fetched_at timestamptz, metadata jsonb`,
    opening_state_observations: `observation_id text, house_id text, floor_id text, element_id text,
      observed_at timestamptz, source text, state text, open_fraction double precision,
      valid_until timestamptz, external_id text, connection_id text, recorded_at timestamptz, metadata jsonb`,
    heat_pump_state_history: `connection_id text, house_id text, equipment_id text, device_id text,
      name text, brand text, model text, observed_at timestamptz, received_at timestamptz,
      available boolean, power boolean, selected_mode text, target_temperature_c double precision,
      current_temperature_c double precision, current_temperature_source text, fan_speed text,
      horizontal_swing text, vertical_swing text, quiet boolean, turbo boolean, xfan boolean,
      activity text, activity_evidence text`,
  }[table];
}

export function targetColumns(table) {
  return {
    measurement_samples: ["sensor_id", "metric", "observed_at", "source", "value", "canonical_unit", "quality", "metadata"],
    readings: [
      "sensor_id", "observed_at", "source", "temperature_c", "relative_humidity_pct", "battery_pct", "quality", "metadata",
    ],
    outdoor_temperature_samples: [
      "house_id", "location_key", "observed_at", "source", "temperature_c", "fetched_at", "station_id", "station_name", "metadata",
    ],
    electricity_price_points: [
      "property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh", "margin_cents_per_kwh",
      "fetched_at", "metadata",
    ],
    opening_state_observations: [
      "observation_id", "house_id", "floor_id", "element_id", "observed_at", "source", "state",
      "open_fraction", "valid_until", "external_id", "connection_id", "recorded_at", "metadata",
    ],
    heat_pump_state_history: [
      "connection_id", "house_id", "equipment_id", "device_id", "name", "brand", "model",
      "observed_at", "received_at", "available", "power", "selected_mode", "target_temperature_c",
      "current_temperature_c", "current_temperature_source", "fan_speed", "horizontal_swing",
      "vertical_swing", "quiet", "turbo", "xfan", "activity", "activity_evidence",
    ],
  }[table];
}

export function mutableColumns(table) {
  const key = new Set(TARGET_PRIMARY_KEYS[table]);
  return targetColumns(table).filter((column) => !key.has(column));
}

export function targetProjection(table, alias) {
  return targetColumns(table).map((column) => {
    if (table === "outdoor_temperature_samples" && column === "metadata") {
      return `CASE WHEN ${alias}.${q("conditions_json")} IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('conditions', ${alias}.${q("conditions_json")}::jsonb)
      END AS ${q("metadata")}`;
    }
    return `${alias}.${q(column)} AS ${q(column)}`;
  }).join(", ");
}

export async function upsertBatch(client, schema, table, payload) {
  const columns = targetColumns(table);
  const sql = `
    INSERT INTO ${q(schema)}.${q(TARGET_TABLES[table])} (${columns.map(q).join(", ")})
    SELECT ${targetProjection(table, "incoming")}
    FROM jsonb_to_recordset($1::jsonb) AS incoming(${recordDefinition(table)})
    ON CONFLICT (${TARGET_PRIMARY_KEYS[table].map(q).join(", ")})
    DO NOTHING
  `;
  await client.query(sql, [JSON.stringify(payload)]);
}

export function payloadComparison(table, actual = "actual", expected = "expected") {
  return mutableColumns(table)
    .map((column) => `${actual}.${q(column)} IS NOT DISTINCT FROM ${expected}.${q(column)}`)
    .join(" AND ");
}

export async function verifyBatch(client, schema, table, payload) {
  if (payload.length === 0) return { expectedRows: 0, foundRows: 0, matchingRows: 0, minimumTime: null, maximumTime: null };
  const keyJoin = TARGET_PRIMARY_KEYS[table]
    .map((column) => `actual.${q(column)} = expected.${q(column)}`)
    .join(" AND ");
  const timeColumn = table === "electricity_price_points" ? "starts_at" : "observed_at";
  const result = await client.query(`
    WITH source_rows AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS incoming(${recordDefinition(table)})
    ), expected AS (
      SELECT ${targetProjection(table, "source_rows")} FROM source_rows
    )
    SELECT COUNT(*)::bigint AS expected_rows,
           COUNT(actual.${q(TARGET_PRIMARY_KEYS[table][0])})::bigint AS found_rows,
           COUNT(*) FILTER (
             WHERE actual.${q(TARGET_PRIMARY_KEYS[table][0])} IS NOT NULL
               AND ${payloadComparison(table)}
           )::bigint AS matching_rows,
           MIN(expected.${q(timeColumn)}) AS minimum_time,
           MAX(expected.${q(timeColumn)}) AS maximum_time
    FROM expected
    LEFT JOIN ${q(schema)}.${q(TARGET_TABLES[table])} actual ON ${keyJoin}
  `, [JSON.stringify(payload)]);
  const row = result.rows[0];
  return {
    expectedRows: Number(row.expected_rows),
    foundRows: Number(row.found_rows),
    matchingRows: Number(row.matching_rows),
    minimumTime: row.minimum_time === null ? null : new Date(row.minimum_time).toISOString(),
    maximumTime: row.maximum_time === null ? null : new Date(row.maximum_time).toISOString(),
  };
}

export function assertVerified(table, verification) {
  if (verification.expectedRows !== verification.foundRows || verification.expectedRows !== verification.matchingRows) {
    throw new Error(
      `Destination verification failed for ${TARGET_TABLES[table]}: expected ${verification.expectedRows}, `
      + `found ${verification.foundRows}, payload matches ${verification.matchingRows}`,
    );
  }
}

export async function migrateTables(client, database, options, manifest, interrupted) {
  for (const table of Object.keys(SOURCE_TABLES)) {
    const sourceDetails = manifest.inventory[table];
    manifest.progress[table] ??= { cursor: null, rowsProcessed: 0, batches: 0, complete: false };
    const progress = manifest.progress[table];
    if (!sourceDetails.exists) {
      progress.complete = true;
      writeManifest(options.checkpoint, manifest);
      continue;
    }
    if (progress.complete) continue;
    console.log(`Migrating ${table} from row ${progress.rowsProcessed} of ${sourceDetails.rows}...`);
    while (!progress.complete) {
      const batch = fetchSourceBatch(database, table, progress.cursor, options.batchSize);
      if (batch.rows.length === 0) {
        progress.complete = true;
        writeManifest(options.checkpoint, manifest);
        break;
      }
      const payload = mapRows(table, batch.rows);
      await client.query("BEGIN");
      try {
        await upsertBatch(client, options.schema, table, payload);
        const verification = await verifyBatch(client, options.schema, table, payload);
        assertVerified(table, verification);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      progress.cursor = batch.cursor;
      progress.rowsProcessed += batch.rows.length;
      progress.batches += 1;
      manifest.state = "migrating";
      writeManifest(options.checkpoint, manifest);
      if (interrupted.requested) throw new Error("Migration interrupted after saving the latest committed checkpoint");
    }
  }
}

export async function verifyAllTables(client, database, options, inventory) {
  const reports = {};
  for (const table of Object.keys(SOURCE_TABLES)) {
    const sourceDetails = inventory[table];
    if (!sourceDetails.exists) {
      reports[table] = {
        status: "absent",
        destinationTable: TARGET_TABLES[table],
        destinationKey: TARGET_PRIMARY_KEYS[table],
        sourceRows: 0,
        matchedRows: 0,
      };
      continue;
    }
    let cursor = null;
    let sourceRows = 0;
    let foundRows = 0;
    let matchedRows = 0;
    let minimumTime = null;
    let maximumTime = null;
    for (;;) {
      const batch = fetchSourceBatch(database, table, cursor, options.batchSize);
      if (batch.rows.length === 0) break;
      cursor = batch.cursor;
      const verification = await verifyBatch(client, options.schema, table, mapRows(table, batch.rows));
      sourceRows += verification.expectedRows;
      foundRows += verification.foundRows;
      matchedRows += verification.matchingRows;
      minimumTime ??= verification.minimumTime;
      maximumTime = verification.maximumTime;
    }
    const report = {
      status: sourceRows === foundRows && sourceRows === matchedRows ? "verified" : "failed",
      sourceRows,
      foundRows,
      matchedRows,
      sourceKey: sourceDetails.sourceKey,
      destinationTable: TARGET_TABLES[table],
      destinationKey: TARGET_PRIMARY_KEYS[table],
      range: { minimumTime, maximumTime },
    };
    reports[table] = report;
    if (report.status !== "verified") assertVerified(table, {
      expectedRows: sourceRows,
      foundRows,
      matchingRows: matchedRows,
    });
    console.log(`Verified ${table}: ${matchedRows}/${sourceRows} exact key-and-payload match(es)`);
  }
  return reports;
}

export async function buildOrLoadManifest(options) {
  if (existsSync(options.checkpoint)) {
    const manifest = readManifest(options.checkpoint);
    if (resolve(manifest.source.path) !== options.source && options.sourceProvided) {
      throw new Error("The checkpoint belongs to a different SQLite source");
    }
    if (manifest.schema !== options.schema) throw new Error("The checkpoint belongs to a different destination schema");
    const snapshotPath = resolve(manifest.snapshot.path);
    if (options.snapshotProvided && snapshotPath !== options.snapshot) {
      throw new Error("The checkpoint belongs to a different SQLite snapshot");
    }
    options.snapshot = snapshotPath;
    if (!existsSync(snapshotPath)) throw new Error(`Checkpoint snapshot is missing: ${snapshotPath}`);
    const currentSnapshot = await describeFile(snapshotPath);
    if (currentSnapshot.sha256 !== manifest.snapshot.sha256 || currentSnapshot.size !== manifest.snapshot.size) {
      throw new Error("The checkpoint snapshot has changed; refusing an unsafe resume");
    }
    const database = openReadOnlySqlite(snapshotPath);
    try {
      assertSqliteCheck(database, "integrity_check");
      if (manifest.preflightSemanticsVersion !== PREFLIGHT_SEMANTICS_VERSION) {
        manifest.inventory = inventoryTelemetrySource(database);
        manifest.blockers = sourceBlockers(manifest.inventory);
        manifest.preflightSemanticsVersion = PREFLIGHT_SEMANTICS_VERSION;
        manifest.preflightUpgrade = {
          upgradedAt: new Date().toISOString(),
          reason: "Re-run destination-key normalization and optional source metadata validation",
        };
        writeManifest(options.checkpoint, manifest);
      }
    } finally {
      database.close();
    }
    return manifest;
  }

  if (!existsSync(options.source)) throw new Error(`SQLite source does not exist: ${options.source}`);
  const snapshotDetails = await createVerifiedSqliteSnapshot({
    sourcePath: options.source,
    destinationPath: options.snapshot,
  });
  const database = openReadOnlySqlite(options.snapshot);
  let inventory;
  try {
    inventory = inventoryTelemetrySource(database);
  } finally {
    database.close();
  }
  const blockers = sourceBlockers(inventory);
  const manifest = {
    format: "stugu-telemetry-migration",
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: blockers.length === 0 ? "ready" : "blocked",
    schema: options.schema,
    source: snapshotDetails.source,
    snapshot: snapshotDetails.snapshot,
    sqliteChecks: snapshotDetails.checks,
    preflightSemanticsVersion: PREFLIGHT_SEMANTICS_VERSION,
    inventory,
    progress: Object.fromEntries(Object.keys(SOURCE_TABLES).map((table) => [
      table,
      { cursor: null, rowsProcessed: 0, batches: 0, complete: false },
    ])),
    blockers,
  };
  writeManifest(options.checkpoint, manifest);
  return manifest;
}
