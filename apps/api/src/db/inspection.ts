import type { ClimateDatabase } from "../db.js";

export const TELEMETRY_EXPORT_TABLES = [
  "measurement_samples", "readings", "outdoor_temperature_samples",
  "electricity_price_points", "heat_pump_state_history",
] as const;

export const EXPORT_TABLES = [
  "properties", "houses", "property_areas", "area_equipment", "property_notes", "sensors",
  "measurement_definitions", "alert_rules", "alert_events", "observations", "maintenance_tasks",
  "action_playbooks", "action_runs", "property_electricity_configs", ...TELEMETRY_EXPORT_TABLES,
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];
export interface DatabaseIntegrityResult {
  integrityOk: boolean;
  foreignKeyIssues: number;
}

/** Worker-only on file databases; in-memory fixtures use their own connection. */
export function exportTableCounts(database: ClimateDatabase, tables: readonly ExportTable[]): Record<string, number> {
  return Object.fromEntries(tables.map(table => {
    if (!EXPORT_TABLES.includes(table)) throw new Error("Unknown export table");
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, Number(row.count)];
  }));
}

export function databaseIntegrity(database: ClimateDatabase): DatabaseIntegrityResult {
  const integrity = database.db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  const foreignKeys = database.db.prepare("PRAGMA foreign_key_check").all();
  return { integrityOk: integrity.every(row => row.quick_check === "ok"), foreignKeyIssues: foreignKeys.length };
}
