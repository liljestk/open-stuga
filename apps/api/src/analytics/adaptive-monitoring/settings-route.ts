import {
  ADAPTIVE_BASELINE_REASON_LIMIT, ADAPTIVE_SETTINGS_MODES, isAdaptiveReferenceGroups, type AdaptiveSettingsChange,
} from "@climate-twin/contracts";
import { requestPrincipal, requireWorkspaceAdmin } from "../../app/support/local-sessions.js";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, rejectUnknownFields, requiredNumber, requiredString } from "../../request-fields.js";
import type express from "express";
import type { AnalyticsQueryRouteContext } from "../query/routes.js";

function parseAdaptiveSettingsChange(input: unknown): AdaptiveSettingsChange {
  const body = bodyObject(input);
  const fields = { "set-mode": "mode", "reset-baseline": "reason", "set-reference-groups": "referenceGroups" } as const;
  const action = enumValue(body.action, ["set-mode", "reset-baseline", "set-reference-groups"], "action");
  rejectUnknownFields(body, ["dataMode", "baseRevision", "action", fields[action]], "adaptive settings");
  const dataMode = enumValue(body.dataMode, ["live", "demo"], "dataMode");
  const baseRevision = requiredNumber(body, "baseRevision");
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision === Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a non-negative integer below the revision limit");
  }
  if (action === "set-reference-groups") {
    const { referenceGroups } = body;
    if (!isAdaptiveReferenceGroups(referenceGroups)) {
      throw new HttpError(400, "INVALID_REFERENCE_GROUPS", "Invalid adaptive temperature reference groups");
    }
    for (const group of referenceGroups) {
      rejectUnknownFields({ ...group }, ["targetSensorId", "kind", "referenceSensorIds", "placement"], "reference group");
    }
    return { action, dataMode, baseRevision, referenceGroups };
  }
  return action === "set-mode"
    ? { action, dataMode, baseRevision, mode: enumValue(body.mode, ADAPTIVE_SETTINGS_MODES, "mode") }
    : { action, dataMode, baseRevision, reason: requiredString(body, "reason", ADAPTIVE_BASELINE_REASON_LIMIT) };
}

export function registerAdaptiveSettingsRoute(context: AnalyticsQueryRouteContext): void {
  const path = `${context.v2Prefix}/monitoring/houses/:houseId/adaptive/settings`;
  const authorize = (request: express.Request, response: express.Response) => {
    const principal = requestPrincipal(response);
    if (principal.bootstrap) throw new HttpError(403, "ADAPTIVE_ACCOUNT_REQUIRED", "Sign in to manage adaptive settings");
    const houseId = requiredString(request.params, "houseId", 200);
    if (!context.visibility(response).house(houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "Active local Home not found");
    response.setHeader("cache-control", "private, no-store");
    return { houseId, actorUserId: principal.userId };
  };
  context.app.get(path, requireWorkspaceAdmin, (request, response) => {
    const { houseId } = authorize(request, response);
    rejectUnknownFields(request.query, ["dataMode"], "adaptive settings query");
    const dataMode = enumValue(request.query.dataMode, ["live", "demo"], "dataMode");
    response.json(context.database.adaptiveMonitoringSettings({ houseId, dataMode }));
  });
  context.app.patch(path, requireWorkspaceAdmin, (request, response) => {
    const scope = authorize(request, response);
    const change = parseAdaptiveSettingsChange(request.body);
    response.json(context.database.changeAdaptiveMonitoringSettings({ ...scope, change }));
  });
}
