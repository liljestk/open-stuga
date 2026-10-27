import { withResponseSignal } from "./response-signal.js";
import type {
  DataExportPrivacyLevel,
} from "@climate-twin/contracts";
import { HttpError, bodyObject, collectionPage, enumValue, optionalResourceQuery, parseMaintenanceTaskInput, parseMaintenanceTaskPatch, parseObservationInput, parseObservationPatch, requireWorkspaceAdmin, requiredString, visibleCollectionPage } from "./support/index.js";
import { configureApiPart19 } from "./part-19.js";


export function configureApiPart20(context: ReturnType<typeof configureApiPart19>) {
  context.app.get(`${context.prefix}/data-export`, requireWorkspaceAdmin, async (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel") as DataExportPrivacyLevel;
      const includeTelemetry = request.query.includeTelemetry === "true";
      if (includeTelemetry && context.telemetryArchive) {
        throw new HttpError(409, "ARCHIVE_EXPORT_REQUIRES_BACKUP", "A raw telemetry JSON export is unavailable after SQLite hot retention; use a verified backup, which includes both SQLite and TimescaleDB");
      }
      const generatedAt = new Date().toISOString();
      const preview = await withResponseSignal(response, signal => context.dataOperations.preview(privacyLevel, includeTelemetry, signal));
      const controlPlane = context.dataOperations.bundle(privacyLevel);
      context.dataOperations.audit("export.started", { privacyLevel, includeTelemetry });
      response.status(200);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="stugu-export-${generatedAt.replace(/[:.]/g, "-")}.json"`);
      response.setHeader("cache-control", "no-store");
      response.flushHeaders();
      const write = async (chunk: string): Promise<boolean> => {
        if (response.destroyed || request.destroyed) return false;
        if (response.write(chunk)) return true;
        await new Promise<void>((resolve) => response.once("drain", resolve));
        return !response.destroyed && !request.destroyed;
      };
      const head = JSON.stringify({
        schemaVersion: "stugu.export/v1",
        generatedAt,
        privacyLevel,
        includesTelemetry: includeTelemetry,
        privacyPreview: preview,
        data: controlPlane,
      });
      if (!includeTelemetry) {
        response.end(head);
        context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
        return;
      }
      if (!await write(`${head.slice(0, -1)},"telemetry":{`)) return;
      const telemetryTables = [
        "measurement_samples",
        "readings",
        "outdoor_temperature_samples",
        "electricity_price_points",
        "heat_pump_state_history",
      ] as const;
      for (let tableIndex = 0; tableIndex < telemetryTables.length; tableIndex += 1) {
        const table = telemetryTables[tableIndex]!;
        if (!await write(`${tableIndex === 0 ? "" : ","}${JSON.stringify(table)}:[`)) return;
        let first = true;
        for (const row of context.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
          if (!await write(`${first ? "" : ","}${JSON.stringify(row)}`)) return;
          first = false;
        }
        if (!await write("]")) return;
      }
      response.end("}}");
      context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
    });
  context.app.get(`${context.prefix}/backups/status`, requireWorkspaceAdmin, (_request, response) => {
      response.json({ backup: context.dataOperations.backupStatus() });
    });
  context.app.post(`${context.prefix}/backups`, requireWorkspaceAdmin, (_request, response) => {
      response.status(202).json({ backup: context.dataOperations.requestBackup() });
    });
  context.app.get(`${context.prefix}/setup/doctor`, requireWorkspaceAdmin, async (_request, response) => {
      const report = await withResponseSignal(response, signal => context.setupDoctor.report(new Date(), signal));
      response.json({ report });
    });
  context.app.get(`${context.prefix}/sensors/:id/label`, (request, response) => {
      const sensorId = request.params.id as string;
      if (!context.visibility(response).sensor(sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      }
      const label = context.setupDoctor.sensorLabel(sensorId);
      if (!label) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      response.json({ label });
    });
  context.app.post(`${context.prefix}/setup/bulk-sensor-mappings`, (request, response) => {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      if (!Array.isArray(body.mappings)) throw new HttpError(400, "INVALID_FIELD", "mappings must be an array");
      const mappings = body.mappings.map((candidate) => {
        const mapping = bodyObject(candidate);
        if (!mapping.measurementEntityIds || typeof mapping.measurementEntityIds !== "object" || Array.isArray(mapping.measurementEntityIds)) {
          throw new HttpError(400, "INVALID_FIELD", "measurementEntityIds must be an object");
        }
        return { sensorId: requiredString(mapping, "sensorId"), measurementEntityIds: Object.fromEntries(
          Object.entries(mapping.measurementEntityIds as Record<string, unknown>).map(([metric, entityId]) => {
            if (typeof entityId !== "string") throw new HttpError(400, "INVALID_FIELD", "Entity ids must be strings");
            return [metric, entityId];
          }),
        ) };
      });
      const sensors = context.database.bulkUpdateSensorBindings(houseId, mappings);
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/houses/${houseId}/sensor-mappings`, occurredAt: new Date().toISOString() } });
      response.json({ sensors });
    });
  context.app.get(`${context.prefix}/observations`, (request, response) => {
      const access = context.visibility(response);
      response.json({ observations: context.database.listObservations(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((observation) => access.house(observation.houseId)) });
    });
  context.app.post(`${context.prefix}/observations`, (request, response) => {
      const input = parseObservationInput(request.body);
      context.stuguby.assertHouseWriteAllowed(input.houseId);
      const { observation, created } = context.database.transaction(() => {
        const result = context.database.getOrCreateObservation(input, "local-rest");
        if (result.created) context.stuguby.captureHomeMutation(result.observation.houseId);
        return result;
      });
      response.status(created ? 201 : 200).json(observation);
    });
  context.app.patch(`${context.prefix}/observations/:id`, (request, response) => {
      const current = context.database.getObservation(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      const observation = context.database.transaction(() => {
        const updated = context.database.updateObservation(
          request.params.id as string,
          parseObservationPatch(request.body),
          "local-rest",
        );
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Observation not found");
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      response.json(observation);
    });
  context.app.get(`${context.prefix}/observations/:id/revisions`, (request, response) => {
      const id = request.params.id as string;
      const observation = context.database.getObservation(id);
      const access = context.visibility(response);
      if (!observation || !access.house(observation.houseId)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
      if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
      response.json({ revisions: context.database.listObservationRevisions(id) });
    });
  context.app.delete(`${context.prefix}/observations/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getObservation(id);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      context.database.transaction(() => {
        if (!context.database.deleteObservation(id)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
        if (current) context.stuguby.captureHomeMutation(current.houseId);
      });
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/maintenance-tasks`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        maintenanceTasks: visibleCollectionPage(
          (limit, offset) => context.database.listMaintenanceTasks({
            ...(propertyId ? { propertyId } : {}),
            ...(houseId ? { houseId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(equipmentId ? { equipmentId } : {}),
            limit,
            offset,
          }),
          (task) => access.maintenance(task),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/maintenance-tasks`, (request, response) => {
      const input = parseMaintenanceTaskInput(request.body);
      const propertyId = input.propertyId ?? (input.houseId ? context.database.getHouse(input.houseId)?.propertyId : undefined);
      if (propertyId) context.stuguby.assertPropertyWriteAllowed(propertyId);
      const { task, created } = context.database.transaction(() => {
        const result = context.database.getOrCreateMaintenanceTask(input, "local-rest");
        if (result.created) context.stuguby.captureCurrentPropertyEntity(
          result.task.propertyId,
          "maintenance",
          result.task.id,
          "upsert",
        );
        return result;
      });
      response.status(created ? 201 : 200).json(task);
    });
  context.app.get(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const task = context.database.getMaintenanceTask(request.params.id as string);
      if (!task || !context.visibility(response).maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
      response.json(task);
    });
  context.app.patch(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const taskId = request.params.id as string;
      const previous = context.database.getMaintenanceTask(taskId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const task = context.database.transaction(() => {
        const updated = context.database.updateMaintenanceTask(
          taskId,
          parseMaintenanceTaskPatch(request.body),
          "local-rest",
        );
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
        context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "maintenance", updated.id, "upsert");
        return updated;
      });
      response.json(task);
    });
  context.app.get(`${context.prefix}/maintenance-tasks/:id/revisions`, (request, response) => {
      const id = request.params.id as string;
      const task = context.database.getMaintenanceTask(id);
      const access = context.visibility(response);
      if (!task || !access.maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
      if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
      response.json({ revisions: context.database.listMaintenanceTaskRevisions(id) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
