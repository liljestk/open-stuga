import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

export const schemasPart08 = {
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
          required: ["deviceId", "model", "alias", "status", "temperature", "humidity", "battery", "deviceType", "lastSeenAt", "mappedSensorId", "mappedOpening"],
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
            deviceType: { enum: ["climate", "contact", "energy", "unknown"], description: "Provider-normalized onboarding purpose derived from the model and exposed capabilities." },
            power: { oneOf: [{ type: "number" }, { type: "null" }], description: "Instantaneous active power in W when the device exposes python-kasa's Energy module." },
            energy: { oneOf: [{ type: "number" }, { type: "null" }], description: "Cumulative device energy in kWh when consumption_total is available; currently total since reboot." },
            lastSeenAt: { type: "string", format: "date-time" },
            mappedSensorId: { oneOf: [{ type: "string" }, { type: "null" }] },
            mappedOpening: {
              oneOf: [{
                type: "object",
                additionalProperties: false,
                required: ["floorId", "elementId", "kind", "label"],
                properties: {
                  floorId: { type: "string" },
                  elementId: { type: "string" },
                  kind: { enum: ["door", "window", "vent"] },
                  label: { oneOf: [{ type: "string" }, { type: "null" }] },
                },
              }, { type: "null" }],
            },
          },
        },
} as const;
