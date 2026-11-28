import type { DatabaseSync } from "node:sqlite";

export function migrateAdaptiveContext(database: DatabaseSync): void {
  for (const [table, column] of [
    ["opening_state_observations", "adaptive_context_at"],
    ["heat_pump_state_history", "adaptive_context_at"],
    ["adaptive_climate_detector_hours", "context_guard_json"],
  ] as const) {
    if (database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_adaptive_opening_context_time
    ON opening_state_observations(house_id, observed_at) WHERE adaptive_context_at IS NOT NULL`);
}
