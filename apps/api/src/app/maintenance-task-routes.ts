import { HttpError, collectionPage, optionalResourceQuery, parseMaintenanceTaskInput, parseMaintenanceTaskPatch, visibleCollectionPage } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Maintenance tasks and their revisions. */
export function registerMaintenanceTaskRoutes(context: ApiRouteRegistrationContext): void {
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
  context.app.delete(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const taskId = request.params.id as string;
      const previous = context.database.getMaintenanceTask(taskId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deleteMaintenanceTask(taskId)) {
          throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
        }
        if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "maintenance", taskId, "delete");
      });
      response.status(204).end();
    });
}
