import { HttpError } from "../http-error.js";
import { collectionPage, visibleCollectionPage } from "./support/collection-pages.js";
import { optionalResourceQuery } from "./support/query-fields.js";
import { parseAreaEquipmentInput, parseAreaEquipmentPatch, parseEquipmentAttachmentUpload, parseEquipmentLinkInput, parseEquipmentLinkPatch } from "./support/property-fields.js";
import { assertEquipmentAttachmentMediaType, equipmentAttachmentData, equipmentAttachmentDisposition } from "./support/equipment-attachments.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Area equipment, its attachments and its links to sensors and houses. */
export function registerAreaEquipmentRoutes(context: ApiRouteRegistrationContext): void {
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
  context.app.patch(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipmentId = request.params.id as string;
      const previous = context.database.getAreaEquipment(equipmentId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const patch = parseAreaEquipmentPatch(request.body);
      if (patch.areaId) {
        const targetArea = context.database.getPropertyArea(patch.areaId);
        if (targetArea && targetArea.propertyId !== previous.propertyId) context.stuguby.assertPropertyWriteAllowed(targetArea.propertyId);
      }
      if (patch.houseId) {
        const targetHouse = context.database.getHouse(patch.houseId);
        if (targetHouse && targetHouse.propertyId !== previous.propertyId) {
          context.stuguby.assertPropertyWriteAllowed(targetHouse.propertyId);
        }
      }
      const equipment = context.database.transaction(() => {
        const updated = context.database.updateAreaEquipment(equipmentId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
        if (previous.propertyId !== updated.propertyId) {
          context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "equipment", updated.id, "delete");
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "equipment", updated.id, "upsert");
        } else {
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "equipment", updated.id, "upsert", Object.keys(patch));
        }
        return updated;
      });
      if (previous && (
        previous.propertyId !== equipment.propertyId
        || previous.areaId !== equipment.areaId
        || (previous.houseId ?? null) !== (equipment.houseId ?? null)
        || JSON.stringify(previous.location ?? null) !== JSON.stringify(equipment.location ?? null)
      )) {
        const observedAt = new Date().toISOString();
        context.notifySpatial((runtime) => {
          runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
          if (equipment.propertyId !== previous.propertyId) {
            runtime.scheduler.enqueueScope({ kind: "property", id: equipment.propertyId }, observedAt, "ownership-changed", true);
          }
        });
      }
      response.json({ equipment });
    });
  context.app.delete(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipmentId = request.params.id as string;
      const previous = context.database.getAreaEquipment(equipmentId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deleteAreaEquipment(equipmentId)) {
          throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
        }
        if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "equipment", equipmentId, "delete");
      });
      if (previous) context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/attachments`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      }
      response.json({ attachments: context.database.listEquipmentAttachments({ equipmentId }) });
    });
  context.app.post(`${context.prefix}/area-equipment/:equipmentId/attachments`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const input = parseEquipmentAttachmentUpload(request.body);
      assertEquipmentAttachmentMediaType(input);
      const attachment = context.database.createEquipmentAttachment({
        equipmentId,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        data: equipmentAttachmentData(input),
      });
      response.status(201).json({
        attachment,
        url: `${context.prefix}/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${attachment.id}`,
      });
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/attachments/:attachmentId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const attachment = context.database.getEquipmentAttachment(request.params.attachmentId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!attachment || attachment.equipmentId !== equipmentId
        || !equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      response.setHeader("content-type", attachment.mimeType);
      response.setHeader("content-length", String(attachment.size));
      response.setHeader("cache-control", "private, no-cache");
      response.setHeader("content-security-policy", "sandbox; default-src 'none'");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("content-disposition", equipmentAttachmentDisposition(attachment.kind, attachment.name));
      response.send(Buffer.from(attachment.data));
    });
  context.app.delete(`${context.prefix}/area-equipment/:equipmentId/attachments/:attachmentId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const attachment = context.database.getEquipmentAttachment(request.params.attachmentId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!attachment || attachment.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      if (!context.database.deleteEquipmentAttachment(attachment.id)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/links`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      }
      response.json({ links: context.database.listEquipmentLinks({ equipmentId }) });
    });
  context.app.post(`${context.prefix}/area-equipment/:equipmentId/links`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const link = context.database.createEquipmentLink({
        equipmentId,
        ...parseEquipmentLinkInput(request.body),
      });
      response.status(201).json({ link });
    });
  context.app.patch(`${context.prefix}/area-equipment/:equipmentId/links/:linkId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const previous = context.database.getEquipmentLink(request.params.linkId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!previous || previous.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const link = context.database.updateEquipmentLink(previous.id, parseEquipmentLinkPatch(request.body));
      if (!link) throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      response.json({ link });
    });
  context.app.delete(`${context.prefix}/area-equipment/:equipmentId/links/:linkId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const link = context.database.getEquipmentLink(request.params.linkId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!link || link.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      if (!context.database.deleteEquipmentLink(link.id)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      response.status(204).end();
    });
}
