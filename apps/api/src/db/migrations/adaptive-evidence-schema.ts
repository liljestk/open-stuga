import { ADAPTIVE_METRICS } from "@climate-twin/contracts";
import type { DatabaseSync } from "node:sqlite";

const timestampSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const metricsSql = ADAPTIVE_METRICS.map((metric) => `'${metric}'`).join(", ");

function observeChange(scope: string, id: string, metric = "''"): string {
  return `INSERT INTO adaptive_configuration_generations (scope, entity_id, metric, generation, changed_at)
    VALUES ('${scope}', ${id}, ${metric}, 1, ${timestampSql})
    ON CONFLICT (scope, entity_id, metric) DO UPDATE SET
      generation = generation + 1, changed_at = max(changed_at, excluded.changed_at);`;
}

function changedColumns(columns: string[]): string {
  return columns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(" OR ");
}

const sensorPlacementAndDevice = [
  "house_id", "floor_id", "room_id", "x", "y", "z", "model", "enabled", "tp_link_device_id", "tp_link_connection_id",
];
const metricSemantics = ["unit", "dimension", "allowed_units_json", "kind", "valid_min", "valid_max", "enabled"];

export function migrateAdaptiveEvidence(database: DatabaseSync): void {
  database.exec(`
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('adaptive_evidence_observed_from', ${timestampSql});
    CREATE TABLE IF NOT EXISTS adaptive_configuration_generations (
      scope TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      generation INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      PRIMARY KEY (scope, entity_id, metric)
    );
    CREATE TABLE IF NOT EXISTS adaptive_evidence_epochs (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL,
      house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      sensor_id TEXT NOT NULL,
      metric TEXT NOT NULL CHECK (metric IN (${metricsSql})),
      purpose TEXT NOT NULL CHECK (purpose IN ('climate', 'sensor-comparison')),
      data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
      baseline_id TEXT NOT NULL,
      configuration_digest TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (house_id, data_mode, sensor_id, metric, purpose, baseline_id, configuration_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_adaptive_evidence_epochs_mode ON adaptive_evidence_epochs(data_mode);
    CREATE TRIGGER IF NOT EXISTS adaptive_sensor_created AFTER INSERT ON sensors
      BEGIN ${observeChange("sensor", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_sensor_configuration_changed AFTER UPDATE ON sensors
      WHEN ${changedColumns(sensorPlacementAndDevice)}
      BEGIN ${observeChange("sensor", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_sensor_temperature_changed AFTER UPDATE OF temperature_entity_id ON sensors
      WHEN NEW.temperature_entity_id IS NOT OLD.temperature_entity_id
      BEGIN ${observeChange("binding", "NEW.id", "'temperature'")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_sensor_humidity_changed AFTER UPDATE OF humidity_entity_id ON sensors
      WHEN NEW.humidity_entity_id IS NOT OLD.humidity_entity_id
      BEGIN ${observeChange("binding", "NEW.id", "'humidity'")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_binding_created AFTER INSERT ON sensor_measurement_bindings
      WHEN NEW.metric IN (${metricsSql})
      BEGIN ${observeChange("binding", "NEW.sensor_id", "NEW.metric")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_binding_updated AFTER UPDATE OF entity_id ON sensor_measurement_bindings
      WHEN NEW.metric IN (${metricsSql}) AND NEW.entity_id IS NOT OLD.entity_id
      BEGIN ${observeChange("binding", "NEW.sensor_id", "NEW.metric")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_binding_removed AFTER DELETE ON sensor_measurement_bindings
      WHEN OLD.metric IN (${metricsSql})
      BEGIN ${observeChange("binding", "OLD.sensor_id", "OLD.metric")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_home_assignment_changed AFTER UPDATE OF property_id, timezone, deleted_at ON houses
      WHEN ${changedColumns(["property_id", "timezone", "deleted_at"])}
      BEGIN ${observeChange("home", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_home_weather_changed AFTER UPDATE OF location_json ON houses
      WHEN json_extract(NEW.location_json, '$.latitude') IS NOT json_extract(OLD.location_json, '$.latitude')
        OR json_extract(NEW.location_json, '$.longitude') IS NOT json_extract(OLD.location_json, '$.longitude')
      BEGIN ${observeChange("weather", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS adaptive_measurement_semantics_changed AFTER UPDATE ON measurement_definitions
      WHEN NEW.id IN (${metricsSql}) AND (${changedColumns(metricSemantics)})
      BEGIN ${observeChange("definition", "NEW.id")} END;
  `);
}
