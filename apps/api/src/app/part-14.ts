import { resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type {
  Floor,
  OpeningStateObservationInput,
} from "@climate-twin/contracts";
import { HttpError, bodyObject, boundedQueryInteger, dateValue, houseLocationValue, houseMapPlacementValue, optionalResourceQuery, parsePropertyNotePatch, requiredNumber, requiredString } from "./support/index.js";
import { configureApiPart13 } from "./part-13.js";


export function configureApiPart14(context: ReturnType<typeof configureApiPart13>) {
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
  context.app.get(`${context.prefix}/houses`, (request, response) => {
      const access = context.visibility(response);
      response.json({
        houses: context.database.listHouses(optionalResourceQuery(request.query.propertyId, "propertyId"))
          .filter((house) => access.house(house.id)),
      });
    });
  context.app.post(`${context.prefix}/houses`, (request, response) => {
      const body = bodyObject(request.body);
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      const targetPropertyId = body.propertyId !== undefined ? requiredString(body, "propertyId") : undefined;
      const propertyCandidates = targetPropertyId ? [] : context.database.listProperties(2, 0);
      const inferredPropertyId = targetPropertyId ?? (propertyCandidates.length === 1 ? propertyCandidates[0]!.id : undefined);
      if (inferredPropertyId) context.stuguby.assertPropertyWriteAllowed(inferredPropertyId);
      let house = context.database.createHouse({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(targetPropertyId ? { propertyId: targetPropertyId } : {}),
        name: requiredString(body, "name"),
        timezone: requiredString(body, "timezone"),
        ...(body.location !== undefined ? { location: houseLocationValue(body.location) } : {}),
        ...(body.mapPlacement !== undefined ? { mapPlacement: houseMapPlacementValue(body.mapPlacement) } : {}),
        ...(body.orientationDegrees !== undefined ? { orientationDegrees: requiredNumber(body, "orientationDegrees") } : {}),
        floors: body.floors as Floor[],
      });
      house = context.stuguby.markLocalHouseInAdoptedProperty(house.id);
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        house.id,
        house.propertyId,
        new Date().toISOString(),
        "ownership-changed",
      ));
      context.status.refreshWeatherConfiguration();
      response.status(201).json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id`, (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      response.json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id/opening-states`, async (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const historical = request.query.at !== undefined
        || request.query.from !== undefined
        || request.query.to !== undefined;
      if (!historical) {
        const at = new Date().toISOString();
        const observations = context.database.listCurrentOpeningStateCandidates(houseId, at, 10_000);
        const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
          return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
            ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
        }));
        response.setHeader("cache-control", "private, no-store");
        response.json({ snapshot: { houseId, at, states }, observations });
        return;
      }
      const at = request.query.at === undefined && request.query.to !== undefined
        ? dateValue(request.query.to, new Date(), "to")
        : dateValue(request.query.at, new Date(), "at");
      const historyRange = request.query.from === undefined ? null : (() => {
        const from = dateValue(request.query.from, new Date(Date.parse(at) - 7 * 86_400_000), "from");
        const to = dateValue(request.query.to, new Date(at), "to");
        const durationMs = Date.parse(to) - Date.parse(from);
        if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
          throw new HttpError(400, "INVALID_OPENING_HISTORY_RANGE", "Opening-state history must cover more than zero and at most 366 days");
        }
        return { from, to, limit: boundedQueryInteger(request.query.limit, "limit", 1, 10_000) ?? 10_000 };
      })();
      const abortController = new AbortController();
      const abortOnClose = () => abortController.abort(new DOMException("Client disconnected", "AbortError"));
      response.once("close", abortOnClose);
      try {
        const observations = (await context.telemetryReader.openingStateSnapshot({
          houseId,
          at,
          limit: 10_000,
          signal: abortController.signal,
          timeoutMs: 5_000,
        })).records;
        const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
          return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
            ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
        }));
        if (!historyRange) {
          response.json({ snapshot: { houseId, at, states }, observations });
          return;
        }
        const { from, to, limit } = historyRange;
        // Seed the requested interval with the effective candidates at its leading
        // edge so clients can distinguish a real closed-to-open transition from a
        // startup heartbeat whose previous state lies just outside the range.
        const initial = (await context.telemetryReader.openingStateSnapshot({
          houseId,
          at: from,
          limit,
          signal: abortController.signal,
          timeoutMs: 5_000,
        })).records;
        const history = (await context.telemetryReader.openingStateHistory({
          houseId,
          from,
          to,
          limit: Math.max(1, limit - Math.min(initial.length, limit - 1)),
          signal: abortController.signal,
          timeoutMs: 5_000,
        })).records;
        const mergedHistory = [...new Map([...initial, ...history].map((observation) => [observation.id, observation])).values()]
          .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
          .slice(-limit);
        response.json({ snapshot: { houseId, at, states }, observations, history: mergedHistory, from, to });
      } finally {
        response.off("close", abortOnClose);
      }
    });
  context.app.post(`${context.prefix}/houses/:id/opening-states`, (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const body = bodyObject(request.body);
      const source = body.source === undefined ? "api" : requiredString(body, "source");
      if (source !== "api" && source !== "manual") {
        throw new HttpError(400, "INVALID_FIELD", "REST callers may record only api or manual opening-state provenance; Home Assistant and Tapo provenance is adapter-managed");
      }
      const input: OpeningStateObservationInput = {
        ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
        floorId: requiredString(body, "floorId"),
        elementId: requiredString(body, "elementId"),
        state: requiredString(body, "state") as OpeningStateObservationInput["state"],
        ...(body.openFraction !== undefined ? { openFraction: requiredNumber(body, "openFraction") } : {}),
        source,
        observedAt: body.observedAt === undefined ? new Date().toISOString() : requiredString(body, "observedAt"),
        ...(body.validUntil !== undefined ? { validUntil: requiredString(body, "validUntil") } : {}),
        ...(body.externalId !== undefined ? { externalId: requiredString(body, "externalId") } : {}),
      };
      const observation = context.database.recordOpeningStateObservation(houseId, input);
      context.notifyOpeningStateRecorded(observation);
      response.status(201).json({ observation });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
