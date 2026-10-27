import { withResponseSignal } from "./response-signal.js";
import { HttpError, bodyObject, requireWorkspaceAdmin, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** The setup doctor and bulk sensor mapping. */
export function registerSetupRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/setup/doctor`, requireWorkspaceAdmin, async (_request, response) => {
      const report = await withResponseSignal(response, signal => context.setupDoctor.report(new Date(), signal));
      response.json({ report });
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
}
