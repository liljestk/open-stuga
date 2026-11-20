import { ANALYTICS_AGGREGATIONS, ANALYTICS_RELATIVE_RANGES } from "@climate-twin/contracts";
import { jsonRequestBody, jsonResponse } from "./support/index.js";

const definition = {
  type: "object", additionalProperties: false,
  required: ["metric", "sensorIds", "range", "resolution", "aggregation", "qualityPreset", "weatherObservationsVisible", "weatherForecastVisible"],
  properties: {
    metric: { type: "string", minLength: 1, maxLength: 200 },
    sensorIds: { type: ["array", "null"], maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
    range: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { const: "relative" }, value: { enum: ANALYTICS_RELATIVE_RANGES } } },
      { type: "object", additionalProperties: false, required: ["kind", "start", "end"], properties: { kind: { const: "absolute" }, start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } } },
    ] },
    resolution: { $ref: "#/components/schemas/AnalyticsQueryRequest/properties/resolution" },
    aggregation: { enum: ANALYTICS_AGGREGATIONS }, qualityPreset: { enum: ["good", "reliable", "all"] },
    weatherObservationsVisible: { type: "boolean" }, weatherForecastVisible: { type: "boolean" },
  },
} as const;
const view = {
  type: "object", additionalProperties: false,
  required: ["id", "houseId", "dataMode", "name", "revision", "definition", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" }, houseId: { type: "string" }, dataMode: { enum: ["live", "demo"] }, name: { type: "string", minLength: 1, maxLength: 80 },
    revision: { type: "integer", minimum: 1 }, definition,
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
} as const;
const scopeQuery = [
  { name: "houseId", in: "query", required: true, schema: { type: "string" } },
  { name: "dataMode", in: "query", required: true, schema: { enum: ["live", "demo"] } },
];
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const body = (updating: boolean) => jsonRequestBody({
  type: "object", additionalProperties: false,
  required: ["houseId", "dataMode", "name", "definition", ...(updating ? ["baseRevision"] : [])],
  properties: {
    houseId: { type: "string", maxLength: 200 }, dataMode: { enum: ["live", "demo"] }, name: { type: "string", minLength: 1, maxLength: 80 }, definition,
    ...(updating ? { baseRevision: { type: "integer", minimum: 1 } } : {}),
  },
});
const one = { type: "object", additionalProperties: false, required: ["view"], properties: { view } };
export const analyticsViewPaths = {
  "/analytics/views": {
    get: { operationId: "listSavedAnalyticsViews", summary: "List this signed-in account's visible Home views", parameters: scopeQuery,
      responses: { "200": jsonResponse("Private saved definitions; visibility and active mode are rechecked", { type: "object", additionalProperties: false, required: ["views"], properties: { views: { type: "array", maxItems: 50, items: view } } }) } },
    post: { operationId: "createSavedAnalyticsView", summary: "Save a private analytics definition", requestBody: body(false),
      responses: { "201": jsonResponse("Saved view", one) } },
  },
  "/analytics/views/{id}": {
    put: { operationId: "updateSavedAnalyticsView", summary: "Replace an owned view at its current revision", parameters: [id], requestBody: body(true),
      responses: { "200": jsonResponse("Updated view", one) } },
    delete: { operationId: "deleteSavedAnalyticsView", summary: "Remove an owned view at its current revision", parameters: [id, ...scopeQuery,
      { name: "baseRevision", in: "query", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "204": { description: "View removed" } } },
  },
};
