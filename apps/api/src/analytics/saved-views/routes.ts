import type express from "express";
import { isAnalyticsViewDefinition, type AnalyticsViewDefinition, type DataMode } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, rejectUnknownFields, requiredString } from "../../request-fields.js";
import { requestPrincipal, requireNonGuest } from "../../app/support/local-sessions.js";
import type { AnalyticsQueryRouteContext } from "../query/routes.js";
import { requireAnalyticsCoverageMeasurements, resolveAnalyticsScopeSensors } from "../query/scope.js";
import { resolveAnalyticsAggregation } from "../query/analytics-query.js";
import { SavedAnalyticsViews, type SavedViewScope } from "./store.js";

function scope(context: AnalyticsQueryRouteContext, response: express.Response, input: Record<string, unknown>): SavedViewScope {
  const principal = requestPrincipal(response);
  if (!context.database.db.prepare("SELECT 1 FROM local_workspace_members WHERE user_id = ?").get(principal.userId)) {
    throw new HttpError(403, "SAVED_VIEW_ACCOUNT_REQUIRED", "Saved views require a signed-in account");
  }
  const result = { userId: principal.userId, houseId: requiredString(input, "houseId", 200),
    dataMode: enumValue<DataMode>(input.dataMode, ["live", "demo"], "dataMode") };
  resolveAnalyticsScopeSensors(context.database, { dataMode: result.dataMode, scope: { kind: "house", id: result.houseId, entityIds: [] } }, context.visibility(response));
  response.setHeader("cache-control", "private, no-store");
  return result;
}
function validateDefinition(context: AnalyticsQueryRouteContext, response: express.Response, owner: SavedViewScope, definition: AnalyticsViewDefinition): void {
  resolveAnalyticsScopeSensors(context.database, { dataMode: owner.dataMode,
    scope: { kind: "house", id: owner.houseId, ...(definition.sensorIds ? { entityIds: definition.sensorIds } : {}) } }, context.visibility(response));
  requireAnalyticsCoverageMeasurements(context.database, [definition.metric]);
  const measurement = context.database.getMeasurementDefinition(definition.metric)!;
  resolveAnalyticsAggregation(measurement, definition.aggregation);
}
function revision(value: unknown): number {
  const result = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || Number(result) < 1) throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  return Number(result);
}
function input(value: unknown, updating = false) {
  const body = bodyObject(value);
  rejectUnknownFields(body, ["houseId", "dataMode", "name", "definition", ...(updating ? ["baseRevision"] : [])], "saved view");
  if (!isAnalyticsViewDefinition(body.definition)) throw new HttpError(400, "INVALID_FIELD", "definition must be a valid analytics view");
  return { body, name: requiredString(body, "name", 80), definition: body.definition };
}

export function registerSavedAnalyticsViewRoutes(context: AnalyticsQueryRouteContext): void {
  const store = new SavedAnalyticsViews(context.database.db);
  const base = `${context.v2Prefix}/analytics/views`;
  context.app.get(base, (request, response) => {
    rejectUnknownFields(request.query, ["houseId", "dataMode"], "saved view query");
    const owner = scope(context, response, request.query);
    const views = store.list(owner).filter((view) => {
      try { validateDefinition(context, response, owner, view.definition); return true; }
      catch (error) { if (error instanceof HttpError && [404, 422].includes(error.status)) return false; throw error; }
    });
    response.json({ views });
  });
  context.app.post(base, requireNonGuest, (request, response) => {
    const parsed = input(request.body);
    const owner = scope(context, response, parsed.body);
    validateDefinition(context, response, owner, parsed.definition);
    response.status(201).json({ view: store.create(owner, parsed) });
  });
  context.app.put(`${base}/:id`, requireNonGuest, (request, response) => {
    const parsed = input(request.body, true);
    const owner = scope(context, response, parsed.body);
    store.get(owner, request.params.id as string);
    validateDefinition(context, response, owner, parsed.definition);
    response.json({ view: store.update(owner, { ...parsed, id: request.params.id as string, baseRevision: revision(parsed.body.baseRevision) }) });
  });
  context.app.delete(`${base}/:id`, requireNonGuest, (request, response) => {
    rejectUnknownFields(request.query, ["houseId", "dataMode", "baseRevision"], "saved view query");
    const owner = scope(context, response, request.query);
    store.delete(owner, { id: request.params.id as string, baseRevision: revision(request.query.baseRevision) });
    response.status(204).end();
  });
}
