import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";
import { pathsPart01 } from "./paths-01.js";
import { pathsPart02 } from "./paths-02.js";
import { pathsPart03 } from "./paths-03.js";
import { pathsPart04 } from "./paths-04.js";
import { pathsPart05 } from "./paths-05.js";
import { pathsPart06 } from "./paths-06.js";
import { schemasPart01 } from "./schemas-01.js";
import { schemasPart02 } from "./schemas-02.js";
import { schemasPart03 } from "./schemas-03.js";
import { schemasPart04 } from "./schemas-04.js";
import { schemasPart05 } from "./schemas-05.js";
import { schemasPart06 } from "./schemas-06.js";
import { schemasPart07 } from "./schemas-07.js";
import { schemasPart08 } from "./schemas-08.js";
import { schemasPart09 } from "./schemas-09.js";
import { schemasPart10 } from "./schemas-10.js";

export const combinedOpenApiDocument = {
  openapi: "3.1.0",
  info: {
      title: "Stugu Local API",
      version: "2.0.0",
      description: "Local-first Stugu API for house layouts, environmental telemetry, forecasts, alerts, replay, and integrations.",
    },
  servers: [{ url: "/api/v1", description: "Legacy climate tuple API" }, { url: "/api/v2", description: "Registry-driven measurements API" }],
  tags: [
      { name: "Telemetry" }, { name: "Digital twin" }, { name: "Alerts" },
      { name: "Context" }, { name: "Security" }, { name: "Weather" }, { name: "Physics" }, { name: "Integrations" }, { name: "Testing" }, { name: "Measurements" }, { name: "Stuguby", description: "Coordinator-led Property collaboration and explicit Home sharing. Homes are read-only by default. Credentials, integrations, account identities, and control commands are outside this protocol." },
      { name: "Spatial layers", description: "Optional local research engines that emit renderer-neutral, versioned 2D/3D semantic layers without mutating core climate state." },
      { name: "Equipment tracking", description: "Feature-gated BLE observations, uncertainty-aware asset estimates, and ordered map state." },
    ],
  security: [{ localSession: [] }],
  paths: {
    ...pathsPart01,
    ...pathsPart02,
    ...pathsPart03,
    ...pathsPart04,
    ...pathsPart05,
    ...pathsPart06,
  },
  components: {
    securitySchemes: {
          localSession: { type: "apiKey", in: "cookie", name: "stuga_session", description: "Opaque HttpOnly SameSite=Strict local session cookie." },
          csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Session-bound token required together with the session cookie on unsafe methods." },
          ingestKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "Optional, configured by INGEST_API_KEY." },
          notesGrant: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "One-time, house-scoped Apple Notes Shortcut grant. The local server stores only its SHA-256 hash." },
          tapoWorkerBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Route-scoped token for the isolated Appium Tapo export worker." },
          trackingObserverBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Installation-bound credential accepted only by tracking observation and heartbeat routes." },
          stugubyNodeSignature: { type: "apiKey", in: "header", name: "X-Stugby-Signature", description: "Ed25519 request signature. X-Stugby-Node-Id, X-Stugby-Timestamp, X-Stugby-Request-Id, and X-Stugby-Protocol are also mandatory and replay-checked." },
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
    responses: {
          NotFound: { description: "Resource not found" },
        },
    schemas: {
      ...schemasPart01,
      ...schemasPart02,
      ...schemasPart03,
      ...schemasPart04,
      ...schemasPart05,
      ...schemasPart06,
      ...schemasPart07,
      ...schemasPart08,
      ...schemasPart09,
      ...schemasPart10,
    },
  },
} as const;
