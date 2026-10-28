import type { Floor } from "@climate-twin/contracts";
import { parseJson } from "../support/json-values.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateEquipmentPlacementTable(): void;
    migrate(): void;
    migrateSensorRoomIds(): void;
  }

  interface ClimateDatabaseCore {
    migrate(): void;
  }
}

registerDatabaseMethods({
  /**
     * SQLite cannot remove the legacy NOT NULL constraint from `area_id` with
     * ALTER TABLE. Rebuild only this table before the normal transactional
     * migration so existing equipment can later target a Home or stay
     * unassigned without manufacturing a fake Property area.
     */
  migrateEquipmentPlacementTable(): void {
      const columns = this.db.prepare("PRAGMA table_info(area_equipment)").all() as unknown as Array<{
        name: string;
        notnull: number;
      }>;
      if (columns.length === 0) return;
      const area = columns.find((column) => column.name === "area_id");
      const hasHouse = columns.some((column) => column.name === "house_id");
      const hasLocation = columns.some((column) => column.name === "location_json");
      if (area?.notnull === 0 && hasHouse && hasLocation) return;

      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(`
          DROP TABLE IF EXISTS area_equipment_location_next;
          CREATE TABLE area_equipment_location_next (
            id TEXT PRIMARY KEY,
            property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
            area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
            house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
            location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
            name TEXT NOT NULL CHECK (length(trim(name)) > 0),
            kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
            manufacturer TEXT,
            model TEXT,
            serial_number TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((area_id IS NOT NULL) + (house_id IS NOT NULL) <= 1)
          );
          INSERT INTO area_equipment_location_next (
            id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          )
          SELECT id, property_id,
            ${hasHouse ? "CASE WHEN house_id IS NULL THEN area_id ELSE NULL END" : "area_id"},
            ${hasHouse ? "house_id" : "NULL"},
            ${hasLocation ? "location_json" : "NULL"},
            name, kind, manufacturer, model, serial_number, status, notes, created_at, updated_at
          FROM area_equipment;
          DROP TABLE area_equipment;
          CREATE TABLE area_equipment (
            id TEXT PRIMARY KEY,
            property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
            area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
            house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
            location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
            name TEXT NOT NULL CHECK (length(trim(name)) > 0),
            kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
            manufacturer TEXT,
            model TEXT,
            serial_number TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((area_id IS NOT NULL) + (house_id IS NOT NULL) <= 1)
          );
          INSERT INTO area_equipment (
            id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          )
          SELECT id, property_id, area_id, house_id, location_json, name, kind,
            manufacturer, model, serial_number, status, notes, created_at, updated_at
          FROM area_equipment_location_next;
          DROP TABLE area_equipment_location_next;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* The failed statement may already have rolled back. */ }
        throw error;
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON");
      }
    },
  migrate(): void {
      this.immediateTransaction(() => {
        this.migrateCoreAndResourceSchema();
        this.migrateSensorAndNotificationSchema();
        this.migrateMaintenanceOwnership();
        this.migratePropertyAndObservationIntegrity();
        this.migrateMeasurementAndActionSchema();
      });
    },
  /**
     * Links legacy room labels only when one room on the sensor's selected floor
     * has the exact same name. The completion marker is important: an explicitly
     * cleared relationship must not be silently recreated on a later restart.
     */
  migrateSensorRoomIds(): void {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_room_ids_v1'").get()) return;
      const rows = this.db.prepare(`SELECT sensor.id, sensor.floor_id, sensor.room, house.floors_json
        FROM sensors AS sensor
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE sensor.room_id IS NULL
        ORDER BY sensor.id`).all() as unknown as Array<{
          id: string;
          floor_id: string;
          room: string;
          floors_json: string;
        }>;
      const link = this.db.prepare("UPDATE sensors SET room_id = ? WHERE id = ? AND room_id IS NULL");
      for (const row of rows) {
        try {
          const floor = parseJson<Floor[]>(row.floors_json).find((candidate) => candidate.id === row.floor_id);
          const matches = floor?.rooms.filter((candidate) => candidate.name === row.room) ?? [];
          if (matches.length === 1) link.run(matches[0]!.id, row.id);
        } catch {
          // Preserve an unlinked legacy label when old layout JSON cannot be
          // interpreted safely; normal layout validation can repair it later.
        }
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_room_ids_v1', 'complete')").run();
    },
});
