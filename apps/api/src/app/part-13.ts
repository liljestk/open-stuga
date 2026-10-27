import { HttpError, assertEquipmentAttachmentMediaType, collectionPage, equipmentAttachmentData, equipmentAttachmentDisposition, optionalResourceQuery, parseAreaEquipmentPatch, parseEquipmentAttachmentUpload, parseEquipmentLinkInput, parseEquipmentLinkPatch, parsePropertyNoteInput, visibleCollectionPage } from "./support/index.js";
import { configureApiPart12 } from "./part-12.js";


export function configureApiPart13(context: ReturnType<typeof configureApiPart12>) {
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
  context.app.get(`${context.prefix}/property-notes`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        notes: visibleCollectionPage(
          (limit, offset) => context.database.listPropertyNotes({
            ...(propertyId ? { propertyId } : {}),
            ...(houseId ? { houseId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(equipmentId ? { equipmentId } : {}),
            limit,
            offset,
          }),
          (note) => access.note(note),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/property-notes`, (request, response) => {
      const input = parsePropertyNoteInput(request.body);
      if (input.houseId) context.stuguby.assertHouseWriteAllowed(input.houseId);
      else context.stuguby.assertPropertyWriteAllowed(input.propertyId);
      const note = context.database.transaction(() => {
        const created = context.database.createPropertyNote(input);
        const sharedHouse = created.houseId ? context.database.getHouse(created.houseId)?.stuguby : null;
        if (created.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(created.houseId);
        else context.stuguby.captureCurrentPropertyEntity(created.propertyId, "note", created.id, "upsert");
        return created;
      });
      response.status(201).json({ note });
    });
  context.app.get(`${context.prefix}/property-notes/:id`, (request, response) => {
      const note = context.database.getPropertyNote(request.params.id as string);
      if (!note || !context.visibility(response).note(note)) throw new HttpError(404, "NOT_FOUND", "Property note not found");
      response.json({ note });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
