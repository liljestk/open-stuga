import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { MAINTENANCE_TASK_CHANGED_FIELDS } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor, StaticParameterRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { AssetRecord, ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { canonicalMaintenanceLifecycle, canonicalMaintenanceObservationIds, maintenanceDate } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import { parameterFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
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
        this.validateMaintenanceTask(next);
        const changedFields = MAINTENANCE_TASK_CHANGED_FIELDS.filter((field) => (
          field === "observationIds"
            ? JSON.stringify(current.observationIds) !== JSON.stringify(next.observationIds)
            : !Object.is(current[field], next[field])
        ));
        if (changedFields.length === 0) return current;
        next.revision = current.revision + 1;
        next.updatedAt = changedAt;
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
  validateMaintenanceTask(task: MaintenanceTask): void {
      if (!this.getProperty(task.propertyId)) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_PROPERTY_NOT_FOUND",
          `Property ${task.propertyId} does not exist`,
        );
      }
      const house = task.houseId === null ? null : this.getHouse(task.houseId);
      if (task.houseId !== null && !house) {
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
      if (task.floorId !== null && !house) {
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
      if (task.observationIds.length > 0 && !house) {
        throw new ClimateDataValidationError(
          422,
          "MAINTENANCE_HOUSE_REQUIRED",
          "Maintenance observation evidence requires a house",
        );
      }
      for (const observationId of task.observationIds) {
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
  listParameters(houseId?: string): StaticParameter[] {
      const rows = (houseId
        ? this.db.prepare("SELECT * FROM static_parameters WHERE house_id = ? ORDER BY label").all(houseId)
        : this.db.prepare("SELECT * FROM static_parameters ORDER BY label").all()) as unknown as StaticParameterRow[];
      return rows.map(parameterFromRow);
    },
  saveParameter(input: Omit<StaticParameter, "id"> & { id?: string }): StaticParameter {
      const parameter: StaticParameter = { ...input, id: input.id ?? randomUUID() };
      this.db.prepare(`INSERT INTO static_parameters
        (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(house_id, scope_type, scope_id, key) DO UPDATE SET
          value_json = excluded.value_json, unit = excluded.unit, label = excluded.label`)
        .run(parameter.id, parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key,
          JSON.stringify(parameter.value), parameter.unit, parameter.label);
      const row = this.db.prepare(`SELECT * FROM static_parameters
        WHERE house_id = ? AND scope_type = ? AND scope_id = ? AND key = ?`)
        .get(parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key) as unknown as StaticParameterRow;
      return parameterFromRow(row);
    },
  deleteParameter(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM static_parameters WHERE id = ?").run(id).changes) > 0;
    },
  createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & { data: Uint8Array }): AssetRecord {
      const asset: AssetRecord = {
        id: randomUUID(), houseId: input.houseId, name: input.name, mimeType: input.mimeType, kind: input.kind,
        size: input.data.byteLength, createdAt: new Date().toISOString(),
      };
      this.db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.houseId, asset.name, asset.mimeType, asset.kind, input.data, asset.size, asset.createdAt);
      return asset;
    },
  listAssets(houseId?: string): AssetRecord[] {
      const sql = `SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size, created_at as createdAt
        FROM assets ${houseId ? "WHERE house_id = ?" : ""} ORDER BY created_at DESC`;
      return (houseId ? this.db.prepare(sql).all(houseId) : this.db.prepare(sql).all()) as unknown as AssetRecord[];
    },
  getAsset(id: string): (AssetRecord & { data: Uint8Array }) | null {
      const row = this.db.prepare(`SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size,
        created_at as createdAt, data FROM assets WHERE id = ?`).get(id);
      return row as unknown as (AssetRecord & { data: Uint8Array }) | null;
    },
  deleteAsset(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM assets WHERE id = ?").run(id).changes) > 0;
    },
});
