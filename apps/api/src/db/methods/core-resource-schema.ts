import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT } from "@climate-twin/contracts";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { DEFAULT_PROPERTY_ID } from "../support/domain-limits.js";
import { registerDatabaseMethods } from "../core.js";

export const SENSOR_SOURCE_METRICS_RECENT_ROWID_WINDOW = 10_000;

export const SENSOR_SOURCE_METRICS_RECENT_ROWS_SQL = `SELECT sensor_id, source, metric
  FROM measurement_samples
  WHERE id > ? AND source IN ('home-assistant', 'tp-link')`;

declare module "../core.js" {
  interface DatabaseInternals {
    migrateCoreAndResourceSchema(): void;
  }
}

registerDatabaseMethods({
  migrateCoreAndResourceSchema(): void {
      this.db.exec(CORE_SCHEMA_SQL);
      const recentSourceMetricsSeeded = this.db.prepare(
        "SELECT 1 FROM metadata WHERE key = 'sensor_source_metrics_recent_samples_v1'",
      ).get();
      if (!recentSourceMetricsSeeded) {
        const sampleMaxId = Number((this.db.prepare(
          "SELECT COALESCE(MAX(id), 0) AS maximum FROM measurement_samples",
        ).get() as { maximum: number }).maximum);
        const afterId = Math.max(0, sampleMaxId - SENSOR_SOURCE_METRICS_RECENT_ROWID_WINDOW);
        // A small exact-source tail covers active integrations during upgrade.
        // The INTEGER PRIMARY KEY range is fixed; it never walks full history.
        this.db.prepare(`INSERT OR IGNORE INTO sensor_source_metrics(sensor_id, source, metric)
          ${SENSOR_SOURCE_METRICS_RECENT_ROWS_SQL}`).run(afterId);
        this.db.prepare(`INSERT INTO metadata(key, value)
          VALUES ('sensor_source_metrics_recent_samples_v1', ?)`).run(String(sampleMaxId));
      }
      const sourceMetricGapMaxId = Number((this.db.prepare(
        "SELECT COALESCE(MAX(id), 0) AS maximum FROM sensor_data_gaps",
      ).get() as { maximum: number }).maximum);
      const sourceMetricGapCheckpoint = Number((this.db.prepare(
        "SELECT value FROM metadata WHERE key = 'sensor_source_metrics_gap_rowid_v1'",
      ).get() as { value?: string } | undefined)?.value ?? 0);
      if (!Number.isSafeInteger(sourceMetricGapCheckpoint)
          || sourceMetricGapCheckpoint < sourceMetricGapMaxId) {
        const afterId = Number.isSafeInteger(sourceMetricGapCheckpoint)
          && sourceMetricGapCheckpoint >= 0
          ? sourceMetricGapCheckpoint
          : 0;
        // Preserve known offline-device capabilities on upgrade without ever
        // scanning retained measurement history. The persistent insert trigger
        // covers rollback writes; this high-watermark repair covers its absence.
        this.db.prepare(`INSERT OR IGNORE INTO sensor_source_metrics(sensor_id, source, metric)
          SELECT sensor_id, source, metric FROM sensor_data_gaps WHERE id > ?`).run(afterId);
        this.db.prepare(`INSERT INTO metadata(key, value)
            VALUES ('sensor_source_metrics_gap_rowid_v1', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(sourceMetricGapMaxId));
      }
      const recordedMeasurementsMigrated = this.db.prepare(
        "SELECT 1 FROM metadata WHERE key = 'sensor_recorded_measurements_v1'",
      ).get();
      if (!recordedMeasurementsMigrated) {
        this.db.exec(`
          INSERT OR IGNORE INTO sensor_recorded_measurements(sensor_id, metric)
            SELECT DISTINCT sensor_id, metric FROM measurement_samples
            WHERE source NOT IN ('mock', 'replay');
          INSERT INTO metadata(key, value) VALUES ('sensor_recorded_measurements_v1', 'complete');
        `);
      }
      const archiveRowIds = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_archive_row_ids'",
      ).get() as { sql: string } | undefined;
      if (!archiveRowIds?.sql.includes("'opening_state_samples'")) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS archive_outdoor_temperature_insert;
          DROP TRIGGER IF EXISTS archive_outdoor_temperature_delete;
          DROP TRIGGER IF EXISTS archive_electricity_price_insert;
          DROP TRIGGER IF EXISTS archive_electricity_price_delete;
          CREATE TABLE telemetry_archive_row_ids_v2 (
            archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL CHECK (table_name IN (
              'outdoor_temperature_samples', 'electricity_price_samples', 'opening_state_samples'
            )),
            natural_key TEXT NOT NULL,
            UNIQUE (table_name, natural_key)
          );
          INSERT INTO telemetry_archive_row_ids_v2(archive_id, table_name, natural_key)
            SELECT archive_id, table_name, natural_key FROM telemetry_archive_row_ids ORDER BY archive_id;
          DROP TABLE telemetry_archive_row_ids;
          ALTER TABLE telemetry_archive_row_ids_v2 RENAME TO telemetry_archive_row_ids;
          CREATE INDEX idx_telemetry_archive_row_ids_page
            ON telemetry_archive_row_ids(table_name, archive_id);
        `);
      }
      this.db.exec(`
        INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          SELECT 'outdoor_temperature_samples', json_array(house_id, location_key, timestamp, source)
          FROM outdoor_temperature_samples ORDER BY timestamp, house_id, location_key, source;
        INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          SELECT 'electricity_price_samples', json_array(property_id, start_at)
          FROM electricity_price_points ORDER BY start_at, property_id;
        INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          SELECT 'opening_state_samples', json_array(id)
          FROM opening_state_observations ORDER BY observed_at, id;
        CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_insert
          AFTER INSERT ON outdoor_temperature_samples BEGIN
            INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
            VALUES ('outdoor_temperature_samples', json_array(NEW.house_id, NEW.location_key, NEW.timestamp, NEW.source));
          END;
        CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_delete
          AFTER DELETE ON outdoor_temperature_samples BEGIN
            DELETE FROM telemetry_archive_row_ids
            WHERE table_name = 'outdoor_temperature_samples'
              AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
            DELETE FROM telemetry_archive_dirty_rows
            WHERE table_name = 'outdoor_temperature_samples'
              AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
          END;
        CREATE TRIGGER IF NOT EXISTS archive_electricity_price_insert
          AFTER INSERT ON electricity_price_points BEGIN
            INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
            VALUES ('electricity_price_samples', json_array(NEW.property_id, NEW.start_at));
          END;
        CREATE TRIGGER IF NOT EXISTS archive_electricity_price_delete
          AFTER DELETE ON electricity_price_points BEGIN
            DELETE FROM telemetry_archive_row_ids
            WHERE table_name = 'electricity_price_samples'
              AND natural_key = json_array(OLD.property_id, OLD.start_at);
            DELETE FROM telemetry_archive_dirty_rows
            WHERE table_name = 'electricity_price_samples'
              AND natural_key = json_array(OLD.property_id, OLD.start_at);
          END;
        CREATE TRIGGER IF NOT EXISTS archive_opening_state_insert
          AFTER INSERT ON opening_state_observations BEGIN
            INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
            VALUES ('opening_state_samples', json_array(NEW.id));
          END;
        CREATE TRIGGER IF NOT EXISTS archive_opening_state_delete
          AFTER DELETE ON opening_state_observations BEGIN
            DELETE FROM telemetry_archive_row_ids
            WHERE table_name = 'opening_state_samples' AND natural_key = json_array(OLD.id);
          END;
      `);
      const orphanedMaintenanceRevision = this.db.prepare(`
              SELECT revision.maintenance_task_id, revision.revision
              FROM maintenance_task_revisions AS revision
              LEFT JOIN maintenance_tasks AS task ON task.id = revision.maintenance_task_id
              WHERE task.id IS NULL
              ORDER BY revision.maintenance_task_id, revision.revision
              LIMIT 1
            `).get() as { maintenance_task_id: string; revision: number } | undefined;
      if (orphanedMaintenanceRevision) {
              throw new Error(
                `ORPHANED_MAINTENANCE_REVISION: maintenance task ${orphanedMaintenanceRevision.maintenance_task_id} `
                + `is missing for revision ${orphanedMaintenanceRevision.revision}`,
              );
            }
      // Older builds allowed more than one unresolved row per rule/sensor.
            // Resolve all but the newest before enforcing the durable invariant.
            this.db.exec(`
              UPDATE alert_events AS candidate
              SET resolved_at = candidate.started_at
              WHERE candidate.resolved_at IS NULL AND EXISTS (
                SELECT 1 FROM alert_events AS newer
                WHERE newer.rule_id = candidate.rule_id
                  AND newer.sensor_id = candidate.sensor_id
                  AND newer.resolved_at IS NULL
                  AND (newer.started_at > candidate.started_at
                    OR (newer.started_at = candidate.started_at AND newer.id > candidate.id))
              );
              CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_one_active
                ON alert_events(rule_id, sensor_id) WHERE resolved_at IS NULL;
            `);
      const outdoorColumns = this.db.prepare("PRAGMA table_info(outdoor_temperature_samples)")
            .all() as unknown as Array<{ name: string }>;
      if (!outdoorColumns.some((column) => column.name === "conditions_json")) {
            this.db.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN conditions_json TEXT");
          }
      const electricityPriceColumns = this.db.prepare("PRAGMA table_info(electricity_price_points)")
            .all() as unknown as Array<{ name: string }>;
      if (!electricityPriceColumns.some((column) => column.name === "margin_cents_per_kwh")) {
            this.db.exec("ALTER TABLE electricity_price_points ADD COLUMN margin_cents_per_kwh REAL NOT NULL DEFAULT 0");
            this.db.exec(`UPDATE electricity_price_points
              SET margin_cents_per_kwh = COALESCE((SELECT config.margin_cents_per_kwh
                FROM property_electricity_configs AS config
                WHERE config.property_id = electricity_price_points.property_id), 0)`);
          }
      const openingStateColumns = this.db.prepare("PRAGMA table_info(opening_state_observations)")
            .all() as unknown as Array<{ name: string }>;
      if (!openingStateColumns.some((column) => column.name === "connection_id")) {
            this.db.exec("ALTER TABLE opening_state_observations ADD COLUMN connection_id TEXT");
          }
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_opening_state_source_time
              ON opening_state_observations(house_id, floor_id, element_id, source, observed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_opening_state_provider_time
              ON opening_state_observations(house_id, floor_id, element_id, source, external_id, connection_id, observed_at DESC);
          `);
      const openingStateCandidatesMigrated = this.db.prepare(
        "SELECT 1 FROM metadata WHERE key = 'opening_state_current_candidates_v1'",
      ).get();
      if (!openingStateCandidatesMigrated) {
        // Current reads need only the interval skyline for each source/binding
        // lane. A newer row permanently hides an older row when it remains
        // effective at least as long; shorter temporary rows retain the older
        // fallback that must reappear after expiry. Provider ceilings use the
        // maximum supported staleness so later binding changes remain correct.
        this.db.exec(`
          DELETE FROM opening_state_current_candidates;
          INSERT INTO opening_state_current_candidates(
            observation_id, house_id, floor_id, element_id, lane_key, observed_at, effective_until_ceiling
          )
          SELECT id, house_id, floor_id, element_id,
            CASE
              WHEN source IN ('manual', 'api') THEN json_array(source)
              ELSE json_array(source, COALESCE(external_id, ''), COALESCE(connection_id, ''))
            END,
            observed_at,
            CASE
              WHEN source IN ('home-assistant', 'tapo') THEN CASE
                WHEN valid_until IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days')
                WHEN valid_until <= strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days') THEN valid_until
                ELSE strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days')
              END
              ELSE valid_until
            END
          FROM opening_state_observations;
          DELETE FROM opening_state_current_candidates
          WHERE effective_until_ceiling IS NOT NULL
            AND effective_until_ceiling <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
          DELETE FROM opening_state_current_candidates
          WHERE EXISTS (
            SELECT 1 FROM opening_state_current_candidates AS newer
            WHERE newer.house_id = opening_state_current_candidates.house_id
              AND newer.floor_id = opening_state_current_candidates.floor_id
              AND newer.element_id = opening_state_current_candidates.element_id
              AND newer.lane_key = opening_state_current_candidates.lane_key
              AND newer.observed_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              AND (
                newer.observed_at > opening_state_current_candidates.observed_at
                OR (
                  newer.observed_at = opening_state_current_candidates.observed_at
                  AND newer.observation_id > opening_state_current_candidates.observation_id
                )
              )
              AND (
                newer.effective_until_ceiling IS NULL
                OR (
                  opening_state_current_candidates.effective_until_ceiling IS NOT NULL
                  AND newer.effective_until_ceiling >= opening_state_current_candidates.effective_until_ceiling
                )
              )
          );
          INSERT INTO metadata(key, value) VALUES ('opening_state_current_candidates_v1', 'complete');
          INSERT OR REPLACE INTO metadata(key, value)
            SELECT 'opening_state_current_candidates_rowid_v2', CAST(COALESCE(MAX(rowid), 0) AS TEXT)
            FROM opening_state_observations;
        `);
      }
      const openingStateCandidateMaxRow = Number((this.db.prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS maximum FROM opening_state_observations",
      ).get() as { maximum: number }).maximum);
      const openingStateCandidateCheckpoint = Number((this.db.prepare(
        "SELECT value FROM metadata WHERE key = 'opening_state_current_candidates_rowid_v2'",
      ).get() as { value?: string } | undefined)?.value ?? 0);
      if (!Number.isSafeInteger(openingStateCandidateCheckpoint)
          || openingStateCandidateCheckpoint < openingStateCandidateMaxRow) {
        const afterRowId = Number.isSafeInteger(openingStateCandidateCheckpoint)
          && openingStateCandidateCheckpoint >= 0
          ? openingStateCandidateCheckpoint
          : 0;
        // The insert trigger survives an application rollback because it lives
        // in SQLite. This bounded high-watermark repair also covers rows written
        // by a legacy binary if that trigger was absent or temporarily damaged.
        this.db.prepare(`INSERT OR IGNORE INTO opening_state_current_candidates(
            observation_id, house_id, floor_id, element_id, lane_key, observed_at, effective_until_ceiling
          )
          SELECT id, house_id, floor_id, element_id,
            CASE
              WHEN source IN ('manual', 'api') THEN json_array(source)
              ELSE json_array(source, COALESCE(external_id, ''), COALESCE(connection_id, ''))
            END,
            observed_at,
            CASE
              WHEN source IN ('home-assistant', 'tapo') THEN CASE
                WHEN valid_until IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days')
                WHEN valid_until <= strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days') THEN valid_until
                ELSE strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+30 days')
              END
              ELSE valid_until
            END
          FROM opening_state_observations
          WHERE rowid > ?`).run(afterRowId);
        this.db.exec(`
          DELETE FROM opening_state_current_candidates
          WHERE effective_until_ceiling IS NOT NULL
            AND effective_until_ceiling <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
          DELETE FROM opening_state_current_candidates
          WHERE EXISTS (
            SELECT 1 FROM opening_state_current_candidates AS newer
            WHERE newer.house_id = opening_state_current_candidates.house_id
              AND newer.floor_id = opening_state_current_candidates.floor_id
              AND newer.element_id = opening_state_current_candidates.element_id
              AND newer.lane_key = opening_state_current_candidates.lane_key
              AND newer.observed_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              AND (
                newer.observed_at > opening_state_current_candidates.observed_at
                OR (
                  newer.observed_at = opening_state_current_candidates.observed_at
                  AND newer.observation_id > opening_state_current_candidates.observation_id
                )
              )
              AND (
                newer.effective_until_ceiling IS NULL
                OR (
                  opening_state_current_candidates.effective_until_ceiling IS NOT NULL
                  AND newer.effective_until_ceiling >= opening_state_current_candidates.effective_until_ceiling
                )
              )
          );
        `);
        this.db.prepare(`INSERT INTO metadata(key, value)
            VALUES ('opening_state_current_candidates_rowid_v2', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(openingStateCandidateMaxRow));
      }
      const propertyColumns = this.db.prepare("PRAGMA table_info(properties)").all() as unknown as Array<{ name: string }>;
      if (!propertyColumns.some((column) => column.name === "stugby_json")) {
            this.db.exec("ALTER TABLE properties ADD COLUMN stugby_json TEXT");
          }
      const addedPropertyDefaultHouse = !propertyColumns.some((column) => column.name === "default_house_id");
      if (addedPropertyDefaultHouse) {
            this.db.exec("ALTER TABLE properties ADD COLUMN default_house_id TEXT REFERENCES houses(id) ON DELETE SET NULL");
          }
      const houseColumns = this.db.prepare("PRAGMA table_info(houses)").all() as unknown as Array<{ name: string }>;
      const migrationTimestamp = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO properties
            (id, name, description, location_json, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)`)
            .run(DEFAULT_PROPERTY_ID, "My property", migrationTimestamp, migrationTimestamp);
      this.db.prepare(`INSERT OR IGNORE INTO property_electricity_configs
            (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
             contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
            SELECT id, 'porssisahko', ?, 1, 0, 'spot', NULL, NULL, NULL, NULL, NULL, ? FROM properties`)
            .run(DEFAULT_ELECTRICITY_PRICE_ENDPOINT, migrationTimestamp);
      if (!houseColumns.some((column) => column.name === "property_id")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN property_id TEXT REFERENCES properties(id) ON DELETE RESTRICT");
          }
      this.db.prepare(`UPDATE houses SET property_id = ?
            WHERE property_id IS NULL OR trim(property_id) = ''
              OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = houses.property_id)`)
            .run(DEFAULT_PROPERTY_ID);
      if (!houseColumns.some((column) => column.name === "location_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN location_json TEXT");
          }
      if (!houseColumns.some((column) => column.name === "map_placement_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN map_placement_json TEXT");
          }
      // Weather is Property-scoped by default. Preserve every existing Home
      // location as an override, and only infer a reference where it is absent.
      this.db.exec(`
            UPDATE houses
            SET location_json = json_set(
              (SELECT property.location_json FROM properties AS property WHERE property.id = houses.property_id),
              '$.source', 'property-location', '$.userOverridden', json('false')
            )
            WHERE location_json IS NULL
              AND EXISTS (
                SELECT 1 FROM properties AS property
                WHERE property.id = houses.property_id AND property.location_json IS NOT NULL
              );
            UPDATE houses
            SET location_json = json_object(
              'latitude', json_extract(map_placement_json, '$.latitude'),
              'longitude', json_extract(map_placement_json, '$.longitude'),
              'source', 'map-placement',
              'confidence', 'high',
              'userOverridden', json('false')
            )
            WHERE location_json IS NULL
              AND map_placement_json IS NOT NULL
              AND json_type(map_placement_json, '$.latitude') IN ('integer', 'real')
              AND json_type(map_placement_json, '$.longitude') IN ('integer', 'real');
          `);
      if (!houseColumns.some((column) => column.name === "orientation_degrees")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360)");
          }
      if (!houseColumns.some((column) => column.name === "stugby_json")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN stugby_json TEXT");
          }
      if (!houseColumns.some((column) => column.name === "deleted_at")) {
            this.db.exec("ALTER TABLE houses ADD COLUMN deleted_at TEXT");
          }
      if (addedPropertyDefaultHouse) {
            this.db.exec(`UPDATE properties
              SET default_house_id = (
                SELECT house.id FROM houses AS house
                WHERE house.property_id = properties.id AND house.deleted_at IS NULL
                ORDER BY house.created_at, house.id LIMIT 1
              )`);
          }
      // A short-lived build persisted the Stuguby id as `stugbyId`. Normalize
      // those links before any federation service reads them.
      this.db.exec(`
            UPDATE properties
            SET stugby_json = json_remove(
              json_set(stugby_json, '$.stugubyId', json_extract(stugby_json, '$.stugbyId')),
              '$.stugbyId'
            )
            WHERE stugby_json IS NOT NULL
              AND json_type(stugby_json, '$.stugubyId') IS NULL
              AND json_type(stugby_json, '$.stugbyId') = 'text';
            UPDATE houses
            SET stugby_json = json_remove(
              json_set(stugby_json, '$.stugubyId', json_extract(stugby_json, '$.stugbyId')),
              '$.stugbyId'
            )
            WHERE stugby_json IS NOT NULL
              AND json_type(stugby_json, '$.stugubyId') IS NULL
              AND json_type(stugby_json, '$.stugbyId') = 'text';
          `);
      this.db.exec(`
            DROP INDEX IF EXISTS idx_houses_property_name;
            CREATE INDEX IF NOT EXISTS idx_houses_visible_property_name
              ON houses(property_id, name, id) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_houses_visible_name
              ON houses(name, id) WHERE deleted_at IS NULL;
            DROP TRIGGER IF EXISTS require_house_property_insert;
            CREATE TRIGGER require_house_property_insert
              BEFORE INSERT ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
                OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
              BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
            DROP TRIGGER IF EXISTS require_house_property_update;
            CREATE TRIGGER require_house_property_update
              BEFORE UPDATE OF property_id ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
                OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
              BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
            DROP TRIGGER IF EXISTS validate_property_default_house_insert;
            CREATE TRIGGER validate_property_default_house_insert
              BEFORE INSERT ON properties WHEN NEW.default_house_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM houses AS house
                  WHERE house.id = NEW.default_house_id
                    AND house.property_id = NEW.id
                    AND house.deleted_at IS NULL
                )
              BEGIN SELECT RAISE(ABORT, 'PROPERTY_DEFAULT_HOUSE_INVALID'); END;
            DROP TRIGGER IF EXISTS validate_property_default_house_update;
            CREATE TRIGGER validate_property_default_house_update
              BEFORE UPDATE OF default_house_id ON properties WHEN NEW.default_house_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM houses AS house
                  WHERE house.id = NEW.default_house_id
                    AND house.property_id = NEW.id
                    AND house.deleted_at IS NULL
                )
              BEGIN SELECT RAISE(ABORT, 'PROPERTY_DEFAULT_HOUSE_INVALID'); END;
            DROP TRIGGER IF EXISTS assign_first_property_house;
            CREATE TRIGGER assign_first_property_house
              AFTER INSERT ON houses WHEN NEW.deleted_at IS NULL
              BEGIN
                UPDATE properties SET default_house_id = NEW.id, updated_at = NEW.updated_at
                WHERE id = NEW.property_id AND default_house_id IS NULL;
              END;
            DROP TRIGGER IF EXISTS maintain_property_default_house_after_update;
            CREATE TRIGGER maintain_property_default_house_after_update
              AFTER UPDATE OF property_id, deleted_at ON houses
              BEGIN
                UPDATE properties SET default_house_id = (
                  SELECT house.id FROM houses AS house
                  WHERE house.property_id = OLD.property_id AND house.deleted_at IS NULL
                  ORDER BY house.created_at, house.id LIMIT 1
                ), updated_at = NEW.updated_at
                WHERE id = OLD.property_id AND default_house_id = OLD.id
                  AND (NEW.property_id <> OLD.property_id OR NEW.deleted_at IS NOT NULL);
                UPDATE properties SET default_house_id = NEW.id, updated_at = NEW.updated_at
                WHERE id = NEW.property_id AND default_house_id IS NULL
                  AND NEW.deleted_at IS NULL AND NEW.property_id <> OLD.property_id;
              END;
            DROP TRIGGER IF EXISTS maintain_property_default_house_after_delete;
            CREATE TRIGGER maintain_property_default_house_after_delete
              AFTER DELETE ON houses
              BEGIN
                UPDATE properties SET default_house_id = (
                  SELECT house.id FROM houses AS house
                  WHERE house.property_id = OLD.property_id AND house.deleted_at IS NULL
                  ORDER BY house.created_at, house.id LIMIT 1
                ), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = OLD.property_id AND default_house_id IS NULL;
              END;
          `);
      this.db.exec("PRAGMA optimize");
      const propertyAreaColumns = this.db.prepare("PRAGMA table_info(property_areas)").all() as unknown as Array<{ name: string }>;
      if (!propertyAreaColumns.some((column) => column.name === "location_json")) {
            this.db.exec("ALTER TABLE property_areas ADD COLUMN location_json TEXT");
          }
      const sensorColumns = this.db.prepare("PRAGMA table_info(sensors)").all() as unknown as Array<{ name: string }>;
      if (!sensorColumns.some((column) => column.name === "measurement_entity_ids_json")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN measurement_entity_ids_json TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "tp_link_device_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_device_id TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "tp_link_connection_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_connection_id TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "room_id")) {
            this.db.exec("ALTER TABLE sensors ADD COLUMN room_id TEXT");
          }
      if (!sensorColumns.some((column) => column.name === "energy_meter_role")) {
            this.db.exec(`ALTER TABLE sensors ADD COLUMN energy_meter_role TEXT NOT NULL DEFAULT 'standalone'
              CHECK (energy_meter_role IN ('whole_home', 'submeter', 'standalone'))`);
          }
      const tapoExportColumns = this.db.prepare("PRAGMA table_info(tapo_history_export_jobs)")
            .all() as unknown as Array<{ name: string }>;
      if (!tapoExportColumns.some((column) => column.name === "time_zone")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'");
            this.db.exec(`UPDATE tapo_history_export_jobs
              SET time_zone = COALESCE((
                SELECT house.timezone FROM sensors AS sensor
                JOIN houses AS house ON house.id = sensor.house_id
                WHERE sensor.id = tapo_history_export_jobs.sensor_id
              ), 'UTC')`);
          }
      if (!tapoExportColumns.some((column) => column.name === "submitted_at")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN submitted_at TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "deployment_fingerprint")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN deployment_fingerprint TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "acceptance_revision")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN acceptance_revision TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_artifact_sha256")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_sha256 TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_artifact_bytes")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_bytes INTEGER");
          }
      if (!tapoExportColumns.some((column) => column.name === "parser_version")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN parser_version TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "source_schema_signature")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_schema_signature TEXT");
          }
      if (!tapoExportColumns.some((column) => column.name === "expected_schema_signature")) {
            this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN expected_schema_signature TEXT");
          }
      const tapoApprovalColumns = this.db.prepare("PRAGMA table_info(tapo_history_canary_approvals)")
            .all() as unknown as Array<{ name: string }>;
      if (!tapoApprovalColumns.some((column) => column.name === "acceptance_revision")) {
            this.db.exec(`ALTER TABLE tapo_history_canary_approvals
              ADD COLUMN acceptance_revision TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
          }
      if (!tapoApprovalColumns.some((column) => column.name === "schema_signature")) {
            this.db.exec(`ALTER TABLE tapo_history_canary_approvals
              ADD COLUMN schema_signature TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
            // An approval created before schema fencing cannot safely authorize a
            // future vendor CSV. The completed canary remains available for audit.
            this.db.exec("DELETE FROM tapo_history_canary_approvals");
          }
      this.migrateSensorRoomIds();
    },
});
