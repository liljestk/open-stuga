import { DEFAULT_PROPERTY_ID } from "../support/domain-limits.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateMaintenanceOwnership(): void;
  }
}

registerDatabaseMethods({
  migrateMaintenanceOwnership(): void {
      // Removal of the obsolete external forwarding queue is intentionally irreversible;
          // discard legacy queued payloads during startup instead of retaining a
          // dormant copy of local measurements.
          this.db.exec("DROP TABLE IF EXISTS measurement_forward_outbox");
      let maintenanceTaskColumns = this.db.prepare("PRAGMA table_info(maintenance_tasks)")
            .all() as unknown as Array<{ name: string; notnull: number }>;
      if (!maintenanceTaskColumns.some((column) => column.name === "area_id")) {
            this.db.exec("ALTER TABLE maintenance_tasks ADD COLUMN area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT");
          }
      if (!maintenanceTaskColumns.some((column) => column.name === "equipment_id")) {
            this.db.exec("ALTER TABLE maintenance_tasks ADD COLUMN equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT");
          }
      maintenanceTaskColumns = this.db.prepare("PRAGMA table_info(maintenance_tasks)")
            .all() as unknown as Array<{ name: string; notnull: number }>;
      const maintenanceHouseColumn = maintenanceTaskColumns.find((column) => column.name === "house_id");
      if (!maintenanceTaskColumns.some((column) => column.name === "property_id") || maintenanceHouseColumn?.notnull === 1) {
            const propertyExpression = maintenanceTaskColumns.some((column) => column.name === "property_id")
              ? "COALESCE(task.property_id, house.property_id)"
              : "house.property_id";
            this.db.exec(`
              DROP TABLE IF EXISTS temp.maintenance_task_observations_migration;
              DROP TABLE IF EXISTS temp.maintenance_task_revisions_migration;
              CREATE TABLE maintenance_tasks_next (
                id TEXT PRIMARY KEY,
                property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
                house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
                floor_id TEXT,
                area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
                equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
                title TEXT NOT NULL CHECK (length(trim(title)) > 0),
                description TEXT,
                basis TEXT NOT NULL CHECK (basis IN ('required', 'scheduled', 'condition-based', 'predictive', 'optional-improvement')),
                basis_detail TEXT,
                priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
                planned_for TEXT,
                due_by TEXT,
                status TEXT NOT NULL CHECK (status IN ('planned', 'in-progress', 'completed', 'verified', 'cancelled')),
                completion_note TEXT,
                completed_at TEXT,
                verification_note TEXT,
                verified_at TEXT,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (planned_for IS NULL OR due_by IS NULL OR planned_for <= due_by),
                CHECK (basis <> 'predictive' OR due_by IS NULL),
                CHECK (
                  (status IN ('planned', 'in-progress', 'cancelled')
                    AND completion_note IS NULL AND completed_at IS NULL
                    AND verification_note IS NULL AND verified_at IS NULL)
                  OR
                  (status = 'completed'
                    AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
                    AND verification_note IS NULL AND verified_at IS NULL)
                  OR
                  (status = 'verified'
                    AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
                    AND verification_note IS NOT NULL AND length(trim(verification_note)) > 0 AND verified_at IS NOT NULL)
                )
              );
              INSERT INTO maintenance_tasks_next(
                id, property_id, house_id, floor_id, area_id, equipment_id, title, description, basis, basis_detail,
                priority, planned_for, due_by, status, completion_note, completed_at, verification_note, verified_at,
                revision, created_at, updated_at
              )
              SELECT task.id, ${propertyExpression}, task.house_id, task.floor_id, task.area_id, task.equipment_id,
                task.title, task.description, task.basis, task.basis_detail, task.priority, task.planned_for, task.due_by,
                task.status, task.completion_note, task.completed_at, task.verification_note, task.verified_at,
                task.revision, task.created_at, task.updated_at
              FROM maintenance_tasks AS task
              LEFT JOIN houses AS house ON house.id = task.house_id;
              CREATE TEMP TABLE maintenance_task_observations_migration AS
                SELECT maintenance_task_id, observation_id FROM maintenance_task_observations;
              CREATE TEMP TABLE maintenance_task_revisions_migration AS
                SELECT revision.maintenance_task_id, revision.revision, revision.changed_at,
                  CASE revision.actor
                    WHEN 'hosted-user' THEN 'workspace-user'
                    WHEN 'hosted-service' THEN 'system-service'
                    ELSE revision.actor
                  END AS actor,
                  revision.changed_fields_json,
                  json_set(revision.snapshot_json,
                    '$.propertyId', task.property_id,
                    '$.houseId', task.house_id) AS snapshot_json
                FROM maintenance_task_revisions AS revision
                JOIN maintenance_tasks_next AS task ON task.id = revision.maintenance_task_id;
              DROP TRIGGER IF EXISTS validate_maintenance_observation_scope_insert;
              DROP TRIGGER IF EXISTS validate_maintenance_observation_scope_update;
              DROP TRIGGER IF EXISTS prevent_house_floor_orphaned_maintenance;
              DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
              DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
              DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
              DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
              DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
              DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
              DROP TRIGGER IF EXISTS cascade_house_property_move;
              DROP TRIGGER IF EXISTS validate_linked_observation_house_update;
              DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_insert_collision;
              DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_update;
              DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_delete;
              DROP TABLE maintenance_task_observations;
              DROP TABLE maintenance_task_revisions;
              DROP TABLE maintenance_tasks;
              ALTER TABLE maintenance_tasks_next RENAME TO maintenance_tasks;
              CREATE TABLE maintenance_task_observations (
                maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
                observation_id TEXT NOT NULL,
                PRIMARY KEY (maintenance_task_id, observation_id),
                FOREIGN KEY (observation_id) REFERENCES observations(id)
                  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
              );
              INSERT INTO maintenance_task_observations(maintenance_task_id, observation_id)
                SELECT maintenance_task_id, observation_id FROM maintenance_task_observations_migration;
              CREATE TABLE maintenance_task_revisions (
                maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                changed_at TEXT NOT NULL,
                actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
                changed_fields_json TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                PRIMARY KEY (maintenance_task_id, revision)
              );
              INSERT INTO maintenance_task_revisions(
                maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json
              ) SELECT maintenance_task_id, revision, changed_at,
                  CASE actor
                    WHEN 'hosted-user' THEN 'workspace-user'
                    WHEN 'hosted-service' THEN 'system-service'
                    WHEN 'local-migration' THEN 'system-service'
                    ELSE actor
                  END,
                  changed_fields_json, snapshot_json
                FROM maintenance_task_revisions_migration;
              DROP TABLE maintenance_task_observations_migration;
              DROP TABLE maintenance_task_revisions_migration;
            `);
          }
      this.migrateRevisionActors();
      this.migrateSecurityAuditSubjectTypes();
      const maintenanceTasksWithLegacyPropertyScope = this.maintenanceTasksBeforeScopeMove(`
            NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = maintenance_tasks.property_id)
            OR (house_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM houses house
              WHERE house.id = maintenance_tasks.house_id AND house.property_id = maintenance_tasks.property_id
            ))
            OR (area_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM property_areas area
              WHERE area.id = maintenance_tasks.area_id AND area.property_id = maintenance_tasks.property_id
            ))
            OR (equipment_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM area_equipment equipment
              WHERE equipment.id = maintenance_tasks.equipment_id
                AND equipment.property_id = maintenance_tasks.property_id
                AND (maintenance_tasks.area_id IS NULL OR equipment.area_id = maintenance_tasks.area_id)
            ))
          `, []);
      // Repair legacy ownership columns from their closest valid parent before
          // reinstating the scope triggers. Databases created while foreign-key
          // enforcement was disabled can otherwise retain non-empty orphan IDs.
          this.db.exec(`
            DROP TRIGGER IF EXISTS validate_area_equipment_scope_insert;
            DROP TRIGGER IF EXISTS validate_area_equipment_scope_update;
            DROP TRIGGER IF EXISTS validate_property_note_scope_insert;
            DROP TRIGGER IF EXISTS validate_property_note_scope_update;
            DROP TRIGGER IF EXISTS validate_maintenance_property_scope_insert;
            DROP TRIGGER IF EXISTS validate_maintenance_property_scope_update;
            DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
            DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
            DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
            DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
            DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
            DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
            DROP TRIGGER IF EXISTS cascade_house_property_move;

            UPDATE property_areas SET property_id = '${DEFAULT_PROPERTY_ID}'
            WHERE property_id IS NULL OR trim(property_id) = ''
              OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = property_areas.property_id);

            UPDATE area_equipment SET
              area_id = CASE WHEN area_id IS NULL OR EXISTS (
                SELECT 1 FROM property_areas area WHERE area.id = area_equipment.area_id
              ) THEN area_id ELSE NULL END,
              house_id = CASE WHEN house_id IS NULL OR EXISTS (
                SELECT 1 FROM houses house WHERE house.id = area_equipment.house_id
              ) THEN house_id ELSE NULL END;

            UPDATE area_equipment
            SET property_id = COALESCE(
              (SELECT area.property_id FROM property_areas area WHERE area.id = area_equipment.area_id),
              (SELECT house.property_id FROM houses house WHERE house.id = area_equipment.house_id),
              CASE WHEN EXISTS (SELECT 1 FROM properties property WHERE property.id = area_equipment.property_id)
                THEN property_id ELSE '${DEFAULT_PROPERTY_ID}' END
            );

            UPDATE property_notes
            SET property_id = COALESCE(
              (SELECT equipment.property_id FROM area_equipment equipment WHERE equipment.id = property_notes.equipment_id),
              (SELECT area.property_id FROM property_areas area WHERE area.id = property_notes.area_id),
              (SELECT house.property_id FROM houses house WHERE house.id = property_notes.house_id),
              CASE WHEN EXISTS (SELECT 1 FROM properties property WHERE property.id = property_notes.property_id)
                THEN property_id ELSE '${DEFAULT_PROPERTY_ID}' END
            );

            UPDATE maintenance_tasks
            SET property_id = COALESCE(
              (SELECT equipment.property_id FROM area_equipment equipment WHERE equipment.id = maintenance_tasks.equipment_id),
              (SELECT area.property_id FROM property_areas area WHERE area.id = maintenance_tasks.area_id),
              (SELECT house.property_id FROM houses house WHERE house.id = maintenance_tasks.house_id),
              CASE WHEN EXISTS (SELECT 1 FROM properties property WHERE property.id = maintenance_tasks.property_id)
                THEN property_id ELSE '${DEFAULT_PROPERTY_ID}' END
            );
          `);
      // Ownership repair is an effective task mutation. Keep live state and its
          // append-only audit history aligned even for databases damaged while
          // foreign-key enforcement or the scope triggers were disabled.
          this.recordScopeMoveMaintenanceRevisions(maintenanceTasksWithLegacyPropertyScope, "system-service");
    },
});
