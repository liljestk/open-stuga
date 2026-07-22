import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";

type OpenApiSchema = Record<string, unknown>;

function jsonResponse(description: string, schema: OpenApiSchema): Record<string, unknown> {
  return { description, content: { "application/json": { schema } } };
}

function jsonRequestBody(schema: OpenApiSchema): Record<string, unknown> {
  return { required: true, content: { "application/json": { schema } } };
}

function spatialJsonResponse(description: string, schema: OpenApiSchema): Record<string, unknown> {
  return jsonResponse(description, schema);
}

function spatialRequestBody(schema: OpenApiSchema): Record<string, unknown> {
  return jsonRequestBody(schema);
}

const spatialScopeQueryParameters = [
  { name: "layers", in: "query", description: "Comma-separated renderer-neutral layer ids.", schema: { type: "string" } },
] as const;

function spatialScopePaths(collection: "houses" | "properties", scopeLabel: "House" | "Property"): Record<string, unknown> {
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

function spatialHouseResourcePath(
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

const spatialLayerPaths = {
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

const spatialLayerSchemas = {
  Vector2: {
    type: "object", additionalProperties: false, required: ["x", "y"],
    properties: { x: { type: "number" }, y: { type: "number" } },
  },
  Vector3: {
    type: "object", additionalProperties: false, required: ["x", "y", "z"],
    properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  },
  SpatialPartition: {
    type: "object", additionalProperties: false, required: ["sourceDbId", "dataMode"],
    properties: { sourceDbId: { type: "string" }, dataMode: { enum: ["demo", "real"] } },
  },
  SpatialScope: {
    type: "object", additionalProperties: false, required: ["kind", "id"],
    properties: { kind: { enum: ["house", "property"] }, id: { type: "string" } },
  },
  SpatialLayerEngineManifest: {
    type: "object", additionalProperties: false,
    required: ["id", "version", "maturity", "title", "description", "supportedScopes", "requiredMetrics", "producedLayerIds"],
    properties: {
      id: { type: "string" }, version: { type: "string" }, maturity: { enum: ["stable", "experimental", "research"] },
      title: { type: "string" }, description: { type: "string" },
      supportedScopes: { type: "array", items: { enum: ["house", "property"] } },
      requiredMetrics: { type: "array", items: { enum: ["temperatureC", "relativeHumidityPct"] } },
      producedLayerIds: { type: "array", items: { type: "string" } },
      dependencies: { type: "array", items: { type: "string" } },
    },
  },
  SpatialCoordinateFrame: {
    type: "object", additionalProperties: false, required: ["id", "version", "kind", "unit"],
    properties: {
      id: { type: "string" }, version: { type: "string" },
      kind: { enum: ["floor-plan-2d", "building-local-3d", "property-local-3d", "geographic"] },
      unit: { enum: ["normalized", "m", "degrees"] }, origin: { $ref: "#/components/schemas/Vector3" },
      floorId: { type: "string" }, rotationDegrees: { type: "number" },
    },
  },
  SpatialZone: {
    type: "object", additionalProperties: false, required: ["id", "name", "kind", "frameId", "centroid"],
    properties: {
      id: { type: "string" }, name: { type: "string" },
      kind: { enum: ["indoor", "cellar", "attic", "crawlspace", "outdoor", "building", "unknown"] },
      frameId: { type: "string" }, floorId: { type: "string" }, roomId: { type: "string" },
      centroid: { $ref: "#/components/schemas/Vector3" }, polygon: { type: "array", items: { $ref: "#/components/schemas/Vector2" } },
      elevationM: { type: "number" }, heightM: { type: "number" }, volumeM3: { type: "number" },
      isEntryZone: { type: "boolean" }, tags: { type: "array", items: { type: "string" } },
    },
  },
  SpatialConnection: {
    type: "object", additionalProperties: false, required: ["id", "zoneAId", "zoneBId", "kind", "enabled"],
    properties: {
      id: { type: "string" }, zoneAId: { type: "string" }, zoneBId: { type: "string" },
      kind: { enum: ["door", "open-passage", "stair", "vent", "window", "envelope-leakage", "site-link", "unknown"] },
      enabled: { type: "boolean" }, normallyOpen: { type: "boolean" }, openingAreaM2: { type: "number" },
      anchors: { type: "array", items: { $ref: "#/components/schemas/Vector3" } },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  SpatialTopologySensorBinding: {
    type: "object", additionalProperties: false,
    required: ["sensorId", "zoneId", "frameId", "position", "role", "activeFrom"],
    properties: {
      sensorId: { type: "string" }, zoneId: { type: "string" }, frameId: { type: "string" },
      position: { $ref: "#/components/schemas/Vector3" }, role: { enum: ["primary", "supporting", "outdoor"] },
      activeFrom: { type: "string", format: "date-time" }, activeTo: { type: "string", format: "date-time" },
      placementRisks: { type: "array", items: { enum: ["near-window", "near-exterior-wall", "near-radiator", "near-heat-pump", "direct-sunlight", "unknown"] } },
    },
  },
  SpatialTopology: {
    type: "object", additionalProperties: false, required: ["scope", "frames", "zones", "connections", "sensorBindings"],
    properties: {
      scope: { $ref: "#/components/schemas/SpatialScope" },
      frames: { type: "array", items: { $ref: "#/components/schemas/SpatialCoordinateFrame" } },
      zones: { type: "array", items: { $ref: "#/components/schemas/SpatialZone" } },
      connections: { type: "array", items: { $ref: "#/components/schemas/SpatialConnection" } },
      sensorBindings: { type: "array", items: { $ref: "#/components/schemas/SpatialTopologySensorBinding" } },
    },
  },
  SpatialLayerMetric: {
    type: "object", additionalProperties: false, required: ["value", "quality"],
    properties: {
      value: { type: ["number", "string", "boolean", "null"] }, unit: { type: "string" },
      quality: { type: "number", minimum: 0, maximum: 1 }, label: { type: "string" },
    },
  },
  SpatialLayerEvidence: {
    type: "object", additionalProperties: false, required: ["score", "kind", "reasonCodes"],
    properties: {
      score: { type: "number" }, kind: { enum: ["observation", "inference", "quality"] },
      reasonCodes: { type: "array", items: { type: "string" } },
      details: { type: "object", additionalProperties: { type: ["number", "string", "boolean", "null"] } },
    },
  },
  SpatialLayerStyle: {
    type: "object", additionalProperties: false,
    properties: {
      emphasis: { type: "number" }, opacity: { type: "number" }, lineStyle: { enum: ["solid", "dashed", "dotted"] },
      direction: { enum: ["a-to-b", "b-to-a", "both", "none"] },
      palette: { enum: ["temperature", "humidity", "quality", "air", "activity", "neutral"] },
    },
  },
  SpatialZoneLayerValue: {
    type: "object", additionalProperties: false,
    required: ["zoneId", "frameId", "metrics", "evidence", "reasonCodes"],
    properties: {
      zoneId: { type: "string" }, frameId: { type: "string" }, name: { type: "string" },
      floorId: { type: "string" }, roomId: { type: "string" },
      polygon: { type: "array", items: { $ref: "#/components/schemas/Vector2" } },
      tags: { type: "array", items: { type: "string" } }, anchor: { $ref: "#/components/schemas/Vector3" },
      metrics: { type: "object", additionalProperties: { $ref: "#/components/schemas/SpatialLayerMetric" } },
      evidence: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerEvidence" } },
      reasonCodes: { type: "array", items: { type: "string" } }, style: { $ref: "#/components/schemas/SpatialLayerStyle" },
    },
  },
  SpatialConnectionLayerValue: {
    type: "object", additionalProperties: false,
    required: ["connectionId", "fromZoneId", "toZoneId", "state", "metrics", "evidence", "reasonCodes"],
    properties: {
      connectionId: { type: "string" }, frameId: { type: "string" },
      anchors: { type: "array", items: { $ref: "#/components/schemas/Vector3" } },
      anchorRefs: { type: "array", items: { type: "object", additionalProperties: false, required: ["frameId", "position"], properties: { frameId: { type: "string" }, position: { $ref: "#/components/schemas/Vector3" } } } },
      fromZoneId: { type: ["string", "null"] }, toZoneId: { type: ["string", "null"] },
      state: { enum: ["directed", "bidirectional-evidence", "no-detectable-propagation", "uncertain", "insufficient-data"] },
      metrics: { type: "object", additionalProperties: { $ref: "#/components/schemas/SpatialLayerMetric" } },
      evidence: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerEvidence" } },
      reasonCodes: { type: "array", items: { type: "string" } }, style: { $ref: "#/components/schemas/SpatialLayerStyle" },
    },
  },
  SpatialPointLayerValue: {
    type: "object", additionalProperties: false,
    required: ["pointId", "frameId", "position", "metrics", "evidence", "reasonCodes"],
    properties: {
      pointId: { type: "string" }, zoneId: { type: "string" }, frameId: { type: "string" },
      position: { $ref: "#/components/schemas/Vector3" },
      metrics: { type: "object", additionalProperties: { $ref: "#/components/schemas/SpatialLayerMetric" } },
      evidence: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerEvidence" } },
      reasonCodes: { type: "array", items: { type: "string" } }, style: { $ref: "#/components/schemas/SpatialLayerStyle" },
    },
  },
  SpatialLayerModel: {
    type: "object", additionalProperties: false, required: ["id", "version", "maturity"],
    properties: { id: { type: "string" }, version: { type: "string" }, maturity: { enum: ["stable", "experimental", "research"] } },
  },
  SpatialLayerSnapshot: {
    type: "object", additionalProperties: false,
    required: ["id", "partition", "scope", "coordinateFrames", "layerId", "model", "generatedAt", "windowStart", "windowEnd", "status", "configVersion", "inputDigest", "qualityScore", "warnings", "reasonCodes", "zones", "connections", "points", "revision", "supersedesSnapshotId", "createdAt"],
    properties: {
      id: { type: "string" }, partition: { $ref: "#/components/schemas/SpatialPartition" },
      scope: { $ref: "#/components/schemas/SpatialScope" }, layerId: { type: "string" },
      generatedAt: { type: "string", format: "date-time" }, windowStart: { type: "string", format: "date-time" }, windowEnd: { type: "string", format: "date-time" },
      status: { enum: ["ready", "warming_up", "insufficient_data", "error"] }, model: { $ref: "#/components/schemas/SpatialLayerModel" },
      coordinateFrames: { type: "array", items: { $ref: "#/components/schemas/SpatialCoordinateFrame" } }, inputDigest: { type: "string" },
      configVersion: { type: "string" }, qualityScore: { type: "number", minimum: 0, maximum: 1 },
      warnings: { type: "array", items: { type: "string" } }, reasonCodes: { type: "array", items: { type: "string" } },
      zones: { type: "array", items: { $ref: "#/components/schemas/SpatialZoneLayerValue" } },
      connections: { type: "array", items: { $ref: "#/components/schemas/SpatialConnectionLayerValue" } },
      points: { type: "array", items: { $ref: "#/components/schemas/SpatialPointLayerValue" } },
      metadata: { type: "object", additionalProperties: { type: ["number", "string", "boolean", "null"] } },
      revision: { type: "integer", minimum: 1 }, supersedesSnapshotId: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  SpatialLayerCurrent: {
    type: "object", required: ["partition", "scope", "at", "topology", "layers", "warnings"],
    properties: {
      partition: { $ref: "#/components/schemas/SpatialPartition" }, scope: { $ref: "#/components/schemas/SpatialScope" }, at: { type: ["string", "null"], format: "date-time" },
      topology: { $ref: "#/components/schemas/SpatialTopology" }, layers: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerSnapshot" } }, warnings: { type: "array", items: { type: "string" } },
    }, additionalProperties: false,
  },
  SpatialLayerHistory: {
    type: "object", additionalProperties: false, required: ["partition", "scope", "from", "to", "layers"],
    properties: { partition: { $ref: "#/components/schemas/SpatialPartition" }, scope: { $ref: "#/components/schemas/SpatialScope" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, layers: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerSnapshot" } } },
  },
  SpatialInferenceRun: {
    type: "object", additionalProperties: false,
    required: ["id", "partition", "scope", "engineId", "engineVersion", "bucketAt", "configVersion", "status", "startedAt", "finishedAt", "inputDigest", "snapshotIds", "errorCode", "errorMessage", "durationMs"],
    properties: {
      id: { type: "string" }, partition: { $ref: "#/components/schemas/SpatialPartition" }, scope: { $ref: "#/components/schemas/SpatialScope" },
      engineId: { type: "string" }, engineVersion: { type: "string" }, bucketAt: { type: "string", format: "date-time" },
      configVersion: { type: "integer", minimum: 0 }, status: { enum: ["running", "succeeded", "failed", "timed_out", "skipped"] },
      startedAt: { type: "string", format: "date-time" }, finishedAt: { type: ["string", "null"], format: "date-time" },
      inputDigest: { type: ["string", "null"] }, snapshotIds: { type: "array", items: { type: "string" } },
      errorCode: { type: ["string", "null"] }, errorMessage: { type: ["string", "null"] }, durationMs: { type: ["integer", "null"], minimum: 0 },
    },
  },
  SpatialEngineHealth: {
    type: "object", additionalProperties: false,
    required: ["scope", "engineId", "engineVersion", "enabled", "state", "latestRun", "latestSnapshotAt"],
    properties: {
      scope: { $ref: "#/components/schemas/SpatialScope" }, engineId: { type: "string" }, engineVersion: { type: "string" }, enabled: { type: "boolean" },
      state: { enum: ["healthy", "learning_baseline", "degraded_sensor_data", "configuration_incomplete", "calibration_stale", "error", "disabled", "never_run"] },
      latestRun: { oneOf: [{ $ref: "#/components/schemas/SpatialInferenceRun" }, { type: "null" }] },
      latestSnapshotAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  SpatialLayerHealth: { type: "object", additionalProperties: false, required: ["partition", "scope", "engines"], properties: { partition: { $ref: "#/components/schemas/SpatialPartition" }, scope: { $ref: "#/components/schemas/SpatialScope" }, engines: { type: "array", items: { $ref: "#/components/schemas/SpatialEngineHealth" } } } },
  SpatialConfigurationVersion: {
    type: "object", additionalProperties: false, required: ["scope", "version", "config", "createdAt", "createdBy"],
    properties: { scope: { $ref: "#/components/schemas/SpatialScope" }, version: { type: "integer", minimum: 0 }, config: { type: "object", additionalProperties: true }, createdAt: { type: "string", format: "date-time" }, createdBy: { type: ["string", "null"] } },
  },
  SpatialEngineAssignment: {
    type: "object", additionalProperties: false, required: ["scope", "engineId", "engineVersion", "enabled", "layerIds", "configVersion", "updatedAt"],
    properties: { scope: { $ref: "#/components/schemas/SpatialScope" }, engineId: { type: "string" }, engineVersion: { type: "string" }, enabled: { type: "boolean" }, layerIds: { type: "array", items: { type: "string" } }, configVersion: { type: "integer", minimum: 0 }, updatedAt: { type: "string", format: "date-time" } },
  },
  SpatialEngineAssignmentInput: {
    type: "object", additionalProperties: false, required: ["engineId", "enabled"],
    properties: { engineId: { type: "string" }, engineVersion: { type: "string" }, enabled: { type: "boolean" }, layerIds: { type: "array", items: { type: "string" } } },
  },
  SpatialLayerConfigurationOverview: { type: "object", additionalProperties: false, required: ["partition", "scope", "configuration", "assignments", "topology", "warnings"], properties: { partition: { $ref: "#/components/schemas/SpatialPartition" }, scope: { $ref: "#/components/schemas/SpatialScope" }, configuration: { $ref: "#/components/schemas/SpatialConfigurationVersion" }, assignments: { type: "array", items: { $ref: "#/components/schemas/SpatialEngineAssignment" } }, topology: { $ref: "#/components/schemas/SpatialTopology" }, warnings: { type: "array", items: { type: "string" } } } },
  SpatialLayerConfigurationInput: { type: "object", additionalProperties: false, required: ["baseVersion", "config"], properties: { baseVersion: { type: "integer", minimum: 0 }, config: { type: "object", additionalProperties: true }, assignments: { type: "array", items: { $ref: "#/components/schemas/SpatialEngineAssignmentInput" } } } },
  SpatialLayerInferenceInput: { type: "object", additionalProperties: false, properties: { bucketAt: { type: "string", format: "date-time" }, layers: { type: "array", items: { type: "string" } } } },
  SpatialInferenceFailure: { type: "object", additionalProperties: false, required: ["engineId", "code", "message"], properties: { engineId: { type: "string" }, code: { type: "string" }, message: { type: "string" } } },
  SpatialLayerInferenceResult: { type: "object", additionalProperties: false, required: ["scope", "bucketAt", "status", "snapshots", "failures"], properties: { scope: { $ref: "#/components/schemas/SpatialScope" }, bucketAt: { type: "string", format: "date-time" }, status: { enum: ["succeeded", "partial", "failed", "disabled"] }, snapshots: { type: "array", items: { $ref: "#/components/schemas/SpatialLayerSnapshot" } }, failures: { type: "array", items: { $ref: "#/components/schemas/SpatialInferenceFailure" } } } },
  SpatialGroundTruthInput: { type: "object", additionalProperties: false, required: ["label"], properties: { id: { type: "string" }, startAt: { type: "string", format: "date-time" }, endAt: { type: ["string", "null"], format: "date-time" }, label: { type: "string" }, zoneId: { type: ["string", "null"] }, fromZoneId: { type: ["string", "null"] }, toZoneId: { type: ["string", "null"] }, source: { enum: ["user", "optional_sensor", "controlled_test"] }, note: { type: ["string", "null"] } } },
  SpatialGroundTruth: { type: "object", additionalProperties: false, required: ["id", "scope", "startAt", "endAt", "label", "zoneId", "fromZoneId", "toZoneId", "source", "note", "createdAt", "createdBy"], properties: { id: { type: "string" }, scope: { $ref: "#/components/schemas/SpatialScope" }, startAt: { type: "string", format: "date-time" }, endAt: { type: ["string", "null"], format: "date-time" }, label: { type: "string" }, zoneId: { type: ["string", "null"] }, fromZoneId: { type: ["string", "null"] }, toZoneId: { type: ["string", "null"] }, source: { enum: ["user", "optional_sensor", "controlled_test"] }, note: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, createdBy: { type: ["string", "null"] } } },
  SpatialSensorBindingInput: { type: "object", additionalProperties: false, required: ["sensorId", "zoneId", "frameId", "position", "role"], properties: { id: { type: "string" }, sensorId: { type: "string" }, zoneId: { type: "string" }, frameId: { type: "string" }, position: { $ref: "#/components/schemas/Vector3" }, role: { enum: ["primary", "supporting", "outdoor"] }, activeFrom: { type: "string", format: "date-time" }, activeTo: { type: ["string", "null"], format: "date-time" }, placementRisks: { type: "array", items: { enum: ["near-window", "near-exterior-wall", "near-radiator", "near-heat-pump", "direct-sunlight", "unknown"] } } } },
  SpatialSensorBinding: { type: "object", additionalProperties: false, required: ["id", "houseId", "sensorId", "zoneId", "frameId", "position", "role", "activeFrom", "createdAt"], properties: { id: { type: "string" }, houseId: { type: "string" }, sensorId: { type: "string" }, zoneId: { type: "string" }, frameId: { type: "string" }, position: { $ref: "#/components/schemas/Vector3" }, role: { enum: ["primary", "supporting", "outdoor"] }, activeFrom: { type: "string", format: "date-time" }, activeTo: { type: "string", format: "date-time" }, placementRisks: { type: "array", items: { enum: ["near-window", "near-exterior-wall", "near-radiator", "near-heat-pump", "direct-sunlight", "unknown"] } }, createdAt: { type: "string", format: "date-time" } } },
  SpatialSensorCalibrationInput: { type: "object", additionalProperties: false, required: ["sensorId", "temperatureOffsetC", "humidityOffsetPct", "confidence", "method"], properties: { id: { type: "string" }, sensorId: { type: "string" }, validFrom: { type: "string", format: "date-time" }, validTo: { type: ["string", "null"], format: "date-time" }, temperatureOffsetC: { type: "number" }, humidityOffsetPct: { type: "number" }, responseLagSeconds: { type: ["number", "null"], minimum: 0 }, confidence: { type: "number", minimum: 0, maximum: 1 }, method: { enum: ["co-location", "manual", "factory", "estimated"] } } },
  SpatialSensorCalibration: { type: "object", additionalProperties: false, required: ["id", "houseId", "sensorId", "validFrom", "temperatureOffsetC", "humidityOffsetPct", "confidence", "method", "createdAt"], properties: { id: { type: "string" }, houseId: { type: "string" }, sensorId: { type: "string" }, validFrom: { type: "string", format: "date-time" }, validTo: { type: "string", format: "date-time" }, temperatureOffsetC: { type: "number" }, humidityOffsetPct: { type: "number" }, responseLagSeconds: { type: "number", minimum: 0 }, confidence: { type: "number", minimum: 0, maximum: 1 }, method: { enum: ["co-location", "manual", "factory", "estimated"] }, createdAt: { type: "string", format: "date-time" } } },
  SpatialCalibrationSessionInput: { type: "object", additionalProperties: false, required: ["kind"], properties: { id: { type: "string" }, kind: { enum: ["co-location", "controlled-propagation", "empty-house-baseline"] }, status: { enum: ["planned", "running", "completed", "cancelled"] }, startAt: { type: "string", format: "date-time" }, endAt: { type: ["string", "null"], format: "date-time" }, intervention: { type: "object", additionalProperties: true }, notes: { type: ["string", "null"] }, calibrations: { type: "array", items: { $ref: "#/components/schemas/SpatialSensorCalibrationInput" } } } },
  SpatialCalibrationSession: { type: "object", additionalProperties: false, required: ["id", "houseId", "kind", "status", "startAt", "endAt", "intervention", "notes", "createdAt", "updatedAt"], properties: { id: { type: "string" }, houseId: { type: "string" }, kind: { enum: ["co-location", "controlled-propagation", "empty-house-baseline"] }, status: { enum: ["planned", "running", "completed", "cancelled"] }, startAt: { type: "string", format: "date-time" }, endAt: { type: ["string", "null"], format: "date-time" }, intervention: { type: "object", additionalProperties: true }, notes: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } } },
  SpatialCalibrationSessionCreateResponse: { type: "object", additionalProperties: false, required: ["session", "calibrations"], properties: { session: { $ref: "#/components/schemas/SpatialCalibrationSession" }, calibrations: { type: "array", items: { $ref: "#/components/schemas/SpatialSensorCalibration" } } } },
  SpatialContextEventInput: { type: "object", additionalProperties: false, required: ["kind"], properties: { id: { type: "string" }, kind: { enum: ["door-open", "window-open", "hvac-change", "heat-pump-change", "extractor-change", "dehumidifier-change", "heater-change", "cooking", "shower", "sauna", "solar-gain", "rapid-weather-change", "persistent-environmental-source", "known-empty", "known-occupied"] }, startAt: { type: "string", format: "date-time" }, endAt: { type: ["string", "null"], format: "date-time" }, zoneIds: { type: "array", items: { type: "string" } }, strength: { type: "number", minimum: 0, maximum: 1 }, source: { type: "string" }, payload: { type: "object", additionalProperties: true } } },
  SpatialContextEvent: { type: "object", additionalProperties: false, required: ["id", "houseId", "kind", "startAt", "source", "payload", "createdAt"], properties: { id: { type: "string" }, houseId: { type: "string" }, kind: { enum: ["door-open", "window-open", "hvac-change", "heat-pump-change", "extractor-change", "dehumidifier-change", "heater-change", "cooking", "shower", "sauna", "solar-gain", "rapid-weather-change", "persistent-environmental-source", "known-empty", "known-occupied"] }, startAt: { type: "string", format: "date-time" }, endAt: { type: "string", format: "date-time" }, zoneIds: { type: "array", items: { type: "string" } }, strength: { type: "number", minimum: 0, maximum: 1 }, source: { type: "string" }, payload: { type: "object", additionalProperties: true }, createdAt: { type: "string", format: "date-time" } } },
} as const;

const localAuthPaths = {
  "/auth/setup": {
    post: {
      tags: ["Context"], operationId: "setupLocalOwner",
      security: [],
      description: "Creates the first local Owner. Restricted to loopback/private trusted proxy requests unless a bootstrap secret is configured.",
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalAuthCredentials" }),
      responses: { "201": spatialJsonResponse("Authenticated Owner session.", { $ref: "#/components/schemas/AppSession" }), "403": { description: "Setup request is neither local nor bootstrap-secret authorized" }, "409": { description: "Workspace is already initialized" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/register": {
    post: {
      tags: ["Context"], operationId: "registerLocalInvitation",
      security: [],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalInvitationRegistrationInput" }),
      responses: { "201": spatialJsonResponse("Authenticated invited-member session.", { $ref: "#/components/schemas/AppSession" }), "404": { description: "Invitation is invalid or expired" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Context"], operationId: "loginLocalMember",
      security: [],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalAuthCredentials" }),
      responses: { "200": spatialJsonResponse("Authenticated local session.", { $ref: "#/components/schemas/AppSession" }), "401": { description: "Invalid credentials" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/logout": {
    post: { tags: ["Context"], operationId: "logoutLocalMember", security: [{ localSession: [], csrfToken: [] }], responses: { "204": { description: "Session revoked and cookies cleared" } } },
  },
  "/tenant/members": {
    get: {
      tags: ["Context"], operationId: "listLocalWorkspaceMembers",
      security: [{ localSession: [] }],
      responses: { "200": spatialJsonResponse("Current members and outstanding invitations.", { $ref: "#/components/schemas/TenantMembersResponse" }) },
    },
    post: {
      tags: ["Context"], operationId: "inviteLocalWorkspaceMember",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/TenantMemberCreateInput" }),
      responses: { "201": spatialJsonResponse("One-time invitation token and activation path.", { $ref: "#/components/schemas/TenantInvitationCreated" }), "409": { description: "Member already exists" } },
    },
  },
  "/tenant/members/{email}/access": {
    parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
    put: {
      tags: ["Context"], operationId: "updateLocalWorkspaceMemberAccess",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({ type: "object", additionalProperties: false, required: ["grants"], properties: { grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } } }),
      responses: { "200": spatialJsonResponse("Updated guest access grants.", { type: "object", required: ["member"], properties: { member: { $ref: "#/components/schemas/TenantMemberSummary" } } }), "404": { description: "Member not found" } },
    },
  },
  "/tenant/members/{email}": {
    parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
    delete: { tags: ["Context"], operationId: "removeLocalWorkspaceMember", security: [{ localSession: [], csrfToken: [] }], responses: { "204": { description: "Member or invitation removed" }, "404": { description: "Member not found" } } },
  },
  "/security/audit-events": {
    get: {
      tags: ["Security"], operationId: "listSecurityAuditEvents",
      description: "Owner/Admin-only append-only evidence for authentication, membership, credential, and grant lifecycle changes. Secret material is never recorded.",
      security: [{ localSession: [] }],
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 } },
      ],
      responses: {
        "200": spatialJsonResponse("Newest security audit events first.", { $ref: "#/components/schemas/SecurityAuditEventsResponse" }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
} as const;

const localAuthSchemas = {
  LocalAuthCredentials: {
    type: "object", additionalProperties: false, required: ["email", "password"],
    properties: { email: { type: "string", format: "email", maxLength: 320 }, password: { type: "string", minLength: 12, maxLength: 1024, writeOnly: true } },
  },
  LocalInvitationRegistrationInput: {
    type: "object", additionalProperties: false, required: ["token", "password"],
    properties: { token: { type: "string", minLength: 32, writeOnly: true }, password: { type: "string", minLength: 12, maxLength: 1024, writeOnly: true }, email: { type: "string", format: "email", maxLength: 320 } },
  },
  GuestAccessGrant: {
    type: "object", additionalProperties: false, required: ["scopeType", "scopeId"],
    properties: { scopeType: { enum: ["property", "house", "area"] }, scopeId: { type: "string", minLength: 1, maxLength: 200 } },
  },
  TenantMemberSummary: {
    type: "object", additionalProperties: false, required: ["email", "role", "grants"],
    properties: { email: { type: "string", format: "email" }, role: { enum: ["owner", "admin", "member", "guest"] }, joinedAt: { type: "string", format: "date-time" }, invitedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" }, grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } },
  },
  TenantMembersResponse: {
    type: "object", additionalProperties: false, required: ["members", "invitations"],
    properties: { members: { type: "array", items: { $ref: "#/components/schemas/TenantMemberSummary" } }, invitations: { type: "array", items: { $ref: "#/components/schemas/TenantMemberSummary" } } },
  },
  TenantMemberCreateInput: {
    type: "object", additionalProperties: false, required: ["email", "role"],
    properties: { email: { type: "string", format: "email" }, role: { enum: ["admin", "member", "guest"] }, grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } },
  },
  TenantInvitationCreated: {
    type: "object", additionalProperties: false, required: ["invitation", "registrationToken", "activationPath", "expiresAt"],
    properties: { invitation: { $ref: "#/components/schemas/TenantMemberSummary" }, registrationToken: { type: "string", readOnly: true }, activationPath: { type: "string", description: "Client-side fragment path; the token is never placed in an HTTP query string." }, expiresAt: { type: "string", format: "date-time" } },
  },
  SecurityAuditEvent: {
    type: "object", additionalProperties: false,
    required: ["id", "eventType", "outcome", "actorUserId", "actorRole", "subjectType", "subjectId", "details", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      eventType: { enum: [
        "auth.owner.created", "auth.invitation.accepted", "auth.login", "auth.logout",
        "membership.invitation.created", "membership.grants.replaced", "membership.revoked",
        "integration.credentials.configured", "integration.credentials.rotated", "integration.credentials.revoked",
        "integration.grant.issued", "integration.grant.revoked",
      ] },
      outcome: { enum: ["succeeded", "denied"] },
      actorUserId: { type: ["string", "null"] },
      actorRole: { enum: ["owner", "admin", "member", "guest", "service", null] },
      subjectType: { enum: ["account", "workspace-member", "integration", "integration-grant"] },
      subjectId: { type: "string", minLength: 1, maxLength: 512 },
      details: {
        type: "object", maxProperties: 32,
        additionalProperties: { oneOf: [{ type: "string", maxLength: 512 }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  SecurityAuditEventsResponse: {
    type: "object", additionalProperties: false, required: ["events"],
    properties: { events: { type: "array", items: { $ref: "#/components/schemas/SecurityAuditEvent" } } },
  },
  StreamAuthorizationEvent: {
    type: "object", additionalProperties: false, required: ["status"],
    properties: { status: { enum: ["changed", "expired"] } },
    description: "Final non-sensitive SSE signal requiring clients to purge cached scoped data before reconnecting or signing in.",
  },
} as const;

const operationalOrchestrationPaths = {
  "/properties/{id}/energy-optimization": { get: { tags: ["Energy"], operationId: "getEnergyOptimization", parameters: [{ $ref: "#/components/parameters/Id" }, { name: "windowHours", in: "query", schema: { type: "integer", minimum: 1, maximum: 12, default: 2 } }], responses: { "200": { description: "Transparent, read-only energy optimization report", content: { "application/json": { schema: { type: "object", required: ["report"], properties: { report: { type: "object" } } } } } } } } },
  "/notification-deliveries": { get: { tags: ["Alerts"], operationId: "listNotificationDeliveries", parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }], responses: { "200": { description: "Redacted durable delivery ledger", content: { "application/json": { schema: { type: "object", required: ["deliveries"], properties: { deliveries: { type: "array", items: { type: "object" } } } } } } } } } },
  "/notification-deliveries/{id}/retry": { post: { tags: ["Alerts"], operationId: "retryNotificationDelivery", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Dead-lettered delivery reset for retry", content: { "application/json": { schema: { type: "object", required: ["delivery"], properties: { delivery: { type: "object" } } } } } }, "409": { description: "Delivery is not retryable" } } } },
  "/action-playbooks": {
    get: { tags: ["Alerts"], operationId: "listActionPlaybooks", parameters: [{ name: "metric", in: "query", schema: { type: "string" } }, { name: "enabled", in: "query", schema: { type: "boolean" } }], responses: { "200": { description: "Reusable action playbooks", content: { "application/json": { schema: { type: "object", required: ["playbooks"], properties: { playbooks: { type: "array", items: { type: "object" } } } } } } } } },
    post: { tags: ["Alerts"], operationId: "createActionPlaybook", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": { description: "Created playbook", content: { "application/json": { schema: { type: "object", required: ["playbook"], properties: { playbook: { type: "object" } } } } } } } },
  },
  "/action-playbooks/{id}": { patch: { tags: ["Alerts"], operationId: "updateActionPlaybook", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "Updated playbook", content: { "application/json": { schema: { type: "object", required: ["playbook"], properties: { playbook: { type: "object" } } } } } } } } },
  "/alerts/{id}/action-playbooks": { get: { tags: ["Alerts"], operationId: "listAlertActionPlaybooks", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Enabled playbooks matching an alert metric", content: { "application/json": { schema: { type: "object", required: ["playbooks"], properties: { playbooks: { type: "array", items: { type: "object" } } } } } } } } } },
  "/action-runs": {
    get: { tags: ["Alerts"], operationId: "listActionRuns", parameters: [{ name: "active", in: "query", schema: { type: "boolean" } }, { name: "sensorId", in: "query", schema: { type: "string" } }, { name: "alertEventId", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Before/after action evidence", content: { "application/json": { schema: { type: "object", required: ["runs"], properties: { runs: { type: "array", items: { type: "object" } } } } } } } } },
    post: { tags: ["Alerts"], operationId: "startActionRun", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["playbookId", "sensorId"] } } } }, responses: { "201": { description: "Action started with a fresh baseline", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } } } },
  },
  "/action-runs/{id}/complete": { post: { tags: ["Alerts"], operationId: "completeActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Action completed and automatic verification scheduled", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } } } } },
  "/action-runs/{id}/cancel": { post: { tags: ["Alerts"], operationId: "cancelActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: ["string", "null"] } } } } } }, responses: { "200": { description: "Action run cancelled", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } } } } },
  "/data-export/preview": { get: { tags: ["Context"], operationId: "previewDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Counts and sensitive categories before export", content: { "application/json": { schema: { type: "object", required: ["preview"], properties: { preview: { type: "object" } } } } } } } } },
  "/data-export": { get: { tags: ["Context"], operationId: "downloadDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Versioned, privacy-scoped streaming JSON export", content: { "application/json": { schema: { type: "object" } } } } } } },
  "/backups/status": { get: { tags: ["Context"], operationId: "getBackupStatus", responses: { "200": { description: "Backup scheduler and isolated restore-drill status", content: { "application/json": { schema: { type: "object", required: ["backup"], properties: { backup: { type: "object" } } } } } } } } },
  "/backups": { post: { tags: ["Context"], operationId: "requestBackup", responses: { "202": { description: "Atomic backup request accepted by the scheduler", content: { "application/json": { schema: { type: "object", required: ["backup"], properties: { backup: { type: "object" } } } } } } } } },
  "/setup/doctor": { get: { tags: ["Integrations"], operationId: "runSetupDoctor", responses: { "200": { description: "Installation readiness checks", content: { "application/json": { schema: { type: "object", required: ["report"], properties: { report: { type: "object" } } } } } } } } },
  "/sensors/{id}/label": { get: { tags: ["Digital twin"], operationId: "getSensorLabel", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Printable and QR-ready local sensor label descriptor", content: { "application/json": { schema: { type: "object", required: ["label"], properties: { label: { type: "object" } } } } } } } } },
  "/setup/bulk-sensor-mappings": { post: { tags: ["Integrations"], operationId: "bulkMapSensors", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId", "mappings"], properties: { houseId: { type: "string" }, mappings: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } } } } } }, responses: { "200": { description: "Atomically validated and saved sensor mappings", content: { "application/json": { schema: { type: "object", required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/Sensor" } } } } } } } } } },
} as const;

const combinedOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Stuga Local API",
    version: "2.0.0",
    description: "Local-first Stuga API for house layouts, environmental telemetry, forecasts, alerts, replay, and integrations.",
  },
  servers: [{ url: "/api/v1", description: "Legacy climate tuple API" }, { url: "/api/v2", description: "Registry-driven measurements API" }],
  tags: [
    { name: "Telemetry" }, { name: "Digital twin" }, { name: "Alerts" },
    { name: "Context" }, { name: "Security" }, { name: "Weather" }, { name: "Physics" }, { name: "Integrations" }, { name: "Testing" }, { name: "Measurements" },
    { name: "Spatial layers", description: "Optional local research engines that emit renderer-neutral, versioned 2D/3D semantic layers without mutating core climate state." },
  ],
  security: [{ localSession: [] }],
  paths: {
    ...localAuthPaths,
    ...spatialLayerPaths,
    ...operationalOrchestrationPaths,
    "/health": { get: { security: [], operationId: "health", responses: { "200": { description: "Service health", content: { "application/json": { schema: { type: "object", required: ["status", "systemVersion", "apiVersion", "database", "uptimeSeconds"], properties: { status: { const: "ok" }, systemVersion: { type: "string" }, apiVersion: { const: "v1" }, database: { const: "ready" }, uptimeSeconds: { type: "integer" } } } } } } } } },
    "/openapi.json": { get: { security: [], operationId: "openApiDocument", responses: { "200": { description: "OpenAPI 3.1 document", content: { "application/json": { schema: { type: "object" } } } } } } },
    "/session": { get: { security: [], tags: ["Context"], operationId: "localSession", responses: { "200": { description: "Current cookie session, or setupRequired state for a pristine database", content: { "application/json": { schema: { $ref: "#/components/schemas/AppSession" } } } }, "401": { description: "Authentication is initialized but no valid session cookie was supplied" } } } },
    "/locations/search": {
      get: {
        tags: ["Context"], operationId: "searchLocations",
        description: "Explicit, user-triggered worldwide place search. Returns coordinates and an IANA timezone so normal setup does not require manual latitude, longitude, or timezone entry.",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 120 } },
          { name: "language", in: "query", schema: { type: "string", pattern: "^[a-zA-Z]{2}$", default: "en" } },
        ],
        responses: {
          "200": { description: "Sanitized Open-Meteo/GeoNames place suggestions", content: { "application/json": { schema: { type: "object", required: ["results"], properties: { results: { type: "array", items: { $ref: "#/components/schemas/LocationSuggestion" } } } } } } },
          "400": { description: "Query is too short or too long" },
          "503": { description: "The location provider is temporarily unavailable" },
        },
      },
    },
    "/locations/defaults": {
      get: {
        tags: ["Context"], operationId: "coordinateDefaults",
        description: "Resolves an IANA timezone for explicitly supplied WGS84 coordinates. The browser calls this only after the user chooses device location.",
        parameters: [
          { name: "latitude", in: "query", required: true, schema: { type: "number", minimum: -90, maximum: 90 } },
          { name: "longitude", in: "query", required: true, schema: { type: "number", minimum: -180, maximum: 180 } },
        ],
        responses: {
          "200": { description: "Coordinate-derived defaults", content: { "application/json": { schema: { $ref: "#/components/schemas/CoordinateDefaults" } } } },
          "400": { description: "Both latitude and longitude are required" },
          "422": { description: "Invalid coordinates" },
          "503": { description: "Timezone discovery unavailable" },
        },
      },
    },
    "/measurement-definitions": {
      get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "listMeasurementDefinitions", parameters: [{ name: "includeDisabled", in: "query", schema: { type: "boolean", default: true }, description: "Set false to return enabled definitions only." }], responses: { "200": { description: "Measurement registry", content: { "application/json": { schema: { type: "object", required: ["definitions"], properties: { definitions: { type: "array", items: { $ref: "#/components/schemas/MeasurementDefinition" } } } } } } } } },
      post: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "createMeasurementDefinition", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MeasurementDefinitionInput" } } } }, responses: { "201": { description: "Created definition", content: { "application/json": { schema: { type: "object", required: ["definition"], properties: { definition: { $ref: "#/components/schemas/MeasurementDefinition" } } } } } }, "409": { description: "Identifier already exists" } } },
    },
    "/measurement-definitions/{id}": {
      patch: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "updateMeasurementDefinition", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MeasurementDefinitionPatch" } } } }, responses: { "200": { description: "Updated definition", content: { "application/json": { schema: { type: "object", required: ["definition"], properties: { definition: { $ref: "#/components/schemas/MeasurementDefinition" } } } } } }, "409": { description: "Immutable identifier, builtin status, or in-use canonical unit" } } },
      delete: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "disableMeasurementDefinition", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Definition disabled without orphaning samples or rules", content: { "application/json": { schema: { type: "object", required: ["definition"], properties: { definition: { $ref: "#/components/schemas/MeasurementDefinition" } } } } } } } },
    },
    "/analytics/query": {
      post: {
        servers: [{ url: "/api/v2" }],
        tags: ["Measurements"],
        operationId: "queryAnalytics",
        description: "Side-effect-free, house-scoped multi-series analytics query. dataMode is mandatory and must match the isolated local database mode.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsQueryRequest" } } } },
        responses: {
          "200": { description: "Coverage-aware observed or derived series with deterministic summaries and provenance", content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsQueryResponse" } } } },
          "400": { description: "Malformed query, unsupported timezone, missing dataMode, or future historical range" },
          "409": { description: "Requested dataMode does not match the isolated local database mode" },
          "422": { description: "Unsupported scope or aggregation, or an interactive source/output point budget was exceeded" },
        },
      },
    },
    "/analytics/findings": {
      get: {
        servers: [{ url: "/api/v2" }],
        tags: ["Measurements"],
        operationId: "dailyAnalyticsFindings",
        description: "Returns the latest persisted daily month-to-date peer-period findings. Findings are descriptive differences with evidence and never causal claims.",
        parameters: [{ name: "houseId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }],
        responses: {
          "200": { description: "Latest snapshot and last daily-run status", content: { "application/json": { schema: { $ref: "#/components/schemas/DailyAnalyticsFindingsResponse" } } } },
          "400": { description: "houseId is missing or invalid" },
          "404": { description: "The house is absent or outside the caller's visibility" },
        },
      },
    },
    "/analytics/coverage": {
      post: {
        servers: [{ url: "/api/v2" }],
        tags: ["Measurements"],
        operationId: "analyticsCoverage",
        description: "Discovers the complete recorded span for selected analytics series before calendar-period comparison. An unavailable archive is reported explicitly.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsCoverageRequest" } } } },
        responses: {
          "200": { description: "Earliest and latest recorded sample for every selected sensor/measurement pair", content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsCoverageResponse" } } } },
          "400": { description: "Malformed request or missing dataMode" },
          "409": { description: "Requested dataMode does not match the isolated local database mode" },
          "422": { description: "Unsupported scope or analytics-disabled measurement" },
        },
      },
    },
    "/measurements": {
      post: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "ingestMeasurements", security: [{ ingestKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/MeasurementSampleInput" }, { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/components/schemas/MeasurementSampleInput" } }, { type: "object", required: ["sample"], properties: { sample: { $ref: "#/components/schemas/MeasurementSampleInput" } } }, { type: "object", required: ["samples"], properties: { samples: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/components/schemas/MeasurementSampleInput" } } } }] } } } }, responses: { "201": { description: "Atomically accepted unique samples", content: { "application/json": { schema: { type: "object", required: ["accepted", "samples"], properties: { accepted: { type: "integer" }, samples: { type: "array", items: { $ref: "#/components/schemas/MeasurementSample" } } } } } } }, "422": { description: "Unit or value range mismatch" } } },
    },
    "/measurements/import": {
      post: {
        servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "importHistoricalMeasurements",
        description: "Imports duplicate-safe historical samples without publishing live events, evaluating alert rules, or requiring sensors to be enabled.",
        security: [{ ingestKey: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["samples"], properties: { samples: { type: "array", minItems: 1, maxItems: 10000, items: { $ref: "#/components/schemas/MeasurementSampleInput" } } } } } } },
        responses: { "201": { description: "Accepted unique samples and ignored duplicate count", content: { "application/json": { schema: { type: "object", required: ["accepted", "ignoredDuplicates"], properties: { accepted: { type: "integer" }, ignoredDuplicates: { type: "integer" } } } } } }, "422": { description: "Unit or value range mismatch" } },
      },
    },
    "/measurements/snapshot": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "measurementSnapshot", parameters: [{ name: "houseId", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Latest sample for every sensor/metric pair", content: { "application/json": { schema: { type: "object", required: ["snapshot"], properties: { snapshot: { type: "array", items: { $ref: "#/components/schemas/MeasurementSnapshotEntry" } } } } } } } } } },
    "/measurements/history": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "measurementHistory", parameters: [{ name: "sensorId", in: "query", required: true, schema: { type: "string" } }, { name: "metric", in: "query", required: true, schema: { type: "string" } }, { name: "from", in: "query", schema: { type: "string", format: "date-time" } }, { name: "to", in: "query", schema: { type: "string", format: "date-time" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50000 } }, { name: "bucketSeconds", in: "query", description: "Optional UTC-aligned arithmetic-mean downsampling. Buckets retain the latest sample source and are marked estimated when combining values.", schema: { type: "integer", minimum: 1, maximum: 86400 } }], responses: { "200": { description: "Ordered raw or UTC-bucketed independent metric samples", content: { "application/json": { schema: { type: "object", required: ["samples", "from", "to", "bucketSeconds", "truncated"], properties: { samples: { type: "array", items: { $ref: "#/components/schemas/MeasurementSample" } }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, bucketSeconds: { type: ["integer", "null"], minimum: 1, maximum: 86400 }, truncated: { type: "boolean" } } } } } } } } },
    "/houses/{id}/outdoor-temperature/history": {
      get: {
        servers: [{ url: "/api/v2" }],
        tags: ["Measurements"],
        operationId: "outdoorTemperatureHistory",
        parameters: [
          { $ref: "#/components/parameters/Id" },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50000 } },
        ],
        responses: {
          "200": {
            description: "Ordered observed outdoor-temperature history merged from SQLite and TimescaleDB",
            content: { "application/json": { schema: {
              type: "object",
              required: ["samples", "from", "to", "truncated"],
              properties: {
                samples: { type: "array", items: {
                  type: "object",
                  required: ["houseId", "locationKey", "timestamp", "temperatureC", "source", "fetchedAt", "stationId", "stationName"],
                  properties: {
                    houseId: { type: "string" },
                    locationKey: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                    temperatureC: { type: "number" },
                    source: { enum: ["fmi-observation", "open-meteo-current", "fmi-backfill", "open-meteo-backfill", "mock", "api"] },
                    fetchedAt: { type: "string", format: "date-time" },
                    stationId: { type: ["string", "null"] },
                    stationName: { type: ["string", "null"] },
                    conditions: { type: "object", additionalProperties: true },
                  },
                } },
                from: { type: "string", format: "date-time" },
                to: { type: "string", format: "date-time" },
                truncated: { type: "boolean" },
              },
            } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/sensors/{id}/measurements": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "sensorMeasurementPage", parameters: [{ $ref: "#/components/parameters/Id" }, { name: "cursor", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }], responses: { "200": { description: "Newest-first cursor page across every metric for one sensor", content: { "application/json": { schema: { type: "object", required: ["samples", "nextCursor"], properties: { samples: { type: "array", items: { $ref: "#/components/schemas/MeasurementSample" } }, nextCursor: { type: ["string", "null"] } } } } } }, "400": { description: "Invalid cursor" }, "404": { description: "Sensor not found" } } } },
    "/measurements/events": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "streamMeasurements", parameters: [{ name: "sensorId", in: "query", style: "form", explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeat or comma-separate sensor IDs." }, { name: "metric", in: "query", style: "form", explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeat or comma-separate metric IDs." }], responses: { "200": { description: "Server-sent `measurement` events and a final authorization event when scoped access changes.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } } } } },
    "/measurements/forecast": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "forecastMeasurement", parameters: [{ name: "sensorId", in: "query", required: true, schema: { type: "string" } }, { name: "metric", in: "query", required: true, schema: { type: "string" } }, { name: "hours", in: "query", schema: { type: "integer", minimum: 1, maximum: 168, default: 12 } }], responses: { "200": { description: "Generic forecast", content: { "application/json": { schema: { type: "object", required: ["forecast"], properties: { forecast: { type: "array", items: { $ref: "#/components/schemas/MeasurementForecastPoint" } } } } } } }, "422": { description: "FORECAST_UNSUPPORTED" } } } },
    "/properties": {
      get: { tags: ["Digital twin"], operationId: "listProperties", parameters: [{ $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Managed properties", content: { "application/json": { schema: { type: "object", required: ["properties"], properties: { properties: { type: "array", items: { $ref: "#/components/schemas/Property" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "createProperty", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyInput" } } } }, responses: { "201": { description: "Created property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "409": { description: "Property identifier conflict" }, "422": { description: "Invalid property metadata" } } },
    },
    "/properties/{id}": {
      get: { tags: ["Digital twin"], operationId: "getProperty", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Digital twin"], operationId: "updateProperty", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyPatch" } } } }, responses: { "200": { description: "Updated property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "422": { description: "Invalid property metadata" } } },
      delete: { tags: ["Digital twin"], operationId: "deleteProperty", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Property still contains resources" } } },
    },
    "/properties/{id}/electricity": {
      get: { tags: ["Energy"], operationId: "getPropertyElectricity", parameters: [{ $ref: "#/components/parameters/Id" }, { $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" }], responses: { "200": { description: "Property price-source configuration, current quote, and raw/effective interval prices. Guest responses omit endpoint query data and detailed upstream errors.", content: { "application/json": { schema: { type: "object", required: ["config", "current", "prices"], additionalProperties: true } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/properties/{id}/electricity/config": {
      put: { tags: ["Energy"], operationId: "configurePropertyElectricity", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyElectricityConfigInput" } } } }, responses: { "200": { description: "Saved property electricity configuration", content: { "application/json": { schema: { type: "object", required: ["config"], additionalProperties: true } } } }, "400": { description: "Invalid source or contract details" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/properties/{id}/electricity/refresh": {
      post: { tags: ["Energy"], operationId: "refreshPropertyElectricity", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Fetched and stored raw source prices", content: { "application/json": { schema: { type: "object", required: ["config", "current", "prices"], additionalProperties: true } } } }, "404": { $ref: "#/components/responses/NotFound" }, "502": { description: "Configured price source failed" } } },
    },
    "/property-areas": {
      get: { tags: ["Digital twin"], operationId: "listPropertyAreas", parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Mapped property areas", content: { "application/json": { schema: { type: "object", required: ["areas"], properties: { areas: { type: "array", items: { $ref: "#/components/schemas/PropertyArea" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "createPropertyArea", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyAreaInput" } } } }, responses: { "201": { description: "Created mapped area", content: { "application/json": { schema: { type: "object", required: ["area"], properties: { area: { $ref: "#/components/schemas/PropertyArea" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Area identifier conflict" }, "422": { description: "Invalid area or polygon" } } },
    },
    "/property-areas/{id}": {
      get: { tags: ["Digital twin"], operationId: "getPropertyArea", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Mapped property area", content: { "application/json": { schema: { type: "object", required: ["area"], properties: { area: { $ref: "#/components/schemas/PropertyArea" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Digital twin"], operationId: "updatePropertyArea", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyAreaPatch" } } } }, responses: { "200": { description: "Updated mapped area", content: { "application/json": { schema: { type: "object", required: ["area"], properties: { area: { $ref: "#/components/schemas/PropertyArea" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Move is blocked because linked evidence requires its current house scope" }, "422": { description: "Invalid area or polygon" } } },
      delete: { tags: ["Digital twin"], operationId: "deletePropertyArea", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Area is still referenced" } } },
    },
    "/area-equipment": {
      get: { tags: ["Digital twin"], operationId: "listAreaEquipment", parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/AreaIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Equipment installed in mapped areas", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { type: "array", items: { $ref: "#/components/schemas/AreaEquipment" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "createAreaEquipment", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AreaEquipmentInput" } } } }, responses: { "201": { description: "Created equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Identifier or area scope conflict" }, "422": { description: "Invalid equipment" } } },
    },
    "/area-equipment/{id}": {
      get: { tags: ["Digital twin"], operationId: "getAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Area equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Digital twin"], operationId: "updateAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AreaEquipmentPatch" } } } }, responses: { "200": { description: "Updated equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Area scope conflict" }, "422": { description: "Invalid equipment" } } },
      delete: { tags: ["Digital twin"], operationId: "deleteAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Equipment is still referenced" } } },
    },
    "/property-notes": {
      get: { tags: ["Context"], operationId: "listPropertyNotes", parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/HouseIdQuery" }, { $ref: "#/components/parameters/AreaIdQuery" }, { $ref: "#/components/parameters/EquipmentIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Property and resource notes", content: { "application/json": { schema: { type: "object", required: ["notes"], properties: { notes: { type: "array", items: { $ref: "#/components/schemas/PropertyNote" } } } } } } } } },
      post: { tags: ["Context"], operationId: "createPropertyNote", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyNoteInput" } } } }, responses: { "201": { description: "Created note", content: { "application/json": { schema: { type: "object", required: ["note"], properties: { note: { $ref: "#/components/schemas/PropertyNote" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Target scope conflict" }, "422": { description: "Invalid note or target" } } },
    },
    "/property-notes/{id}": {
      get: { tags: ["Context"], operationId: "getPropertyNote", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Property note", content: { "application/json": { schema: { type: "object", required: ["note"], properties: { note: { $ref: "#/components/schemas/PropertyNote" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Context"], operationId: "updatePropertyNote", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyNotePatch" } } } }, responses: { "200": { description: "Updated note", content: { "application/json": { schema: { type: "object", required: ["note"], properties: { note: { $ref: "#/components/schemas/PropertyNote" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Target scope conflict" }, "422": { description: "Invalid note or target" } } },
      delete: { tags: ["Context"], operationId: "deletePropertyNote", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/houses": {
      get: { tags: ["Digital twin"], operationId: "listHouses", parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }], responses: { "200": { description: "Houses", content: { "application/json": { schema: { type: "object", required: ["houses"], properties: { houses: { type: "array", items: { $ref: "#/components/schemas/House" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "createHouse", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HouseCreate" } } } }, responses: { "201": { description: "Created house", content: { "application/json": { schema: { type: "object", required: ["house"], properties: { house: { $ref: "#/components/schemas/House" } } } } } }, "400": { description: "Malformed house, weather location, map placement, or orientation" }, "404": { description: "Selected property does not exist" }, "409": { description: "House identifier already exists" }, "422": { description: "A property selection, timezone, coordinate, map scale, map footprint floor, location label, or orientation is invalid" } } },
    },
    "/houses/{id}": {
      get: { tags: ["Digital twin"], operationId: "getHouse", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "House", content: { "application/json": { schema: { type: "object", required: ["house"], properties: { house: { $ref: "#/components/schemas/House" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Digital twin"], operationId: "updateHouse", description: "Partially updates house metadata, layout, weather location, precise map placement, and/or the floor plan's compass orientation. Set location, mapPlacement, or orientationDegrees to null to clear it. Map placement is independent of weather location and does not invalidate outdoor-temperature history.", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HousePatch" } } } }, responses: { "200": { description: "Updated house", content: { "application/json": { schema: { type: "object", required: ["house"], properties: { house: { $ref: "#/components/schemas/House" } } } } } }, "400": { description: "Malformed patch, weather location, map placement, or orientation" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Layout would orphan or exclude an existing sensor, observation, or maintenance task" }, "422": { description: "A timezone, coordinate, map scale, map footprint floor, location label, or orientation is invalid" } } },
      delete: { tags: ["Digital twin"], operationId: "deleteHouse", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "House still owns maintenance tasks or is referenced by a property note" } } },
    },
    "/houses/{id}/opening-states": {
      get: {
        tags: ["Physics"], operationId: "getOpeningStates",
        description: "Returns the effective state of every door, window, and vent plus the bounded observation candidates used at the requested time. Stale or unknown contact readings fall back to the configured manual/default state.",
        parameters: [{ $ref: "#/components/parameters/Id" }, { name: "at", in: "query", schema: { type: "string", format: "date-time" } }],
        responses: { "200": { description: "Effective opening-state snapshot and observations", content: { "application/json": { schema: { type: "object", required: ["snapshot", "observations"], properties: { snapshot: { $ref: "#/components/schemas/OpeningStateSnapshot" }, observations: { type: "array", items: { $ref: "#/components/schemas/OpeningStateObservation" } } } } } } }, "404": { $ref: "#/components/responses/NotFound" } },
      },
      post: {
        tags: ["Physics"], operationId: "recordOpeningState",
        description: "Records a manual or generic API opening-state observation. Home Assistant and Tapo provenance is reserved for their authenticated local adapters.",
        parameters: [{ $ref: "#/components/parameters/Id" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OpeningStateObservationInput" } } } },
        responses: { "201": { description: "Recorded observation", content: { "application/json": { schema: { type: "object", required: ["observation"], properties: { observation: { $ref: "#/components/schemas/OpeningStateObservation" } } } } } }, "400": { description: "Invalid state, source, fraction, or validity interval" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Observation id or configured binding conflict" } },
      },
    },
    "/houses/{id}/electricity-price": {
      get: {
        tags: ["Energy"], operationId: "getHouseElectricityPrice", parameters: [{ $ref: "#/components/parameters/Id" }, { $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" }],
        description: "Returns the current effective Property price and, when a range is requested, House-safe interval history. A direct House grant is sufficient; Property contract, endpoint, source identity, and raw upstream price are never included.",
        responses: {
          "200": { description: "House-safe current and optional historical effective electricity prices", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["current"], properties: { current: { oneOf: [{ $ref: "#/components/schemas/HomeElectricityPricePoint" }, { type: "null" }] }, prices: { type: "array", items: { $ref: "#/components/schemas/HomeElectricityPricePoint" } } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/houses/{id}/energy-cost": {
      get: {
        tags: ["Energy"], operationId: "getHouseEnergyCost",
        description: "Calculates cumulative metered energy cost by aligning cumulative energy-counter deltas with every overlapping stored electricity-price interval.",
        parameters: [
          { $ref: "#/components/parameters/Id" },
          { name: "sensorId", in: "query", required: true, schema: { type: "string" } },
          { $ref: "#/components/parameters/FromQuery" },
          { $ref: "#/components/parameters/ToQuery" },
        ],
        responses: {
          "200": { description: "Time-aligned cumulative Home energy cost", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["cost"], properties: { cost: { $ref: "#/components/schemas/HomeEnergyCost" } } } } } },
          "400": { description: "Missing sensor or invalid range" },
          "404": { $ref: "#/components/responses/NotFound" },
          "503": { description: "Complete archived telemetry is temporarily unavailable" },
        },
      },
    },
    "/houses/{id}/weather": {
      get: {
        tags: ["Weather"],
        operationId: "getHouseWeather",
        description: "Returns provider-neutral house-scoped current conditions, point forecasts, and warning capability. Automatic routing uses FMI where Finnish official warning/observation coverage applies and Open-Meteo worldwide. Components can fail independently; inspect componentStatus (or the legacy unavailable field) and stale before using the result. An empty warnings array means no warnings only when componentStatus.warnings.emptyResultIsAuthoritative is true.",
        parameters: [
          { $ref: "#/components/parameters/Id" },
          { name: "hours", in: "query", description: "Requested point-forecast horizon in hours.", schema: { type: "integer", minimum: 1, maximum: 240, default: 48 } },
        ],
        responses: {
          "200": { description: "Weather context, possibly partial or served from stale in-memory cache", content: { "application/json": { schema: { type: "object", required: ["weather"], properties: { weather: { $ref: "#/components/schemas/HouseWeather" } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "HOUSE_LOCATION_REQUIRED: set the house WGS84 location first; or WEATHER_REQUEST_SUPERSEDED: house metadata changed while the upstream request was running" },
          "503": { description: "WEATHER_UNAVAILABLE: no usable provider result or cached fallback is available" },
        },
      },
    },
    "/houses/{id}/thermal-simulation": {
      get: {
        tags: ["Physics"],
        operationId: "runThermalSimulation",
        description: "Fits an effective sensor-scoped first-order thermal model from overlapping indoor and persisted outdoor observations, then returns distinct observed, simulated, residual, and optional weather-scenario values. Insufficient calibration data is a successful typed state; simulated values are never stored as measurements.",
        parameters: [
          { $ref: "#/components/parameters/Id" },
          { name: "sensorId", in: "query", required: true, schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration start; the requested range may not exceed 14 days." },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration end; defaults to now." },
          { name: "horizonHours", in: "query", schema: { type: "integer", minimum: 0, maximum: 72, default: 12 } },
          { name: "scenarioOutdoorTemperatureC", in: "query", schema: { type: "number" }, description: "Optional constant future outdoor boundary. This does not alter historical calibration." },
        ],
        responses: {
          "200": { description: "Ready, provisional, or insufficient-data thermal result", content: { "application/json": { schema: { type: "object", required: ["simulation"], properties: { simulation: { $ref: "#/components/schemas/ThermalSimulationResult" } } } } } },
          "400": { description: "Malformed timestamp, range, or scenario" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The sensor belongs to another house" },
        },
      },
    },
    "/houses/{id}/thermal-isolation": {
      get: {
        tags: ["Physics"],
        operationId: "compareThermalIsolation",
        description: "Compares empirical outdoor-temperature response across sensors, rooms, floors, and the whole house. The 0-100 score is modeled 24-hour thermal retention, not a U-value, airtightness test, energy label, or code assessment.",
        parameters: [
          { $ref: "#/components/parameters/Id" },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration start; the requested range may not exceed 14 days." },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration end; defaults to now." },
        ],
        responses: {
          "200": { description: "Room, floor, house, and sensor thermal-isolation comparison", content: { "application/json": { schema: { type: "object", required: ["isolation"], properties: { isolation: { $ref: "#/components/schemas/ThermalIsolationResult" } } } } } },
          "400": { description: "Malformed timestamp or calibration range" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "The enabled sensor scope exceeds the bounded synchronous comparison limit" },
        },
      },
    },
    "/houses/{id}/layout": {
      put: {
        tags: ["Digital twin"], operationId: "replaceHouseLayout", parameters: [{ $ref: "#/components/parameters/Id" }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["floors"], properties: { floors: { type: "array", items: { $ref: "#/components/schemas/Floor" } } } } } } },
        responses: { "200": { description: "Updated house", content: { "application/json": { schema: { type: "object", required: ["house"], properties: { house: { $ref: "#/components/schemas/House" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Layout would orphan or exclude an existing sensor, observation, or maintenance task" } },
      },
    },
    "/houses/{id}/floors/{floorId}": {
      put: {
        tags: ["Digital twin"], operationId: "replaceFloor", parameters: [{ $ref: "#/components/parameters/Id" }, { name: "floorId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Floor" } } } },
        responses: { "200": { description: "Updated floor", content: { "application/json": { schema: { $ref: "#/components/schemas/Floor" } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Floor change would orphan or exclude an existing sensor, observation, or maintenance task" } },
      },
    },
    "/sensors": {
      get: { tags: ["Digital twin"], operationId: "listSensors", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Sensors", content: { "application/json": { schema: { type: "object", required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/Sensor" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "createSensor", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SensorInput" } } } }, responses: { "201": { description: "Created sensor", content: { "application/json": { schema: { type: "object", required: ["sensor"], properties: { sensor: { $ref: "#/components/schemas/Sensor" } } } } } }, "404": { description: "House not found" }, "409": { description: "TP-Link child device is already assigned" }, "422": { description: "Floor membership or x/y bounds are invalid" } } },
    },
    "/sensors/snapshots": { get: { tags: ["Telemetry"], operationId: "listSensorSnapshots", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Sensors with latest readings", content: { "application/json": { schema: { type: "object", required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/SensorSnapshot" } } } } } } } } } },
    "/snapshot": { get: { tags: ["Telemetry"], operationId: "listSnapshotCompatibility", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Web-compatible sensor snapshots", content: { "application/json": { schema: { type: "object", required: ["snapshot"], properties: { snapshot: { type: "array", items: { $ref: "#/components/schemas/SensorSnapshot" } } } } } } } } } },
    "/sensors/{id}": {
      get: { tags: ["Digital twin"], operationId: "getSensor", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Sensor", content: { "application/json": { schema: { type: "object", required: ["sensor", "reading"], properties: { sensor: { $ref: "#/components/schemas/Sensor" }, reading: { oneOf: [{ $ref: "#/components/schemas/Reading" }, { type: "null" }] } } } } } } } },
      put: { tags: ["Digital twin"], operationId: "replaceSensorFields", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SensorPatch" } } } }, responses: { "200": { description: "Updated sensor", content: { "application/json": { schema: { $ref: "#/components/schemas/Sensor" } } } }, "404": { description: "Sensor or target house not found" }, "409": { description: "TP-Link child device is already assigned" }, "422": { description: "Target floor membership or x/y bounds are invalid" } } },
      patch: { tags: ["Digital twin"], operationId: "updateSensor", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SensorPatch" } } } }, responses: { "200": { description: "Updated sensor", content: { "application/json": { schema: { type: "object", required: ["sensor"], properties: { sensor: { $ref: "#/components/schemas/Sensor" } } } } } }, "404": { description: "Sensor or target house not found" }, "409": { description: "TP-Link child device is already assigned" }, "422": { description: "Target floor membership or x/y bounds are invalid" } } },
      delete: { tags: ["Digital twin"], operationId: "deleteSensor", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } },
    },
    "/readings": {
      get: { tags: ["Telemetry"], operationId: "queryReadingsCompatibility", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }, { $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50000, default: 2000 } }], responses: { "200": { description: "Flat historical readings", content: { "application/json": { schema: { type: "object", required: ["readings"], properties: { readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } } } } } } } } },
      post: {
        tags: ["Telemetry"], operationId: "ingestReadings", security: [{ ingestKey: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/ReadingInput" }, { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/components/schemas/ReadingInput" } }, { type: "object", required: ["readings"], properties: { readings: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/components/schemas/ReadingInput" } } } }] } } } },
        responses: { "201": { description: "Accepted readings and duplicate count", content: { "application/json": { schema: { type: "object", required: ["readings", "ignoredDuplicates"], properties: { readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } }, ignoredDuplicates: { type: "integer" } } } } } } },
      },
    },
    "/readings/latest": { get: { tags: ["Telemetry"], operationId: "latestReadings", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }], responses: { "200": { description: "Latest reading per sensor", content: { "application/json": { schema: { type: "object", required: ["readings"], properties: { readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } } } } } } } } } },
    "/history": { get: { tags: ["Telemetry"], operationId: "queryHistory", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }, { $ref: "#/components/parameters/FromQuery" }, { $ref: "#/components/parameters/ToQuery" }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50000, default: 20000 } }, { name: "bucketSeconds", in: "query", description: "Optional UTC-aligned arithmetic-mean downsampling for long ranges.", schema: { type: "integer", minimum: 1, maximum: 86400 } }, { name: "forecastHours", in: "query", schema: { type: "integer", minimum: 0, maximum: 168, default: 0 } }], responses: { "200": { description: "Historical raw or bucketed series", content: { "application/json": { schema: { type: "object", required: ["from", "to", "bucketSeconds", "series", "truncated"], properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, bucketSeconds: { type: ["integer", "null"], minimum: 1, maximum: 86400 }, series: { type: "array", items: { $ref: "#/components/schemas/HistorySeries" } }, truncated: { type: "boolean" } } } } } } } } },
    "/forecast": { get: { tags: ["Telemetry"], operationId: "forecast", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }, { name: "hours", in: "query", schema: { type: "integer", minimum: 1, maximum: 168, default: 12 } }, { name: "horizonMinutes", in: "query", schema: { type: "integer", minimum: 0, maximum: 10080, default: 0 }, description: "Compatibility horizon; when greater than zero it takes precedence over hours." }], responses: { "200": { description: "Linear baseline forecasts with confidence bands", content: { "application/json": { schema: { type: "object", required: ["generatedAt", "model", "series"], properties: { generatedAt: { type: "string", format: "date-time" }, model: { const: "linear-v1" }, series: { type: "array", items: { type: "object", required: ["sensorId", "forecast"], properties: { sensorId: { type: "string" }, forecast: { type: "array", items: { $ref: "#/components/schemas/ForecastPoint" } } } } }, forecast: { type: "array", items: { $ref: "#/components/schemas/ForecastPoint" } } } } } } } } } },
    "/stream": { get: { tags: ["Telemetry"], operationId: "streamTelemetry", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }], responses: { "200": { description: "Server-sent reading, alert, integration, weather, and heartbeat events. Authorization changes emit a final event before closing. Weather snapshots carry a stable SSE id so consumers can deduplicate repeated delivery.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { weather: { $ref: "#/components/schemas/WeatherUpdateEvent" }, authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } } } } },
    "/events": { get: { tags: ["Telemetry"], operationId: "streamTelemetryCompatibility", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }], responses: { "200": { description: "Web-compatible server-sent event stream including provider-neutral weather snapshots and final authorization changes.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { weather: { $ref: "#/components/schemas/WeatherUpdateEvent" }, authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } } } } },
    "/alert-rules": {
      get: { tags: ["Alerts"], operationId: "listAlertRules", responses: { "200": { description: "Rules", content: { "application/json": { schema: { type: "object", required: ["rules"], properties: { rules: { type: "array", items: { $ref: "#/components/schemas/AlertRule" } } } } } } } } },
      post: { tags: ["Alerts"], operationId: "createAlertRule", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AlertRuleInput" } } } }, responses: { "201": { description: "Created rule", content: { "application/json": { schema: { $ref: "#/components/schemas/AlertRule" } } } } } },
    },
    "/alert-rules/{id}": {
      patch: { tags: ["Alerts"], operationId: "updateAlertRule", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AlertRulePatch" } } } }, responses: { "200": { description: "Updated rule", content: { "application/json": { schema: { type: "object", required: ["rule"], properties: { rule: { $ref: "#/components/schemas/AlertRule" } } } } } } } },
      delete: { tags: ["Alerts"], operationId: "deleteAlertRule", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } },
    },
    "/alert-events": { get: { tags: ["Alerts"], operationId: "listAlertEvents", parameters: [{ name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }], responses: { "200": { description: "Alert events", content: { "application/json": { schema: { type: "object", required: ["events"], properties: { events: { type: "array", items: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } } },
    "/alert-events/{id}/acknowledge": { post: { tags: ["Alerts"], operationId: "acknowledgeAlert", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Acknowledged alert", content: { "application/json": { schema: { type: "object", required: ["event"], properties: { event: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } },
    "/alerts": { get: { tags: ["Alerts"], operationId: "listAlertsCompatibility", parameters: [{ name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }], responses: { "200": { description: "Web-compatible alert events", content: { "application/json": { schema: { type: "object", required: ["alerts"], properties: { alerts: { type: "array", items: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } } },
    "/alerts/{id}/acknowledge": { post: { tags: ["Alerts"], operationId: "acknowledgeAlertCompatibility", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Acknowledged alert", content: { "application/json": { schema: { $ref: "#/components/schemas/AlertEvent" } } } } } } },
    "/properties/{id}/energy-optimization": {
      get: {
        tags: ["Energy"], operationId: "getPropertyEnergyOptimization",
        parameters: [{ $ref: "#/components/parameters/Id" }, { name: "windowHours", in: "query", schema: { type: "integer", minimum: 1, maximum: 12, default: 2 } }],
        responses: { "200": jsonResponse("Read-only price and consumption optimization report.", { type: "object", additionalProperties: false, required: ["report"], properties: { report: { $ref: "#/components/schemas/EnergyOptimizationReport" } } }), "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/notification-deliveries": {
      get: {
        tags: ["Alerts"], operationId: "listNotificationDeliveries",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }],
        responses: { "200": jsonResponse("Redacted durable notification delivery ledger.", { type: "object", additionalProperties: false, required: ["deliveries"], properties: { deliveries: { type: "array", items: { $ref: "#/components/schemas/NotificationDeliveryStatus" } } } }) },
      },
    },
    "/notification-deliveries/{id}/retry": {
      post: {
        tags: ["Alerts"], operationId: "retryNotificationDelivery", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: { "200": jsonResponse("Delivery returned to the durable outbox.", { type: "object", additionalProperties: false, required: ["delivery"], properties: { delivery: { $ref: "#/components/schemas/NotificationDeliveryStatus" } } }), "403": { description: "Owner or Admin role required" }, "409": { description: "Delivery is not retryable" } },
      },
    },
    "/action-playbooks": {
      get: {
        tags: ["Alerts"], operationId: "listActionPlaybooks",
        parameters: [{ name: "metric", in: "query", schema: { type: "string" } }, { name: "enabled", in: "query", schema: { type: "boolean", default: false } }],
        responses: { "200": jsonResponse("Reusable evidence-based response playbooks.", { type: "object", additionalProperties: false, required: ["playbooks"], properties: { playbooks: { type: "array", items: { $ref: "#/components/schemas/ActionPlaybook" } } } }) },
      },
      post: {
        tags: ["Alerts"], operationId: "createActionPlaybook", requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionPlaybookInput" }),
        responses: { "201": jsonResponse("Created action playbook.", { type: "object", additionalProperties: false, required: ["playbook"], properties: { playbook: { $ref: "#/components/schemas/ActionPlaybook" } } }), "400": { description: "Invalid playbook" } },
      },
    },
    "/action-playbooks/{id}": {
      patch: {
        tags: ["Alerts"], operationId: "updateActionPlaybook", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionPlaybookPatch" }),
        responses: { "200": jsonResponse("Updated action playbook.", { type: "object", additionalProperties: false, required: ["playbook"], properties: { playbook: { $ref: "#/components/schemas/ActionPlaybook" } } }), "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/alerts/{id}/action-playbooks": {
      get: {
        tags: ["Alerts"], operationId: "listAlertActionPlaybooks", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: { "200": jsonResponse("Enabled playbooks matching the alert metric.", { type: "object", additionalProperties: false, required: ["playbooks"], properties: { playbooks: { type: "array", items: { $ref: "#/components/schemas/ActionPlaybook" } } } }), "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/action-runs": {
      get: {
        tags: ["Alerts"], operationId: "listActionRuns",
        parameters: [{ name: "sensorId", in: "query", schema: { type: "string" } }, { name: "alertEventId", in: "query", schema: { type: "string" } }, { name: "active", in: "query", schema: { type: "boolean", default: false } }],
        responses: { "200": jsonResponse("Durable before-and-after action evidence.", { type: "object", additionalProperties: false, required: ["runs"], properties: { runs: { type: "array", items: { $ref: "#/components/schemas/ActionRun" } } } }) },
      },
      post: {
        tags: ["Alerts"], operationId: "startActionRun", requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionRunStartInput" }),
        responses: { "201": jsonResponse("Started action run with a captured baseline.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "400": { description: "Invalid action run" } },
      },
    },
    "/action-runs/{id}/complete": {
      post: {
        tags: ["Alerts"], operationId: "completeActionRun", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: { "200": jsonResponse("Action marked complete and automatic verification scheduled.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/action-runs/{id}/cancel": {
      post: {
        tags: ["Alerts"], operationId: "cancelActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ActionRunCancelInput" } } } },
        responses: { "200": jsonResponse("Cancelled action run.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/data-export/preview": {
      get: {
        tags: ["Context"], operationId: "previewDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }],
        responses: { "200": jsonResponse("Counts and privacy-sensitive categories included by a prospective export.", { type: "object", additionalProperties: false, required: ["preview"], properties: { preview: { $ref: "#/components/schemas/DataExportPreview" } } }) },
      },
    },
    "/data-export": {
      get: {
        tags: ["Context"], operationId: "exportData", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }],
        responses: { "200": jsonResponse("Streaming, downloadable local data export.", { $ref: "#/components/schemas/DataExportBundle" }) },
      },
    },
    "/backups/status": {
      get: { tags: ["Context"], operationId: "getBackupStatus", responses: { "200": jsonResponse("Backup scheduler and restore-drill status.", { type: "object", additionalProperties: false, required: ["backup"], properties: { backup: { $ref: "#/components/schemas/BackupOperationStatus" } } }) } },
    },
    "/backups": {
      post: { tags: ["Context"], operationId: "requestBackup", responses: { "202": jsonResponse("Verified backup requested.", { type: "object", additionalProperties: false, required: ["backup"], properties: { backup: { $ref: "#/components/schemas/BackupOperationStatus" } } }) } },
    },
    "/setup/doctor": {
      get: { tags: ["Integrations"], operationId: "runSetupDoctor", responses: { "200": jsonResponse("Installation readiness report.", { type: "object", additionalProperties: false, required: ["report"], properties: { report: { $ref: "#/components/schemas/SetupDoctorReport" } } }) } },
    },
    "/sensors/{id}/label": {
      get: { tags: ["Digital twin"], operationId: "getSensorLabel", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Printable sensor identity label descriptor.", { type: "object", additionalProperties: false, required: ["label"], properties: { label: { $ref: "#/components/schemas/SensorLabelDescriptor" } } }), "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/setup/bulk-sensor-mappings": {
      post: { tags: ["Integrations"], operationId: "bulkUpdateSensorMappings", requestBody: jsonRequestBody({ $ref: "#/components/schemas/BulkSensorMappingsInput" }), responses: { "200": jsonResponse("All sensor bindings saved atomically.", { type: "object", additionalProperties: false, required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/Sensor" } } } }), "400": { description: "Invalid mapping table" } } },
    },
    "/observations": {
      get: { tags: ["Context"], operationId: "listObservations", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Manual observations", content: { "application/json": { schema: { type: "object", required: ["observations"], properties: { observations: { type: "array", items: { $ref: "#/components/schemas/ManualObservation" } } } } } } } } },
      post: { tags: ["Context"], operationId: "createObservation", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ObservationInput" } } } }, responses: { "201": { description: "Created observation", content: { "application/json": { schema: { $ref: "#/components/schemas/ManualObservation" } } } } } },
    },
    "/observations/{id}": {
      patch: {
        tags: ["Context"], operationId: "updateObservation", parameters: [{ $ref: "#/components/parameters/Id" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ObservationPatch" } } } },
        responses: {
          "200": { description: "Updated observation", content: { "application/json": { schema: { $ref: "#/components/schemas/ManualObservation" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "baseRevision is stale" },
          "422": { description: "Invalid time, lifecycle, or house/floor/sensor relationship" },
        },
      },
      delete: {
        tags: ["Context"], operationId: "deleteObservation", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: {
          "204": { description: "Permanently deleted" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "Observation is linked to maintenance and must be explicitly unlinked first" },
        },
      },
    },
    "/observations/{id}/revisions": {
      get: {
        tags: ["Context"], operationId: "listObservationRevisions", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: {
          "200": { description: "Append-only observation revisions", content: { "application/json": { schema: { type: "object", required: ["revisions"], properties: { revisions: { type: "array", items: { $ref: "#/components/schemas/ObservationRevision" } } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/maintenance-tasks": {
      get: {
        tags: ["Context"], operationId: "listMaintenanceTasks",
        parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/HouseIdQuery" }, { $ref: "#/components/parameters/AreaIdQuery" }, { $ref: "#/components/parameters/EquipmentIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }],
        responses: { "200": { description: "Property, house, area, or equipment maintenance tasks", content: { "application/json": { schema: { type: "object", required: ["maintenanceTasks"], properties: { maintenanceTasks: { type: "array", items: { $ref: "#/components/schemas/MaintenanceTask" } } } } } } } },
      },
      post: {
        tags: ["Context"], operationId: "createMaintenanceTask",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTaskInput" } } } },
        responses: {
          "201": { description: "Created maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "Maintenance id conflict or linked observation belongs to another house" },
          "422": { description: "Invalid maintenance schedule or relationship" },
        },
      },
    },
    "/maintenance-tasks/{id}": {
      get: {
        tags: ["Context"], operationId: "getMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: {
          "200": { description: "Maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Context"], operationId: "updateMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTaskPatch" } } } },
        responses: {
          "200": { description: "Updated maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "baseRevision is stale or an evidence link crosses house scope" },
          "422": { description: "Invalid maintenance schedule or lifecycle transition" },
        },
      },
      delete: {
        tags: ["Context"], operationId: "deleteMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: { "204": { description: "Permanently deleted" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/maintenance-tasks/{id}/revisions": {
      get: {
        tags: ["Context"], operationId: "listMaintenanceTaskRevisions", parameters: [{ $ref: "#/components/parameters/Id" }],
        responses: {
          "200": { description: "Append-only maintenance task revisions", content: { "application/json": { schema: { type: "object", required: ["revisions"], properties: { revisions: { type: "array", items: { $ref: "#/components/schemas/MaintenanceTaskRevision" } } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/parameters": {
      get: { tags: ["Context"], operationId: "listStaticParameters", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Static parameters", content: { "application/json": { schema: { type: "object", required: ["parameters"], properties: { parameters: { type: "array", items: { $ref: "#/components/schemas/StaticParameter" } } } } } } } } },
      post: { tags: ["Context"], operationId: "upsertStaticParameter", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameterInput" } } } }, responses: { "200": { description: "Saved parameter", content: { "application/json": { schema: { type: "object", required: ["parameter"], properties: { parameter: { $ref: "#/components/schemas/StaticParameter" } } } } } } } },
    },
    "/parameters/{id}": { delete: { tags: ["Context"], operationId: "deleteStaticParameter", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } } },
    "/static-parameters": {
      get: { tags: ["Context"], operationId: "listStaticParametersCompatibility", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Web-compatible static parameters", content: { "application/json": { schema: { type: "object", required: ["parameters"], properties: { parameters: { type: "array", items: { $ref: "#/components/schemas/StaticParameter" } } } } } } } } },
      post: { tags: ["Context"], operationId: "saveStaticParameterCompatibility", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameterInput" } } } }, responses: { "201": { description: "Saved parameter", content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameter" } } } } } },
    },
    "/assets": {
      get: { tags: ["Digital twin"], operationId: "listAssets", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Floor plan and 3D asset metadata", content: { "application/json": { schema: { type: "object", required: ["assets"], properties: { assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } } } } } } } } },
      post: { tags: ["Digital twin"], operationId: "uploadAsset", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AssetUploadInput" } } } }, responses: { "201": { description: "Uploaded base64 asset", content: { "application/json": { schema: { type: "object", required: ["asset", "url"], properties: { asset: { $ref: "#/components/schemas/Asset" }, url: { type: "string" } } } } } }, "413": { description: "Decoded asset exceeds 10 MiB" }, "415": { description: "Unsupported asset media type" } } },
    },
    "/assets/{id}": { get: { tags: ["Digital twin"], operationId: "downloadAsset", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Asset bytes", content: { "*/*": { schema: { type: "string", contentEncoding: "base64" } } } } } }, delete: { tags: ["Digital twin"], operationId: "deleteAsset", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } } },
    "/integrations/status": { get: { tags: ["Integrations"], operationId: "integrationStatus", responses: { "200": { description: "Redacted integration status", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationStatus" } } } } } } },
    "/integrations/sensor-data-gaps": {
      get: {
        tags: ["Integrations"],
        operationId: "listSensorDataGaps",
        description: "Lists durable sensor/metric outage intervals and their recovery outcomes.",
        parameters: [
          { $ref: "#/components/parameters/HouseIdQuery" },
          { name: "sensorId", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 } },
        ],
        responses: {
          "200": {
            description: "Detected sensor data gaps",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["gaps"],
                  properties: {
                    gaps: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "sensorId", "metric", "source", "startedAt", "detectedAt", "endedAt", "recoveryState", "recoveredPoints", "attemptCount", "lastAttemptAt", "nextAttemptAt", "recoveryError"],
                        properties: {
                          id: { type: "integer" },
                          sensorId: { type: "string" },
                          metric: { type: "string" },
                          source: { enum: ["home-assistant", "tp-link"] },
                          startedAt: { type: "string", format: "date-time" },
                          detectedAt: { type: "string", format: "date-time" },
                          endedAt: { type: ["string", "null"], format: "date-time" },
                          recoveryState: { enum: ["open", "pending", "running", "complete", "partial", "failed", "not-supported"] },
                          recoveredPoints: { type: "integer", minimum: 0 },
                          attemptCount: { type: "integer", minimum: 0 },
                          lastAttemptAt: { type: ["string", "null"], format: "date-time" },
                          nextAttemptAt: { type: ["string", "null"], format: "date-time" },
                          recoveryError: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/integrations/discover": { post: { tags: ["Integrations"], operationId: "discoverIntegrations", requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { houseId: { type: "string" }, tpLinkUsername: { type: "string" }, tpLinkPassword: { type: "string", writeOnly: true } } } } } }, responses: { "200": { description: "Best-effort LAN discovery results for Home Assistant and supported TP-Link hubs or energy devices", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationDiscoveryResult" } } } } } } },
    "/integrations/home-assistant/config": { put: { tags: ["Integrations"], operationId: "configureHomeAssistant", description: "Write-only server-side credential setup; responses never contain the saved URL or token.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HomeAssistantConfigInput" } } } }, responses: { "200": { description: "Credentials saved and connection started", content: { "application/json": { schema: { type: "object", required: ["ok", "configured", "integration"], properties: { ok: { const: true }, configured: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "400": { description: "Invalid URL or token" } } } },
    "/integrations/home-assistant/config/{houseId}": {
      patch: {
        tags: ["Integrations"], operationId: "moveHouseHomeAssistant",
        description: "Moves the saved write-only Home Assistant connection to another House without returning or re-entering credentials. Existing sensor entity mappings remain on the source House.",
        parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId"], properties: { houseId: { type: "string", minLength: 1 } }, additionalProperties: false } } } },
        responses: {
          "200": { description: "Home Assistant connection moved", content: { "application/json": { schema: { type: "object", required: ["ok", "fromHouseId", "houseId", "integration"], properties: { ok: { const: true }, fromHouseId: { type: "string" }, houseId: { type: "string" }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The target House already has a Home Assistant assignment" },
        },
      },
      delete: { tags: ["Integrations"], operationId: "disconnectHouseHomeAssistant", parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "House Home Assistant credentials deleted", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/integrations/home-assistant/setup": { get: { tags: ["Integrations"], operationId: "homeAssistantSetup", responses: { "200": { description: "Environment and entity-map setup help", content: { "application/json": { schema: { type: "object", required: ["configured", "steps", "entityMapSchema", "notes"], additionalProperties: true } } } } } } },
    "/integrations/home-assistant/test": { post: { tags: ["Integrations"], operationId: "homeAssistantStatusTest", responses: { "200": { description: "Status of the environment-configured bridge", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
    "/integrations/home-assistant/test-draft": { post: { tags: ["Integrations"], operationId: "testHomeAssistantDraft", description: "Temporarily verifies draft credentials and streaming permission without saving them or activating real-data mode.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HomeAssistantConfigInput" } } } }, responses: { "200": { description: "Non-persisting credential test result", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
    "/integrations/tp-link/setup": { get: { tags: ["Integrations"], operationId: "tpLinkSetup", responses: { "200": { description: "Direct H100/H200 climate-child and capability-based energy-device setup help", content: { "application/json": { schema: { type: "object", required: ["configured", "supportedHubs", "supportedClimateSensors", "supportedEnergyDevices", "steps", "sensorPatchSchema", "deviceMapSchema", "notes"], additionalProperties: true } } } } } } },
    "/integrations/tp-link/config": { put: { tags: ["Integrations"], operationId: "configureTpLink", description: "Creates or updates one house-scoped, write-only TP-Link connection. Stable device identity is used to follow safe address changes, while a connection id cannot be reassigned to different physical hardware. Responses never contain account credentials.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TpLinkConfigInput" } } } }, responses: { "200": { description: "Credentials saved and house connection started", content: { "application/json": { schema: { type: "object", required: ["ok", "configured", "integration"], properties: { ok: { const: true }, configured: { const: true }, connectionId: { type: "string" }, houseId: { type: "string" }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "400": { description: "Invalid device address or credentials" }, "409": { description: "The stable device identity conflicts with the requested connection or another House assignment" } } } },
    "/integrations/tp-link/config/{connectionId}": {
      patch: {
        tags: ["Integrations"], operationId: "moveTpLinkConnection",
        description: "Moves a saved write-only TP-Link connection to another House without returning or re-entering credentials. Direct sensor bindings on the source House are detached while sensor history and placement remain.",
        parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId"], properties: { houseId: { type: "string", minLength: 1 } }, additionalProperties: false } } } },
        responses: {
          "200": { description: "TP-Link connection moved", content: { "application/json": { schema: { type: "object", required: ["ok", "fromHouseId", "houseId", "detachedSensorIds", "integration"], properties: { ok: { const: true }, fromHouseId: { type: "string" }, houseId: { type: "string" }, detachedSensorIds: { type: "array", items: { type: "string" } }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The same physical TP-Link endpoint is already assigned to the target House" },
        },
      },
      delete: { tags: ["Integrations"], operationId: "disconnectTpLinkConnection", parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "House TP-Link connection deleted; affected sensors retain history and placement while their direct bindings are detached", content: { "application/json": { schema: { type: "object", required: ["ok", "detachedSensorIds", "integration"], properties: { ok: { const: true }, detachedSensorIds: { type: "array", items: { type: "string" } }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/integrations/tp-link/devices": { get: { tags: ["Integrations"], operationId: "listTpLinkDevices", responses: { "200": { description: "Sanitized climate children or direct energy devices seen by the local bridge", content: { "application/json": { schema: { type: "object", required: ["devices"], properties: { devices: { type: "array", items: { $ref: "#/components/schemas/TpLinkDiscoveredDevice" } } } } } } } } } },
    "/integrations/tp-link/history-export/jobs": { get: { tags: ["Integrations"], operationId: "listTapoHistoryExportJobs", responses: { "200": jsonResponse("Durable automated Tapo history-export jobs and non-secret automation health", { type: "object", additionalProperties: false, required: ["enabled", "automation", "jobs"], properties: { enabled: { type: "boolean" }, automation: { type: "object", additionalProperties: false, required: ["operational", "canaryPending", "waitingEmails", "maxPendingEmails", "exportIntervalMinutes", "canaryApprovalMaxAgeDays", "mailbox", "lastWorkerSeenAt", "deploymentFingerprintPrefix"], properties: { operational: { type: "boolean" }, canaryPending: { type: "boolean" }, waitingEmails: { type: "integer", minimum: 0 }, maxPendingEmails: { type: "integer", minimum: 1 }, exportIntervalMinutes: { type: "integer", enum: [1, 15, 30, 60, 360, 720, 1440] }, canaryApprovalMaxAgeDays: { type: "integer", minimum: 1 }, mailbox: { type: "object", additionalProperties: false, required: ["lastSuccessfulPollAt", "lastErrorAt", "lastErrorCode", "consecutiveFailures", "budgetExhaustions"], properties: { lastSuccessfulPollAt: { type: ["string", "null"], format: "date-time" }, lastErrorAt: { type: ["string", "null"], format: "date-time" }, lastErrorCode: { type: ["string", "null"] }, consecutiveFailures: { type: "integer", minimum: 0 }, budgetExhaustions: { type: "integer", minimum: 0 } } }, lastWorkerSeenAt: { type: ["string", "null"], format: "date-time" }, deploymentFingerprintPrefix: { type: ["string", "null"] } } }, jobs: { type: "array", items: { $ref: "#/components/schemas/TapoHistoryExportJob" } } } }) } } },
    "/integrations/tp-link/history-export/canary": { post: { tags: ["Integrations"], operationId: "createTapoHistoryExportCanary", description: "Owner/admin acceptance gate. Queues a fresh bounded Appium/email job whose staged rows are excluded from automatic gap ingestion.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["sensorId", "metric", "from", "to"], properties: { sensorId: { type: "string", minLength: 1 }, metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } }), responses: { "202": jsonResponse("Fresh canary queued", { type: "object", additionalProperties: false, required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "403": { description: "Owner or admin role required" }, "409": { description: "Tapo automation or target binding is not ready" }, "422": { description: "Canary range is invalid" } } } },
    "/integrations/tp-link/history-export/backfill": { post: { tags: ["Integrations"], operationId: "createTapoHistoryBackfill", description: "Owner/admin request for a durable TP-Link temperature or humidity backfill. The coordinator uses local retention first, then segments the configured Tapo fallback, for an explicit range of at most 730 days.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["sensorId", "metric", "from", "to"], properties: { sensorId: { type: "string", minLength: 1 }, metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } }), responses: { "202": jsonResponse("Historical recovery gap recorded or rearmed", { type: "object", additionalProperties: false, required: ["gap"], properties: { gap: { type: "object", required: ["id", "sensorId", "metric", "source", "startedAt", "endedAt", "recoveryState"], properties: { id: { type: "integer" }, sensorId: { type: "string" }, metric: { type: "string" }, source: { const: "tp-link" }, startedAt: { type: "string", format: "date-time" }, endedAt: { type: "string", format: "date-time" }, recoveryState: { enum: ["pending", "running", "complete", "partial", "failed", "not-supported"] } } } } }), "403": { description: "Owner or admin role required" }, "409": { description: "Tapo history or the target binding is not ready" }, "422": { description: "Backfill range is invalid" } } } },
    "/integrations/tp-link/history-export/jobs/{id}/retry": { post: { tags: ["Integrations"], operationId: "retryTapoHistoryExportJob", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Export job requeued with a fresh attempt budget", { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "409": { description: "Job is not retryable" } } } },
    "/integrations/tp-link/history-export/jobs/{id}": { delete: { tags: ["Integrations"], operationId: "cancelTapoHistoryExportJob", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Export job cancelled", { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "404": { $ref: "#/components/responses/NotFound" } } } },
    "/internal/tapo-history/jobs/claim": { get: { tags: ["Integrations"], operationId: "claimTapoHistoryExportJob", security: [{ tapoWorkerBearer: [] }], parameters: [{ name: "workerId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }, { name: "deploymentFingerprint", in: "query", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], responses: { "200": jsonResponse("Leased Appium export job with an opaque capability token", { $ref: "#/components/schemas/TapoHistoryWorkerClaim" }), "204": { description: "No runnable export job or matching fresh canary approval" }, "400": { description: "Missing or mismatched deployment fingerprint attestation" }, "401": { description: "Invalid worker token" } } } },
    "/internal/tapo-history/jobs/{id}/heartbeat": { post: { tags: ["Integrations"], operationId: "heartbeatTapoHistoryExportJob", security: [{ tapoWorkerBearer: [] }], parameters: [{ $ref: "#/components/parameters/Id" }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/TapoHistoryWorkerLeaseInput" }), responses: { "200": jsonResponse("Worker lease extended", { $ref: "#/components/schemas/TapoHistoryWorkerLease" }), "409": { description: "Worker lease or deployment attestation was lost" } } } },
    "/internal/tapo-history/jobs/{id}/status": { post: { tags: ["Integrations"], operationId: "updateTapoHistoryExportJobStatus", security: [{ tapoWorkerBearer: [] }], parameters: [{ $ref: "#/components/parameters/Id" }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/TapoHistoryWorkerStatusInput" }), responses: { "200": jsonResponse("Worker-owned export state updated", { type: "object", additionalProperties: false, required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" } } }), "409": { description: "Worker lease or deployment attestation was lost" } } } },
    "/integrations/tp-link/test": { post: { tags: ["Integrations"], operationId: "tpLinkStatusTest", responses: { "200": { description: "Status of the direct local TP-Link bridge", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
    "/integrations/tp-link/test-draft": { post: { tags: ["Integrations"], operationId: "testTpLinkDraft", description: "Runs one isolated helper poll with draft credentials without saving or activating them.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TpLinkConfigInput" } } } }, responses: { "200": { description: "Non-persisting credential test result", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
    "/integrations/telegram/discover": {
      post: {
        tags: ["Integrations"], operationId: "discoverTelegramChat",
        description: "Verifies a write-only bot token and lists only private chats that have already sent the bot a message (normally /start).",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramDiscoveryInput" } } } },
        responses: {
          "200": { description: "Verified bot and private-chat candidates", content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramDiscoveryResult" } } } },
          "400": { description: "Invalid token, or Telegram rejected the credentials" },
          "503": { description: "Telegram is unavailable or rate limiting requests" },
        },
      },
    },
    "/integrations/telegram/config": {
      put: {
        tags: ["Integrations"], operationId: "configureTelegram",
        description: "Verifies and stores a bot token and one private-chat identifier in the local secrets file. The token is write-only and never returned.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramConfigInput" } } } },
        responses: {
          "200": { description: "Telegram delivery configured", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationConfigurationResult" } } } },
          "400": { description: "Invalid credentials, chat identifier, or non-private chat" },
          "503": { description: "Telegram is unavailable or rate limiting requests" },
        },
      },
      delete: { tags: ["Integrations"], operationId: "disconnectTelegram", description: "Deletes the locally stored Telegram credentials.", responses: { "200": { description: "Telegram credentials deleted", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } } } },
    },
    "/integrations/telegram/test": {
      post: { tags: ["Integrations"], operationId: "testTelegram", description: "Sends a protected test message to the configured private chat.", responses: { "200": { description: "Test message accepted by Telegram", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } }, "409": { description: "Telegram is not configured" }, "503": { description: "Telegram is unavailable or rate limiting requests" } } },
    },
    "/integrations/telegram/setup": {
      get: { tags: ["Integrations"], operationId: "telegramSetup", responses: { "200": { description: "Guided BotFather, private-chat pairing, security, and alert-rule setup metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramSetup" } } } } } },
    },
    "/integrations/apple-notes/grants": {
      get: { tags: ["Integrations"], operationId: "listAppleNotesGrants", description: "Lists redacted, house-scoped Shortcut grants. Raw bearer tokens are never returned.", responses: { "200": { description: "Active Apple Notes Shortcut grants", content: { "application/json": { schema: { type: "object", required: ["grants"], properties: { grants: { type: "array", items: { $ref: "#/components/schemas/AppleNotesGrantSummary" } } } } } } } } },
      post: {
        tags: ["Integrations"], operationId: "createAppleNotesGrant",
        description: "Creates a house-scoped Shortcut grant and returns its bearer token exactly once. Only a token hash is persisted.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesGrantInput" } } } },
        responses: { "201": { description: "Created grant with one-time bearer token", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesGrantCreated" } } } }, "404": { description: "House not found" } },
      },
    },
    "/integrations/apple-notes/grants/{id}": {
      delete: { tags: ["Integrations"], operationId: "revokeAppleNotesGrant", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Grant revoked", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/integrations/apple-notes/setup": {
      get: { tags: ["Integrations"], operationId: "appleNotesSetup", responses: { "200": { description: "Guided iOS Shortcuts bridge recipes, limitations, and endpoint metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesSetup" } } } } } },
    },
    "/integrations/apple-notes/snapshot": {
      get: {
        tags: ["Integrations"], operationId: "appleNotesSnapshot", security: [{ notesGrant: [] }],
        description: "Returns a generated, read-only maintenance snapshot for the grant's house. Stuga remains the source of truth.",
        parameters: [{ name: "houseId", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Generated maintenance snapshot", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesSnapshot" } } } }, "401": { description: "Missing or invalid Shortcut grant" }, "403": { description: "Grant is scoped to another house" }, "404": { description: "House not found" } },
      },
    },
    "/integrations/apple-notes/capture": {
      post: {
        tags: ["Integrations"], operationId: "captureAppleNotesMaintenance", security: [{ notesGrant: [] }],
        description: "Creates one maintenance task from a Shortcut command. Retrying an identical operationId is idempotent; reusing it with changed content is a conflict.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureInput" } } } },
        responses: { "200": { description: "Identical command was already applied", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureResult" } } } }, "201": { description: "Maintenance task created", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureResult" } } } }, "401": { description: "Missing or invalid Shortcut grant" }, "403": { description: "Grant is scoped to another house" }, "409": { description: "operationId was reused with different content" }, "422": { description: "Invalid maintenance command" } },
      },
    },
    "/mock/scenarios": { get: { tags: ["Testing"], operationId: "listMockScenarios", responses: { "200": { description: "Scenarios", content: { "application/json": { schema: { type: "object", required: ["scenarios", "active", "enabled"], properties: { scenarios: { type: "array", items: { $ref: "#/components/schemas/MockScenario" } }, active: { $ref: "#/components/schemas/MockScenarioId" }, enabled: { type: "boolean" } } } } } } } } },
    "/mock/scenario": {
      put: { tags: ["Testing"], operationId: "selectMockScenario", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["scenario"], properties: { scenario: { $ref: "#/components/schemas/MockScenarioId" } } } } } }, responses: { "200": { description: "Selected scenario", content: { "application/json": { schema: { type: "object", required: ["active"], properties: { active: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } },
      post: { tags: ["Testing"], operationId: "selectMockScenarioCompatibility", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { scenarioId: { $ref: "#/components/schemas/MockScenarioId" }, scenario: { $ref: "#/components/schemas/MockScenarioId" } }, anyOf: [{ required: ["scenarioId"] }, { required: ["scenario"] }] } } } }, responses: { "200": { description: "Selected scenario", content: { "application/json": { schema: { type: "object", required: ["ok", "active"], properties: { ok: { const: true }, active: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } },
    },
    "/mock/tick": { post: { tags: ["Testing"], operationId: "generateMockTick", responses: { "201": { description: "Generated readings", content: { "application/json": { schema: { type: "object", required: ["readings", "scenario"], properties: { readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } }, scenario: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } } },
    "/replay": {
      get: { tags: ["Testing"], operationId: "replayStatus", responses: { "200": { description: "Replay state", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
      post: { tags: ["Testing"], operationId: "startReplay", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReplayInput" } } } }, responses: { "202": { description: "Replay started", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
      delete: { tags: ["Testing"], operationId: "stopReplay", responses: { "200": { description: "Replay stopped", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
    },
  },
  components: {
    securitySchemes: {
      localSession: { type: "apiKey", in: "cookie", name: "stuga_session", description: "Opaque HttpOnly SameSite=Strict local session cookie." },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Session-bound token required together with the session cookie on unsafe methods." },
      ingestKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "Optional, configured by INGEST_API_KEY." },
      notesGrant: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "One-time, house-scoped Apple Notes Shortcut grant. The local server stores only its SHA-256 hash." },
      tapoWorkerBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Route-scoped token for the isolated Appium Tapo export worker." },
    },
    parameters: {
      Id: { name: "id", in: "path", required: true, schema: { type: "string" } },
      PropertyIdQuery: { name: "propertyId", in: "query", schema: { type: "string", maxLength: 200 }, description: "Optional property scope." },
      HouseIdQuery: { name: "houseId", in: "query", schema: { type: "string" }, description: "Optional house scope." },
      AreaIdQuery: { name: "areaId", in: "query", schema: { type: "string", maxLength: 200 }, description: "Optional mapped-area scope." },
      EquipmentIdQuery: { name: "equipmentId", in: "query", schema: { type: "string", maxLength: 200 }, description: "Optional equipment scope." },
      CollectionLimitQuery: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 }, description: "Maximum resources returned in this page." },
      CollectionOffsetQuery: { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 }, description: "Zero-based resource offset." },
      SensorIdsQuery: { name: "sensorId", in: "query", style: "form", explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeat or comma-separate sensor IDs." },
      FromQuery: { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
      ToQuery: { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
    },
    schemas: {
      ...localAuthSchemas,
      ...spatialLayerSchemas,
      MeasurementDefinition: {
        type: "object",
        required: ["id", "labels", "unit", "dimension", "allowedUnits", "kind", "defaultAggregation", "genericHistoryEnabled", "genericStatsEnabled", "precision", "validMin", "validMax", "displayMin", "displayMax", "interpolationDelta", "colorScale", "builtin", "enabled", "spatialInterpolation", "forecastSupported"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$", maxLength: 64 },
          labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
          unit: { type: "string", minLength: 1 },
          dimension: { type: "string", minLength: 1 },
          allowedUnits: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1 } },
          kind: { enum: ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"] },
          defaultAggregation: { enum: ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"] },
          genericHistoryEnabled: { type: "boolean" }, genericStatsEnabled: { type: "boolean" },
          precision: { type: "integer", minimum: 0, maximum: 6 },
          validMin: { type: ["number", "null"] }, validMax: { type: ["number", "null"] },
          displayMin: { type: ["number", "null"] }, displayMax: { type: ["number", "null"] },
          interpolationDelta: { type: "number", exclusiveMinimum: 0 },
          colorScale: { enum: ["thermal", "humidity", "air-quality", "sequential"] },
          builtin: { type: "boolean", readOnly: true }, enabled: { type: "boolean" },
          spatialInterpolation: { type: "boolean" }, forecastSupported: { type: "boolean" },
        },
      },
      MeasurementDefinitionInput: {
        description: "Custom definitions default to enabled, sequential color, and no spatial interpolation or forecast capability.",
        type: "object",
        required: ["id", "labels", "unit"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$", maxLength: 64 },
          labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
          unit: { type: "string", minLength: 1 }, precision: { type: "integer", minimum: 0, maximum: 6, default: 1 },
          dimension: { type: "string", minLength: 1, default: "finite_scalar" },
          allowedUnits: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1 } },
          kind: { enum: ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"], default: "gauge" },
          defaultAggregation: { enum: ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"], default: "mean" },
          genericHistoryEnabled: { type: "boolean", default: true }, genericStatsEnabled: { type: "boolean", default: true },
          validMin: { type: ["number", "null"], default: null }, validMax: { type: ["number", "null"], default: null },
          displayMin: { type: ["number", "null"], default: null }, displayMax: { type: ["number", "null"], default: null },
          interpolationDelta: { type: "number", exclusiveMinimum: 0, default: 1 },
          colorScale: { enum: ["thermal", "humidity", "air-quality", "sequential"], default: "sequential" },
          enabled: { type: "boolean", default: true }, spatialInterpolation: { type: "boolean", default: false }, forecastSupported: { type: "boolean", default: false },
        },
      },
      MeasurementDefinitionPatch: {
        type: "object",
        description: "Partial mutable definition fields. id and builtin are immutable.",
        properties: {
          labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
          unit: { type: "string", minLength: 1 }, precision: { type: "integer", minimum: 0, maximum: 6 },
          dimension: { type: "string", minLength: 1 },
          allowedUnits: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1 } },
          kind: { enum: ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"] },
          defaultAggregation: { enum: ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"] },
          genericHistoryEnabled: { type: "boolean" }, genericStatsEnabled: { type: "boolean" },
          validMin: { type: ["number", "null"] }, validMax: { type: ["number", "null"] },
          displayMin: { type: ["number", "null"] }, displayMax: { type: ["number", "null"] },
          interpolationDelta: { type: "number", exclusiveMinimum: 0 },
          colorScale: { enum: ["thermal", "humidity", "air-quality", "sequential"] },
          enabled: { type: "boolean" }, spatialInterpolation: { type: "boolean" }, forecastSupported: { type: "boolean" },
        },
      },
      AnalyticsQueryRequest: {
        type: "object",
        additionalProperties: false,
        required: ["apiVersion", "dataMode", "scope", "measurementIds", "range", "resolution", "aggregation", "requestId"],
        properties: {
          apiVersion: { const: "1.0" },
          dataMode: { enum: ["live", "demo"] },
          scope: {
            type: "object", additionalProperties: false, required: ["kind", "id"],
            properties: {
              kind: { const: "house" }, id: { type: "string", minLength: 1, maxLength: 200 },
              entityIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
            },
          },
          measurementIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
          range: {
            type: "object", additionalProperties: false, required: ["start", "end", "timezone"],
            properties: {
              start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" },
              timezone: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
          resolution: { enum: ["auto", "raw", "1m", "5m", "15m", "1h", "1d"] },
          aggregation: { enum: ["default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"] },
          qualityFilter: {
            type: "object", additionalProperties: false, required: ["include"],
            properties: { include: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ["good", "estimated", "stale"] } } },
          },
          include: { type: "array", maxItems: 4, uniqueItems: true, items: { enum: ["series", "summary", "provenance", "quality"] } },
          maxPointsPerSeries: { type: "integer", minimum: 100, maximum: 5000, default: 800 },
          requestId: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      AnalyticsCoverageRequest: {
        type: "object",
        additionalProperties: false,
        required: ["apiVersion", "dataMode", "scope", "measurementIds", "requestId"],
        properties: {
          apiVersion: { const: "1.0" },
          dataMode: { enum: ["live", "demo"] },
          scope: { $ref: "#/components/schemas/AnalyticsQueryRequest/properties/scope" },
          measurementIds: { $ref: "#/components/schemas/AnalyticsQueryRequest/properties/measurementIds" },
          requestId: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      AnalyticsCoverageResponse: {
        type: "object",
        additionalProperties: false,
        required: ["apiVersion", "requestId", "dataMode", "range", "series", "complete", "archiveState", "generatedAt"],
        properties: {
          apiVersion: { const: "1.0" }, requestId: { type: "string" }, dataMode: { enum: ["live", "demo"] },
          range: { type: "object", additionalProperties: false, required: ["start", "end"], properties: {
            start: { type: ["string", "null"], format: "date-time" }, end: { type: ["string", "null"], format: "date-time" },
          } },
          series: { type: "array", items: { type: "object", additionalProperties: false,
            required: ["entityId", "entityLabel", "measurementId", "start", "end"], properties: {
              entityId: { type: "string" }, entityLabel: { type: "string" }, measurementId: { type: "string" },
              start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" },
            } } },
          complete: { type: "boolean" },
          archiveState: { enum: ["not-configured", "not-ready", "merged", "failed"] },
          generatedAt: { type: "string", format: "date-time" },
        },
      },
      AnalyticsFindingPeriodEvidence: {
        type: "object", additionalProperties: false,
        required: ["key", "year", "start", "end", "value", "sampleCount", "coverage"],
        properties: {
          key: { type: "string" }, year: { type: "integer" },
          start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" },
          value: { type: "number" }, sampleCount: { type: "integer", minimum: 0 },
          coverage: { type: ["number", "null"], minimum: 0, maximum: 1 },
        },
      },
      AnalyticsFinding: {
        type: "object", additionalProperties: false,
        required: ["id", "category", "subjectId", "subjectLabel", "metric", "unit", "statistic", "direction", "strength", "current", "baseline", "baselineMedian", "absoluteDifference", "percentDifference"],
        properties: {
          id: { type: "string" }, category: { enum: ["sensor", "outdoor-weather", "electricity", "opening"] },
          subjectId: { type: "string" }, subjectLabel: { type: "string" }, metric: { type: "string" }, unit: { type: "string" },
          statistic: { enum: ["mean", "sum", "delta", "open-count"] }, direction: { enum: ["higher", "lower"] },
          strength: { enum: ["notable", "strong"] }, current: { $ref: "#/components/schemas/AnalyticsFindingPeriodEvidence" },
          baseline: { type: "array", minItems: 1, maxItems: 5, items: { $ref: "#/components/schemas/AnalyticsFindingPeriodEvidence" } },
          baselineMedian: { type: "number" }, absoluteDifference: { type: "number", minimum: 0 },
          percentDifference: { type: ["number", "null"], minimum: 0 },
        },
      },
      DailyAnalyticsFindingsSnapshot: {
        type: "object", additionalProperties: false,
        required: ["apiVersion", "houseId", "dataMode", "periodKind", "evaluatedThrough", "algorithmVersion", "generatedAt", "findings", "warnings"],
        properties: {
          apiVersion: { const: "1.0" }, houseId: { type: "string" }, dataMode: { enum: ["live", "demo"] },
          periodKind: { const: "month-to-date" }, evaluatedThrough: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
          algorithmVersion: { type: "string" }, generatedAt: { type: "string", format: "date-time" },
          findings: { type: "array", maxItems: 16, items: { $ref: "#/components/schemas/AnalyticsFinding" } },
          warnings: { type: "array", uniqueItems: true, items: { enum: ["archive-incomplete", "source-truncated", "scope-limited"] } },
        },
      },
      DailyAnalyticsFindingsResponse: {
        type: "object", additionalProperties: false, required: ["snapshot", "status"],
        properties: {
          snapshot: { oneOf: [{ $ref: "#/components/schemas/DailyAnalyticsFindingsSnapshot" }, { type: "null" }] },
          status: { type: "object", additionalProperties: false, required: ["state", "lastAttemptAt", "lastError"], properties: {
            state: { enum: ["pending", "ready", "failed"] },
            lastAttemptAt: { type: ["string", "null"], format: "date-time" },
            lastError: { type: ["string", "null"] },
          } },
        },
      },
      AnalyticsProvenance: {
        type: "object", additionalProperties: false,
        required: ["algorithmKey", "algorithmVersion", "generatedAt", "inputStart", "inputEnd", "sourceIds", "archiveState"],
        properties: {
          algorithmKey: { type: "string" }, algorithmVersion: { type: "string" },
          generatedAt: { type: "string", format: "date-time" }, inputStart: { type: "string", format: "date-time" }, inputEnd: { type: "string", format: "date-time" },
          sourceIds: { type: "array", items: { type: "string" } },
          archiveState: { enum: ["not-configured", "not-ready", "merged", "failed"] },
        },
      },
      AnalyticsSummary: {
        type: "object", additionalProperties: false,
        required: ["entityId", "measurementId", "canonicalUnit", "count", "coverage", "minimum", "maximum", "mean", "median", "standardDeviation", "medianAbsoluteDeviation", "p05", "p95"],
        properties: {
          entityId: { type: "string" }, measurementId: { type: "string" }, canonicalUnit: { type: "string" },
          count: { type: "integer", minimum: 0 }, coverage: { type: "number", minimum: 0, maximum: 1 },
          minimum: { type: ["number", "null"] }, maximum: { type: ["number", "null"] }, mean: { type: ["number", "null"] }, median: { type: ["number", "null"] },
          standardDeviation: { type: ["number", "null"] }, medianAbsoluteDeviation: { type: ["number", "null"] }, p05: { type: ["number", "null"] }, p95: { type: ["number", "null"] },
        },
      },
      AnalyticsQueryResponse: {
        type: "object", additionalProperties: false,
        required: ["apiVersion", "requestId", "dataMode", "resolvedRange", "resolution", "series", "summaries", "quality", "provenance", "warnings", "generatedAt", "cache"],
        properties: {
          apiVersion: { const: "1.0" }, requestId: { type: "string" }, dataMode: { enum: ["live", "demo"] },
          resolvedRange: { $ref: "#/components/schemas/AnalyticsQueryRequest/properties/range" },
          resolution: { enum: ["raw", "1m", "5m", "15m", "1h", "1d"] },
          series: {
            type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["entityId", "entityLabel", "measurementId", "canonicalUnit", "truthClass", "aggregation", "resolution", "points", "summary", "provenance"],
              properties: {
                entityId: { type: "string" }, entityLabel: { type: "string" }, measurementId: { type: "string" }, canonicalUnit: { type: "string" },
                truthClass: { enum: ["observed", "derived", "estimated", "inferred", "forecast", "simulated"] },
                aggregation: { enum: ["raw", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"] },
                resolution: { enum: ["raw", "1m", "5m", "15m", "1h", "1d"] },
                points: { type: "array", items: { type: "object", required: ["timestamp", "value", "minimum", "maximum", "sampleCount", "coverage", "qualityFlags"], properties: {
                  timestamp: { type: "string", format: "date-time" }, value: { type: ["number", "null"] }, minimum: { type: ["number", "null"] }, maximum: { type: ["number", "null"] },
                  sampleCount: { type: "integer", minimum: 0 }, coverage: { type: "number", minimum: 0, maximum: 1 }, qualityFlags: { type: "array", items: { type: "string" } },
                } } },
                summary: { $ref: "#/components/schemas/AnalyticsSummary" }, provenance: { $ref: "#/components/schemas/AnalyticsProvenance" },
              },
            },
          },
          summaries: { type: "array", items: { $ref: "#/components/schemas/AnalyticsSummary" } },
          quality: { type: "object", required: ["coverage", "seriesCount", "sampleCount", "excludedSampleCount", "includedQualities", "lowCoverageSeries"], properties: {
            coverage: { type: "number", minimum: 0, maximum: 1 }, seriesCount: { type: "integer", minimum: 0 }, sampleCount: { type: "integer", minimum: 0 },
            excludedSampleCount: { type: "integer", minimum: 0 }, includedQualities: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ["good", "estimated", "stale"] } },
            lowCoverageSeries: { type: "integer", minimum: 0 },
          } },
          provenance: { type: "array", items: { $ref: "#/components/schemas/AnalyticsProvenance" } },
          warnings: { type: "array", items: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } },
          generatedAt: { type: "string", format: "date-time" },
          cache: { type: "object", required: ["hit", "keyVersion"], properties: { hit: { const: false }, keyVersion: { const: "analytics-query-v1" } } },
        },
      },
      MeasurementSampleInput: {
        type: "object",
        description: "Canonical unit, timestamp, and quality are optional on ingestion and receive registry/API defaults when omitted. Source provenance is assigned by the server and is not part of the public ingestion contract.",
        required: ["sensorId", "metric", "value"],
        properties: {
          sensorId: { type: "string" },
          metric: { type: "string" },
          value: { type: "number" },
          canonicalUnit: { type: "string", description: "Defaults to the registered canonical unit." },
          timestamp: { type: "string", format: "date-time", description: "Defaults to the server time. Live ingestion accepts at most five minutes of positive sender clock skew." },
          quality: { enum: ["good", "estimated", "stale"], default: "good" },
        },
      },
      MeasurementSample: {
        type: "object",
        required: ["sensorId", "metric", "value", "canonicalUnit", "timestamp", "source", "quality"],
        properties: {
          sensorId: { type: "string" }, metric: { type: "string" }, value: { type: "number" }, canonicalUnit: { type: "string" },
          timestamp: { type: "string", format: "date-time" }, source: { enum: ["mock", "home-assistant", "tp-link", "api", "import", "replay"] },
          quality: { enum: ["good", "estimated", "stale"] },
        },
      },
      MeasurementForecastPoint: {
        type: "object",
        required: ["sensorId", "metric", "timestamp", "value", "low", "high"],
        properties: { sensorId: { type: "string" }, metric: { type: "string" }, timestamp: { type: "string", format: "date-time" }, value: { type: "number" }, low: { type: "number" }, high: { type: "number" } },
      },
      MeasurementSnapshotEntry: {
        type: "object",
        required: ["sensorId", "measurements"],
        properties: { sensorId: { type: "string" }, measurements: { type: "object", additionalProperties: { $ref: "#/components/schemas/MeasurementSample" } } },
      },
      ReadingInput: {
        type: "object",
        required: ["sensorId", "temperature", "humidity"],
        properties: {
          sensorId: { type: "string" },
          timestamp: { type: "string", format: "date-time", description: "Defaults to the server time. Live ingestion accepts at most five minutes of positive sender clock skew." },
          temperature: { type: "number", minimum: -80, maximum: 100 },
          humidity: { type: "number", minimum: 0, maximum: 100 },
          battery: { type: ["number", "null"], minimum: 0, maximum: 100, default: null },
          quality: { enum: ["good", "estimated", "stale"], default: "good" },
          measurements: { type: "object", additionalProperties: { type: "number" }, description: "Optional registry-defined numeric values accepted alongside the v1 tuple." },
        },
      },
      Reading: {
        type: "object",
        required: ["sensorId", "timestamp", "temperature", "humidity", "battery", "source", "quality"],
        properties: {
          sensorId: { type: "string" }, timestamp: { type: "string", format: "date-time" },
          temperature: { type: "number" }, humidity: { type: "number" }, battery: { type: ["number", "null"] },
          source: { enum: ["mock", "home-assistant", "tp-link", "api", "import", "replay"] },
          quality: { enum: ["good", "estimated", "stale"] },
          measurements: { type: "object", additionalProperties: { type: "number" } },
        },
      },
      ForecastPoint: {
        type: "object",
        required: ["sensorId", "timestamp", "temperature", "humidity", "temperatureLow", "temperatureHigh", "humidityLow", "humidityHigh"],
        properties: {
          sensorId: { type: "string" }, timestamp: { type: "string", format: "date-time" },
          temperature: { type: "number" }, humidity: { type: "number" },
          temperatureLow: { type: "number" }, temperatureHigh: { type: "number" },
          humidityLow: { type: "number" }, humidityHigh: { type: "number" },
          measurements: { type: "object", additionalProperties: { type: "object", required: ["value", "low", "high"], properties: { value: { type: "number" }, low: { type: "number" }, high: { type: "number" } } } },
        },
      },
      HistorySeries: {
        type: "object",
        required: ["sensorId", "readings", "forecast"],
        properties: {
          sensorId: { type: "string" }, readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } },
          forecast: { type: "array", items: { $ref: "#/components/schemas/ForecastPoint" } },
        },
      },
      Point: {
        type: "object",
        required: ["x", "y"],
        properties: {
          x: { type: "number", description: "Horizontal coordinate in the floor plan's width coordinate system." },
          y: { type: "number", description: "Depth coordinate in the floor plan's height coordinate system." },
        },
      },
      OpeningStateBinding: {
        type: "object",
        required: ["provider", "externalId"],
        additionalProperties: false,
        description: "Provider-neutral contact-state binding. The element's configured state is retained as a safe fallback.",
        properties: {
          provider: { type: "string", enum: ["home-assistant", "tapo"] },
          externalId: { type: "string", minLength: 1, maxLength: 255, description: "Home Assistant entity id or Tapo child-device id." },
          connectionId: { type: "string", minLength: 1, maxLength: 255 },
          invert: { type: "boolean", default: false },
          staleAfterSeconds: { type: "number", minimum: 1, maximum: 2_592_000, default: 900 },
        },
      },
      OpeningStateObservation: {
        type: "object",
        required: ["id", "houseId", "floorId", "elementId", "state", "source", "observedAt"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, floorId: { type: "string" }, elementId: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "unknown"] },
          openFraction: { type: "number", minimum: 0, maximum: 1 },
          source: { type: "string", enum: ["manual", "home-assistant", "tapo", "api"] },
          observedAt: { type: "string", format: "date-time" }, validUntil: { type: "string", format: "date-time" }, externalId: { type: "string" }, connectionId: { type: "string" },
        },
      },
      OpeningStateObservationInput: {
        type: "object",
        required: ["floorId", "elementId", "state"],
        additionalProperties: false,
        properties: {
          id: { type: "string" }, floorId: { type: "string" }, elementId: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "unknown"] }, openFraction: { type: "number", minimum: 0, maximum: 1 },
          source: { type: "string", enum: ["manual", "api"], default: "api" },
          observedAt: { type: "string", format: "date-time" }, validUntil: { type: "string", format: "date-time" }, externalId: { type: "string" },
        },
      },
      OpeningStateSnapshot: {
        type: "object",
        required: ["houseId", "at", "states"],
        properties: {
          houseId: { type: "string" }, at: { type: "string", format: "date-time" },
          states: { type: "array", items: { type: "object", required: ["floorId", "elementId", "kind", "state", "openFraction", "source", "assumed"], properties: {
            floorId: { type: "string" }, elementId: { type: "string" }, kind: { type: "string", enum: ["door", "window", "vent"] }, label: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] }, openFraction: { type: "number", minimum: 0, maximum: 1 }, source: { type: "string", enum: ["default", "manual", "home-assistant", "tapo", "api"] },
            observedAt: { type: "string", format: "date-time" }, assumed: { type: "boolean" },
          } } },
        },
      },
      HouseLocation: {
        type: "object",
        description: "House position in the WGS84 latitude/longitude coordinate reference system. This is outdoor-context metadata, separate from floor-local x/y/z coordinates.",
        required: ["latitude", "longitude"],
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90, description: "WGS84 latitude in decimal degrees." },
          longitude: { type: "number", minimum: -180, maximum: 180, description: "WGS84 longitude in decimal degrees." },
          label: { type: "string", maxLength: 200, description: "Optional user-facing area label. A precise street address is not required." },
          countryCode: { type: "string", pattern: "^[A-Z]{2}$", description: "Optional ISO country hint retained from discovery." },
          source: { enum: ["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"] },
          confidence: { enum: ["high", "medium", "low"] },
          discoveredAt: { type: "string", format: "date-time" },
          userOverridden: { type: "boolean", description: "True after a person explicitly enters or corrects this value." },
        },
      },
      HouseMapPlacement: {
        type: "object",
        description: "Precise WGS84 placement and scale for drawing a floor plan on a map. This is independent of HouseLocation, which remains the weather lookup location.",
        required: ["latitude", "longitude", "metersPerPlanUnit"],
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90, description: "WGS84 latitude of the floor-plan anchor in decimal degrees." },
          longitude: { type: "number", minimum: -180, maximum: 180, description: "WGS84 longitude of the floor-plan anchor in decimal degrees." },
          metersPerPlanUnit: { type: "number", exclusiveMinimum: 0, description: "Real-world metres represented by one local floor-plan x/y unit." },
          footprintFloorId: { type: "string", minLength: 1, description: "Optional id of the house floor whose plan extent is used as the map footprint." },
        },
      },
      Floor: {
        type: "object",
        required: ["id", "name", "width", "height", "elevation", "walls", "rooms"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["basement", "ground", "upper", "attic", "mezzanine", "outdoor"], description: "Semantic level type used by floor-management interfaces." },
          width: { type: "number", exclusiveMinimum: 0 },
          height: { type: "number", exclusiveMinimum: 0 },
          metersPerPlanUnit: { type: "number", exclusiveMinimum: 0, maximum: 10_000, description: "Verified horizontal scale for this level: real-world metres represented by one local x/y unit." },
          elevation: { type: "number", description: "Absolute floor-plane height in metres in the house vertical coordinate system; sensor z values use the same vertical origin." },
          ceilingHeight: { type: "number", exclusiveMinimum: 0, description: "Clear room height in metres." },
          wallHeight: { type: "number", exclusiveMinimum: 0, maximum: 20, description: "Exterior wall height above the floor plane in metres; falls back to ceilingHeight when omitted." },
          roof: {
            type: "object",
            description: "Optional roof envelope attached to this level, normally an attic.",
            required: ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"],
            properties: {
              style: { type: "string", enum: ["gable", "hip", "shed", "flat"] },
              pitchDegrees: { type: "number", minimum: 0, maximum: 75 },
              ridgeAxis: { type: "string", enum: ["x", "y"] },
              overhang: { type: "number", minimum: 0, description: "Horizontal extension in floor-plan units." },
              eavesHeight: { type: "number", minimum: 0, description: "Wall height from attic floor to eaves in metres." },
            },
          },
          walls: { type: "array", items: { type: "object", required: ["id", "from", "to"], properties: { id: { type: "string" }, from: { $ref: "#/components/schemas/Point" }, to: { $ref: "#/components/schemas/Point" } } } },
          rooms: { type: "array", items: { type: "object", required: ["id", "name", "points"], properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" }, points: { type: "array", minItems: 3, items: { $ref: "#/components/schemas/Point" } } } } },
          planElements: {
            type: "array",
            description: "Optional architectural symbols placed on the editable floor plan.",
            items: {
              oneOf: [
                {
                  title: "Wall opening",
                  type: "object",
                  required: ["id", "kind", "position", "rotationDegrees", "wallId"],
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string", enum: ["door", "window"] },
                    position: { $ref: "#/components/schemas/Point" },
                    rotationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
                     width: { type: "number", exclusiveMinimum: 0, description: "When present, the full width must fit within the referenced wall segment." },
                     height: { type: "number", exclusiveMinimum: 0, description: "Physical opening height in metres, used by the 3D representation." },
                     label: { type: "string", minLength: 1, maxLength: 120 },
                     wallId: { type: "string", description: "Required wall attachment used for alignment and cascade deletion." },
                     variant: { type: "string", enum: ["interior", "exterior", "sliding", "double", "open-passage", "fixed", "casement", "tilt-turn"], description: "Kind-specific door or window construction variant." },
                     state: { type: "string", enum: ["open", "closed"], description: "Manual state and fallback whenever a linked contact sensor is missing, stale, or unknown. Doors and windows default closed." },
                     openFraction: { type: "number", minimum: 0, maximum: 1, description: "Effective aperture while open." },
                     bottomOffsetM: { type: "number", minimum: 0, description: "Bottom of the opening above the floor, in metres." },
                     stateBinding: { $ref: "#/components/schemas/OpeningStateBinding" },
                  },
                },
                {
                  title: "Free-standing fixture",
                  type: "object",
                  required: ["id", "kind", "position", "rotationDegrees"],
                  not: { required: ["wallId"] },
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string", enum: ["fireplace", "vent"] },
                    position: { $ref: "#/components/schemas/Point" },
                    rotationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
                     width: { type: "number", exclusiveMinimum: 0 },
                     height: { type: "number", exclusiveMinimum: 0, description: "Physical fixture height in metres, used by the 3D representation." },
                     label: { type: "string", minLength: 1, maxLength: 120 },
                      verticalExtent: { type: "string", enum: ["level", "roof"], description: "A roof-reaching fireplace continues as a chimney through every higher floor." },
                      chimneyHeightAboveRoof: { type: "number", minimum: 0, maximum: 5, description: "Fireplace chimney projection above the roof in metres; requires verticalExtent roof." },
                      chimneyWidth: { type: "number", exclusiveMinimum: 0, description: "Independent floor-to-roof chimney shaft width in floor-plan units." },
                      chimneyDepth: { type: "number", exclusiveMinimum: 0, description: "Independent floor-to-roof chimney shaft depth in floor-plan units." },
                     variant: { type: "string", enum: ["passive", "supply", "extract", "balanced", "transfer"], description: "Vent construction or operating mode; only supported for vents." },
                     state: { type: "string", enum: ["open", "closed"], description: "Manual state and sensor fallback; passive and mechanical vents default open." },
                     openFraction: { type: "number", minimum: 0, maximum: 1 },
                     bottomOffsetM: { type: "number", minimum: 0, description: "Bottom of the vent above the floor, in metres." },
                     nominalFlowM3h: { type: "number", minimum: 0, maximum: 100_000, description: "Optional design flow in cubic metres per hour." },
                     stateBinding: { $ref: "#/components/schemas/OpeningStateBinding" },
                  },
                },
                {
                  title: "Exterior fire escape",
                  type: "object",
                  required: ["id", "kind", "position", "rotationDegrees", "wallId"],
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string", enum: ["fireEscape"] },
                    position: { $ref: "#/components/schemas/Point" },
                    rotationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
                    width: { type: "number", exclusiveMinimum: 0, description: "Width along the exterior wall in floor-plan units." },
                    height: { type: "number", minimum: 0.6, description: "Physical escape height in metres." },
                    label: { type: "string", minLength: 1, maxLength: 120 },
                    wallId: { type: "string", description: "Exterior wall used for alignment and cascade deletion." },
                    variant: { type: "string", enum: ["ladder", "stairs"] },
                    bottomOffsetM: { type: "number", minimum: 0, description: "Bottom of the escape above the level floor plane, in metres." },
                    projection: { type: "number", exclusiveMinimum: 0, description: "Distance projected out from the exterior wall in floor-plan units." },
                  },
                },
              ],
            },
          },
          backgroundImage: { type: "string", description: "Optional trusted raster data URL used by the local floor-plan editor." },
        },
      },
      AppSession: {
        type: "object",
        required: ["authenticated", "principal", "tenant", "availableTenants", "readOnly", "grants"],
        additionalProperties: false,
        properties: {
          authenticated: { type: "boolean" },
          principal: { type: "object", required: ["type", "email"], properties: { type: { type: "string" }, email: { type: ["string", "null"] } } },
          tenant: { type: "object", required: ["id", "name", "role"], properties: { id: { type: "string" }, name: { type: "string" }, role: { enum: ["owner", "admin", "member", "guest", "service"] } } },
          availableTenants: { type: "array", items: { type: "object", required: ["id", "name", "role"], additionalProperties: false, properties: { id: { type: "string" }, name: { type: "string" }, role: { enum: ["owner", "admin", "member", "guest", "service"] } } } },
          readOnly: { type: "boolean" },
          grants: { type: "array", maxItems: 100, items: { type: "object", required: ["scopeType", "scopeId"], properties: { scopeType: { enum: ["property", "house", "area"] }, scopeId: { type: "string" } } } },
          csrfToken: { type: "string", readOnly: true, description: "Present only for authenticated local sessions." },
          setupRequired: { type: "boolean", readOnly: true },
        },
      },
      GeoCoordinate: {
        type: "object", required: ["latitude", "longitude"], additionalProperties: false,
        properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } },
      },
      Property: {
        type: "object", required: ["id", "name", "description", "location", "createdAt", "updatedAt"], additionalProperties: false,
        properties: {
          id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 },
          location: { oneOf: [{ $ref: "#/components/schemas/HouseLocation" }, { type: "null" }] },
          createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      PropertyInput: {
        type: "object", required: ["name"], additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: ["string", "null"], maxLength: 5_000 }, location: { oneOf: [{ $ref: "#/components/schemas/HouseLocation" }, { type: "null" }] } },
      },
      PropertyPatch: {
        type: "object", minProperties: 1, additionalProperties: false,
        properties: { name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: ["string", "null"], maxLength: 5_000 }, location: { oneOf: [{ $ref: "#/components/schemas/HouseLocation" }, { type: "null" }] } },
      },
      PropertyAreaKind: { enum: ["well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road", "yard", "building", "other"] },
      PropertyArea: {
        type: "object", required: ["id", "propertyId", "name", "kind", "description", "polygon", "createdAt", "updatedAt"], additionalProperties: false,
        properties: {
          id: { type: "string" }, propertyId: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 200 },
          kind: { $ref: "#/components/schemas/PropertyAreaKind" }, description: { type: ["string", "null"], maxLength: 5_000 },
          location: { $ref: "#/components/schemas/GeoCoordinate" },
          polygon: { type: "array", oneOf: [{ maxItems: 0 }, { minItems: 3, maxItems: 500 }], items: { $ref: "#/components/schemas/GeoCoordinate" } },
          createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      PropertyAreaInput: {
        type: "object", required: ["propertyId", "name", "kind", "polygon"], additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, propertyId: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { $ref: "#/components/schemas/PropertyAreaKind" }, description: { type: ["string", "null"], maxLength: 5_000 }, location: { $ref: "#/components/schemas/GeoCoordinate" }, polygon: { type: "array", oneOf: [{ maxItems: 0 }, { minItems: 3, maxItems: 500 }], items: { $ref: "#/components/schemas/GeoCoordinate" } } },
      },
      PropertyAreaPatch: {
        type: "object", minProperties: 1, additionalProperties: false,
        properties: { propertyId: { type: "string", minLength: 1, maxLength: 200, description: "Moves the area aggregate, including equipment and scoped context, to this property." }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { $ref: "#/components/schemas/PropertyAreaKind" }, description: { type: ["string", "null"], maxLength: 5_000 }, location: { oneOf: [{ $ref: "#/components/schemas/GeoCoordinate" }, { type: "null" }] }, polygon: { type: "array", oneOf: [{ maxItems: 0 }, { minItems: 3, maxItems: 500 }], items: { $ref: "#/components/schemas/GeoCoordinate" } } },
      },
      AreaEquipment: {
        type: "object", required: ["id", "propertyId", "areaId", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes", "createdAt", "updatedAt"], additionalProperties: false,
        properties: {
          id: { type: "string" }, propertyId: { type: "string" }, areaId: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 },
          manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 },
          status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 },
          createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      AreaEquipmentInput: {
        type: "object", required: ["areaId", "name", "kind"], additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, propertyId: { type: "string", minLength: 1, maxLength: 200 }, areaId: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 }, manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 }, status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 } },
      },
      AreaEquipmentPatch: {
        type: "object", minProperties: 1, additionalProperties: false,
        properties: { areaId: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 }, manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 }, status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 } },
      },
      PropertyNote: {
        type: "object", required: ["id", "propertyId", "houseId", "areaId", "equipmentId", "kind", "text", "createdAt", "updatedAt"], additionalProperties: false,
        properties: { id: { type: "string" }, propertyId: { type: "string" }, houseId: { type: ["string", "null"] }, areaId: { type: ["string", "null"] }, equipmentId: { type: ["string", "null"] }, kind: { enum: ["note", "inspection", "maintenance"] }, text: { type: "string", minLength: 1, maxLength: 5_000 }, createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true } },
      },
      PropertyNoteInput: {
        type: "object", required: ["propertyId", "kind", "text"], additionalProperties: false,
        description: "A note can target the property itself or at most one house, mapped area, or equipment item.",
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, propertyId: { type: "string", minLength: 1, maxLength: 200 }, houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, kind: { enum: ["note", "inspection", "maintenance"] }, text: { type: "string", minLength: 1, maxLength: 5_000 } },
      },
      PropertyNotePatch: {
        type: "object", minProperties: 1, additionalProperties: false,
        description: "Targets remain mutually exclusive; use null to remove a target.",
        properties: { houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, kind: { enum: ["note", "inspection", "maintenance"] }, text: { type: "string", minLength: 1, maxLength: 5_000 } },
      },
      House: {
        type: "object",
        required: ["id", "propertyId", "name", "timezone", "floors", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" },
          propertyId: { type: "string", description: "Managed property containing this house." },
          name: { type: "string" },
          timezone: { type: "string", description: "Timezone used for display and calendar grouping. New writes are validated as IANA time-zone identifiers; reads may expose an invalid historical value until it is corrected. Weather timestamps remain UTC ISO 8601." },
          location: { $ref: "#/components/schemas/HouseLocation" },
          mapPlacement: { $ref: "#/components/schemas/HouseMapPlacement" },
          orientationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360, description: "Confirmed clockwise compass bearing of the floor plan's top/up direction: 0=north, 90=east, 180=south, 270=west. Omitted while unknown." },
          floors: { type: "array", items: { $ref: "#/components/schemas/Floor" } },
          createdAt: { type: "string", format: "date-time", readOnly: true },
          updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      HouseCreate: {
        type: "object",
        required: ["name", "timezone", "floors"],
        properties: {
          id: { type: "string" },
          propertyId: { type: "string", minLength: 1, description: "Managed property for this home. It may be omitted only when the workspace has zero or one property." },
          name: { type: "string" },
          timezone: { type: "string", maxLength: 100, description: "IANA time-zone identifier validated by the server." },
          location: { $ref: "#/components/schemas/HouseLocation" },
          mapPlacement: { $ref: "#/components/schemas/HouseMapPlacement" },
          orientationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360, description: "Confirmed clockwise compass bearing of the floor plan's top/up direction. Omit while unknown." },
          floors: { type: "array", items: { $ref: "#/components/schemas/Floor" } },
        },
      },
      HousePatch: {
        type: "object",
        description: "Partial house update. Use location: null to remove weather metadata and mapPlacement: null to remove precise map placement.",
        properties: {
          propertyId: { type: "string", minLength: 1, description: "Moves the home and its house-scoped notes and work to this property." },
          name: { type: "string" },
          timezone: { type: "string", maxLength: 100, description: "IANA time-zone identifier validated by the server when changed. An unchanged invalid historical value may be preserved." },
          location: { oneOf: [{ $ref: "#/components/schemas/HouseLocation" }, { type: "null" }] },
          mapPlacement: { oneOf: [{ $ref: "#/components/schemas/HouseMapPlacement" }, { type: "null" }] },
          orientationDegrees: { oneOf: [{ type: "number", minimum: 0, exclusiveMaximum: 360 }, { type: "null" }], description: "Confirmed clockwise compass bearing of the floor plan's top/up direction. Set null to return to unknown." },
          floors: { type: "array", items: { $ref: "#/components/schemas/Floor" } },
        },
      },
      OutdoorConditions: {
        type: "object",
        description: "Canonical outdoor observation or forecast values. Properties absent from the FMI response are omitted rather than inferred or converted to zero.",
        required: ["timestamp"],
        properties: {
          timestamp: { type: "string", format: "date-time" },
          temperatureC: { type: "number", description: "Air temperature in degrees Celsius." },
          dewPointC: { type: "number", description: "Dew point in degrees Celsius." },
          relativeHumidityPercent: { type: "number", description: "Relative humidity in percent." },
          pressureHpa: { type: "number", description: "Sea-level pressure in hectopascals." },
          windDirectionDegrees: { type: "number", description: "Wind direction in degrees." },
          windSpeedMps: { type: "number", description: "Wind speed in metres per second." },
          windGustMps: { type: "number", description: "Wind gust in metres per second." },
          precipitation1hMm: { type: "number", description: "One-hour precipitation in millimetres." },
          precipitationIntensityMmPerHour: { type: "number", description: "Observed precipitation intensity in millimetres per hour." },
          precipitationProbabilityPercent: { type: "number" },
          precipitationFormCode: { type: "number", description: "FMI precipitation-form code; clients must use FMI code metadata rather than invent labels." },
          potentialPrecipitationFormCode: { type: "number", description: "FMI potential precipitation-form code." },
          snowDepthCm: { type: "number", description: "Observed snow depth in centimetres." },
          cloudCoverPercent: { type: "number" },
          lowCloudCoverPercent: { type: "number" },
          mediumCloudCoverPercent: { type: "number" },
          highCloudCoverPercent: { type: "number" },
          visibilityMeters: { type: "number" },
          fogIntensity: { type: "number", description: "FMI fog-intensity value." },
          globalRadiationWm2: { type: "number", description: "Global solar radiation in watts per square metre." },
          weatherSymbolCode: { type: "number", description: "FMI WeatherSymbol3 code." },
          presentWeatherCode: { type: "number", description: "Observed FMI/WMO present-weather code." },
          thunderstormProbabilityPercent: { type: "number" },
          frostProbabilityPercent: { type: "number" },
          severeFrostProbabilityPercent: { type: "number" },
          maximumWindSpeedMps: { type: "number", description: "Hourly maximum wind speed in metres per second." },
          maximumWindGustMps: { type: "number", description: "Hourly maximum gust in metres per second." },
        },
      },
      WeatherStation: {
        type: "object",
        description: "Provenance for the nearest recent FMI observation station selected by the service. It is not the house position.",
        required: ["id", "name", "latitude", "longitude", "distanceKm"],
        properties: {
          id: { type: ["string", "null"] },
          name: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          distanceKm: { type: "number", minimum: 0 },
        },
      },
      WeatherWarning: {
        type: "object",
        description: "An actual, non-cancelled FMI CAP warning whose polygon or circle contains the stored house location.",
        required: ["id", "event", "headline", "description", "severity", "urgency", "certainty", "effectiveAt", "onsetAt", "expiresAt", "areas", "web"],
        properties: {
          id: { type: "string" },
          event: { type: "string" },
          headline: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["minor", "moderate", "severe", "extreme", "unknown"] },
          urgency: { type: "string" },
          certainty: { type: "string" },
          effectiveAt: { type: ["string", "null"], format: "date-time" },
          onsetAt: { type: ["string", "null"], format: "date-time" },
          expiresAt: { type: ["string", "null"], format: "date-time" },
          areas: { type: "array", items: { type: "string" } },
          web: { type: ["string", "null"], format: "uri" },
        },
      },
      WeatherComponentStatus: {
        type: "object",
        description: "Provider-neutral availability, coverage, freshness, and provenance for one weather component.",
        required: ["provider", "product", "attribution", "availability", "coverage", "emptyResultIsAuthoritative", "fetchedAt", "stale"],
        properties: {
          provider: { type: "string", enum: ["fmi", "open-meteo"] },
          product: { type: "string", description: "Provider product, endpoint, or dataset identifier." },
          attribution: { type: "string" },
          availability: { type: "string", enum: ["available", "unavailable", "not-applicable"] },
          coverage: { type: "string", enum: ["covered", "outside-coverage", "unknown"] },
          emptyResultIsAuthoritative: { type: "boolean", description: "True only when an empty value from this component authoritatively means none exists for the location and time." },
          fetchedAt: { type: "string", format: "date-time" },
          stale: { type: "boolean" },
        },
      },
      LocationSuggestion: {
        type: "object",
        required: ["id", "name", "label", "latitude", "longitude", "timezone", "countryCode", "country", "region", "source", "confidence"],
        properties: {
          id: { type: "string" }, name: { type: "string" }, label: { type: "string" },
          latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 },
          timezone: { type: "string", description: "IANA timezone supplied by the place database." },
          countryCode: { type: ["string", "null"] }, country: { type: ["string", "null"] }, region: { type: ["string", "null"] },
          source: { const: "open-meteo-geocoding" }, confidence: { enum: ["high", "medium"] },
        },
      },
      CoordinateDefaults: {
        type: "object",
        required: ["timezone", "source"],
        properties: {
          timezone: { type: "string", description: "IANA timezone resolved for the supplied coordinates." },
          source: { const: "open-meteo-coordinate" },
        },
      },
      WeatherComponentStatuses: {
        type: "object",
        required: ["observation", "forecast", "short-range", "warnings"],
        properties: {
          observation: { $ref: "#/components/schemas/WeatherComponentStatus" },
          forecast: { $ref: "#/components/schemas/WeatherComponentStatus" },
          "short-range": { $ref: "#/components/schemas/WeatherComponentStatus" },
          warnings: { $ref: "#/components/schemas/WeatherComponentStatus" },
        },
      },
      HouseWeather: {
        type: "object",
        description: "House-scoped observation, point forecast, and official-warning context. Inspect provenance, stale, componentStatus, and unavailable before decisions.",
        required: ["houseId", "location", "provider", "attribution", "fetchedAt", "forecastIssuedAt", "stale", "current", "observationStation", "forecast", "warnings", "unavailable"],
        properties: {
          houseId: { type: "string" },
          location: { $ref: "#/components/schemas/HouseLocation" },
          provider: { type: "string", enum: ["fmi", "open-meteo"] },
          attribution: { type: "string", description: "Required provider attribution; preserve it in displays and downstream exports." },
          fetchedAt: { type: "string", format: "date-time", description: "Time the upstream fetch represented by this object began." },
          forecastIssuedAt: { type: ["string", "null"], format: "date-time", description: "FMI result time for the edited forecast, when available." },
          stale: { type: "boolean", description: "True when an upstream refresh failed and the service returned its previous in-memory result." },
          current: { oneOf: [{ $ref: "#/components/schemas/OutdoorConditions" }, { type: "null" }] },
          observationStation: { oneOf: [{ $ref: "#/components/schemas/WeatherStation" }, { type: "null" }] },
          forecast: { type: "array", items: { $ref: "#/components/schemas/OutdoorConditions" } },
          warnings: { type: "array", items: { $ref: "#/components/schemas/WeatherWarning" } },
          unavailable: { type: "array", uniqueItems: true, items: { enum: ["observation", "forecast", "short-range", "warnings"] }, description: "Legacy compatibility field listing upstream components that failed, returned no usable values, or do not cover this location. Prefer componentStatus when present." },
          componentStatus: { $ref: "#/components/schemas/WeatherComponentStatuses" },
        },
      },
      WeatherUpdateEvent: {
        type: "object",
        description: "Provider-neutral snapshot accepted by the weather event broker after house/location fencing and durable projection. Downstream transports may deliver more than once, so consumers should deduplicate by id.",
        required: ["id", "type", "houseId", "publishedAt", "trigger", "weather"],
        properties: {
          id: { type: "string", pattern: "^weather-[a-f0-9]{64}$" },
          type: { const: "weather.snapshot" },
          houseId: { type: "string" },
          publishedAt: { type: "string", format: "date-time" },
          trigger: { enum: ["scheduled-refresh", "on-demand"] },
          weather: { $ref: "#/components/schemas/HouseWeather" },
        },
      },
      ThermalModelV1: {
        type: "object",
        description: "Effective first-order lumped model. Its fitted parameters are empirical and must not be interpreted as wall U-values, leakage, or material properties.",
        required: ["method", "version", "scope", "trainedFrom", "trainedTo", "parameters", "applicability", "sensitivity"],
        properties: {
          method: { const: "first-order-lumped-v1" },
          version: { const: "1.0.0" },
          scope: { type: "object", required: ["houseId", "sensorIds"], properties: { houseId: { type: "string" }, sensorIds: { type: "array", items: { type: "string" } } } },
          trainedFrom: { type: "string", format: "date-time" },
          trainedTo: { type: "string", format: "date-time" },
          parameters: { type: "object", required: ["timeConstantHours", "effectiveEquilibriumLiftC"], properties: { timeConstantHours: { type: "number" }, effectiveEquilibriumLiftC: { type: "number" } } },
          applicability: { type: "object", additionalProperties: { type: "number" } },
          sensitivity: { type: "object", additionalProperties: { type: "number" } },
        },
      },
      ThermalSimulationPoint: {
        type: "object",
        required: ["timestamp", "phase", "outdoorTemperatureC", "observedTemperatureC", "simulatedTemperatureC", "residualC", "lowC", "highC"],
        properties: {
          timestamp: { type: "string", format: "date-time" },
          phase: { enum: ["fit", "scenario"] },
          outdoorTemperatureC: { type: "number" },
          observedTemperatureC: { type: ["number", "null"] },
          simulatedTemperatureC: { type: "number" },
          residualC: { type: ["number", "null"], description: "Observed minus simulated temperature." },
          lowC: { type: "number", description: "Lower empirical model band; not a formal confidence interval." },
          highC: { type: "number", description: "Upper empirical model band; not a formal confidence interval." },
        },
      },
      ThermalSimulationResult: {
        type: "object",
        required: ["generatedAt", "systemVersion", "houseId", "sensorId", "roomLabel", "from", "to", "horizonHours", "scenarioOutdoorTemperatureC", "scenarioAnchorTimestamp", "calibration", "points"],
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          systemVersion: { type: "string" },
          houseId: { type: "string" },
          sensorId: { type: "string" },
          roomLabel: { type: "string" },
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          horizonHours: { type: "integer" },
          scenarioOutdoorTemperatureC: { type: ["number", "null"] },
          scenarioAnchorTimestamp: { type: ["string", "null"], format: "date-time" },
          calibration: {
            type: "object",
            required: ["status", "model", "quality", "warnings", "assumptions"],
            properties: {
              status: { enum: ["ready", "provisional", "insufficient-data"] },
              model: { oneOf: [{ $ref: "#/components/schemas/ThermalModelV1" }, { type: "null" }] },
              quality: { type: "object", additionalProperties: true },
              warnings: { type: "array", items: { type: "string" } },
              assumptions: { type: "array", items: { type: "string" } },
            },
          },
          points: { type: "array", items: { $ref: "#/components/schemas/ThermalSimulationPoint" } },
        },
      },
      ThermalIsolationMetrics: {
        type: "object",
        additionalProperties: false,
        required: ["effectiveTimeConstantHours", "halfResponseHours", "retainedAfter24HoursPct", "outdoorResponseAfter24HoursPct", "modelSkillPct", "typicalTemperatureSpreadC", "p90TemperatureSpreadC"],
        properties: {
          effectiveTimeConstantHours: { type: ["number", "null"] },
          halfResponseHours: { type: ["number", "null"] },
          retainedAfter24HoursPct: { type: ["number", "null"], minimum: 0, maximum: 100 },
          outdoorResponseAfter24HoursPct: { type: ["number", "null"], minimum: 0, maximum: 100 },
          modelSkillPct: { type: ["number", "null"], minimum: -100, maximum: 100 },
          typicalTemperatureSpreadC: { type: ["number", "null"], minimum: 0 },
          p90TemperatureSpreadC: { type: ["number", "null"], minimum: 0 },
        },
      },
      ThermalIsolationEntry: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "calibrationStatus", "confidence", "rating", "score", "rank", "comparedWithHousePoints", "childCoveragePct", "sensorCount", "eligibleSensorCount", "metrics", "quality", "warnings"],
        properties: {
          scope: { type: "object", additionalProperties: false, required: ["type", "id", "label", "sensorIds"], properties: {
            type: { enum: ["house", "floor", "room", "sensor"] }, id: { type: "string" }, label: { type: "string" },
            parentId: { type: "string" }, floorId: { type: "string" }, sensorIds: { type: "array", items: { type: "string" } },
          } },
          calibrationStatus: { enum: ["ready", "provisional", "insufficient-data"] },
          confidence: { enum: ["high", "medium", "low", "unavailable"] },
          rating: { enum: ["low", "moderate", "high", "very-high", null] },
          score: { type: ["number", "null"], minimum: 0, maximum: 100 },
          rank: { type: ["integer", "null"], minimum: 1 },
          comparedWithHousePoints: { type: ["number", "null"] },
          childCoveragePct: { type: "number", minimum: 0, maximum: 100 },
          sensorCount: { type: "integer", minimum: 0 },
          eligibleSensorCount: { type: "integer", minimum: 0 },
          metrics: { $ref: "#/components/schemas/ThermalIsolationMetrics" },
          quality: { type: "object", additionalProperties: false, required: ["durationHours", "outdoorRangeC", "validationMaeC", "persistenceMaeC", "scoreLow", "scoreHigh"], properties: {
            durationHours: { type: "number", minimum: 0 }, outdoorRangeC: { type: "number", minimum: 0 },
            validationMaeC: { type: ["number", "null"], minimum: 0 }, persistenceMaeC: { type: ["number", "null"], minimum: 0 },
            scoreLow: { type: ["number", "null"], minimum: 0, maximum: 100 }, scoreHigh: { type: ["number", "null"], minimum: 0, maximum: 100 },
          } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      ThermalIsolationResult: {
        type: "object",
        additionalProperties: false,
        required: ["generatedAt", "systemVersion", "houseId", "from", "to", "entries", "insights", "methodology"],
        properties: {
          generatedAt: { type: "string", format: "date-time" }, systemVersion: { type: "string" }, houseId: { type: "string" },
          from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
          entries: { type: "array", items: { $ref: "#/components/schemas/ThermalIsolationEntry" } },
          insights: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "scopeIds", "value", "unit"], properties: {
            code: { enum: ["LOWEST_BUFFERING_ROOM", "FLOOR_CONTRAST", "ROOM_SENSOR_SPREAD", "LIMITED_EVIDENCE"] },
            scopeIds: { type: "array", items: { type: "string" } }, value: { type: "number" }, unit: { enum: ["score-points", "celsius", "percent"] },
          } } },
          methodology: { type: "object", additionalProperties: false, required: ["scoreMethod", "aggregationMethod", "interpretation", "limitations"], properties: {
            scoreMethod: { const: "modeled-24h-retention-v1" }, aggregationMethod: { const: "median-child-score-v1" },
            interpretation: { type: "string" }, limitations: { type: "array", items: { type: "string" } },
          } },
        },
      },
      Sensor: {
        type: "object",
        required: ["id", "houseId", "floorId", "name", "roomId", "room", "model", "x", "y", "z", "tags", "enabled"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, floorId: { type: "string" },
          name: { type: "string" },
          roomId: { type: ["string", "null"], description: "Stable room relationship on floorId. Null means the legacy display label is not linked to floor-plan geometry." },
          room: { type: "string", description: "Backwards-compatible display label, synchronized from the linked room name when roomId is non-null." },
          model: { type: "string" },
          x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
          temperatureEntityId: { type: "string" }, humidityEntityId: { type: "string" }, batteryEntityId: { type: "string" },
          tpLinkDeviceId: { type: "string" }, tpLinkConnectionId: { type: "string" }, measurementEntityIds: { type: "object", additionalProperties: { type: "string" } },
          tags: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" },
        },
      },
      SensorSnapshot: {
        allOf: [
          { $ref: "#/components/schemas/Sensor" },
          { type: "object", required: ["reading"], properties: { reading: { oneOf: [{ $ref: "#/components/schemas/Reading" }, { type: "null" }] } } },
        ],
      },
      SensorInput: {
        type: "object",
        required: ["houseId", "floorId", "name", "room", "model", "x", "y", "z"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, floorId: { type: "string" },
          name: { type: "string" },
          roomId: { type: ["string", "null"], description: "Optional stable room id. Omit for legacy exact-name resolution; use null to retain an unlinked room label." },
          room: { type: "string" }, model: { type: "string" },
          x: { type: "number", minimum: 0, description: "Floor-local position; must be less than or equal to the selected floor width." },
          y: { type: "number", minimum: 0, description: "Floor-local position; must be less than or equal to the selected floor height." },
          z: { type: "number", description: "Unbounded absolute sensor height in metres using the same vertical origin as Floor.elevation; it may be below or above the floor plane." },
          tags: { type: "array", items: { type: "string" } }, enabled: { type: "boolean", default: true },
          temperatureEntityId: { type: "string" }, humidityEntityId: { type: "string" }, batteryEntityId: { type: "string" },
          tpLinkDeviceId: { oneOf: [{ type: "string" }, { type: "null" }], description: "Stable direct-hub child-device identifier. It is unique within its house-scoped connection." },
          tpLinkConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], description: "House-scoped TP-Link connection that owns the device." },
          measurementEntityIds: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      SensorPatch: {
        type: "object",
        description: "Partial sensor update. A house/floor move and its coordinates are validated together before one atomic update.",
        properties: {
          houseId: { type: "string" }, floorId: { type: "string" },
          name: { type: "string" },
          roomId: { type: ["string", "null"], description: "Set a stable room relationship or clear it with null. When omitted, a changed legacy room label is resolved by exact name when possible." },
          room: { type: "string" }, model: { type: "string" },
          x: { type: "number", minimum: 0, description: "Floor-local position; must be less than or equal to the resulting floor width." },
          y: { type: "number", minimum: 0, description: "Floor-local position; must be less than or equal to the resulting floor height." },
          z: { type: "number", description: "Unbounded absolute height in metres; negative and above-floor values are valid." },
          tags: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" },
          temperatureEntityId: { type: "string" }, humidityEntityId: { type: "string" }, batteryEntityId: { type: "string" },
          tpLinkDeviceId: { oneOf: [{ type: "string" }, { type: "null" }], description: "Assign a direct TP-Link child device, or set null to clear the binding." },
          tpLinkConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], description: "Assign the owning house-scoped TP-Link connection, or set null to clear it." },
          measurementEntityIds: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      AlertRuleInput: {
        type: "object",
        required: ["name", "metric", "operator", "threshold", "durationSeconds", "severity"],
        properties: {
          id: { type: "string" }, name: { type: "string" }, sensorId: { type: ["string", "null"], default: null },
          metric: { type: "string" }, operator: { enum: ["gt", "gte", "lt", "lte"] }, threshold: { type: "number" },
          durationSeconds: { type: "integer", minimum: 1, maximum: 31536000 },
          severity: { enum: ["info", "warning", "critical"] }, enabled: { type: "boolean", default: true },
          webhookEnabled: { type: "boolean", default: false },
          telegramEnabled: { type: "boolean", default: false },
        },
      },
      AlertRule: {
        type: "object",
        required: ["id", "name", "sensorId", "metric", "operator", "threshold", "durationSeconds", "severity", "enabled", "webhookEnabled", "telegramEnabled"],
        properties: {
          id: { type: "string" }, name: { type: "string" }, sensorId: { type: ["string", "null"] }, metric: { type: "string" },
          operator: { enum: ["gt", "gte", "lt", "lte"] }, threshold: { type: "number" }, durationSeconds: { type: "integer", minimum: 1, maximum: 31536000 },
          severity: { enum: ["info", "warning", "critical"] }, enabled: { type: "boolean" }, webhookEnabled: { type: "boolean" }, telegramEnabled: { type: "boolean" },
        },
      },
      AlertRulePatch: {
        type: "object",
        properties: {
          name: { type: "string" }, sensorId: { type: ["string", "null"] }, metric: { type: "string" },
          operator: { enum: ["gt", "gte", "lt", "lte"] }, threshold: { type: "number" },
          durationSeconds: { type: "integer", minimum: 1, maximum: 31536000 },
          severity: { enum: ["info", "warning", "critical"] }, enabled: { type: "boolean" }, webhookEnabled: { type: "boolean" }, telegramEnabled: { type: "boolean" },
        },
      },
      AlertEvent: {
        type: "object",
        required: ["id", "ruleId", "sensorId", "metric", "value", "threshold", "severity", "startedAt", "acknowledgedAt", "resolvedAt"],
        properties: {
          id: { type: "string" }, ruleId: { type: "string" }, sensorId: { type: "string" }, metric: { type: "string" },
          value: { type: "number" }, threshold: { type: "number" }, severity: { enum: ["info", "warning", "critical"] },
          startedAt: { type: "string", format: "date-time" }, acknowledgedAt: { type: ["string", "null"], format: "date-time" },
          resolvedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      ObservationInput: {
        type: "object",
        required: ["houseId", "floorId", "kind", "severity", "note"],
        additionalProperties: false,
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, floorId: { type: "string" }, sensorId: { type: ["string", "null"] },
          kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
          severity: { enum: ["info", "warning", "critical"] }, note: { type: "string" },
          x: { type: ["number", "null"] }, y: { type: ["number", "null"] },
          occurredAt: { type: "string", description: "Observed time. Use RFC3339 for exact/approximate or YYYY-MM-DD for date-only; omit for date-range/unknown." },
          timePrecision: { enum: ["exact", "approximate", "date-only", "date-range", "unknown"], default: "exact" },
          validFrom: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          validTo: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          source: { enum: ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"], default: "unknown" },
          sourceDetail: { type: ["string", "null"] },
          confidence: { enum: ["confirmed", "probable", "uncertain", "awaiting-inspection"], default: "uncertain" },
        },
      },
      ObservationPatch: {
        type: "object",
        required: ["baseRevision"],
        minProperties: 2,
        additionalProperties: false,
        properties: {
          baseRevision: { type: "integer", minimum: 1 },
          floorId: { type: "string" }, sensorId: { type: ["string", "null"] },
          kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
          severity: { enum: ["info", "warning", "critical"] }, note: { type: "string" },
          x: { type: ["number", "null"] }, y: { type: ["number", "null"] }, occurredAt: { type: "string" },
          timePrecision: { enum: ["exact", "approximate", "date-only", "date-range", "unknown"] },
          validFrom: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          validTo: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          source: { enum: ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"] },
          sourceDetail: { type: ["string", "null"] },
          confidence: { enum: ["confirmed", "probable", "uncertain", "awaiting-inspection"] },
          status: { enum: ["open", "resolved"] },
          resolutionNote: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
          },
        },
      },
      ManualObservation: {
        type: "object",
        required: ["id", "houseId", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt", "createdAt", "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote", "resolvedAt", "revision", "updatedAt"],
        additionalProperties: false,
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, floorId: { type: "string" }, sensorId: { type: ["string", "null"] },
          kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
          severity: { enum: ["info", "warning", "critical"] }, note: { type: "string" },
          x: { type: ["number", "null"] }, y: { type: ["number", "null"] },
          occurredAt: { type: "string", description: "Observed time; empty only when timePrecision is unknown." },
          createdAt: { type: "string", format: "date-time", readOnly: true, description: "Immutable server-recorded time." },
          timePrecision: { enum: ["exact", "approximate", "date-only", "date-range", "unknown"] },
          validFrom: { type: ["string", "null"] }, validTo: { type: ["string", "null"] },
          source: { enum: ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"] },
          sourceDetail: { type: ["string", "null"] },
          confidence: { enum: ["confirmed", "probable", "uncertain", "awaiting-inspection"] },
          status: { enum: ["open", "resolved"], readOnly: true, description: "Lifecycle state. New observations are always open." },
          resolutionNote: {
            type: ["string", "null"],
            maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
            readOnly: true,
            description: "Required human-readable outcome while resolved.",
          },
          resolvedAt: { type: ["string", "null"], format: "date-time", readOnly: true, description: "Server-recorded resolution time; cleared on reopen." },
          revision: { type: "integer", minimum: 1, readOnly: true },
          updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      ObservationRevision: {
        type: "object",
        required: ["observationId", "revision", "changedAt", "actor", "changedFields", "snapshot"],
        additionalProperties: false,
        properties: {
          observationId: { type: "string" }, revision: { type: "integer", minimum: 1 },
          changedAt: { type: "string", format: "date-time" },
          actor: { enum: ["local-rest", "local-mcp", "local-migration", "workspace-user", "system-service"] },
          actorId: { type: ["string", "null"] }, actorLabel: { type: ["string", "null"] },
          changedFields: { type: "array", uniqueItems: true, items: { enum: [
            "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt", "timePrecision",
            "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote", "resolvedAt",
          ] } },
          snapshot: { $ref: "#/components/schemas/ManualObservation" },
        },
      },
      MaintenanceTaskInput: {
        type: "object",
        required: ["title", "basis"],
        anyOf: [
          { required: ["propertyId"] },
          { required: ["houseId"], properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } } },
        ],
        additionalProperties: false,
        description: "Create planned maintenance. Supply propertyId for property-only work, or a houseId from which propertyId can be derived. Floors and observation evidence require a house. Lifecycle timestamps and completion fields are server-owned.",
        properties: {
          id: { type: "string" },
          propertyId: { type: "string", minLength: 1, maxLength: 200 },
          houseId: { type: ["string", "null"], maxLength: 200 },
          floorId: { type: ["string", "null"], maxLength: 200 },
          areaId: { type: ["string", "null"], maxLength: 200 },
          equipmentId: { type: ["string", "null"], maxLength: 200 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 },
          basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
          basisDetail: { type: ["string", "null"], maxLength: 5_000 },
          priority: { enum: ["low", "normal", "high", "urgent"], default: "normal" },
          plannedFor: { type: ["string", "null"], format: "date" },
          dueBy: { type: ["string", "null"], format: "date", description: "Must be absent for predictive tasks." },
          observationIds: { type: "array", maxItems: 100, default: [], items: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
      MaintenanceTaskPatch: {
        type: "object",
        required: ["baseRevision"],
        minProperties: 2,
        additionalProperties: false,
        description: "Optimistic maintenance edit. Completing requires completionNote; verifying a completed task requires verificationNote. Completion and verification timestamps are assigned by the server.",
        properties: {
          baseRevision: { type: "integer", minimum: 1 },
          houseId: { type: ["string", "null"], maxLength: 200, description: "Reassign within the immutable property, or null for property-only work. Clear floorId and observationIds when removing the house." },
          floorId: { type: ["string", "null"], maxLength: 200 },
          areaId: { type: ["string", "null"], maxLength: 200 },
          equipmentId: { type: ["string", "null"], maxLength: 200 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 },
          basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
          basisDetail: { type: ["string", "null"], maxLength: 5_000 },
          priority: { enum: ["low", "normal", "high", "urgent"] },
          plannedFor: { type: ["string", "null"], format: "date" },
          dueBy: { type: ["string", "null"], format: "date" },
          observationIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } },
          status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
          completionNote: { type: ["string", "null"], maxLength: 5_000 },
          verificationNote: { type: ["string", "null"], maxLength: 5_000 },
        },
      },
      MaintenanceTask: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority",
          "plannedFor", "dueBy", "observationIds", "status", "completionNote", "completedAt",
          "verificationNote", "verifiedAt", "revision", "createdAt", "updatedAt",
        ],
        properties: {
          id: { type: "string" },
          propertyId: { type: "string" },
          houseId: { type: ["string", "null"] },
          floorId: { type: ["string", "null"] },
          areaId: { type: ["string", "null"] },
          equipmentId: { type: ["string", "null"] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 },
          basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
          basisDetail: { type: ["string", "null"], maxLength: 5_000 },
          priority: { enum: ["low", "normal", "high", "urgent"] },
          plannedFor: { type: ["string", "null"], format: "date" },
          dueBy: { type: ["string", "null"], format: "date" },
          observationIds: { type: "array", uniqueItems: true, maxItems: 100, items: { type: "string", maxLength: 200 } },
          status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
          completionNote: { type: ["string", "null"], maxLength: 5_000 },
          completedAt: { type: ["string", "null"], format: "date-time", readOnly: true },
          verificationNote: { type: ["string", "null"], maxLength: 5_000 },
          verifiedAt: { type: ["string", "null"], format: "date-time", readOnly: true },
          revision: { type: "integer", minimum: 1, readOnly: true },
          createdAt: { type: "string", format: "date-time", readOnly: true },
          updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      MaintenanceTaskRevision: {
        type: "object",
        additionalProperties: false,
        required: ["maintenanceTaskId", "revision", "changedAt", "actor", "changedFields", "snapshot"],
        properties: {
          maintenanceTaskId: { type: "string" },
          revision: { type: "integer", minimum: 1 },
          changedAt: { type: "string", format: "date-time" },
          actor: { enum: ["local-rest", "local-mcp", "local-migration", "workspace-user", "system-service"] },
          actorId: { type: ["string", "null"] },
          actorLabel: { type: ["string", "null"] },
          changedFields: { type: "array", uniqueItems: true, items: { enum: [
            "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor", "dueBy",
            "observationIds", "status", "completionNote", "completedAt", "verificationNote", "verifiedAt",
          ] } },
          snapshot: { $ref: "#/components/schemas/MaintenanceTask" },
        },
      },
      StaticParameterInput: {
        type: "object",
        required: ["houseId", "scopeType", "scopeId", "key", "value", "label"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" },
          scopeType: { enum: ["house", "floor", "room", "sensor"] }, scopeId: { type: "string" }, key: { type: "string" },
          value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
          unit: { type: ["string", "null"], default: null }, label: { type: "string" },
        },
      },
      StaticParameter: {
        type: "object",
        required: ["id", "houseId", "scopeType", "scopeId", "key", "value", "unit", "label"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, scopeType: { enum: ["house", "floor", "room", "sensor"] },
          scopeId: { type: "string" }, key: { type: "string" },
          value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }, unit: { type: ["string", "null"] }, label: { type: "string" },
        },
      },
      AssetUploadInput: {
        type: "object",
        required: ["houseId", "name", "mimeType", "kind", "data"],
        properties: {
          houseId: { type: "string" }, name: { type: "string" },
          mimeType: { enum: ["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"] },
          kind: { enum: ["floor-plan", "model-3d", "other"] },
          data: { type: "string", description: "Base64 bytes, optionally prefixed by a data URL; decoded content is limited to 10 MiB." },
        },
      },
      Asset: {
        type: "object",
        required: ["id", "houseId", "name", "mimeType", "kind", "size", "createdAt"],
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, name: { type: "string" }, mimeType: { type: "string" },
          kind: { enum: ["floor-plan", "model-3d", "other"] }, size: { type: "integer", minimum: 0 }, createdAt: { type: "string", format: "date-time" },
        },
      },
      TelegramDiscoveryInput: {
        type: "object", additionalProperties: false, required: ["botToken"],
        properties: { botToken: { type: "string", minLength: 20, maxLength: 256, writeOnly: true, description: "BotFather token used for this one discovery request; it is not persisted." } },
      },
      TelegramConfigInput: {
        type: "object", additionalProperties: false, required: ["botToken", "chatId"],
        properties: {
          botToken: { type: "string", minLength: 20, maxLength: 256, writeOnly: true },
          chatId: { type: "string", pattern: "^-?[0-9]+$", description: "Immutable Telegram private-chat identifier serialized as text." },
        },
      },
      TelegramChatCandidate: {
        type: "object", additionalProperties: false, required: ["id", "label", "username", "type"],
        properties: { id: { type: "string", pattern: "^-?[0-9]+$" }, label: { type: "string" }, username: { type: ["string", "null"] }, type: { const: "private" } },
      },
      TelegramDiscoveryResult: {
        type: "object", additionalProperties: false, required: ["botUsername", "chats", "message"],
        properties: { botUsername: { type: "string" }, chats: { type: "array", items: { $ref: "#/components/schemas/TelegramChatCandidate" } }, message: { type: "string" } },
      },
      IntegrationConfigurationResult: {
        type: "object", additionalProperties: false, required: ["ok", "configured", "integration"],
        properties: { ok: { const: true }, configured: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } },
      },
      TelegramSetup: {
        type: "object", additionalProperties: true,
        description: "Server-authored setup metadata. The web wizard presents BotFather creation, /start pairing, private-chat selection, local secret storage, testing, and per-rule activation in order.",
        required: ["available", "configured", "privateChatsOnly", "steps", "privacy", "limitations"],
        properties: { available: { type: "boolean" }, configured: { type: "boolean" }, privateChatsOnly: { const: true }, steps: { type: "array", items: { type: "string" } }, privacy: { type: "array", items: { type: "string" } }, limitations: { type: "array", items: { type: "string" } } },
      },
      AppleNotesGrantInput: {
        type: "object", additionalProperties: false, required: ["deviceLabel", "houseId"],
        properties: { deviceLabel: { type: "string", minLength: 1, maxLength: 100 }, houseId: { type: "string", minLength: 1, maxLength: 200 } },
      },
      AppleNotesGrantSummary: {
        type: "object", additionalProperties: false, required: ["id", "deviceLabel", "houseId", "createdAt"],
        properties: { id: { type: "string" }, deviceLabel: { type: "string" }, houseId: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
      },
      AppleNotesGrantCreated: {
        type: "object", additionalProperties: false, required: ["id", "deviceLabel", "houseId", "createdAt", "token", "integration"],
        properties: {
          id: { type: "string" }, deviceLabel: { type: "string" }, houseId: { type: "string" }, createdAt: { type: "string", format: "date-time" },
          token: { type: "string", minLength: 32, readOnly: true, description: "Returned exactly once at grant creation. Store only inside the iOS Shortcut." },
          integration: { $ref: "#/components/schemas/IntegrationStatus" },
        },
      },
      AppleNotesSetup: {
        type: "object", additionalProperties: true,
        description: "Server-authored recipes for a generated Notes snapshot and a Share Sheet maintenance capture Shortcut. Apple Notes has no supported general server sync API, so the system database remains canonical.",
        required: ["available", "snapshotPath", "capturePath", "steps", "limitations"],
        properties: {
          available: { type: "boolean" }, snapshotPath: { type: "string" }, capturePath: { type: "string" },
          steps: { type: "array", items: { type: "string" } }, limitations: { type: "array", items: { type: "string" } },
        },
      },
      AppleNotesSnapshot: {
        type: "object", additionalProperties: false, required: ["schema", "generatedAt", "houseId", "title", "text", "maintenanceTasks"],
        properties: {
          schema: { const: "stuga.apple-notes-snapshot/v1" }, generatedAt: { type: "string", format: "date-time" }, houseId: { type: "string" },
          title: { type: "string" }, text: { type: "string" }, maintenanceTasks: { type: "array", items: { $ref: "#/components/schemas/MaintenanceTask" } },
        },
      },
      AppleNotesMaintenanceCaptureInput: {
        type: "object", additionalProperties: false,
        required: ["schema", "operationId", "houseId", "title", "basis"],
        properties: {
          schema: { const: "stuga.apple-notes-command/v1" }, operationId: { type: "string", format: "uuid" }, id: { type: "string" },
          houseId: { type: "string" }, floorId: { type: ["string", "null"], maxLength: 200 }, title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 }, basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
          basisDetail: { type: ["string", "null"], maxLength: 5_000 }, priority: { enum: ["low", "normal", "high", "urgent"], default: "normal" },
          plannedFor: { type: ["string", "null"], format: "date" }, dueBy: { type: ["string", "null"], format: "date" },
          observationIds: { type: "array", maxItems: 100, default: [], items: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
      AppleNotesMaintenanceCaptureResult: {
        type: "object", additionalProperties: false, required: ["ok", "deduplicated", "task", "receipt"],
        properties: { ok: { const: true }, deduplicated: { type: "boolean" }, task: { $ref: "#/components/schemas/MaintenanceTask" }, receipt: { type: "string" } },
      },
      HomeAssistantConfigInput: {
        type: "object",
        required: ["url", "token"],
        properties: {
          houseId: { type: "string", minLength: 1, description: "House which owns this Home Assistant connection." },
          url: { type: "string", format: "uri", maxLength: 2048, description: "HTTP(S) Home Assistant address without embedded credentials." },
          token: { type: "string", minLength: 1, maxLength: 8192, writeOnly: true },
        },
      },
      TpLinkConfigInput: {
        type: "object",
        required: ["host", "username", "password"],
        properties: {
          houseId: { type: "string", minLength: 1, description: "House which owns this TP-Link connection." },
          connectionId: { type: "string", minLength: 1, description: "Existing connection to update; omitted when adding another hub or socket." },
          host: { type: "string", minLength: 1, maxLength: 253 },
          username: { type: "string", minLength: 1, maxLength: 320, writeOnly: true },
          password: { type: "string", minLength: 1, maxLength: 4096, writeOnly: true },
        },
      },
      TapoHistoryExportJob: {
        type: "object", additionalProperties: false,
        required: ["id", "canary", "provider", "sensorId", "deviceId", "deviceName", "timeZone", "metric", "expectedRecipient", "from", "to", "intervalMinutes", "status", "attemptCount", "maxAttempts", "availableAt", "leaseOwner", "leaseExpiresAt", "heartbeatAt", "submittedAt", "mailboxMessageId", "sourceArtifactSha256", "sourceArtifactBytes", "parserVersion", "sourceSchemaSignature", "stagedSampleCount", "consumedSampleCount", "lastError", "attentionReason", "detail", "createdAt", "updatedAt", "completedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, canary: { type: "boolean", description: "True for an isolated acceptance job whose staged rows are never reused for automatic gap recovery." }, provider: { enum: ["appium", "private-cloud"] },
          sensorId: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" }, timeZone: { type: "string", description: "Immutable IANA timezone snapshot used for app date selection and CSV parsing." }, metric: { type: "string" },
          expectedRecipient: { type: ["string", "null"], format: "email" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
          intervalMinutes: { type: "integer", minimum: 1 }, status: { enum: ["queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"] },
          attemptCount: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1 }, availableAt: { type: "string", format: "date-time" },
          leaseOwner: { type: ["string", "null"] }, leaseExpiresAt: { type: ["string", "null"], format: "date-time" }, heartbeatAt: { type: ["string", "null"], format: "date-time" }, submittedAt: { type: ["string", "null"], format: "date-time", description: "Server time when the current export attempt was confirmed submitted." },
          mailboxMessageId: { type: ["string", "null"] },
          sourceArtifactSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$", description: "SHA-256 of the exact source CSV bytes, retained for audit without exposing the mailbox capability." },
          sourceArtifactBytes: { type: ["integer", "null"], minimum: 0 },
          parserVersion: { type: ["string", "null"] },
          sourceSchemaSignature: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$", description: "Canonical parsed CSV structure signature fenced by the accepted canary." },
          stagedSampleCount: { type: "integer", minimum: 0 }, consumedSampleCount: { type: "integer", minimum: 0 },
          lastError: { type: ["string", "null"] }, attentionReason: { type: ["string", "null"] }, detail: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      TapoHistoryWorkerLeaseInput: {
        type: "object", additionalProperties: false, required: ["workerId", "leaseToken"],
        properties: { workerId: { type: "string", minLength: 1, maxLength: 200 }, leaseToken: { type: "string", minLength: 1, maxLength: 500, writeOnly: true } },
      },
      TapoHistoryWorkerJob: {
        type: "object", additionalProperties: false,
        required: ["id", "sensorId", "deviceId", "deviceName", "metric", "from", "to", "timeZone", "intervalMinutes", "expectedRecipient", "status", "attemptCount", "leaseExpiresAt"],
        properties: {
          id: { type: "string", format: "uuid" }, sensorId: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" },
          metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
          timeZone: { type: "string", description: "Snapshotted IANA timezone used to turn the UTC gap into app-local calendar dates." },
          intervalMinutes: { type: "integer", minimum: 1 }, expectedRecipient: { type: ["string", "null"], format: "email", writeOnly: true },
          status: { enum: ["queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"] },
          attemptCount: { type: "integer", minimum: 0 }, leaseExpiresAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      TapoHistoryWorkerStatusInput: {
        type: "object", additionalProperties: false, required: ["workerId", "leaseToken", "status"],
        properties: {
          workerId: { type: "string", minLength: 1, maxLength: 200 }, leaseToken: { type: "string", minLength: 1, maxLength: 500, writeOnly: true },
          status: { enum: ["running", "waiting-email", "needs-attention", "failed"] }, detail: { type: ["string", "null"], maxLength: 1000 },
        },
      },
      TapoHistoryWorkerClaim: {
        type: "object", additionalProperties: false, required: ["job", "leaseToken", "serverNow"],
        properties: {
          job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" },
          leaseToken: { type: "string", writeOnly: true },
          serverNow: { type: "string", format: "date-time", description: "API clock sample used to derive a monotonic local lease TTL." },
        },
      },
      TapoHistoryWorkerLease: {
        type: "object", additionalProperties: false, required: ["job", "serverNow"],
        properties: {
          job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" },
          serverNow: { type: "string", format: "date-time", description: "API clock sample used to derive a monotonic local lease TTL." },
        },
      },
      PropertyElectricityConfigInput: {
        type: "object",
        required: ["provider", "endpointUrl", "enabled", "marginCentsPerKwh", "contractType"],
        properties: {
          provider: { enum: ["porssisahko", "custom"] }, endpointUrl: { type: "string", format: "uri" }, enabled: { type: "boolean" },
          marginCentsPerKwh: { type: "number" }, contractType: { enum: ["spot", "fixed", "other"] },
          contractName: { type: ["string", "null"] }, retailer: { type: ["string", "null"] }, monthlyFeeEur: { type: ["number", "null"], minimum: 0 },
        },
      },
      HomeElectricityPricePoint: {
        type: "object", additionalProperties: false,
        required: ["startAt", "endAt", "effectivePriceCentsPerKwh", "effectivePriceEurPerKwh", "fetchedAt"],
        properties: {
          startAt: { type: "string", format: "date-time" }, endAt: { type: "string", format: "date-time" },
          effectivePriceCentsPerKwh: { type: "number" }, effectivePriceEurPerKwh: { type: "number" },
          fetchedAt: { type: "string", format: "date-time" },
        },
      },
      HomeEnergyCost: {
        type: "object", additionalProperties: false,
        required: ["houseId", "sensorId", "from", "to", "consumptionKwh", "pricedConsumptionKwh", "costEur", "priceCoveragePercent", "measurementCoverageFrom", "measurementCoverageUntil", "complete", "calculatedAt"],
        properties: {
          houseId: { type: "string" }, sensorId: { type: "string" },
          from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
          consumptionKwh: { type: ["number", "null"] }, pricedConsumptionKwh: { type: ["number", "null"] },
          costEur: { type: ["number", "null"] }, priceCoveragePercent: { type: "number", minimum: 0, maximum: 100 },
          measurementCoverageFrom: { type: ["string", "null"], format: "date-time" },
          measurementCoverageUntil: { type: ["string", "null"], format: "date-time" },
          complete: { type: "boolean" }, calculatedAt: { type: "string", format: "date-time" },
        },
      },
      IntegrationStatus: {
        type: "object",
        required: ["homeAssistant", "tpLink", "webhook", "telegram", "appleNotes", "mock", "weather"],
        properties: {
          homeAssistant: { type: "object", required: ["configured", "connected", "lastEventAt", "mappedEntities", "error"], properties: { configured: { type: "boolean" }, connected: { type: "boolean" }, lastEventAt: { type: ["string", "null"], format: "date-time" }, mappedEntities: { type: "integer" }, error: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", required: ["houseId", "configured", "connected", "lastEventAt", "mappedEntities", "error"], properties: { houseId: { type: "string" }, configured: { type: "boolean" }, connected: { type: "boolean" }, lastEventAt: { type: ["string", "null"], format: "date-time" }, mappedEntities: { type: "integer" }, error: { type: ["string", "null"] } } } } } },
          tpLink: { type: "object", required: ["configured", "connected", "lastPollAt", "mappedDevices", "discoveredDevices", "hubModel", "error"], properties: { configured: { type: "boolean" }, connected: { type: "boolean" }, lastPollAt: { type: ["string", "null"], format: "date-time" }, mappedDevices: { type: "integer" }, discoveredDevices: { type: "integer" }, hubModel: { enum: ["H100", "H200", null] }, error: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", additionalProperties: true } } } },
          webhook: { type: "object", required: ["configured", "lastDeliveryAt", "error"], properties: { configured: { type: "boolean" }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] }, destinations: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["id", "lastDeliveryAt", "error"], properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } } } } },
          telegram: { type: "object", required: ["available", "configured", "connected", "botUsername", "chatLabel", "lastDeliveryAt", "error"], properties: { available: { type: "boolean" }, configured: { type: "boolean" }, connected: { type: "boolean" }, botUsername: { type: ["string", "null"] }, chatLabel: { type: ["string", "null"] }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } },
          appleNotes: { type: "object", required: ["available", "configured", "grantCount", "lastSyncAt", "error"], properties: { available: { type: "boolean" }, configured: { type: "boolean" }, grantCount: { type: "integer", minimum: 0 }, lastSyncAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } },
          mock: { type: "object", required: ["enabled", "intervalMs", "mode", "activatedAt"], properties: { enabled: { type: "boolean" }, intervalMs: { type: "integer" }, mode: { enum: ["demo", "real"] }, activatedAt: { type: ["string", "null"], format: "date-time" } } },
          weather: { type: "object", required: ["provider", "configuredHouses", "lastSuccessAt", "error"], properties: { policy: { enum: ["automatic", "fmi", "open-meteo"] }, availableProviders: { type: "array", items: { enum: ["fmi", "open-meteo"] } }, provider: { enum: ["fmi", "open-meteo"] }, configuredHouses: { type: "integer" }, lastSuccessAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", additionalProperties: false, required: ["houseId", "configured", "provider", "lastSuccessAt", "error"], properties: { houseId: { type: "string" }, configured: { type: "boolean" }, provider: { enum: ["fmi", "open-meteo"] }, lastSuccessAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } } } } },
        },
      },
      IntegrationDiscoveryResult: {
        type: "object",
        required: ["homeAssistant", "tpLink", "warnings"],
        properties: {
          homeAssistant: { type: "array", items: { type: "object", required: ["name", "url", "host", "port", "version"], properties: { name: { type: "string" }, url: { type: "string", format: "uri" }, host: { type: "string" }, port: { type: "integer" }, version: { type: ["string", "null"] } } } },
          tpLink: { type: "array", items: { type: "object", required: ["host", "model", "alias", "sourceType"], properties: { host: { type: "string" }, model: { type: "string" }, alias: { type: ["string", "null"] }, sourceType: { enum: ["hub", "energy-device"] } } } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      IntegrationTestResult: { type: "object", required: ["ok", "message"], properties: { ok: { type: "boolean" }, connected: { type: "boolean" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } } },
      MockScenarioId: { type: "string", enum: ["normal", "shower", "leak", "cold-front", "heating-failure"] },
      MockScenario: {
        type: "object",
        required: ["id", "label", "description"],
        properties: { id: { $ref: "#/components/schemas/MockScenarioId" }, label: { type: "string" }, description: { type: "string" } },
      },
      ReplayInput: {
        type: "object",
        properties: {
          sensorIds: { type: "array", items: { type: "string" }, description: "Defaults to every configured sensor." },
          from: { type: "string", format: "date-time", description: "Defaults to one hour before to." },
          to: { type: "string", format: "date-time", description: "Defaults to the server time." },
          speed: { type: "number", minimum: 0.1, maximum: 10000, default: 60 },
        },
      },
      EnergyOptimizationReport: {
        type: "object", additionalProperties: false,
        required: ["propertyId", "generatedAt", "priceCoverageFrom", "priceCoverageUntil", "averagePriceCentsPerKwh", "currentPriceCentsPerKwh", "currentPricePercentile", "suggestedWindows", "recentDailyConsumptionKwh", "estimatedDailyCostEur", "baselinePowerWatts", "peakPowerWatts", "insights", "limitations"],
        properties: {
          propertyId: { type: "string" }, generatedAt: { type: "string", format: "date-time" },
          priceCoverageFrom: { type: ["string", "null"], format: "date-time" }, priceCoverageUntil: { type: ["string", "null"], format: "date-time" },
          averagePriceCentsPerKwh: { type: ["number", "null"] }, currentPriceCentsPerKwh: { type: ["number", "null"] }, currentPricePercentile: { type: ["number", "null"] },
          suggestedWindows: { type: "array", items: { type: "object", additionalProperties: false, required: ["startAt", "endAt", "averagePriceCentsPerKwh", "relativeToAveragePercent", "rank"], properties: { startAt: { type: "string", format: "date-time" }, endAt: { type: "string", format: "date-time" }, averagePriceCentsPerKwh: { type: "number" }, relativeToAveragePercent: { type: "number" }, rank: { enum: ["best", "good", "expensive"] } } } },
          recentDailyConsumptionKwh: { type: ["number", "null"] }, estimatedDailyCostEur: { type: ["number", "null"] }, baselinePowerWatts: { type: ["number", "null"] }, peakPowerWatts: { type: ["number", "null"] },
          insights: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "severity", "title", "explanation", "estimatedSavingsEur"], properties: { id: { type: "string" }, severity: { enum: ["info", "opportunity", "warning"] }, title: { type: "string" }, explanation: { type: "string" }, estimatedSavingsEur: { type: ["number", "null"] } } } },
          limitations: { type: "array", items: { type: "string" } },
        },
      },
      NotificationDeliveryStatus: {
        type: "object", additionalProperties: false,
        required: ["id", "subjectKind", "subjectId", "stage", "sequence", "channel", "destinationId", "attempts", "maxAttempts", "availableAt", "createdAt", "deliveredAt", "deadLetteredAt", "abandonedAt", "lastError"],
        properties: {
          id: { type: "string" }, subjectKind: { enum: ["alert", "maintenance", "action-run"] }, subjectId: { type: "string" },
          stage: { enum: ["initial", "escalation", "reminder", "due", "verification"] }, sequence: { type: "integer", minimum: 0 }, channel: { enum: ["webhook", "telegram"] }, destinationId: { type: "string" }, attempts: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1, maximum: 100 },
          availableAt: { type: "string", format: "date-time" }, createdAt: { type: "string", format: "date-time" }, deliveredAt: { type: ["string", "null"], format: "date-time" }, deadLetteredAt: { type: ["string", "null"], format: "date-time" }, abandonedAt: { type: ["string", "null"], format: "date-time" }, lastError: { type: ["string", "null"] },
        },
      },
      ActionPlaybook: {
        type: "object", additionalProperties: false,
        required: ["id", "name", "description", "instructions", "metric", "goal", "minimumImprovement", "targetValue", "waitSeconds", "verificationWindowSeconds", "enabled", "builtIn", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" }, name: { type: "string", maxLength: 160 }, description: { type: "string", maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 500 } }, metric: { type: "string" }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" }, builtIn: { type: "boolean", readOnly: true }, createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
        },
      },
      ActionPlaybookInput: {
        type: "object", additionalProperties: false,
        required: ["name", "description", "instructions", "metric", "goal", "minimumImprovement", "waitSeconds", "verificationWindowSeconds"],
        properties: {
          id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 160 }, description: { type: "string", minLength: 1, maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, metric: { type: "string", minLength: 1 }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" },
        },
      },
      ActionPlaybookPatch: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 160 }, description: { type: "string", minLength: 1, maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, metric: { type: "string", minLength: 1 }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" },
        },
      },
      ActionRun: {
        type: "object", additionalProperties: false,
        required: ["id", "playbookId", "alertEventId", "maintenanceTaskId", "sensorId", "metric", "status", "startedAt", "actionCompletedAt", "verifyAfter", "verificationDeadline", "baselineValue", "baselineTimestamp", "resultValue", "resultTimestamp", "improvement", "sampleCount", "operatorNote", "verificationNote", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" }, playbookId: { type: "string" }, alertEventId: { type: ["string", "null"] }, maintenanceTaskId: { type: ["string", "null"] }, sensorId: { type: "string" }, metric: { type: "string" }, status: { enum: ["active", "waiting", "verified", "not-improved", "cancelled"] },
          startedAt: { type: "string", format: "date-time" }, actionCompletedAt: { type: ["string", "null"], format: "date-time" }, verifyAfter: { type: ["string", "null"], format: "date-time" }, verificationDeadline: { type: ["string", "null"], format: "date-time" }, baselineValue: { type: "number" }, baselineTimestamp: { type: "string", format: "date-time" }, resultValue: { type: ["number", "null"] }, resultTimestamp: { type: ["string", "null"], format: "date-time" }, improvement: { type: ["number", "null"] }, sampleCount: { type: "integer", minimum: 0 }, operatorNote: { type: ["string", "null"] }, verificationNote: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
        },
      },
      ActionRunStartInput: {
        type: "object", additionalProperties: false, required: ["playbookId", "sensorId"],
        properties: { playbookId: { type: "string", minLength: 1 }, sensorId: { type: "string", minLength: 1 }, alertEventId: { type: ["string", "null"] }, maintenanceTaskId: { type: ["string", "null"] }, operatorNote: { type: ["string", "null"] } },
      },
      ActionRunCancelInput: { type: "object", additionalProperties: false, properties: { note: { type: ["string", "null"] } } },
      DataExportPreview: {
        type: "object", additionalProperties: false, required: ["schemaVersion", "generatedAt", "privacyLevel", "includesTelemetry", "counts", "sensitiveCategories", "estimatedTelemetryRows"],
        properties: { schemaVersion: { const: "stuga.export/v1" }, generatedAt: { type: "string", format: "date-time" }, privacyLevel: { enum: ["structure", "operations", "full"] }, includesTelemetry: { type: "boolean" }, counts: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, sensitiveCategories: { type: "array", items: { type: "string" } }, estimatedTelemetryRows: { type: "integer", minimum: 0 } },
      },
      DataExportBundle: {
        type: "object", required: ["schemaVersion", "generatedAt", "privacyLevel", "includesTelemetry", "privacyPreview", "data"],
        properties: { schemaVersion: { const: "stuga.export/v1" }, generatedAt: { type: "string", format: "date-time" }, privacyLevel: { enum: ["structure", "operations", "full"] }, includesTelemetry: { type: "boolean" }, privacyPreview: { $ref: "#/components/schemas/DataExportPreview" }, data: { type: "object", additionalProperties: true }, telemetry: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } } },
      },
      BackupOperationStatus: {
        type: "object", additionalProperties: false, required: ["available", "schedulerHealthy", "requestId", "state", "requestedAt", "completedAt", "backupPath", "lastError", "latestVerifiedBackupAt", "latestRestoreDrillAt"],
        properties: { available: { type: "boolean" }, schedulerHealthy: { type: "boolean" }, requestId: { type: ["string", "null"] }, state: { enum: ["idle", "requested", "running", "complete", "failed"] }, requestedAt: { type: ["string", "null"], format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" }, backupPath: { type: ["string", "null"] }, lastError: { type: ["string", "null"] }, latestVerifiedBackupAt: { type: ["string", "null"], format: "date-time" }, latestRestoreDrillAt: { type: ["string", "null"], format: "date-time" } },
      },
      SetupDoctorReport: {
        type: "object", additionalProperties: false, required: ["generatedAt", "overall", "checks"],
        properties: { generatedAt: { type: "string", format: "date-time" }, overall: { enum: ["ready", "attention", "blocked"] }, checks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "category", "status", "title", "detail", "action"], properties: { id: { type: "string" }, category: { enum: ["storage", "telemetry", "integration", "sensors", "notifications", "recovery", "security"] }, status: { enum: ["pass", "warning", "fail", "not-applicable"] }, title: { type: "string" }, detail: { type: "string" }, action: { type: ["string", "null"] } } } } },
      },
      SensorLabelDescriptor: {
        type: "object", additionalProperties: false, required: ["sensorId", "sensorName", "houseName", "roomName", "setupUri"],
        properties: { sensorId: { type: "string" }, sensorName: { type: "string" }, houseName: { type: "string" }, roomName: { type: ["string", "null"] }, setupUri: { type: "string", format: "uri" } },
      },
      BulkSensorMappingsInput: {
        type: "object", additionalProperties: false, required: ["houseId", "mappings"],
        properties: { houseId: { type: "string", minLength: 1 }, mappings: { type: "array", items: { type: "object", additionalProperties: false, required: ["sensorId", "measurementEntityIds"], properties: { sensorId: { type: "string", minLength: 1 }, measurementEntityIds: { type: "object", additionalProperties: { type: "string" } } } } } },
      },
      ReplayState: {
        type: "object",
        required: ["active", "count", "emitted", "speed", "from", "to"],
        properties: {
          active: { type: "boolean" }, count: { type: "integer" }, emitted: { type: "integer" }, speed: { type: "number" },
          from: { type: ["string", "null"], format: "date-time" }, to: { type: ["string", "null"], format: "date-time" },
        },
      },
      TpLinkDiscoveredDevice: {
        type: "object",
        required: ["deviceId", "model", "alias", "status", "temperature", "humidity", "battery", "lastSeenAt", "mappedSensorId"],
        properties: {
          houseId: { type: "string" },
          connectionId: { type: "string" },
          deviceId: { type: "string" },
          model: { type: "string" },
          alias: { oneOf: [{ type: "string" }, { type: "null" }] },
          status: { oneOf: [{ type: "string" }, { type: "null" }] },
          temperature: { oneOf: [{ type: "number" }, { type: "null" }], description: "Temperature normalized to degrees Celsius." },
          humidity: { oneOf: [{ type: "number" }, { type: "null" }] },
          battery: { oneOf: [{ type: "number" }, { type: "null" }] },
          contactOpen: { oneOf: [{ type: "boolean" }, { type: "null" }], description: "Contact state reported by devices such as Tapo T110." },
          power: { oneOf: [{ type: "number" }, { type: "null" }], description: "Instantaneous active power in W when the device exposes python-kasa's Energy module." },
          energy: { oneOf: [{ type: "number" }, { type: "null" }], description: "Cumulative device energy in kWh when consumption_total is available; currently total since reboot." },
          lastSeenAt: { type: "string", format: "date-time" },
          mappedSensorId: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    responses: {
      NotFound: { description: "Resource not found" },
    },
  },
} as const;

const V2_PATHS = new Set([
  "/measurement-definitions",
  "/measurement-definitions/{id}",
  "/analytics/findings",
  "/analytics/coverage",
  "/analytics/query",
  "/measurements",
  "/measurements/import",
  "/measurements/snapshot",
  "/measurements/history",
  "/houses/{id}/outdoor-temperature/history",
  "/sensors/{id}/measurements",
  "/measurements/events",
  "/measurements/forecast",
]);

function selectPaths(version: "v1" | "v2"): Record<string, unknown> {
  return Object.fromEntries(Object.entries(combinedOpenApiDocument.paths).filter(([path]) =>
    path === "/openapi.json" || (version === "v2" ? V2_PATHS.has(path) : !V2_PATHS.has(path))));
}

export const openApiV1Document = {
  ...combinedOpenApiDocument,
  info: { ...combinedOpenApiDocument.info, version: "1.0.0", description: "Stuga v1 compatibility API for layouts, house-scoped FMI weather, and temperature/humidity tuples." },
  servers: [{ url: "/api/v1", description: "Legacy climate tuple API" }],
  paths: selectPaths("v1"),
};

export const openApiV2Document = {
  ...combinedOpenApiDocument,
  info: { ...combinedOpenApiDocument.info, version: "2.0.0", description: "Stuga v2 registry-driven sparse measurements API." },
  servers: [{ url: "/api/v2", description: "Registry-driven measurements API" }],
  paths: selectPaths("v2"),
};

/** @deprecated Import the version-specific document. Retained for source compatibility. */
export const openApiDocument = openApiV1Document;
