import { ADAPTIVE_FINDING_STATES, ADAPTIVE_METRICS } from "@climate-twin/contracts";
import { requestPrincipal, requireWorkspaceAdmin } from "../../app/support/local-sessions.js";
import { HttpError } from "../../http-error.js";
import { enumValue, rejectUnknownFields, requiredString } from "../../request-fields.js";
import type { Request, Response } from "express";
import type { AnalyticsQueryRouteContext } from "../query/routes.js";
import { adaptiveFindingDetail, adaptiveFindingsPage } from "./findings-reader.js";

function queryInt(query: Request["query"], key: string, fallback: number, max: number): number {
  if (query[key] === undefined) return fallback;
  const raw = requiredString(query, key, 16);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function registerAdaptiveFindingsRoutes(context: AnalyticsQueryRouteContext): void {
  const path = `${context.v2Prefix}/monitoring/houses/:houseId/adaptive/findings`;
  function authorize(request: Request, response: Response) {
    const principal = requestPrincipal(response);
    if (principal.bootstrap) throw new HttpError(403, "ADAPTIVE_ACCOUNT_REQUIRED", "Sign in to read Adaptive Home diagnostics");
    const houseId = requiredString(request.params, "houseId", 200);
    const visibility = context.visibility(response);
    if (!visibility.house(houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "Active local Home not found");
    const dataMode = enumValue(request.query.dataMode, ["live", "demo"], "dataMode");
    response.setHeader("cache-control", "private, no-store");
    return { scope: { houseId, dataMode }, visible: (sensorId: string) => visibility.sensor(sensorId), actor: principal.userId };
  }
  context.app.get(path, requireWorkspaceAdmin, (request, response) => {
    rejectUnknownFields(request.query, ["dataMode", "limit", "cursor", "state", "metric"], "adaptive findings query");
    const { scope, visible, actor } = authorize(request, response);
    const { cursor, state, metric } = request.query;
    response.json(adaptiveFindingsPage(context.database, scope, {
      visible, actor, limit: queryInt(request.query, "limit", 50, 100),
      ...(cursor === undefined ? {} : { cursor: requiredString(request.query, "cursor", 1200) }),
      ...(state === undefined ? {} : { state: enumValue(state, ADAPTIVE_FINDING_STATES, "state") }),
      ...(metric === undefined ? {} : { metric: enumValue(metric, ADAPTIVE_METRICS, "metric") }),
    }));
  });
  context.app.get(`${path}/:findingId`, requireWorkspaceAdmin, (request, response) => {
    rejectUnknownFields(request.query, ["dataMode", "limit", "beforeRevision"], "adaptive finding query");
    const { scope, visible } = authorize(request, response);
    const detail = adaptiveFindingDetail(context.database, scope, {
      visible, id: requiredString(request.params, "findingId", 80), limit: queryInt(request.query, "limit", 50, 100),
      before: queryInt(request.query, "beforeRevision", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    });
    if (!detail) throw new HttpError(404, "ADAPTIVE_FINDING_NOT_FOUND", "Adaptive Home finding not found");
    response.json(detail);
  });
}
