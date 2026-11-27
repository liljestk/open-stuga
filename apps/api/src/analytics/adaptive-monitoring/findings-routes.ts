import {
  ADAPTIVE_FINDING_STATES, ADAPTIVE_METRICS, ADAPTIVE_REVIEW_DISPOSITIONS, ADAPTIVE_REVIEW_KEY_LIMIT,
  ADAPTIVE_REVIEW_NOTE_LIMIT, type AdaptiveFindingReviewWrite,
} from "@climate-twin/contracts";
import { requestPrincipal, requireWorkspaceAdmin } from "../../app/support/local-sessions.js";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, optionalBoolean, optionalString, rejectUnknownFields, requiredNumber, requiredString } from "../../request-fields.js";
import type { Request, Response } from "express";
import type { AnalyticsQueryRouteContext } from "../query/routes.js";
import { adaptiveFindingDetail, adaptiveFindingsPage, readVisibleAdaptiveFinding } from "./findings-reader.js";
import { recordAdaptiveReview } from "./finding-reviews.js";
import { adaptiveHomeSnapshot } from "./snapshot-reader.js";
import type { AdaptiveCollectionWorker } from "./collection-worker.js";

function parseReview(input: unknown): AdaptiveFindingReviewWrite {
  const body = bodyObject(input);
  rejectUnknownFields(body, ["baseRevision", "idempotencyKey", "disposition", "note", "reportedRecovery"], "adaptive review");
  const baseRevision = requiredNumber(body, "baseRevision");
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  }
  const idempotencyKey = requiredString(body, "idempotencyKey", ADAPTIVE_REVIEW_KEY_LIMIT);
  if (!/^[A-Za-z0-9._~-]+$/.test(idempotencyKey)) throw new HttpError(400, "INVALID_FIELD", "Invalid idempotency key");
  const disposition = enumValue(body.disposition, ADAPTIVE_REVIEW_DISPOSITIONS, "disposition");
  const note = optionalString(body, "note", ADAPTIVE_REVIEW_NOTE_LIMIT);
  const reportedRecovery = optionalBoolean(body, "reportedRecovery");
  return { baseRevision, idempotencyKey, disposition, ...(note === undefined ? {} : { note }),
    ...(reportedRecovery === undefined ? {} : { reportedRecovery }) };
}

function queryInt(query: Request["query"], key: string, fallback: number, max: number): number {
  if (query[key] === undefined) return fallback;
  const raw = requiredString(query, key, 16);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function registerAdaptiveFindingsRoutes(context: AnalyticsQueryRouteContext, worker: Pick<AdaptiveCollectionWorker, "status">): void {
  const base = `${context.v2Prefix}/monitoring/houses/:houseId/adaptive`;
  const path = `${base}/findings`;
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
  context.app.get(base, requireWorkspaceAdmin, (request, response) => {
    rejectUnknownFields(request.query, ["dataMode", "limit", "streamCursor", "findingCursor", "state", "metric"], "adaptive snapshot query");
    const { scope, visible, actor } = authorize(request, response);
    const { streamCursor, findingCursor, state, metric } = request.query;
    const execution = worker.status().state;
    response.json(adaptiveHomeSnapshot(context.database, scope, {
      visible, actor, worker: execution === "failed" || execution === "paused" ? execution : null,
      limit: queryInt(request.query, "limit", 50, 100),
      ...(streamCursor === undefined ? {} : { streamCursor: requiredString(request.query, "streamCursor", 2400) }),
      ...(findingCursor === undefined ? {} : { findingCursor: requiredString(request.query, "findingCursor", 2400) }),
      ...(state === undefined ? {} : { state: enumValue(state, ADAPTIVE_FINDING_STATES, "state") }),
      ...(metric === undefined ? {} : { metric: enumValue(metric, ADAPTIVE_METRICS, "metric") }),
    }));
  });
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
    const { scope, visible, actor } = authorize(request, response);
    const detail = adaptiveFindingDetail(context.database, scope, {
      visible, actor, id: requiredString(request.params, "findingId", 80), limit: queryInt(request.query, "limit", 50, 100),
      before: queryInt(request.query, "beforeRevision", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    });
    if (!detail) throw new HttpError(404, "ADAPTIVE_FINDING_NOT_FOUND", "Adaptive Home finding not found");
    response.json(detail);
  });
  context.app.post(`${path}/:findingId/reviews`, requireWorkspaceAdmin, (request, response) => {
    rejectUnknownFields(request.query, ["dataMode"], "adaptive review query");
    const { scope, visible, actor } = authorize(request, response);
    const id = requiredString(request.params, "findingId", 80);
    const input = parseReview(request.body);
    const review = context.database.transaction(() => {
      const finding = readVisibleAdaptiveFinding(context.database, scope, { id, visible });
      if (!finding) throw new HttpError(404, "ADAPTIVE_FINDING_NOT_FOUND", "Adaptive Home finding not found");
      return recordAdaptiveReview(context.database, { finding, actor, input });
    });
    response.json(review);
  });
}
