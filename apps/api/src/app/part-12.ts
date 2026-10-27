import { createHash } from "node:crypto";
import type {
  PropertyInventorySnapshot,
} from "@climate-twin/contracts";
import { HttpError, collectionPage, completeVisibleCollection, optionalResourceQuery, parseAreaEquipmentInput, parsePropertyAreaInput, parsePropertyAreaPatch, visibleCollectionPage } from "./support/index.js";
import { configureApiPart11 } from "./part-11.js";


export function configureApiPart12(context: ReturnType<typeof configureApiPart11>) {
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
  context.app.get(`${context.prefix}/area-equipment`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        equipment: visibleCollectionPage(
          (limit, offset) => context.database.listAreaEquipment({
            ...(propertyId ? { propertyId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(houseId ? { houseId } : {}),
            limit,
            offset,
          }),
          (equipment) => access.equipment(equipment),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/area-equipment`, (request, response) => {
      const input = parseAreaEquipmentInput(request.body);
      const area = input.areaId ? context.database.getPropertyArea(input.areaId) : null;
      const house = input.houseId ? context.database.getHouse(input.houseId) : null;
      const propertyId = area?.propertyId ?? house?.propertyId ?? input.propertyId;
      if (propertyId) context.stuguby.assertPropertyWriteAllowed(propertyId);
      const equipment = context.database.transaction(() => {
        const created = context.database.createAreaEquipment(input);
        context.stuguby.captureCurrentPropertyEntity(created.propertyId, "equipment", created.id, "upsert");
        return created;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: equipment.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ equipment });
    });
  context.app.get(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipment = context.database.getAreaEquipment(request.params.id as string);
      if (!equipment || !context.visibility(response).equipment(equipment)) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      response.json({ equipment });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
