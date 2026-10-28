import { HttpError } from "../http-error.js";
import { collectionPage, visibleCollectionPage } from "./support/collection-pages.js";
import { optionalResourceQuery } from "./support/query-fields.js";
import { parsePropertyNoteInput, parsePropertyNotePatch } from "./support/property-fields.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Property notes. */
export function registerPropertyNoteRoutes(context: ApiRouteRegistrationContext): void {
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
  context.app.patch(`${context.prefix}/property-notes/:id`, (request, response) => {
      const noteId = request.params.id as string;
      const previous = context.database.getPropertyNote(noteId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Property note not found");
      const patch = parsePropertyNotePatch(request.body);
      const targetHouseId = patch.houseId === undefined ? previous.houseId : patch.houseId;
      const previousHouse = previous.houseId ? context.database.getHouse(previous.houseId) : null;
      if (previousHouse) context.stuguby.assertHouseWriteAllowed(previousHouse.id);
      else context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      if (targetHouseId !== previous.houseId) {
        if (targetHouseId) context.stuguby.assertHouseWriteAllowed(targetHouseId);
        else context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      }
      const note = context.database.transaction(() => {
        const updated = context.database.updatePropertyNote(noteId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property note not found");
        if (previous.houseId !== updated.houseId) {
          const previousSharedHouse = previous.houseId ? context.database.getHouse(previous.houseId)?.stuguby : null;
          if (previous.houseId && previousSharedHouse && previousSharedHouse.syncState !== "detached") {
            context.stuguby.captureHomeMutation(previous.houseId);
          } else {
            context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "note", updated.id, "delete");
          }
        }
        const sharedHouse = updated.houseId ? context.database.getHouse(updated.houseId)?.stuguby : null;
        if (updated.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(updated.houseId);
        else context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "note", updated.id, "upsert", Object.keys(patch));
        return updated;
      });
      response.json({ note });
    });
  context.app.delete(`${context.prefix}/property-notes/:id`, (request, response) => {
      const noteId = request.params.id as string;
      const previous = context.database.getPropertyNote(noteId);
      const previousHouse = previous?.houseId ? context.database.getHouse(previous.houseId) : null;
      if (previousHouse) context.stuguby.assertHouseWriteAllowed(previousHouse.id);
      else if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deletePropertyNote(noteId)) {
          throw new HttpError(404, "NOT_FOUND", "Property note not found");
        }
        const sharedHouse = previous?.houseId ? context.database.getHouse(previous.houseId)?.stuguby : null;
        if (previous?.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(previous.houseId);
        else if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "note", noteId, "delete");
      });
      response.status(204).end();
    });
}
