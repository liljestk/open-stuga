import { isOneOf, OBSERVATION_CONFIDENCES, OBSERVATION_SOURCES } from "@climate-twin/contracts";
import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import type {
  MaintenanceTask,
  MaintenanceTaskInput,
  MaintenanceTaskRevision,
  ManualObservation,
  ManualObservationPatch,
  ObservationChangedField,
} from "@climate-twin/contracts";
import { MAINTENANCE_TASK_CHANGED_FIELDS, OBSERVATION_CHANGED_FIELDS, boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor, LocalObservationRevisionActor, MaintenanceTaskRevisionRow, MaintenanceTaskRow, StoredObservation } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { canonicalMaintenanceObservationIds, canonicalObservationPatchLifecycle, maintenanceDate, maintenanceTaskFromRow, maintenanceTaskRevisionFromRow } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import { canonicalObservationPatchTime } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  updateObservation(
      id: string,
      patch: ManualObservationPatch,
      actor: LocalObservationRevisionActor = "local-rest",
    ): ManualObservation | null {
      return this.immediateTransaction(() => {
        const current = this.getObservation(id);
        if (!current) return null;
        if (patch.baseRevision !== current.revision) {
          throw new ClimateDataValidationError(
            409,
            "OBSERVATION_REVISION_CONFLICT",
            `Observation ${id} is at revision ${current.revision}; reload it before applying this change`,
          );
        }
        const temporal = canonicalObservationPatchTime(current, patch);
        const changedAt = new Date().toISOString();
        const lifecycle = canonicalObservationPatchLifecycle(current, patch, changedAt);
        const next: StoredObservation = {
          ...current,
          ...(patch.floorId !== undefined ? { floorId: patch.floorId } : {}),
          ...(patch.sensorId !== undefined ? { sensorId: patch.sensorId } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.x !== undefined ? { x: patch.x } : {}),
          ...(patch.y !== undefined ? { y: patch.y } : {}),
          ...temporal,
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.sourceDetail !== undefined ? { sourceDetail: patch.sourceDetail } : {}),
          ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
          ...lifecycle,
        };
        this.validateObservation(
          next,
          (patch.sensorId !== undefined && patch.sensorId !== current.sensorId)
            || (patch.floorId !== undefined && patch.floorId !== current.floorId),
        );
        const changedFields = OBSERVATION_CHANGED_FIELDS.filter((field) => !Object.is(current[field], next[field]));
        if (changedFields.length === 0) return current;
        next.revision = current.revision + 1;
        next.updatedAt = changedAt;
        const result = this.db.prepare(`UPDATE observations SET
          floor_id = ?, sensor_id = ?, kind = ?, severity = ?, note = ?, x = ?, y = ?, occurred_at = ?,
          time_precision = ?, valid_from = ?, valid_to = ?, source = ?, source_detail = ?, confidence = ?,
          status = ?, resolution_note = ?, resolved_at = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
          .run(next.floorId, next.sensorId, next.kind, next.severity, next.note, next.x, next.y, next.occurredAt,
            next.timePrecision, next.validFrom, next.validTo, next.source, next.sourceDetail, next.confidence,
            next.status, next.resolutionNote, next.resolvedAt, next.revision, next.updatedAt, id, patch.baseRevision);
        if (Number(result.changes) !== 1) {
          throw new ClimateDataValidationError(409, "OBSERVATION_REVISION_CONFLICT", "Observation changed while the patch was being applied");
        }
        this.insertObservationRevision(next, actor, changedFields);
        return next;
      });
    },
  deleteObservation(id: string): boolean {
      if (!this.getObservation(id)) return false;
      const linked = this.db.prepare(`SELECT maintenance_task_id FROM maintenance_task_observations
        WHERE observation_id = ? ORDER BY maintenance_task_id LIMIT 1`).get(id) as { maintenance_task_id: string } | undefined;
      if (linked) {
        throw new ClimateDataValidationError(
          409,
          "OBSERVATION_LINKED_TO_MAINTENANCE",
          `Observation ${id} is linked to maintenance task ${linked.maintenance_task_id}; unlink it before deletion`,
        );
      }
      return Number(this.db.prepare("DELETE FROM observations WHERE id = ?").run(id).changes) > 0;
    },
  insertObservationRevision(
      observation: StoredObservation,
      actor: LocalObservationRevisionActor,
      changedFields: ObservationChangedField[],
    ): void {
      this.db.prepare(`INSERT INTO observation_revisions
        (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(observation.id, observation.revision, observation.updatedAt, actor,
          JSON.stringify(changedFields), JSON.stringify(observation));
    },
  validateObservation(observation: StoredObservation, validateSensorRelation = true): void {
      const house = this.getHouse(observation.houseId);
      if (!house) {
        throw new ClimateDataValidationError(404, "OBSERVATION_HOUSE_NOT_FOUND", `House ${observation.houseId} does not exist`);
      }
      const floor = house.floors.find((candidate) => candidate.id === observation.floorId);
      if (!floor) {
        throw new ClimateDataValidationError(
          422,
          "OBSERVATION_FLOOR_NOT_FOUND",
          `Floor ${observation.floorId} does not belong to house ${observation.houseId}`,
        );
      }
      if ((observation.x === null) !== (observation.y === null)) {
        throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_POSITION", "Observation x and y must either both be set or both be null");
      }
      if (observation.x !== null && observation.y !== null) {
        if (![observation.x, observation.y].every(Number.isFinite)
          || observation.x < 0 || observation.x > floor.width || observation.y < 0 || observation.y > floor.height) {
          throw new ClimateDataValidationError(
            422,
            "OBSERVATION_OUT_OF_BOUNDS",
            `Observation x/y must be within floor ${floor.id}: 0 <= x <= ${floor.width}, 0 <= y <= ${floor.height}`,
          );
        }
      }
      if (validateSensorRelation && observation.sensorId !== null) {
        const sensor = this.getSensor(observation.sensorId);
        if (!sensor) {
          throw new ClimateDataValidationError(404, "OBSERVATION_SENSOR_NOT_FOUND", `Sensor ${observation.sensorId} does not exist`);
        }
        if (sensor.houseId !== observation.houseId || sensor.floorId !== observation.floorId) {
          throw new ClimateDataValidationError(
            409,
            "OBSERVATION_SENSOR_SCOPE_MISMATCH",
            `Sensor ${sensor.id} does not belong to house ${observation.houseId} and floor ${observation.floorId}`,
          );
        }
      }
      if (!isOneOf(observation.source, OBSERVATION_SOURCES)) {
        throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_SOURCE", "Observation source is not supported");
      }
      if (!isOneOf(observation.confidence, OBSERVATION_CONFIDENCES)) {
        throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_CONFIDENCE", "Observation confidence is not supported");
      }
      if (observation.status === "open") {
        if (observation.resolutionNote !== null || observation.resolvedAt !== null) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_OBSERVATION_RESOLUTION",
            "An open observation cannot contain resolutionNote or resolvedAt",
          );
        }
      } else if (!observation.resolutionNote?.trim() || !observation.resolvedAt) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_OBSERVATION_RESOLUTION",
          "A resolved observation requires a non-empty resolutionNote and a server-recorded resolvedAt",
        );
      }
    },
  listMaintenanceTasks(filters: string | {
      propertyId?: string;
      houseId?: string;
      areaId?: string;
      equipmentId?: string;
      limit?: number;
      offset?: number;
    } = {}): MaintenanceTask[] {
      const options = typeof filters === "string" ? { houseId: filters } : filters;
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
});
