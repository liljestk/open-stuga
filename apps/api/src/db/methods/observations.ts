import { randomUUID } from "node:crypto";
import { type ManualObservation, type ManualObservationInput, type ObservationRevision, isOneOf, OBSERVATION_CONFIDENCES, OBSERVATION_SOURCES, type ManualObservationPatch, type ObservationChangedField } from "@climate-twin/contracts";
import { OBSERVATION_CHANGED_FIELDS } from "../support/domain-limits.js";
import { LocalObservationRevisionActor, StoredObservation } from "../support/record-types.js";
import { ObservationRevisionRow, ObservationRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { canonicalObservationCreateTime, canonicalObservationPatchLifecycle } from "../support/observation-lifecycle.js";
import { observationFromRow, observationRevisionFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { canonicalObservationPatchTime } from "../support/observation-lifecycle.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
    updateObservation(id: string, patch: ManualObservationPatch, actor?: LocalObservationRevisionActor): ManualObservation | null;
    deleteObservation(id: string): boolean;
    insertObservationRevision(
        observation: StoredObservation,
        actor: LocalObservationRevisionActor,
        changedFields: ObservationChangedField[],
      ): void;
    validateObservation(observation: StoredObservation, validateSensorRelation?: boolean): void;
  }

  interface ClimateDatabaseCore {
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
    updateObservation(id: string, patch: ManualObservationPatch, actor?: LocalObservationRevisionActor): ManualObservation | null;
    deleteObservation(id: string): boolean;
  }
}

registerDatabaseMethods({
  listObservations(houseId?: string): ManualObservation[] {
      const rows = (houseId
        ? this.db.prepare(`SELECT observation.* FROM observations AS observation
            JOIN houses AS house ON house.id = observation.house_id
            WHERE observation.house_id = ? AND house.deleted_at IS NULL ORDER BY observation.occurred_at DESC`).all(houseId)
        : this.db.prepare(`SELECT observation.* FROM observations AS observation
            JOIN houses AS house ON house.id = observation.house_id
            WHERE house.deleted_at IS NULL ORDER BY observation.occurred_at DESC`).all()) as unknown as ObservationRow[];
      return rows.map(observationFromRow);
    },
  getObservation(id: string): StoredObservation | null {
      const row = this.db.prepare(`SELECT observation.* FROM observations AS observation
        JOIN houses AS house ON house.id = observation.house_id
        WHERE observation.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as ObservationRow | undefined;
      return row ? observationFromRow(row) : null;
    },
  getOrCreateObservation(
      input: ManualObservationInput,
      actor: LocalObservationRevisionActor = "local-rest",
    ): { observation: ManualObservation; created: boolean } {
      return this.immediateTransaction(() => {
        if (input.id) {
          const existing = this.getObservation(input.id);
          if (existing) {
            const temporal = canonicalObservationCreateTime(input, existing.createdAt);
            const matches = existing.houseId === input.houseId
              && existing.floorId === input.floorId
              && existing.sensorId === (input.sensorId ?? null)
              && existing.kind === input.kind
              && existing.severity === input.severity
              && existing.note === input.note
              && existing.x === (input.x ?? null)
              && existing.y === (input.y ?? null)
              && existing.occurredAt === temporal.occurredAt
              && existing.timePrecision === temporal.timePrecision
              && existing.validFrom === temporal.validFrom
              && existing.validTo === temporal.validTo
              && existing.source === (input.source ?? "unknown")
              && existing.sourceDetail === (input.sourceDetail ?? null)
              && existing.confidence === (input.confidence ?? "uncertain");
            if (!matches) {
              throw new ClimateDataValidationError(
                409,
                "OBSERVATION_ID_CONFLICT",
                `Observation ${input.id} already exists with different content`,
              );
            }
            return { observation: existing, created: false };
          }
        }
        return { observation: this.createObservation(input, actor), created: true };
      });
    },
  listObservationRevisions(observationId: string): ObservationRevision[] {
      const rows = this.db.prepare(`SELECT * FROM observation_revisions
        WHERE observation_id = ? ORDER BY revision`).all(observationId) as unknown as ObservationRevisionRow[];
      return rows.map(observationRevisionFromRow);
    },
  createObservation(input: ManualObservationInput, actor: LocalObservationRevisionActor = "local-rest"): ManualObservation {
      return this.immediateTransaction(() => {
        const createdAt = new Date().toISOString();
        const temporal = canonicalObservationCreateTime(input, createdAt);
        const observation: StoredObservation = {
          id: input.id ?? randomUUID(),
          houseId: input.houseId,
          floorId: input.floorId,
          sensorId: input.sensorId ?? null,
          kind: input.kind,
          severity: input.severity,
          note: input.note,
          x: input.x ?? null,
          y: input.y ?? null,
          ...temporal,
          createdAt,
          source: input.source ?? "unknown",
          sourceDetail: input.sourceDetail ?? null,
          confidence: input.confidence ?? "uncertain",
          status: "open",
          resolutionNote: null,
          resolvedAt: null,
          revision: 1,
          updatedAt: createdAt,
        };
        this.validateObservation(observation);
        this.db.prepare(`INSERT INTO observations
          (id, house_id, floor_id, sensor_id, kind, severity, note, x, y, occurred_at, created_at,
           time_precision, valid_from, valid_to, source, source_detail, confidence, revision, updated_at,
           status, resolution_note, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(observation.id, observation.houseId, observation.floorId, observation.sensorId, observation.kind,
            observation.severity, observation.note, observation.x, observation.y, observation.occurredAt,
            observation.createdAt, observation.timePrecision, observation.validFrom, observation.validTo,
            observation.source, observation.sourceDetail, observation.confidence, observation.revision, observation.updatedAt,
            observation.status, observation.resolutionNote, observation.resolvedAt);
        this.insertObservationRevision(observation, actor, [...OBSERVATION_CHANGED_FIELDS]);
        return observation;
      });
    },
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
});
