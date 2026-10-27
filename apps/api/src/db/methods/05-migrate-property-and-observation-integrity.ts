import { OBSERVATION_CHANGED_FIELDS } from "../support/01-json-value-to-area-equipment-row.js";
import { ObservationRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { observationFromRow } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  migratePropertyAndObservationIntegrity(): void {
      this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_schedule
              ON maintenance_tasks(house_id, status, planned_for, due_by, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_property_schedule
              ON maintenance_tasks(property_id, status, planned_for, due_by, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_area_schedule
              ON maintenance_tasks(area_id, status, planned_for, due_by, updated_at DESC)
              WHERE area_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_equipment_schedule
              ON maintenance_tasks(equipment_id, status, planned_for, due_by, updated_at DESC)
              WHERE equipment_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_list_order
              ON maintenance_tasks(COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id);
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_property_list_order
              ON maintenance_tasks(property_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id);
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_list_order
              ON maintenance_tasks(house_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
              WHERE house_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_area_list_order
              ON maintenance_tasks(area_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
              WHERE area_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_equipment_list_order
              ON maintenance_tasks(equipment_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
              WHERE equipment_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_maintenance_task_observations_observation
              ON maintenance_task_observations(observation_id, maintenance_task_id);
            CREATE INDEX IF NOT EXISTS idx_maintenance_task_revisions_changed
              ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
            CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_insert
              BEFORE INSERT ON maintenance_tasks
              WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
                WHERE house.id = NEW.house_id
                  AND json_extract(floor.value, '$.id') = NEW.floor_id
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
            CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_update
              BEFORE UPDATE OF floor_id, house_id ON maintenance_tasks
              WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
                WHERE house.id = NEW.house_id
                  AND json_extract(floor.value, '$.id') = NEW.floor_id
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
            CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_maintenance
              BEFORE UPDATE OF floors_json ON houses
              WHEN EXISTS (
                SELECT 1 FROM maintenance_tasks AS task
                WHERE task.house_id = OLD.id AND task.floor_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(NEW.floors_json) AS floor
                    WHERE json_extract(floor.value, '$.id') = task.floor_id
                  )
              )
              BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_MAINTENANCE_TASK'); END;
            CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_insert
              BEFORE INSERT ON maintenance_task_observations
              WHEN NOT EXISTS (
                SELECT 1 FROM maintenance_tasks AS task
                JOIN observations AS observation ON observation.id = NEW.observation_id
                WHERE task.id = NEW.maintenance_task_id
                  AND task.house_id IS NOT NULL
                  AND task.house_id = observation.house_id
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
            CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_update
              BEFORE UPDATE OF maintenance_task_id, observation_id ON maintenance_task_observations
              WHEN NOT EXISTS (
                SELECT 1 FROM maintenance_tasks AS task
                JOIN observations AS observation ON observation.id = NEW.observation_id
                WHERE task.id = NEW.maintenance_task_id
                  AND task.house_id IS NOT NULL
                  AND task.house_id = observation.house_id
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
            DROP TRIGGER IF EXISTS validate_linked_maintenance_task_house_update;
            CREATE TRIGGER validate_linked_maintenance_task_house_update
              BEFORE UPDATE OF house_id ON maintenance_tasks
              WHEN EXISTS (
                SELECT 1 FROM maintenance_task_observations AS link
                JOIN observations AS observation ON observation.id = link.observation_id
                WHERE link.maintenance_task_id = OLD.id
                  AND (NEW.house_id IS NULL OR observation.house_id <> NEW.house_id)
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
            CREATE TRIGGER IF NOT EXISTS validate_linked_observation_house_update
              BEFORE UPDATE OF house_id ON observations
              WHEN EXISTS (
                SELECT 1 FROM maintenance_task_observations AS link
                JOIN maintenance_tasks AS task ON task.id = link.maintenance_task_id
                WHERE link.observation_id = OLD.id
                  AND (task.house_id IS NULL OR task.house_id <> NEW.house_id)
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
            CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_insert_collision
              BEFORE INSERT ON maintenance_task_revisions
              WHEN EXISTS (
                SELECT 1 FROM maintenance_task_revisions
                WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision
              )
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
            CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_update
              BEFORE UPDATE ON maintenance_task_revisions
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
            CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_delete
              BEFORE DELETE ON maintenance_task_revisions
              WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
            CREATE TRIGGER IF NOT EXISTS validate_area_equipment_scope_insert
              BEFORE INSERT ON area_equipment
              WHEN (NEW.area_id IS NOT NULL AND NEW.house_id IS NOT NULL)
                OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM property_areas area
                WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
              )) OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM houses house
                WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
              ))
              BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOCATION_SCOPE_MISMATCH'); END;
            CREATE TRIGGER IF NOT EXISTS validate_area_equipment_scope_update
              BEFORE UPDATE OF property_id, area_id, house_id ON area_equipment
              WHEN (NEW.area_id IS NOT NULL AND NEW.house_id IS NOT NULL)
                OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM property_areas area
                WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
              )) OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM houses house
                WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
              ))
              BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOCATION_SCOPE_MISMATCH'); END;
            DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
            DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
            DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
            DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
            CREATE TRIGGER cascade_equipment_scope_move
              AFTER UPDATE OF property_id, area_id, house_id ON area_equipment
              WHEN OLD.property_id <> NEW.property_id
                OR OLD.area_id IS NOT NEW.area_id
                OR OLD.house_id IS NOT NEW.house_id
              BEGIN
                UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at
                  WHERE equipment_id = NEW.id;
                UPDATE maintenance_tasks SET
                  property_id = NEW.property_id,
                  area_id = NEW.area_id,
                  floor_id = CASE
                    WHEN NEW.house_id IS NOT NULL AND house_id IS NEW.house_id THEN floor_id
                    WHEN NEW.house_id IS NOT NULL THEN NULL
                    WHEN house_id IS NULL OR EXISTS (
                    SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                      AND house.property_id = NEW.property_id
                    ) THEN floor_id ELSE NULL END,
                  house_id = CASE
                    WHEN NEW.house_id IS NOT NULL THEN NEW.house_id
                    WHEN house_id IS NULL OR EXISTS (
                    SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                      AND house.property_id = NEW.property_id
                    ) THEN house_id ELSE NULL END
                WHERE equipment_id = NEW.id;
              END;
            DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
            CREATE TRIGGER cascade_property_area_scope_move
              AFTER UPDATE OF property_id ON property_areas
              WHEN OLD.property_id <> NEW.property_id
              BEGIN
                UPDATE area_equipment SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE area_id = NEW.id;
                UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE area_id = NEW.id;
                UPDATE maintenance_tasks SET
                  property_id = NEW.property_id,
                  floor_id = CASE WHEN house_id IS NULL OR EXISTS (
                    SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                      AND house.property_id = NEW.property_id
                  ) THEN floor_id ELSE NULL END,
                  house_id = CASE WHEN house_id IS NULL OR EXISTS (
                    SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                      AND house.property_id = NEW.property_id
                  ) THEN house_id ELSE NULL END
                WHERE area_id = NEW.id AND equipment_id IS NULL;
              END;
            CREATE TRIGGER IF NOT EXISTS validate_property_note_scope_insert
              BEFORE INSERT ON property_notes
              WHEN ((NEW.house_id IS NOT NULL) + (NEW.area_id IS NOT NULL) + (NEW.equipment_id IS NOT NULL)) > 1
                OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
                )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
                )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
                    AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
                ))
              BEGIN SELECT RAISE(ABORT, 'PROPERTY_NOTE_SCOPE_MISMATCH'); END;
            CREATE TRIGGER IF NOT EXISTS validate_property_note_scope_update
              BEFORE UPDATE OF property_id, house_id, area_id, equipment_id ON property_notes
              WHEN ((NEW.house_id IS NOT NULL) + (NEW.area_id IS NOT NULL) + (NEW.equipment_id IS NOT NULL)) > 1
                OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
                )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
                )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
                    AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
                ))
              BEGIN SELECT RAISE(ABORT, 'PROPERTY_NOTE_SCOPE_MISMATCH'); END;
            DROP TRIGGER IF EXISTS validate_maintenance_property_scope_insert;
            DROP TRIGGER IF EXISTS validate_maintenance_property_scope_update;
            CREATE TRIGGER validate_maintenance_property_scope_insert
              BEFORE INSERT ON maintenance_tasks
              WHEN (NEW.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house
                  WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
                )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area
                  WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
                )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
                    AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
                ))
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_PROPERTY_SCOPE_MISMATCH'); END;
            CREATE TRIGGER validate_maintenance_property_scope_update
              BEFORE UPDATE OF property_id, house_id, area_id, equipment_id ON maintenance_tasks
              WHEN (NEW.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house
                  WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
                )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area
                  WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
                )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
                    AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
                ))
              BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_PROPERTY_SCOPE_MISMATCH'); END;
            DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
            DROP TRIGGER IF EXISTS cascade_house_property_move;
            CREATE TRIGGER cascade_house_property_move
              AFTER UPDATE OF property_id ON houses
              WHEN OLD.property_id <> NEW.property_id
              BEGIN
                UPDATE area_equipment SET property_id = NEW.property_id, updated_at = NEW.updated_at
                  WHERE house_id = NEW.id;
                UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE house_id = NEW.id;
                UPDATE maintenance_tasks SET
                  property_id = NEW.property_id,
                  equipment_id = CASE WHEN equipment_id IS NULL OR EXISTS (
                    SELECT 1 FROM area_equipment equipment
                    WHERE equipment.id = maintenance_tasks.equipment_id
                      AND equipment.property_id = NEW.property_id
                  ) THEN equipment_id ELSE NULL END,
                  area_id = CASE WHEN area_id IS NULL OR EXISTS (
                    SELECT 1 FROM property_areas area
                    WHERE area.id = maintenance_tasks.area_id AND area.property_id = NEW.property_id
                  ) THEN area_id ELSE NULL END
                WHERE house_id = NEW.id;
              END;
          `);
      const invalidPropertyScope = this.db.prepare(`
            SELECT resource, id FROM (
              SELECT 'property-area' AS resource, area.id AS id
              FROM property_areas area
              WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = area.property_id)
              UNION ALL
              SELECT 'area-equipment', equipment.id
              FROM area_equipment equipment
              WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = equipment.property_id)
                OR (equipment.area_id IS NOT NULL AND equipment.house_id IS NOT NULL)
                OR (equipment.area_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM property_areas area
                WHERE area.id = equipment.area_id AND area.property_id = equipment.property_id
                ))
                OR (equipment.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house
                  WHERE house.id = equipment.house_id AND house.property_id = equipment.property_id
                ))
              UNION ALL
              SELECT 'property-note', note.id
              FROM property_notes note
              WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = note.property_id)
                OR ((note.house_id IS NOT NULL) + (note.area_id IS NOT NULL) + (note.equipment_id IS NOT NULL)) > 1
                OR (note.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house WHERE house.id = note.house_id AND house.property_id = note.property_id
                ))
                OR (note.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area WHERE area.id = note.area_id AND area.property_id = note.property_id
                ))
                OR (note.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = note.equipment_id AND equipment.property_id = note.property_id
                ))
              UNION ALL
              SELECT 'maintenance-task', task.id
              FROM maintenance_tasks task
              WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = task.property_id)
                OR (task.house_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM houses house WHERE house.id = task.house_id AND house.property_id = task.property_id
                ))
                OR (task.area_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM property_areas area WHERE area.id = task.area_id AND area.property_id = task.property_id
                ))
                OR (task.equipment_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM area_equipment equipment
                  WHERE equipment.id = task.equipment_id AND equipment.property_id = task.property_id
                    AND (task.area_id IS NULL OR equipment.area_id = task.area_id)
                ))
            ) ORDER BY resource, id LIMIT 1
          `).get() as { resource: string; id: string } | undefined;
      if (invalidPropertyScope) {
            throw new Error(
              `INVALID_PROPERTY_SCOPE: ${invalidPropertyScope.resource} ${invalidPropertyScope.id} has an orphaned or conflicting owner`,
            );
          }
      this.db.exec("DROP INDEX IF EXISTS idx_sensors_tp_link_device");
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sensors_tp_link_connection_device
            ON sensors(house_id, COALESCE(tp_link_connection_id, ''), tp_link_device_id)
            WHERE tp_link_device_id IS NOT NULL`);
      const observationColumns = this.db.prepare("PRAGMA table_info(observations)").all() as unknown as Array<{ name: string }>;
      const observationColumnNames = new Set(observationColumns.map((column) => column.name));
      const addObservationColumn = (name: string, sql: string): void => {
            if (!observationColumnNames.has(name)) this.db.exec(sql);
          };
      addObservationColumn("time_precision", `ALTER TABLE observations ADD COLUMN time_precision TEXT NOT NULL DEFAULT 'exact'
            CHECK (time_precision IN ('exact', 'approximate', 'date-only', 'date-range', 'unknown'))`);
      addObservationColumn("valid_from", "ALTER TABLE observations ADD COLUMN valid_from TEXT");
      addObservationColumn("valid_to", "ALTER TABLE observations ADD COLUMN valid_to TEXT");
      addObservationColumn("source", `ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
            CHECK (source IN ('owner', 'caretaker', 'contractor', 'sensor', 'imported-document', 'automated-analysis', 'unknown'))`);
      addObservationColumn("source_detail", "ALTER TABLE observations ADD COLUMN source_detail TEXT");
      addObservationColumn("confidence", `ALTER TABLE observations ADD COLUMN confidence TEXT NOT NULL DEFAULT 'uncertain'
            CHECK (confidence IN ('confirmed', 'probable', 'uncertain', 'awaiting-inspection'))`);
      addObservationColumn("status", `ALTER TABLE observations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open', 'resolved'))`);
      addObservationColumn("resolution_note", "ALTER TABLE observations ADD COLUMN resolution_note TEXT");
      addObservationColumn("resolved_at", "ALTER TABLE observations ADD COLUMN resolved_at TEXT");
      addObservationColumn("revision", "ALTER TABLE observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)");
      addObservationColumn("updated_at", "ALTER TABLE observations ADD COLUMN updated_at TEXT");
      this.db.prepare("UPDATE observations SET updated_at = created_at WHERE updated_at IS NULL").run();
      this.db.prepare(`UPDATE observations
            SET status = 'open', resolution_note = NULL, resolved_at = NULL
            WHERE status IS NULL
              OR status NOT IN ('open', 'resolved')
              OR (status = 'open' AND (resolution_note IS NOT NULL OR resolved_at IS NOT NULL))
              OR (status = 'resolved' AND (resolution_note IS NULL OR length(trim(resolution_note)) = 0 OR resolved_at IS NULL))`).run();
      this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS validate_observation_lifecycle_insert
              BEFORE INSERT ON observations
              WHEN NOT (
                (NEW.status = 'open' AND NEW.resolution_note IS NULL AND NEW.resolved_at IS NULL)
                OR
                (NEW.status = 'resolved' AND NEW.resolution_note IS NOT NULL
                  AND length(trim(NEW.resolution_note)) > 0 AND NEW.resolved_at IS NOT NULL)
              )
              BEGIN SELECT RAISE(ABORT, 'INVALID_OBSERVATION_LIFECYCLE'); END;
            CREATE TRIGGER IF NOT EXISTS validate_observation_lifecycle_update
              BEFORE UPDATE OF status, resolution_note, resolved_at ON observations
              WHEN NOT (
                (NEW.status = 'open' AND NEW.resolution_note IS NULL AND NEW.resolved_at IS NULL)
                OR
                (NEW.status = 'resolved' AND NEW.resolution_note IS NOT NULL
                  AND length(trim(NEW.resolution_note)) > 0 AND NEW.resolved_at IS NOT NULL)
              )
              BEGIN SELECT RAISE(ABORT, 'INVALID_OBSERVATION_LIFECYCLE'); END;
          `);
      const observationRevisionMigration = this.db.prepare(
            "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
          ).get();
      if (!observationRevisionMigration) {
            this.immediateTransaction(() => {
              // Another process may have completed this backfill while BEGIN IMMEDIATE
              // waited for the write lock. Recheck under that lock before scanning or
              // inserting the completion marker.
              if (this.db.prepare(
                "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
              ).get()) return;
              const insertLegacyRevision = this.db.prepare(`INSERT INTO observation_revisions
                (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
                SELECT ?, 1, ?, 'system-service', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM observation_revisions WHERE observation_id = ? AND revision = 1
                )`);
              for (const row of this.db.prepare("SELECT * FROM observations").all() as unknown as ObservationRow[]) {
                const observation = observationFromRow(row);
                insertLegacyRevision.run(
                  observation.id,
                  observation.createdAt,
                  JSON.stringify(OBSERVATION_CHANGED_FIELDS),
                  JSON.stringify(observation),
                  observation.id,
                );
              }
              this.db.prepare("INSERT INTO metadata(key, value) VALUES ('observation_revisions_v1', 'complete')").run();
            });
          }
    },
});
