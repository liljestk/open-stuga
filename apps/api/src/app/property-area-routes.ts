import { HttpError, collectionPage, optionalResourceQuery, parsePropertyAreaInput, parsePropertyAreaPatch, visibleCollectionPage } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Property areas such as yards, wells and outbuildings. */
export function registerPropertyAreaRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/property-areas`, (request, response) => {
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      response.json({
        areas: visibleCollectionPage(
          (limit, offset) => context.database.listPropertyAreas(propertyId, limit, offset),
          (area) => access.area(area.id),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/property-areas`, (request, response) => {
      const input = parsePropertyAreaInput(request.body);
      context.stuguby.assertPropertyWriteAllowed(input.propertyId);
      const area = context.database.transaction(() => {
        const created = context.database.createPropertyArea(input);
        context.stuguby.captureCurrentPropertyEntity(created.propertyId, "area", created.id, "upsert");
        return created;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: area.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ area });
    });
  context.app.get(`${context.prefix}/property-areas/:id`, (request, response) => {
      const area = context.database.getPropertyArea(request.params.id as string);
      if (!area || !context.visibility(response).area(area.id)) throw new HttpError(404, "NOT_FOUND", "Property area not found");
      response.json({ area });
    });
  context.app.patch(`${context.prefix}/property-areas/:id`, (request, response) => {
      const areaId = request.params.id as string;
      const previous = context.database.getPropertyArea(areaId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Property area not found");
      context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const patch = parsePropertyAreaPatch(request.body);
      if (patch.propertyId && patch.propertyId !== previous.propertyId) context.stuguby.assertPropertyWriteAllowed(patch.propertyId);
      const area = context.database.transaction(() => {
        const updated = context.database.updatePropertyArea(areaId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property area not found");
        if (previous.propertyId !== updated.propertyId) {
          context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "area", updated.id, "delete");
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert");
        } else {
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert",
            Object.keys(patch).filter((field) => field !== "propertyId"));
        }
        return updated;
      });
      if (previous) {
        const observedAt = new Date().toISOString();
        context.notifySpatial((runtime) => {
          runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "property-context-changed", true);
          if (previous.propertyId !== area.propertyId) {
            runtime.scheduler.enqueueScope({ kind: "property", id: area.propertyId }, observedAt, "ownership-changed", true);
          }
        });
      }
      response.json({ area });
    });
  context.app.delete(`${context.prefix}/property-areas/:id`, (request, response) => {
      const areaId = request.params.id as string;
      const previous = context.database.getPropertyArea(areaId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deletePropertyArea(areaId)) {
          throw new HttpError(404, "NOT_FOUND", "Property area not found");
        }
        if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "area", areaId, "delete");
      });
      if (previous) context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(204).end();
    });
}
