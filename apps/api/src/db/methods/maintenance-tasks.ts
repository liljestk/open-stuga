import type { MaintenanceTask, MaintenanceTaskInput, MaintenanceTaskRevision, MaintenanceTaskChangedField, MaintenanceTaskPatch, MaintenanceTaskRevisionActor, PropertyArea } from "@climate-twin/contracts";
import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import { MAINTENANCE_TASK_CHANGED_FIELDS, boundedCollectionLimit, boundedCollectionOffset } from "../support/domain-limits.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/record-types.js";
import { MaintenanceTaskRevisionRow, MaintenanceTaskRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { canonicalMaintenanceObservationIds, maintenanceDate, canonicalMaintenanceLifecycle } from "../support/observation-lifecycle.js";
import { maintenanceTaskFromRow, maintenanceTaskRevisionFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listMaintenanceTasks(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): MaintenanceTask[];
    getMaintenanceTask(id: string): MaintenanceTask | null;
    listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[];
    getOrCreateMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): {
            task: MaintenanceTask;
            created: boolean;
        };
    createMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask;
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
    maintenanceTaskObservationIds(maintenanceTaskId: string): string[];
    replaceMaintenanceTaskObservationLinks(maintenanceTaskId: string, observationIds: string[]): void;
    insertMaintenanceTaskRevision(
        task: MaintenanceTask,
        actor: MaintenanceTaskRevisionActor,
        changedFields: MaintenanceTaskChangedField[],
      ): void;
    ensureScopeMoveCanDetachHouses(where: string, values: string[], propertyId: string): void;
    maintenanceTasksBeforeScopeMove(where: string, values: string[]): MaintenanceTask[];
    recordScopeMoveMaintenanceRevisions(
        previousTasks: readonly MaintenanceTask[],
        actor?: MaintenanceTaskRevisionActor,
      ): void;
    validateMaintenanceTask(task: MaintenanceTask, retainedHiddenHouseId?: string | null): void;
  }

  interface ClimateDatabaseCore {
    listMaintenanceTasks(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): MaintenanceTask[];
    getMaintenanceTask(id: string): MaintenanceTask | null;
    listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[];
    getOrCreateMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): {
            task: MaintenanceTask;
            created: boolean;
        };
    createMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask;
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
  }
}

