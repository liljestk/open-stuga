import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";

export type OpenApiSchema = Record<string, unknown>;

export function jsonResponse(description: string, schema: OpenApiSchema): Record<string, unknown> {
  return { description, content: { "application/json": { schema } } };
}

export function jsonRequestBody(schema: OpenApiSchema): Record<string, unknown> {
  return { required: true, content: { "application/json": { schema } } };
}

export function stugubyResponse(description: string, schema: OpenApiSchema): Record<string, unknown> {
  return { description, content: { [STUGBY_MEDIA_TYPE]: { schema } } };
}

export function stugubyRequestBody(schema: OpenApiSchema): Record<string, unknown> {
  return { required: true, content: { [STUGBY_MEDIA_TYPE]: { schema } } };
}

export function spatialJsonResponse(description: string, schema: OpenApiSchema): Record<string, unknown> {
  return jsonResponse(description, schema);
}

export function spatialRequestBody(schema: OpenApiSchema): Record<string, unknown> {
  return jsonRequestBody(schema);
}

export const spatialScopeQueryParameters = [
  { name: "layers", in: "query", description: "Comma-separated renderer-neutral layer ids.", schema: { type: "string" } },
] as const;

export function spatialScopePaths(collection: "houses" | "properties", scopeLabel: "House" | "Property"): Record<string, unknown> {
  const base = `/${collection}/{id}/layers`;
  const pathParameters = [{ $ref: "#/components/parameters/Id" }];
  const currentResponse = { $ref: "#/components/schemas/SpatialLayerCurrent" };
  const overviewResponse = { $ref: "#/components/schemas/SpatialLayerConfigurationOverview" };
  return {
    [`${base}/current`]: {
      parameters: pathParameters,
      get: {
        tags: ["Spatial layers"], operationId: `get${scopeLabel}SpatialLayersCurrent`, parameters: spatialScopeQueryParameters,
        responses: { "200": spatialJsonResponse("Current versioned spatial layers and the exact topology used to render them.", currentResponse), "503": { description: "Optional engine unavailable" } },
      },
    },
    [`${base}/history`]: {
      parameters: pathParameters,
      get: {
        tags: ["Spatial layers"], operationId: `get${scopeLabel}SpatialLayersHistory`,
        parameters: [
          ...spatialScopeQueryParameters,
          { $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20_000, default: 2_000 } },
          { name: "includeSuperseded", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: { "200": spatialJsonResponse("Stored, replayable layer revisions.", { $ref: "#/components/schemas/SpatialLayerHistory" }), "503": { description: "Optional engine unavailable" } },
      },
    },
    [`${base}/health`]: {
      parameters: pathParameters,
      get: {
        tags: ["Spatial layers"], operationId: `get${scopeLabel}SpatialLayerHealth`,
        responses: { "200": spatialJsonResponse("Per-engine model health and last-run state.", { $ref: "#/components/schemas/SpatialLayerHealth" }), "503": { description: "Optional engine unavailable" } },
      },
    },
    [`${base}/config`]: {
      parameters: pathParameters,
      get: {
        tags: ["Spatial layers"], operationId: `get${scopeLabel}SpatialLayerConfig`,
        responses: { "200": spatialJsonResponse("Versioned configuration, assignments, and resolved topology.", overviewResponse), "503": { description: "Optional engine unavailable" } },
      },
      put: {
        tags: ["Spatial layers"], operationId: `update${scopeLabel}SpatialLayerConfig`,
        requestBody: spatialRequestBody({ $ref: "#/components/schemas/SpatialLayerConfigurationInput" }),
        responses: { "200": spatialJsonResponse("New immutable configuration version.", overviewResponse), "409": { description: "Configuration version conflict" }, "503": { description: "Optional engine unavailable" } },
      },
    },
    [`${base}/infer`]: {
      parameters: pathParameters,
      post: {
        tags: ["Spatial layers"], operationId: `infer${scopeLabel}SpatialLayers`,
        description: "Runs the selected engines in a disposable worker. Intended for explicit replay, calibration, and research use.",
        requestBody: spatialRequestBody({ $ref: "#/components/schemas/SpatialLayerInferenceInput" }),
        responses: { "200": spatialJsonResponse("Versioned inference snapshots.", { $ref: "#/components/schemas/SpatialLayerInferenceResult" }), "503": { description: "Optional engine unavailable" } },
      },
    },
    [`${base}/ground-truth`]: {
      parameters: pathParameters,
      get: {
        tags: ["Spatial layers"], operationId: `list${scopeLabel}SpatialLayerGroundTruth`,
        responses: { "200": spatialJsonResponse("Evaluation labels kept separate from inferred output.", { type: "object", required: ["groundTruth"], properties: { groundTruth: { type: "array", items: { $ref: "#/components/schemas/SpatialGroundTruth" } } } }) },
      },
      post: {
        tags: ["Spatial layers"], operationId: `create${scopeLabel}SpatialLayerGroundTruth`,
        requestBody: spatialRequestBody({ $ref: "#/components/schemas/SpatialGroundTruthInput" }),
        responses: { "201": spatialJsonResponse("Stored evaluation label.", { type: "object", required: ["groundTruth"], properties: { groundTruth: { $ref: "#/components/schemas/SpatialGroundTruth" } } }) },
      },
    },
  };
}

export function spatialHouseResourcePath(
  resource: "bindings" | "calibrations" | "calibration-sessions" | "context-events",
  label: string,
  itemSchema: string,
  inputSchema: string,
  collectionKey: string,
  itemKey: string,
  createResponseSchema?: string,
): Record<string, unknown> {
  const responseCollection = { type: "object", additionalProperties: false, required: [collectionKey], properties: { [collectionKey]: { type: "array", items: { $ref: `#/components/schemas/${itemSchema}` } } } };
  const responseItem = createResponseSchema
    ? { $ref: `#/components/schemas/${createResponseSchema}` }
    : { type: "object", additionalProperties: false, required: [itemKey], properties: { [itemKey]: { $ref: `#/components/schemas/${itemSchema}` } } };
  return {
    [`/houses/{id}/layers/${resource}`]: {
      parameters: [{ $ref: "#/components/parameters/Id" }],
      get: {
        tags: ["Spatial layers"], operationId: `listHouseSpatial${label}`,
        parameters: resource === "context-events" ? [{ $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" }] : [],
        responses: { "200": spatialJsonResponse(`Stored spatial ${resource}.`, responseCollection), "503": { description: "Optional engine unavailable" } },
      },
      post: {
        tags: ["Spatial layers"], operationId: `createHouseSpatial${label}`,
        requestBody: spatialRequestBody({ $ref: `#/components/schemas/${inputSchema}` }),
        responses: { "201": spatialJsonResponse(`Stored spatial ${resource.slice(0, -1)}.`, responseItem), "503": { description: "Optional engine unavailable" } },
      },
    },
  };
}

export const spatialLayerPaths = {
  "/layer-engines": {
    get: {
      tags: ["Spatial layers"], operationId: "listSpatialLayerEngines",
      responses: { "200": spatialJsonResponse("Installed stable, experimental, and research engine manifests.", { type: "object", required: ["enabled", "engines"], properties: { enabled: { type: "boolean" }, engines: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerEngineManifest" } } } }) },
    },
  },
  ...spatialScopePaths("houses", "House"),
  ...spatialScopePaths("properties", "Property"),
  ...spatialHouseResourcePath("bindings", "Bindings", "SpatialSensorBinding", "SpatialSensorBindingInput", "bindings", "binding"),
  ...spatialHouseResourcePath("calibrations", "Calibrations", "SpatialSensorCalibration", "SpatialSensorCalibrationInput", "calibrations", "calibration"),
  ...spatialHouseResourcePath("calibration-sessions", "CalibrationSessions", "SpatialCalibrationSession", "SpatialCalibrationSessionInput", "sessions", "session", "SpatialCalibrationSessionCreateResponse"),
  ...spatialHouseResourcePath("context-events", "ContextEvents", "SpatialContextEvent", "SpatialContextEventInput", "events", "event"),
  "/layers/events": {
    get: {
      tags: ["Spatial layers"], operationId: "streamSpatialLayerSnapshots",
      parameters: [
        { name: "scopeKind", in: "query", schema: { enum: ["house", "property"] }, description: "Supply together with scopeId." },
        { name: "scopeId", in: "query", schema: { type: "string" }, description: "Supply together with scopeKind." },
      ],
      responses: { "200": { description: "Server-sent ready and spatial-layer-snapshot notifications. Authorization changes emit a final event before the stream closes.", content: { "text/event-stream": { schema: { type: "string" } } }, "x-sse-event-schemas": { authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } }, "503": { description: "Optional engine unavailable" } },
    },
  },
} as const;
