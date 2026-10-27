import { HttpError, parseObservationInput, parseObservationPatch } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Manual observations and their revisions. */
export function registerObservationRoutes(context: ApiRouteRegistrationContext): void {
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
}
