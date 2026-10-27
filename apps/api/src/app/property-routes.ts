import type { Property, PropertyInventorySnapshot } from "@climate-twin/contracts";
import { HttpError, collectionPage, parsePropertyInput, parsePropertyPatch, visibleCollectionPage, completeVisibleCollection } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";
import { createHash } from "node:crypto";

/** Property CRUD and the property inventory. */
export function registerPropertyRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/properties`, (request, response) => {
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      const properties = visibleCollectionPage(
        (limit, offset) => context.database.listProperties(limit, offset),
        (property) => access.property(property) !== null,
        page,
      ).map((property) => access.property(property) as Property);
      response.json({ properties });
    });
  context.app.post(`${context.prefix}/properties`, (request, response) => {
      const property = context.database.createProperty(parsePropertyInput(request.body));
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ property });
    });
  context.app.get(`${context.prefix}/properties/:id`, (request, response) => {
      const candidate = context.database.getProperty(request.params.id as string);
      const property = candidate ? context.visibility(response).property(candidate) : null;
      if (!property) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.json({ property });
    });
  context.app.patch(`${context.prefix}/properties/:id`, (request, response) => {
      const propertyId = request.params.id as string;
      context.stuguby.assertPropertyWriteAllowed(propertyId);
      const patch = parsePropertyPatch(request.body);
      const property = context.database.transaction(() => {
        const updated = context.database.updateProperty(propertyId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property not found");
        const sharedFields = Object.keys(patch).filter((field) => field !== "defaultHouseId");
        if (sharedFields.length > 0) {
          context.stuguby.captureCurrentPropertyEntity(updated.id, "property", updated.id, "upsert", sharedFields);
        }
        return updated;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.json({ property });
    });
  context.app.delete(`${context.prefix}/properties/:id`, async (request, response) => {
      const propertyId = request.params.id as string;
      const property = context.database.getProperty(propertyId);
      if (property?.stuguby && property.stuguby.syncState !== "detached") {
        throw new HttpError(409, "STUGBY_DISCONNECT_REQUIRED", "Disconnect the Stuguby Property explicitly before deleting it");
      }
      context.requireImmutableTelemetryLineage("property", propertyId);
      if (!context.database.deleteProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/properties/:propertyId/inventory`, (request, response) => {
      const propertyId = request.params.propertyId as string;
      const property = context.database.getProperty(propertyId);
      const access = context.visibility(response);
      if (!property || !access.property(property)) {
        throw new HttpError(404, "NOT_FOUND", "Property not found");
      }
      const areas = completeVisibleCollection(
        (limit, offset) => context.database.listPropertyAreas(propertyId, limit, offset),
        (area) => access.area(area.id),
      );
      const equipment = completeVisibleCollection(
        (limit, offset) => context.database.listAreaEquipment({ propertyId, limit, offset }),
        (item) => access.equipment(item),
      );
      const visibleEquipmentIds = new Set(equipment.map((item) => item.id));
      const attachments = context.database.listEquipmentAttachments({ propertyId })
        .filter((attachment) => visibleEquipmentIds.has(attachment.equipmentId));
      const links = context.database.listEquipmentLinks({ propertyId })
        .filter((link) => visibleEquipmentIds.has(link.equipmentId));
      const syncToken = createHash("sha256")
        .update(JSON.stringify({ propertyId, areas, equipment, attachments, links }))
        .digest("hex");
      const etag = `"${syncToken}"`;
      response.setHeader("cache-control", "private, no-cache");
      response.setHeader("etag", etag);
      if (request.header("if-none-match")?.split(",").some((value) => {
        const candidate = value.trim();
        return candidate === "*" || candidate.replace(/^W\//u, "") === etag;
      })) {
        response.status(304).end();
        return;
      }
      const inventory: PropertyInventorySnapshot = {
        propertyId,
        generatedAt: new Date().toISOString(),
        syncToken,
        areas,
        equipment,
        attachments,
        links,
      };
      response.json({ inventory });
    });
}