registerDatabaseMethods({
  listMaintenanceTasks(options: {
      propertyId?: string;
      houseId?: string;
      areaId?: string;
      equipmentId?: string;
      limit?: number;
      offset?: number;
    } = {}): MaintenanceTask[] {
      const clauses: string[] = [];
      const values: string[] = [];
      for (const [column, value] of [
        ["property_id", options.propertyId], ["house_id", options.houseId], ["area_id", options.areaId],
        ["equipment_id", options.equipmentId],
      ] as const) {
        if (value) { clauses.push(`${column} = ?`); values.push(value); }
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT * FROM maintenance_tasks${where}
        ORDER BY COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id LIMIT ? OFFSET ?`)
        .all(...values, boundedCollectionLimit(options.limit), boundedCollectionOffset(options.offset)) as unknown as MaintenanceTaskRow[];
      if (rows.length === 0) return [];
      const taskIds = rows.map((row) => row.id);
      const placeholders = taskIds.map(() => "?").join(", ");
      const links = this.db.prepare(`SELECT maintenance_task_id, observation_id FROM maintenance_task_observations
        WHERE maintenance_task_id IN (${placeholders}) ORDER BY maintenance_task_id, observation_id`)
        .all(...taskIds) as unknown as Array<{
          maintenance_task_id: string;
          observation_id: string;
        }>;
      const observationIdsByTask = new Map<string, string[]>();
      for (const link of links) {
        const observationIds = observationIdsByTask.get(link.maintenance_task_id) ?? [];
        observationIds.push(link.observation_id);
        observationIdsByTask.set(link.maintenance_task_id, observationIds);
      }
      return rows.map((row) => maintenanceTaskFromRow(row, observationIdsByTask.get(row.id) ?? []));
    },
  getMaintenanceTask(id: string): MaintenanceTask | null {
      const row = this.db.prepare("SELECT * FROM maintenance_tasks WHERE id = ?").get(id) as unknown as MaintenanceTaskRow | undefined;
      return row ? maintenanceTaskFromRow(row, this.maintenanceTaskObservationIds(id)) : null;
    },
  listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[] {
      const rows = this.db.prepare(`SELECT * FROM maintenance_task_revisions
        WHERE maintenance_task_id = ? ORDER BY revision`).all(maintenanceTaskId) as unknown as MaintenanceTaskRevisionRow[];
      return rows.map(maintenanceTaskRevisionFromRow);
    },
  getOrCreateMaintenanceTask(
      input: MaintenanceTaskInput,
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): { task: MaintenanceTask; created: boolean } {
      return this.immediateTransaction(() => {
        const id = input.id;
        if (id) {
          const existing = this.getMaintenanceTask(id);
          if (existing) {
            const house = input.houseId ? this.getHouse(input.houseId) : null;
            const expectedPropertyId = input.propertyId?.trim() || house?.propertyId;
            const matches = existing.propertyId === expectedPropertyId
              && existing.houseId === (input.houseId ?? null)
              && existing.floorId === (input.floorId ?? null)
              && existing.areaId === (input.areaId ?? null)
              && existing.equipmentId === (input.equipmentId ?? null)
              && existing.title === input.title.trim()
              && existing.description === (input.description?.trim() || null)
              && existing.basis === input.basis
              && existing.basisDetail === (input.basisDetail?.trim() || null)
              && existing.priority === (input.priority ?? "normal")
              && existing.plannedFor === maintenanceDate(input.plannedFor ?? null, "plannedFor")
              && existing.dueBy === maintenanceDate(input.dueBy ?? null, "dueBy")
              && JSON.stringify(existing.observationIds)
                === JSON.stringify(canonicalMaintenanceObservationIds(input.observationIds ?? []));
            if (!matches) {
              throw new ClimateDataValidationError(
                409,
                "MAINTENANCE_ID_CONFLICT",
                `Maintenance task ${id} already exists with different content`,
              );
            }
            return { task: existing, created: false };
          }
        }
        return { task: this.createMaintenanceTask(input, actor), created: true };
      });
    },
  createMaintenanceTask(
      input: MaintenanceTaskInput,
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): MaintenanceTask {
      return this.immediateTransaction(() => {
        const createdAt = new Date().toISOString();
        const requestedHouseId = input.houseId ?? null;
        const house = requestedHouseId === null ? null : this.getHouse(requestedHouseId);
        if (requestedHouseId !== null && !house) {
          throw new ClimateDataValidationError(
            404,
            "MAINTENANCE_HOUSE_NOT_FOUND",
            `House ${requestedHouseId} does not exist`,
          );
        }
        const propertyId = input.propertyId?.trim() || house?.propertyId;
        if (!propertyId) {
          throw new ClimateDataValidationError(
            422,
            "MAINTENANCE_PROPERTY_REQUIRED",
            "propertyId is required when a maintenance task has no house",
          );
        }
        if (!this.getProperty(propertyId)) {
          throw new ClimateDataValidationError(404, "MAINTENANCE_PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist`);
        }
        if (house && house.propertyId !== propertyId) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
            `House ${house.id} does not belong to property ${propertyId}`,
          );
        }
        const task: MaintenanceTask = {
          id: input.id ?? randomUUID(),
          propertyId,
          houseId: requestedHouseId,
          floorId: input.floorId ?? null,
          areaId: input.areaId ?? null,
          equipmentId: input.equipmentId ?? null,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          basis: input.basis,
          basisDetail: input.basisDetail?.trim() || null,
          priority: input.priority ?? "normal",
          plannedFor: maintenanceDate(input.plannedFor ?? null, "plannedFor"),
          dueBy: maintenanceDate(input.dueBy ?? null, "dueBy"),
          observationIds: canonicalMaintenanceObservationIds(input.observationIds ?? []),
          status: "planned",
          completionNote: null,
          completedAt: null,
          verificationNote: null,
          verifiedAt: null,
          revision: 1,
          createdAt,
          updatedAt: createdAt,
        };
        this.validateMaintenanceTask(task);
        try {
          this.db.prepare(`INSERT INTO maintenance_tasks
            (id, property_id, house_id, floor_id, area_id, equipment_id, title, description, basis, basis_detail, priority, planned_for, due_by,
             status, completion_note, completed_at, verification_note, verified_at, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            task.id, task.propertyId, task.houseId, task.floorId, task.areaId ?? null, task.equipmentId ?? null, task.title, task.description, task.basis, task.basisDetail,
            task.priority, task.plannedFor, task.dueBy, task.status, task.completionNote, task.completedAt,
            task.verificationNote, task.verifiedAt, task.revision, task.createdAt, task.updatedAt,
          );
        } catch (error) {
          if (isSqliteFailure(error, "unique", "maintenance_tasks.id")) {
            throw new ClimateDataValidationError(409, "MAINTENANCE_ID_CONFLICT", `Maintenance task ${task.id} already exists`);
          }
          throw error;
        }
        this.replaceMaintenanceTaskObservationLinks(task.id, task.observationIds);
        this.insertMaintenanceTaskRevision(task, actor, [...MAINTENANCE_TASK_CHANGED_FIELDS]);
        return task;
      });
    },
  updateMaintenanceTask(
      id: string,
      patch: MaintenanceTaskPatch,
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): MaintenanceTask | null {
      return this.immediateTransaction(() => {
        const current = this.getMaintenanceTask(id);
        if (!current) return null;
        if (patch.baseRevision !== current.revision) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_REVISION_CONFLICT",
            `Maintenance task ${id} is at revision ${current.revision}; reload it before applying this change`,
          );
        }
        const changedAt = new Date().toISOString();
        const lifecycle = canonicalMaintenanceLifecycle(current, patch, changedAt);
        const next: MaintenanceTask = {
          ...current,
          ...(patch.houseId !== undefined ? { houseId: patch.houseId } : {}),
          ...(patch.floorId !== undefined ? { floorId: patch.floorId } : {}),
          ...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
          ...(patch.equipmentId !== undefined ? { equipmentId: patch.equipmentId } : {}),
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
          ...(patch.basis !== undefined ? { basis: patch.basis } : {}),
          ...(patch.basisDetail !== undefined ? { basisDetail: patch.basisDetail?.trim() || null } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.plannedFor !== undefined ? { plannedFor: maintenanceDate(patch.plannedFor, "plannedFor") } : {}),
          ...(patch.dueBy !== undefined ? { dueBy: maintenanceDate(patch.dueBy, "dueBy") } : {}),
          ...(patch.observationIds !== undefined
            ? { observationIds: canonicalMaintenanceObservationIds(patch.observationIds) }
            : {}),
          ...lifecycle,
        };
        const currentObservationIds = new Set(current.observationIds);
        const retainedHiddenHouseId = next.houseId === current.houseId
          && next.floorId === current.floorId
          && next.observationIds.every((observationId) => currentObservationIds.has(observationId))
          ? current.houseId
          : null;
        this.validateMaintenanceTask(next, retainedHiddenHouseId);
        const changedFields = MAINTENANCE_TASK_CHANGED_FIELDS.filter((field) => (
          field === "observationIds"
            ? JSON.stringify(current.observationIds) !== JSON.stringify(next.observationIds)
            : !Object.is(current[field], next[field])
        ));
        if (changedFields.length === 0) return current;
        next.revision = current.revision + 1;
        next.updatedAt = changedAt;
        if (changedFields.includes("observationIds")) {
          this.db.prepare("DELETE FROM maintenance_task_observations WHERE maintenance_task_id = ?").run(id);
        }
        const result = this.db.prepare(`UPDATE maintenance_tasks SET
          house_id = ?, floor_id = ?, area_id = ?, equipment_id = ?, title = ?, description = ?, basis = ?, basis_detail = ?, priority = ?, planned_for = ?, due_by = ?,
          status = ?, completion_note = ?, completed_at = ?, verification_note = ?, verified_at = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?`).run(
          next.houseId, next.floorId, next.areaId ?? null, next.equipmentId ?? null, next.title, next.description, next.basis, next.basisDetail, next.priority, next.plannedFor,
          next.dueBy, next.status, next.completionNote, next.completedAt, next.verificationNote, next.verifiedAt,
          next.revision, next.updatedAt, id, patch.baseRevision,
        );
        if (Number(result.changes) !== 1) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_REVISION_CONFLICT",
            "Maintenance task changed while the patch was being applied",
          );
        }
        if (changedFields.includes("observationIds")) {
          this.replaceMaintenanceTaskObservationLinks(id, next.observationIds);
        }
        this.insertMaintenanceTaskRevision(next, actor, changedFields);
        return next;
      });
    },
  deleteMaintenanceTask(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM maintenance_tasks WHERE id = ?").run(id).changes) > 0;
    },
  maintenanceTaskObservationIds(maintenanceTaskId: string): string[] {
      const rows = this.db.prepare(`SELECT observation_id FROM maintenance_task_observations
        WHERE maintenance_task_id = ? ORDER BY observation_id`).all(maintenanceTaskId) as unknown as Array<{ observation_id: string }>;
      return rows.map((row) => row.observation_id);
    },
  replaceMaintenanceTaskObservationLinks(maintenanceTaskId: string, observationIds: string[]): void {
      this.db.prepare("DELETE FROM maintenance_task_observations WHERE maintenance_task_id = ?").run(maintenanceTaskId);
      const insert = this.db.prepare(`INSERT INTO maintenance_task_observations
        (maintenance_task_id, observation_id) VALUES (?, ?)`);
      for (const observationId of observationIds) insert.run(maintenanceTaskId, observationId);
    },
  insertMaintenanceTaskRevision(
      task: MaintenanceTask,
      actor: MaintenanceTaskRevisionActor,
      changedFields: MaintenanceTaskChangedField[],
    ): void {
      this.db.prepare(`INSERT INTO maintenance_task_revisions
        (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        task.id, task.revision, task.updatedAt, actor, JSON.stringify(changedFields), JSON.stringify(task),
      );
    },
  /** Capture tasks before a parent move so trigger-cascaded scope changes remain visible in revision history. */
  ensureScopeMoveCanDetachHouses(where: string, values: string[], propertyId: string): void {
      const linked = this.db.prepare(`SELECT task.id FROM maintenance_tasks task
        JOIN houses house ON house.id = task.house_id
        JOIN maintenance_task_observations link ON link.maintenance_task_id = task.id
        WHERE (${where}) AND house.property_id <> ? LIMIT 1`).get(...values, propertyId) as { id: string } | undefined;
      if (linked) {
        throw new ClimateDataValidationError(
          409,
          "PROPERTY_MOVE_HAS_LINKED_EVIDENCE",
          `Maintenance task ${linked.id} has house observation evidence; move or unlink that task before moving this resource`,
        );
      }
    },
  maintenanceTasksBeforeScopeMove(where: string, values: string[]): MaintenanceTask[] {
      const rows = this.db.prepare(`SELECT id FROM maintenance_tasks WHERE ${where}`).all(...values) as Array<{ id: string }>;
      return rows.flatMap(({ id }) => {
        const task = this.getMaintenanceTask(id);
        return task ? [task] : [];
      });
    },
  recordScopeMoveMaintenanceRevisions(
      previousTasks: readonly MaintenanceTask[],
      actor: MaintenanceTaskRevisionActor = "local-rest",
    ): void {
      for (const previous of previousTasks) {
        const cascaded = this.getMaintenanceTask(previous.id);
        if (!cascaded) continue;
        const changedFields = MAINTENANCE_TASK_CHANGED_FIELDS.filter((field) => (
          field === "observationIds"
            ? JSON.stringify(previous.observationIds) !== JSON.stringify(cascaded.observationIds)
            : !Object.is(previous[field], cascaded[field])
        ));
        if (changedFields.length === 0) continue;
        const next: MaintenanceTask = {
          ...cascaded,
          revision: cascaded.revision + 1,
          updatedAt: this.nextUpdatedAt(cascaded.updatedAt),
        };
        this.db.prepare("UPDATE maintenance_tasks SET revision = ?, updated_at = ? WHERE id = ?")
          .run(next.revision, next.updatedAt, next.id);
        this.insertMaintenanceTaskRevision(next, actor, changedFields);
      }
    },
  validateMaintenanceTask(task: MaintenanceTask, retainedHiddenHouseId: string | null = null): void {
      if (!this.getProperty(task.propertyId)) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_PROPERTY_NOT_FOUND",
          `Property ${task.propertyId} does not exist`,
        );
      }
      const house = task.houseId === null ? null : this.getHouse(task.houseId);
      const retainingHiddenHouse = task.houseId !== null && !house && task.houseId === retainedHiddenHouseId;
      if (task.houseId !== null && !house && !retainingHiddenHouse) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_HOUSE_NOT_FOUND",
          `House ${task.houseId} does not exist`,
        );
      }
      if (house && house.propertyId !== task.propertyId) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
          `House ${house.id} does not belong to property ${task.propertyId}`,
        );
      }
      if (task.floorId !== null && !house && !retainingHiddenHouse) {
        throw new ClimateDataValidationError(
          422,
          "MAINTENANCE_HOUSE_REQUIRED",
          "A maintenance floor requires a house",
        );
      }
      if (task.floorId !== null && house && !house.floors.some((floor) => floor.id === task.floorId)) {
        throw new ClimateDataValidationError(
          422,
          "MAINTENANCE_FLOOR_NOT_FOUND",
          `Floor ${task.floorId} does not belong to house ${task.houseId}`,
        );
      }
      const areaId = task.areaId ?? null;
      const equipmentId = task.equipmentId ?? null;
      let area: PropertyArea | null = null;
      if (areaId !== null) {
        area = this.getPropertyArea(areaId);
        if (!area) {
          throw new ClimateDataValidationError(404, "MAINTENANCE_AREA_NOT_FOUND", `Area ${areaId} does not exist`);
        }
        if (area.propertyId !== task.propertyId) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
            `Area ${areaId} does not belong to property ${task.propertyId}`,
          );
        }
      }
      if (equipmentId !== null) {
        const equipment = this.getAreaEquipment(equipmentId);
        if (!equipment) {
          throw new ClimateDataValidationError(
            404,
            "MAINTENANCE_EQUIPMENT_NOT_FOUND",
            `Equipment ${equipmentId} does not exist`,
          );
        }
        if (equipment.propertyId !== task.propertyId || (area && equipment.areaId !== area.id)) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
            `Equipment ${equipmentId} does not belong to the selected property and area`,
          );
        }
      }
      if (!task.title.trim() || Array.from(task.title).length > 200) {
        throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_TITLE", "Maintenance title must be 1 to 200 characters");
      }
      for (const [field, value] of [
        ["description", task.description], ["basisDetail", task.basisDetail],
        ["completionNote", task.completionNote], ["verificationNote", task.verificationNote],
      ] as const) {
        if (value !== null && (!value.trim() || Array.from(value).length > 5_000)) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_MAINTENANCE_TEXT",
            `${field} must be a non-empty string of at most 5000 characters or null`,
          );
        }
      }
      if (!["required", "scheduled", "condition-based", "predictive", "optional-improvement"].includes(task.basis)) {
        throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_BASIS", "Maintenance basis is not supported");
      }
      if (!["low", "normal", "high", "urgent"].includes(task.priority)) {
        throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_PRIORITY", "Maintenance priority is not supported");
      }
      maintenanceDate(task.plannedFor, "plannedFor");
      maintenanceDate(task.dueBy, "dueBy");
      if (task.plannedFor !== null && task.dueBy !== null && task.plannedFor > task.dueBy) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_MAINTENANCE_SCHEDULE",
          "plannedFor must be before or equal to dueBy",
        );
      }
      if (task.basis === "predictive" && task.dueBy !== null) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_MAINTENANCE_SCHEDULE",
          "Predictive maintenance cannot claim a formal dueBy date",
        );
      }
      if (task.observationIds.length > 100
        || task.observationIds.length !== new Set(task.observationIds).size
        || task.observationIds.some((id) => !id.trim() || Array.from(id).length > 200)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_MAINTENANCE_OBSERVATIONS",
          "observationIds must contain at most 100 unique, non-empty identifiers of at most 200 characters",
        );
      }
      if (task.observationIds.length > 0 && !house && !retainingHiddenHouse) {
        throw new ClimateDataValidationError(
          422,
          "MAINTENANCE_HOUSE_REQUIRED",
          "Maintenance observation evidence requires a house",
        );
      }
      for (const observationId of retainingHiddenHouse ? [] : task.observationIds) {
        const observation = this.getObservation(observationId);
        if (!observation) {
          throw new ClimateDataValidationError(
            404,
            "MAINTENANCE_OBSERVATION_NOT_FOUND",
            `Observation ${observationId} does not exist`,
          );
        }
        if (observation.houseId !== house!.id) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_OBSERVATION_SCOPE_MISMATCH",
            `Observation ${observationId} does not belong to house ${task.houseId}`,
          );
        }
      }
      const lifecycleIsValid = task.status === "completed"
        ? Boolean(task.completionNote?.trim() && task.completedAt && task.verificationNote === null && task.verifiedAt === null)
        : task.status === "verified"
          ? Boolean(task.completionNote?.trim() && task.completedAt && task.verificationNote?.trim() && task.verifiedAt)
          : task.completionNote === null && task.completedAt === null
            && task.verificationNote === null && task.verifiedAt === null;
      if (!lifecycleIsValid) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_MAINTENANCE_LIFECYCLE",
          "Maintenance completion and verification fields do not match its status",
        );
      }
    },
});
