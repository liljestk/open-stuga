import type { DatabaseSync } from "node:sqlite";

const TRACKING_TABLES_IN_DROP_ORDER = [
  "property_member_locations",
  "equipment_loans",
  "tracking_boundary_states",
  "tracking_events",
  "equipment_current_locations",
  "equipment_location_estimates",
  "tracking_gateway_rollups",
  "tracking_observations",
  "equipment_tracking_bindings",
  "tracking_endpoints",
  "tracking_observers",
  "tracking_property_settings",
  "tracking_asset_tag_assignments",
  "tracking_tags",
] as const;

function columns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

/**
 * Early tracking previews used tag-centric tables with names later reused by
 * the profile-driven model. Rebuild only when every affected table is empty;
 * non-empty legacy evidence must be handled by an explicit data migration.
 */
export function migrateEmptyLegacyTrackingSchema(database: DatabaseSync): void {
  const observationColumns = columns(database, "tracking_observations");
  if (observationColumns.size === 0
    || ["data_mode", "endpoint_id", "equipment_id", "binding_id"].every(
      (column) => observationColumns.has(column),
    )) return;

  const existing = TRACKING_TABLES_IN_DROP_ORDER.filter((table) => tableExists(database, table));
  const nonEmpty = existing.filter((table) => Boolean(
    database.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get(),
  ));
  if (nonEmpty.length > 0) {
    throw new Error(
      `Legacy tracking data requires an explicit migration before startup (${nonEmpty.join(", ")})`,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS prevent_bound_equipment_property_move;
      DROP TRIGGER IF EXISTS cascade_equipment_loan_scope_move;
      ${existing.map((table) => `DROP TABLE "${table}";`).join("\n")}
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
