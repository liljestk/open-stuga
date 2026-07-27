import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

export const schemasPart03 = {
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
          type: "object", required: ["id", "propertyId", "areaId", "houseId", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes", "createdAt", "updatedAt"], additionalProperties: false,
          properties: {
            id: { type: "string" }, propertyId: { type: "string" }, areaId: { type: ["string", "null"] }, houseId: { type: ["string", "null"] }, location: { $ref: "#/components/schemas/GeoCoordinate" }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 },
            manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 },
            status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 },
            createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
          },
        },
  AreaEquipmentInput: {
          type: "object", required: ["name", "kind"], additionalProperties: false,
          properties: { id: { type: "string", minLength: 1, maxLength: 200 }, propertyId: { type: "string", minLength: 1, maxLength: 200 }, areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, location: { $ref: "#/components/schemas/GeoCoordinate" }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 }, manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 }, status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 } },
        },
  AreaEquipmentPatch: {
          type: "object", minProperties: 1, additionalProperties: false,
          properties: { areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 }, location: { oneOf: [{ $ref: "#/components/schemas/GeoCoordinate" }, { type: "null" }] }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", minLength: 1, maxLength: 200 }, manufacturer: { type: ["string", "null"], maxLength: 200 }, model: { type: ["string", "null"], maxLength: 200 }, serialNumber: { type: ["string", "null"], maxLength: 200 }, status: { enum: ["active", "out-of-service", "retired"] }, notes: { type: ["string", "null"], maxLength: 5_000 } },
        },
  EquipmentAttachment: {
          type: "object", additionalProperties: false,
          required: ["id", "equipmentId", "kind", "name", "mimeType", "size", "createdAt"],
          properties: {
            id: { type: "string" }, equipmentId: { type: "string" }, kind: { enum: ["photo", "document"] },
            name: { type: "string", minLength: 1, maxLength: 255 }, mimeType: { type: "string", minLength: 1, maxLength: 200 },
            size: { type: "integer", minimum: 1, maximum: 10_485_760 },
            createdAt: { type: "string", format: "date-time", readOnly: true },
          },
        },
  EquipmentAttachmentUploadInput: {
          type: "object", additionalProperties: false, required: ["kind", "name", "mimeType", "data"],
          properties: {
            kind: { enum: ["photo", "document"] }, name: { type: "string", minLength: 1, maxLength: 255 },
            mimeType: {
              enum: [
                "image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain", "text/markdown",
                "application/rtf", "text/rtf", "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.oasis.opendocument.text",
              ],
            },
            data: { type: "string", description: "Base64 bytes, optionally prefixed by a matching data URL; decoded content is limited to 10 MiB." },
          },
        },
  EquipmentLink: {
          type: "object", additionalProperties: false,
          required: ["id", "equipmentId", "label", "url", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" }, equipmentId: { type: "string" },
            label: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048, pattern: "^https?://" },
            createdAt: { type: "string", format: "date-time", readOnly: true },
            updatedAt: { type: "string", format: "date-time", readOnly: true },
          },
        },
  EquipmentLinkInput: {
          type: "object", additionalProperties: false, required: ["label", "url"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048, pattern: "^https?://" },
          },
        },
  EquipmentLinkPatch: {
          type: "object", additionalProperties: false, minProperties: 1,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048, pattern: "^https?://" },
          },
        },
  PropertyInventorySnapshot: {
          type: "object",
          additionalProperties: false,
          required: ["propertyId", "generatedAt", "syncToken", "areas", "equipment", "attachments", "links"],
          properties: {
            propertyId: { type: "string" },
            generatedAt: { type: "string", format: "date-time" },
            syncToken: { type: "string", description: "Opaque token over the visible inventory metadata." },
            areas: { type: "array", items: { $ref: "#/components/schemas/PropertyArea" } },
            equipment: { type: "array", items: { $ref: "#/components/schemas/AreaEquipment" } },
            attachments: { type: "array", items: { $ref: "#/components/schemas/EquipmentAttachment" } },
            links: { type: "array", items: { $ref: "#/components/schemas/EquipmentLink" } },
          },
        },
  TrackingCapabilities: {
          type: "object", additionalProperties: false,
          required: ["flags", "bleServiceUuid", "protocolVersions", "maximumObservationBatchSize", "observerModes"],
          properties: {
            flags: { type: "object", additionalProperties: { type: "boolean" } },
            bleServiceUuid: { type: "string", format: "uuid" },
            protocolVersions: { type: "array", items: { type: "integer", minimum: 0, maximum: 3 } },
            maximumObservationBatchSize: { type: "integer", minimum: 1, maximum: 100 },
            observerModes: { type: "array", items: { enum: ["passive", "property", "active-property", "find-nearby", "gateway"] } },
          },
        },
  TrackingPropertySettings: {
          type: "object", additionalProperties: false,
          required: ["propertyId", "enabled", "propertyBoundary", "liveNearbySeconds", "recentlySeenSeconds", "staleSeconds", "unknownSeconds", "movementThresholdMeters", "movementMaximumIntervalSeconds", "minimumMovementConfidence", "exitAlertDebounceSeconds", "updatedAt"],
          properties: {
            propertyId: { type: "string" }, enabled: { type: "boolean" },
            propertyBoundary: { type: "array", maxItems: 500, items: { $ref: "#/components/schemas/GeoCoordinate" } },
            liveNearbySeconds: { type: "integer", minimum: 1 }, recentlySeenSeconds: { type: "integer", minimum: 10 },
            staleSeconds: { type: "integer", minimum: 60 }, unknownSeconds: { type: "integer", minimum: 300 },
            movementThresholdMeters: { type: "number", minimum: 1 }, movementMaximumIntervalSeconds: { type: "integer", minimum: 5 },
            minimumMovementConfidence: { type: "number", minimum: 0, maximum: 1 },
            exitAlertDebounceSeconds: { type: "integer", minimum: 5 },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
  TrackingTag: {
          type: "object", additionalProperties: false,
          required: ["id", "tenantId", "propertyId", "serialNumber", "hardwareModel", "firmwareVersion", "protocolVersion", "rotationWindowMinutes", "batteryType", "batteryPercent", "capabilities", "status", "pairedAt", "lastSeenAt", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" }, tenantId: { type: "string" }, propertyId: { type: "string" },
            serialNumber: { type: "string" }, hardwareModel: { type: "string" }, firmwareVersion: { type: ["string", "null"] },
            protocolVersion: { type: "integer", minimum: 0, maximum: 3 }, rotationWindowMinutes: { type: "integer", minimum: 5, maximum: 60 },
            batteryType: { type: ["string", "null"] }, batteryPercent: { type: ["integer", "null"], minimum: 0, maximum: 100 },
            capabilities: { type: "object", additionalProperties: false, required: ["motion", "battery", "buzzer", "button", "tamper", "connectable"], properties: { motion: { type: "boolean" }, battery: { type: "boolean" }, buzzer: { type: "boolean" }, button: { type: "boolean" }, tamper: { type: "boolean" }, connectable: { type: "boolean" } } },
            status: { enum: ["provisioning", "active", "disabled", "retired"] },
            pairedAt: { type: ["string", "null"], format: "date-time" }, lastSeenAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
          },
        },
  TrackingObserver: {
          type: "object", additionalProperties: false,
          required: ["id", "tenantId", "propertyId", "type", "name", "trustLevel", "fixedPosition", "fixedPositionAccuracyMeters", "zoneId", "appInstallationId", "hardwareMetadata", "lastHeartbeatAt", "status", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" }, tenantId: { type: "string" }, propertyId: { type: "string" },
            type: { enum: ["esp32-gateway", "linux-gateway", "android-gateway", "android-phone", "ios-phone"] },
            name: { type: "string" }, trustLevel: { type: "number", minimum: 0, maximum: 1 },
            fixedPosition: { oneOf: [{ $ref: "#/components/schemas/GeoCoordinate" }, { type: "null" }] },
            fixedPositionAccuracyMeters: { type: ["number", "null"], minimum: 0 },
            zoneId: { type: ["string", "null"] }, appInstallationId: { type: ["string", "null"] },
            hardwareMetadata: { type: "object", additionalProperties: true },
            lastHeartbeatAt: { type: ["string", "null"], format: "date-time" },
            status: { enum: ["online", "offline", "degraded", "disabled"] },
            createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
          },
        },
  TrackingObservationInput: {
          type: "object", additionalProperties: false,
          required: ["observationId", "propertyId", "observerId", "observedAt", "rotatingTagId", "authenticator", "protocolVersion", "epochCounter", "eventCounter", "rssi", "scanMode"],
          properties: {
            observationId: { type: "string", minLength: 1, maxLength: 100 }, propertyId: { type: "string" }, observerId: { type: "string" },
            observedAt: { type: "string", format: "date-time" }, rotatingTagId: { type: "string", description: "Base64url-encoded 64-bit rotating identifier." },
            authenticator: { type: "string", description: "Base64url-encoded truncated advertisement authenticator." },
            protocolVersion: { type: "integer", minimum: 0, maximum: 3 }, advertisementFlags: { type: "integer", minimum: 0, maximum: 63 },
            epochCounter: { type: "integer", minimum: 0, maximum: 65_535 }, eventCounter: { type: "integer", minimum: 0, maximum: 65_535 },
            rssi: { type: "integer", minimum: -127, maximum: 20 }, txPower: { type: "integer", minimum: -127, maximum: 20 },
            motion: { type: "boolean" }, batteryPercent: { type: "integer", minimum: 0, maximum: 100 },
            observerPosition: { type: "object", additionalProperties: false, required: ["latitude", "longitude", "horizontalAccuracyMeters", "source"], properties: { latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 }, horizontalAccuracyMeters: { type: "number", minimum: 0 }, source: { enum: ["gps", "fused", "network", "fixed", "manual"] }, capturedAt: { type: "string", format: "date-time" }, reducedAccuracy: { type: "boolean" } } },
            fixedGatewayPositionId: { type: "string" }, scanMode: { enum: ["passive", "property", "active-property", "find-nearby", "gateway"] },
            appState: { enum: ["foreground", "background", "suspended"] }, deviceTimeOffsetMs: { type: "integer" },
            rawPayload: { type: "string" }, metadata: { type: "object", additionalProperties: true },
          },
        },
  TrackingObservationBatchInput: {
          type: "object", additionalProperties: false, required: ["observations"],
          properties: { observations: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/TrackingObservationInput" } } },
        },
  TrackingObservationBatchResult: {
          type: "object", additionalProperties: false, required: ["accepted", "duplicates", "rejected", "serverTime", "errors"],
          properties: {
            accepted: { type: "integer", minimum: 0 }, duplicates: { type: "integer", minimum: 0 }, rejected: { type: "integer", minimum: 0 },
            serverTime: { type: "string", format: "date-time" },
            errors: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "code"], properties: { index: { type: "integer", minimum: 0 }, code: { type: "string" } } } },
          },
        },
  AssetPositionEstimate: {
          type: "object", additionalProperties: false,
          required: ["id", "equipmentId", "propertyId", "calculatedAt", "effectiveAt", "positionType", "coordinate", "accuracyRadiusMeters", "zoneId", "confidence", "confidenceLevel", "movementState", "freshnessState", "lastObservedAt", "observerCount", "algorithmVersion", "evidenceObservationIds", "explanation", "version"],
          properties: {
            id: { type: "string" }, equipmentId: { type: "string" }, propertyId: { type: "string" },
            calculatedAt: { type: "string", format: "date-time" }, effectiveAt: { type: "string", format: "date-time" },
            positionType: { enum: ["confirmed-zone", "estimated-coordinate", "nearby-live", "last-known", "unknown"] },
            coordinate: { oneOf: [{ $ref: "#/components/schemas/GeoCoordinate" }, { type: "null" }] },
            accuracyRadiusMeters: { type: ["number", "null"], minimum: 0 }, zoneId: { type: ["string", "null"] },
            confidence: { type: "number", minimum: 0, maximum: 1 }, confidenceLevel: { enum: ["high", "medium", "low"] },
            movementState: { enum: ["moving", "stationary", "unknown"] }, freshnessState: { enum: ["live", "recent", "last-known", "stale", "unknown"] },
            lastObservedAt: { type: ["string", "null"], format: "date-time" }, observerCount: { type: "integer", minimum: 0 },
            algorithmVersion: { type: "string" }, evidenceObservationIds: { type: "array", items: { type: "string" } },
            explanation: { type: "object", additionalProperties: true }, version: { type: "integer", minimum: 1 },
          },
        },
  TrackingScanToken: {
          type: "object", additionalProperties: false, required: ["equipmentId", "bleServiceUuid", "protocolVersion", "rotatingTagIds", "validUntil"],
          properties: {
            equipmentId: { type: "string" }, bleServiceUuid: { type: "string", format: "uuid" },
            protocolVersion: { type: "integer", minimum: 0, maximum: 3 },
            rotatingTagIds: { type: "array", minItems: 1, items: { type: "string" } },
            validUntil: { type: "string", format: "date-time" },
          },
        },
  TrackingMapSnapshot: {
          type: "object", additionalProperties: false,
          required: ["propertyId", "generatedAt", "sequence", "settings", "zones", "gateways", "assets", "members"],
          properties: {
            propertyId: { type: "string" }, generatedAt: { type: "string", format: "date-time" }, sequence: { type: "integer", minimum: 0 },
            settings: { $ref: "#/components/schemas/TrackingPropertySettings" },
            zones: { type: "array", items: { $ref: "#/components/schemas/PropertyArea" } },
            gateways: { type: "array", items: { $ref: "#/components/schemas/TrackingObserver" } },
            assets: { type: "array", items: { type: "object", additionalProperties: false, required: ["equipment", "tag", "assignment", "position"], properties: { equipment: { $ref: "#/components/schemas/AreaEquipment" }, tag: { oneOf: [{ $ref: "#/components/schemas/TrackingTag" }, { type: "null" }] }, assignment: { oneOf: [trackingObject, { type: "null" }] }, position: { oneOf: [{ $ref: "#/components/schemas/AssetPositionEstimate" }, { type: "null" }] } } } },
            members: { type: "array", items: { $ref: "#/components/schemas/PropertyMemberLocation" } },
          },
        },
  EquipmentLoan: {
          type: "object", additionalProperties: false,
          required: ["id", "propertyId", "equipmentId", "borrowerLabel", "borrowedAt", "expectedReturnAt", "note", "returnedAt", "returnedByLabel", "returnNote"],
          properties: {
            id: { type: "string" }, propertyId: { type: "string" }, equipmentId: { type: "string" },
            borrowerLabel: { type: "string" }, borrowedAt: { type: "string", format: "date-time" },
            expectedReturnAt: { type: ["string", "null"], format: "date-time" },
            note: { type: ["string", "null"], maxLength: 1_000 },
            returnedAt: { type: ["string", "null"], format: "date-time" },
            returnedByLabel: { type: ["string", "null"] },
            returnNote: { type: ["string", "null"], maxLength: 1_000 },
          },
        },
  EquipmentBorrowInput: {
          type: "object", additionalProperties: false,
          properties: {
            expectedReturnAt: { type: ["string", "null"], format: "date-time" },
            note: { type: ["string", "null"], maxLength: 1_000 },
          },
        },
  EquipmentReturnInput: {
          type: "object", additionalProperties: false,
          properties: { note: { type: ["string", "null"], maxLength: 1_000 } },
        },
} as const;
