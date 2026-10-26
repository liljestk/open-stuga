import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

const durableAnalyticsPath = (input: {
  getOperationId: string;
  refreshOperationId: string;
  responseSchema: string;
  description: string;
  windowed?: boolean;
}) => {
  const parameters = [
    { name: "houseId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } },
    { name: "dataMode", in: "query", required: true, schema: { enum: ["live", "demo"] } },
    ...(input.windowed ? [{ name: "windowDays", in: "query", schema: { enum: [1, 7, 14], default: 7 } }] : []),
  ];
  const success = {
    description: "Last successful immutable artifact and explicit durable refresh status",
    content: { "application/json": { schema: { $ref: input.responseSchema } } },
  };
  const errors = {
    "400": { description: "Home, data mode, or canonical window is invalid" },
    "404": { description: "The Home is absent or outside the caller's visibility" },
    "409": { description: "Requested dataMode does not match the isolated local database mode" },
  };
  return {
    get: {
      servers: [{ url: "/api/v2" }],
      tags: ["Measurements"],
      operationId: input.getOperationId,
      description: `${input.description} This read never scans telemetry, fits a model, queues work, or wakes the background worker.`,
      parameters,
      responses: { "200": success, ...errors },
    },
    post: {
      servers: [{ url: "/api/v2" }],
      tags: ["Measurements"],
      operationId: input.refreshOperationId,
      description: "Idempotently queues a low-priority refresh while retaining the last successful artifact.",
      parameters,
      responses: {
        "202": success,
        ...errors,
        "403": { description: "Guest accounts cannot queue manual refresh work" },
      },
    },
  };
};

export const pathsPart01 = {
  ...localAuthPaths,
  ...spatialLayerPaths,
  ...operationalOrchestrationPaths,
  ...trackingPaths,
  ...stugubyPaths,
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
  "/analytics/opening-activity": {
        post: {
          servers: [{ url: "/api/v2" }],
          tags: ["Measurements"],
          operationId: "openingActivity",
          description: "Derives door and window activity with canonical half-open observation validity, transition counting, and provenance.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OpeningActivityRequest" } } } },
          responses: {
            "200": { description: "Server-owned opening timelines and transition summaries", content: { "application/json": { schema: { $ref: "#/components/schemas/OpeningActivityResponse" } } } },
            "400": { description: "Malformed request, unsupported version, or invalid range" },
            "404": { description: "The Home is absent or outside the caller's visibility" },
            "409": { description: "Requested dataMode does not match the isolated local database mode" },
            "503": { description: "Required historical telemetry is temporarily incomplete" },
          },
        },
      },
  "/analytics/thermal-isolation": durableAnalyticsPath({
    getOperationId: "cachedThermalIsolation",
    refreshOperationId: "refreshCachedThermalIsolation",
    responseSchema: "#/components/schemas/DurableThermalIsolationResponse",
    description: "Returns the canonical thermal-isolation comparison for the last complete day.",
    windowed: true,
  }),
  "/analytics/moisture-response": durableAnalyticsPath({
    getOperationId: "cachedMoistureResponse",
    refreshOperationId: "refreshCachedMoistureResponse",
    responseSchema: "#/components/schemas/DurableMoistureResponseResponse",
    description: "Returns the canonical moisture-response comparison for the last complete day.",
    windowed: true,
  }),
  "/analytics/home-performance": durableAnalyticsPath({
    getOperationId: "homePerformance",
    refreshOperationId: "refreshHomePerformance",
    responseSchema: "#/components/schemas/DurableHomePerformanceResponse",
    description: "Returns the server-owned canonical 30-day whole-Home performance artifact.",
  }),
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
  "/measurements/history": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "measurementHistory", parameters: [{ name: "sensorId", in: "query", required: true, schema: { type: "string" } }, { name: "metric", in: "query", required: true, schema: { type: "string" } }, { name: "from", in: "query", schema: { type: "string", format: "date-time" } }, { name: "to", in: "query", schema: { type: "string", format: "date-time" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50000 } }, { name: "cursor", in: "query", description: "Opaque raw-history keyset cursor returned by the previous page.", schema: { type: "string" } }, { name: "bucketSeconds", in: "query", description: "Optional UTC-aligned arithmetic-mean downsampling. Buckets retain the latest sample source and are marked estimated when combining values. Bucketed responses cover the whole requested window regardless of its length, bounded by limit.", schema: { type: "integer", minimum: 1, maximum: 86400 } }], responses: { "200": { description: "Ordered raw or UTC-bucketed independent metric samples", content: { "application/json": { schema: { type: "object", required: ["samples", "from", "to", "bucketSeconds", "truncated", "nextCursor"], properties: { samples: { type: "array", items: { $ref: "#/components/schemas/MeasurementSample" } }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, bucketSeconds: { type: ["integer", "null"], minimum: 1, maximum: 86400 }, truncated: { type: "boolean" }, nextCursor: { type: ["string", "null"] } } } } } } } } },
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
  "/measurements/forecast": { get: { servers: [{ url: "/api/v2" }], tags: ["Measurements"], operationId: "forecastMeasurement", parameters: [{ name: "sensorId", in: "query", required: true, schema: { type: "string" } }, { name: "metric", in: "query", required: true, schema: { type: "string" } }, { name: "hours", in: "query", schema: { type: "integer", minimum: 1, maximum: 168, default: 12 } }], description: "Hourly forecast from the latest reading. The thermal model (temperature with an outdoor driver) and an hour-of-day profile are backtested on the last two weeks; the better one is used, intervals come from past errors at each horizon, and the forecast is withheld (empty) unless it beats \"no change\" at six hours.", responses: { "200": { description: "Backtested forecast and its evaluation", content: { "application/json": { schema: { type: "object", required: ["forecast", "evaluation"], properties: { forecast: { type: "array", items: { $ref: "#/components/schemas/MeasurementForecastPoint" } }, evaluation: { $ref: "#/components/schemas/MeasurementForecastEvaluation" } } } } } }, "422": { description: "FORECAST_UNSUPPORTED" } } } },
  "/properties": {
        get: { tags: ["Digital twin"], operationId: "listProperties", parameters: [{ $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Managed properties", content: { "application/json": { schema: { type: "object", required: ["properties"], properties: { properties: { type: "array", items: { $ref: "#/components/schemas/Property" } } } } } } } } },
        post: { tags: ["Digital twin"], operationId: "createProperty", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyInput" } } } }, responses: { "201": { description: "Created property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "409": { description: "Property identifier conflict" }, "422": { description: "Invalid property metadata" } } },
      },
  "/properties/{id}": {
        get: { tags: ["Digital twin"], operationId: "getProperty", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
        patch: { tags: ["Digital twin"], operationId: "updateProperty", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PropertyPatch" } } } }, responses: { "200": { description: "Updated property", content: { "application/json": { schema: { type: "object", required: ["property"], properties: { property: { $ref: "#/components/schemas/Property" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "422": { description: "Invalid property metadata" } } },
        delete: { tags: ["Digital twin"], operationId: "deleteProperty", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Property still contains resources" } } },
      },
  "/properties/{propertyId}/inventory": {
        get: {
          tags: ["Digital twin"],
          operationId: "getPropertyInventory",
          parameters: [trackingPathParameter("propertyId")],
          responses: {
            "200": {
              description: "Consistent Property inventory snapshot. Equipment identifiers also join to optional tracking state.",
              headers: { ETag: { description: "Opaque inventory sync token.", schema: { type: "string" } } },
              content: { "application/json": { schema: {
                type: "object",
                required: ["inventory"],
                properties: { inventory: { $ref: "#/components/schemas/PropertyInventorySnapshot" } },
              } } },
            },
            "304": { description: "The visible inventory has not changed." },
            "413": { description: "The Property inventory exceeds the supported snapshot size." },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
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
        get: { tags: ["Digital twin"], operationId: "listAreaEquipment", parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/HouseIdQuery" }, { $ref: "#/components/parameters/AreaIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }], responses: { "200": { description: "Property inventory equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { type: "array", items: { $ref: "#/components/schemas/AreaEquipment" } } } } } } } } },
        post: { tags: ["Digital twin"], operationId: "createAreaEquipment", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AreaEquipmentInput" } } } }, responses: { "201": { description: "Created equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Identifier or expected-location scope conflict" }, "422": { description: "Invalid equipment" } } },
      },
  "/area-equipment/{id}": {
        get: { tags: ["Digital twin"], operationId: "getAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Area equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
        patch: { tags: ["Digital twin"], operationId: "updateAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AreaEquipmentPatch" } } } }, responses: { "200": { description: "Updated equipment", content: { "application/json": { schema: { type: "object", required: ["equipment"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" } } } } } }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Expected-location or linked-evidence scope conflict" }, "422": { description: "Invalid equipment" } } },
        delete: { tags: ["Digital twin"], operationId: "deleteAreaEquipment", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Equipment is still referenced" } } },
      },
  "/area-equipment/{equipmentId}/attachments": {
        parameters: [{ name: "equipmentId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["Digital twin"], operationId: "listEquipmentAttachments",
          responses: { "200": jsonResponse("Photos, manuals, and similar documents attached to this equipment.", { type: "object", required: ["attachments"], properties: { attachments: { type: "array", items: { $ref: "#/components/schemas/EquipmentAttachment" } } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
        post: {
          tags: ["Digital twin"], operationId: "uploadEquipmentAttachment",
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/EquipmentAttachmentUploadInput" }),
          responses: {
            "201": jsonResponse("Stored equipment attachment.", { type: "object", required: ["attachment", "url"], properties: { attachment: { $ref: "#/components/schemas/EquipmentAttachment" }, url: { type: "string" } } }),
            "404": { $ref: "#/components/responses/NotFound" }, "413": { description: "Decoded file exceeds 10 MiB" }, "415": { description: "Unsupported photo or document media type" },
          },
        },
      },
} as const;
