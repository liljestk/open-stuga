import type { ActionPlaybookInput } from "@climate-twin/contracts";
import { HttpError, bodyObject, boundedQueryInteger, measurementId, optionalResourceQuery, parseActionPlaybookInput, parseActionRunStart, requireNonGuest, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Action playbooks and action runs, including the playbooks suggested for an alert. */
export function registerActionRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/action-playbooks`, requireNonGuest, (request, response) => {
      const metric = typeof request.query.metric === "string" ? measurementId(request.query.metric) : undefined;
      response.json({ playbooks: context.database.listActionPlaybooks(metric, request.query.enabled === "true") });
    });
  context.app.post(`${context.prefix}/action-playbooks`, (request, response) => {
      response.status(201).json({ playbook: context.database.saveActionPlaybook(parseActionPlaybookInput(request.body) as ActionPlaybookInput) });
    });
  context.app.patch(`${context.prefix}/action-playbooks/:id`, (request, response) => {
      const playbook = context.database.updateActionPlaybook(
        request.params.id as string,
        parseActionPlaybookInput(request.body, true) as Partial<ActionPlaybookInput>,
      );
      if (!playbook) throw new HttpError(404, "NOT_FOUND", "Action playbook not found");
      response.json({ playbook });
    });
  context.app.get(`${context.prefix}/alerts/:id/action-playbooks`, (request, response) => {
      const event = context.database.getAlertEvent(request.params.id as string);
      if (!event || !context.visibility(response).sensor(event.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      response.json({ playbooks: context.database.listActionPlaybooks(event.metric, true) });
    });
  context.app.get(`${context.prefix}/action-runs`, (request, response) => {
      const access = context.visibility(response);
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      if (houseId) {
        const house = context.database.getHouse(houseId);
        if (!house || !access.house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      }
      response.json({ runs: context.database.listActionRuns({
        ...(houseId ? { houseId } : {}),
        ...(typeof request.query.sensorId === "string" ? { sensorId: request.query.sensorId } : {}),
        ...(typeof request.query.alertEventId === "string" ? { alertEventId: request.query.alertEventId } : {}),
        activeOnly: request.query.active === "true",
        limit: boundedQueryInteger(request.query.limit, "limit", 1, 500) ?? 500,
      }).filter((run) => access.sensor(run.sensorId)) });
    });
  context.app.post(`${context.prefix}/action-runs`, (request, response) => {
      const run = context.database.startActionRun(parseActionRunStart(request.body));
      context.bus.publish({ type: "mutation", data: { method: "POST", resource: `/action-runs/${run.id}`, occurredAt: run.createdAt } });
      response.status(201).json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/complete`, (request, response) => {
      const run = context.database.completeActionRun(request.params.id as string);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/cancel`, (request, response) => {
      const body = request.body === undefined ? {} : bodyObject(request.body);
      const note = body.note === undefined || body.note === null ? null : requiredString(body, "note");
      const run = context.database.cancelActionRun(request.params.id as string, note);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
}
