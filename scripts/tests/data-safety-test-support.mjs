import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";

import test from "node:test";

import {
  MIGRATION_AGGREGATES,
  MIGRATION_HYPERTABLES,
  acquireCheckpointLock,
  destinationFingerprint,
  ensureAndRefreshMeasurementAggregates,
  inventoryTelemetrySource,
  mapRows,
  parseMigrationArgs,
  provisionDestination,
  runDryMigration,
  upsertBatch,
  validateExpectedHypertables,
  verifyBatch,
} from "../migrate-telemetry-to-timescale.mjs";

import {
  createBackup,
  parseBackupArgs,
  timescaleDumpArguments,
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  timescaleRestorePlan,
  verifyBackup,
} from "../stugu-backup.mjs";

import { backupArguments } from "../stugu-backup-scheduler.mjs";

import { openReadOnlySqlite, sha256File } from "../sqlite-snapshot-utils.mjs";

export function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-data-safety-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function createTelemetryFixture(path, {
  duplicateReading = false,
  equivalentInstantKeys = false,
  outdoorConditionsJson = undefined,
} = {}) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE measurement_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      canonical_unit TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      UNIQUE(sensor_id, metric, timestamp, source)
    );
    CREATE TABLE readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      battery REAL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL
    );
    CREATE TABLE outdoor_temperature_samples (
      house_id TEXT NOT NULL,
      location_key TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      temperature_c REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      station_id TEXT,
      station_name TEXT,
      PRIMARY KEY(house_id, location_key, timestamp, source)
    );
    CREATE TABLE electricity_price_points (
      property_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      raw_price_cents_per_kwh REAL NOT NULL,
      margin_cents_per_kwh REAL NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(property_id, start_at)
    );
    CREATE TABLE opening_state_observations (
      id TEXT PRIMARY KEY,
      house_id TEXT NOT NULL,
      floor_id TEXT NOT NULL,
      element_id TEXT NOT NULL,
      state TEXT NOT NULL,
      open_fraction REAL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      valid_until TEXT,
      external_id TEXT,
      connection_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE heat_pump_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL,
      house_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      state_json TEXT NOT NULL,
      UNIQUE (connection_id, observed_at)
    );
    INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-1', 'temperature', 19.5, 'degC', '2026-07-18T10:00:00.000Z', 'api', 'good');
    INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-1', '2026-07-18T10:00:00.000Z', 19.5, 52, 88, 'api', 'good');
    INSERT INTO outdoor_temperature_samples
      (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
      VALUES ('house-1', 'yard', '2026-07-18T10:00:00.000Z', 17.2, 'fmi-observation',
        '2026-07-18T10:01:00.000Z', 'station-1', 'Test station');
    INSERT INTO electricity_price_points
      (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at)
      VALUES ('property-1', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z', 6.4, 0.45,
        '2026-07-18T09:00:00.000Z');
    INSERT INTO opening_state_observations
      (id, house_id, floor_id, element_id, state, open_fraction, source, observed_at,
       valid_until, external_id, connection_id, created_at)
      VALUES ('opening-1', 'house-1', 'floor-1', 'door-1', 'open', 1, 'api',
        '2026-07-18T10:00:00.000Z', NULL, 'binary_sensor.door', 'ha-1',
        '2026-07-18T10:00:01.000Z');
    INSERT INTO heat_pump_state_history
      (connection_id, house_id, observed_at, received_at, state_json)
      VALUES (
        'gree-aabbccddeeff',
        'house-1',
        '2026-07-18T10:00:00.000Z',
        '2026-07-18T10:00:01.000Z',
        '{"connectionId":"gree-aabbccddeeff","houseId":"house-1","equipmentId":null,
          "deviceId":"AABBCCDDEEFF","name":"Nordkapp","brand":"Wilfa","model":"Nordkapp 30",
          "observedAt":"2026-07-18T10:00:00.000Z","receivedAt":"2026-07-18T10:00:01.000Z",
          "available":true,"power":true,"selectedMode":"cool","targetTemperatureC":22,
          "currentTemperatureC":25.5,"currentTemperatureSource":"reported",
          "currentHumidityPercent":48,"targetHumidityPercent":50,"fanSpeed":"Auto",
          "horizontalSwing":null,"verticalSwing":"FullSwing","freshAir":true,"anion":true,
          "sleep":false,"light":true,"quiet":false,"turbo":false,"xfan":true,
          "steadyHeat":false,"powerSave":true,"cleanFilter":false,"waterFull":false,
          "dehumidifierMode":"AnionOnly","activity":"unknown","activityEvidence":"unavailable"}'
      );
  `);
  if (duplicateReading) {
    database.exec(`INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-1', '2026-07-18T10:00:00.000Z', 20, 53, 87, 'api', 'estimated')`);
  }
  if (equivalentInstantKeys) {
    database.exec(`
      INSERT INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        VALUES ('sensor-1', 'temperature', 20, 'degC', '2026-07-18T12:00:00.000+02:00', 'api', 'good');
      INSERT INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality)
        VALUES ('sensor-1', '2026-07-18T12:00:00.000+02:00', 20, 53, 87, 'api', 'estimated');
      INSERT INTO outdoor_temperature_samples
        (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
        VALUES ('house-1', 'yard', '2026-07-18T12:00:00.000+02:00', 17.3, 'fmi-observation',
          '2026-07-18T12:01:00.000+02:00', 'station-1', 'Test station');
      INSERT INTO electricity_price_points
        (property_id, start_at, end_at, raw_price_cents_per_kwh, fetched_at)
        VALUES ('property-1', '2026-07-18T12:00:00.000+02:00', '2026-07-18T13:00:00.000+02:00', 6.5,
          '2026-07-18T11:00:00.000+02:00');
    `);
  }
  if (outdoorConditionsJson !== undefined) {
    database.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN conditions_json TEXT");
    database.prepare("UPDATE outdoor_temperature_samples SET conditions_json = ?").run(outdoorConditionsJson);
  }
  return database;
}
