import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

export const pathsPart02 = {
  "/area-equipment/{equipmentId}/attachments/{attachmentId}": {
        parameters: [
          { name: "equipmentId", in: "path", required: true, schema: { type: "string" } },
          { name: "attachmentId", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["Digital twin"], operationId: "downloadEquipmentAttachment",
          responses: { "200": { description: "Authorized attachment bytes. Photos are inline; documents download as attachments.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
        },
        delete: {
          tags: ["Digital twin"], operationId: "deleteEquipmentAttachment",
          responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/area-equipment/{equipmentId}/links": {
        parameters: [{ name: "equipmentId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["Digital twin"], operationId: "listEquipmentLinks",
          responses: { "200": jsonResponse("Relevant external information links for this equipment.", { type: "object", required: ["links"], properties: { links: { type: "array", items: { $ref: "#/components/schemas/EquipmentLink" } } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
        post: {
          tags: ["Digital twin"], operationId: "createEquipmentLink",
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/EquipmentLinkInput" }),
          responses: { "201": jsonResponse("Stored equipment link.", { type: "object", required: ["link"], properties: { link: { $ref: "#/components/schemas/EquipmentLink" } } }), "404": { $ref: "#/components/responses/NotFound" }, "422": { description: "Invalid or unsafe URL" } },
        },
      },
  "/area-equipment/{equipmentId}/links/{linkId}": {
        parameters: [
          { name: "equipmentId", in: "path", required: true, schema: { type: "string" } },
          { name: "linkId", in: "path", required: true, schema: { type: "string" } },
        ],
        patch: {
          tags: ["Digital twin"], operationId: "updateEquipmentLink",
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/EquipmentLinkPatch" }),
          responses: { "200": jsonResponse("Updated equipment link.", { type: "object", required: ["link"], properties: { link: { $ref: "#/components/schemas/EquipmentLink" } } }), "404": { $ref: "#/components/responses/NotFound" }, "422": { description: "Invalid or unsafe URL" } },
        },
        delete: {
          tags: ["Digital twin"], operationId: "deleteEquipmentLink",
          responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" } },
        },
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
        delete: { tags: ["Digital twin"], operationId: "deleteHouse", description: "Soft-deletes a Home. The Home and Home-owned data disappear from active APIs while retained rows and Property-owned maintenance, notes, and equipment remain intact.", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Home hidden; no retained data was physically deleted" }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
  "/houses/{id}/opening-states": {
        get: {
          tags: ["Physics"], operationId: "getOpeningStates",
          description: "Returns the effective state of every door, window, and vent plus the bounded observation candidates used at the requested time. Stale or unknown contact readings fall back to the configured manual/default state. Supplying from adds a bounded history seeded with the effective leading-edge observations so transition analysis does not mistake startup heartbeats for opening events.",
          parameters: [
            { $ref: "#/components/parameters/Id" },
            { name: "at", in: "query", schema: { type: "string", format: "date-time" } },
            { $ref: "#/components/parameters/FromQuery" },
            { $ref: "#/components/parameters/ToQuery" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10_000, default: 10_000 } },
          ],
          responses: { "200": { description: "Effective opening-state snapshot and observations, with optional bounded history", content: { "application/json": { schema: { type: "object", required: ["snapshot", "observations"], properties: { snapshot: { $ref: "#/components/schemas/OpeningStateSnapshot" }, observations: { type: "array", items: { $ref: "#/components/schemas/OpeningStateObservation" } }, history: { type: "array", items: { $ref: "#/components/schemas/OpeningStateObservation" } }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } } } } }, "400": { description: "Invalid range or limit" }, "404": { $ref: "#/components/responses/NotFound" } },
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
          description: "Calculates one source's energy cost. A cumulative energy counter is preferred; power samples are integrated with a bounded hold when no complete counter interval is available.",
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
  "/houses/{id}/energy-summary": {
        get: {
          tags: ["Energy"], operationId: "getHouseEnergySummary",
          description: "Calculates a server-authoritative Home total across every visible electricity source. Each source prefers cumulative energy and falls back to bounded power integration, so power-only plugs are included without double counting.",
          parameters: [
            { $ref: "#/components/parameters/Id" },
            { $ref: "#/components/parameters/FromQuery" },
            { $ref: "#/components/parameters/ToQuery" },
          ],
          responses: {
            "200": { description: "Versioned, auditable Home energy and cost summary", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { $ref: "#/components/schemas/HomeEnergySummary" } } } } } },
            "400": { description: "Invalid range" },
            "404": { $ref: "#/components/responses/NotFound" },
            "503": { description: "Complete archived telemetry is temporarily unavailable" },
          },
        },
      },
  "/houses/{id}/energy-projection": {
        get: {
          tags: ["Energy"], operationId: "getHouseEnergyProjection",
          description: "Projects the Home's next thirty days of consumption and cost. A weather regression on heating degree-hours, driven by the stored forecast and then recent weather, is used only when it beat repeating the last thirty days in a rolling backtest; the interval and confidence come from that backtest. Null when no source stands for the whole Home.",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: {
            "200": { description: "Backtested thirty-day projection", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["projection"], properties: { projection: { oneOf: [{ $ref: "#/components/schemas/HomeEnergyProjection" }, { type: "null" }] } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "503": { description: "Complete archived telemetry is temporarily unavailable" },
          },
        },
      },
  "/houses/{id}/weather": {
        get: {
          tags: ["Weather"],
          operationId: "getHouseWeather",
          description: "Returns the local, durable provider-neutral weather snapshot last accepted by the background monitor; this read never contacts FMI or Open-Meteo. The canonical stored horizon is 48 hours and shorter requested horizons are filtered locally. Components can fail independently; inspect componentStatus (or the legacy unavailable field) and stale before using the result. An empty warnings array means no warnings only when componentStatus.warnings.emptyResultIsAuthoritative is true.",
          parameters: [
            { $ref: "#/components/parameters/Id" },
            { name: "hours", in: "query", description: "Local view horizon in hours. The durable upstream snapshot is bounded to 48 hours, so larger values cannot add points beyond that canonical window.", schema: { type: "integer", minimum: 1, maximum: 240, default: 48 } },
          ],
          responses: {
            "200": { description: "Durable last-good weather context, possibly partial or marked stale", content: { "application/json": { schema: { type: "object", required: ["weather"], properties: { weather: { $ref: "#/components/schemas/HouseWeather" } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "HOUSE_LOCATION_REQUIRED: set the house WGS84 location first; or WEATHER_REQUEST_SUPERSEDED: house metadata changed while the snapshot was being read" },
            "503": { description: "WEATHER_UNAVAILABLE: the background monitor has not retained a usable snapshot for this Home and location" },
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
  "/houses/{id}/moisture-response": {
        get: {
          tags: ["Physics"],
          operationId: "compareMoistureResponse",
          description: "Compares how indoor water-vapor pressure follows the persisted outdoor moisture boundary across sensors, rooms, floors, and the whole house. Relative humidity is temperature-corrected before fitting. This is not an airtightness, dampness, mould, or building-code assessment.",
          parameters: [
            { $ref: "#/components/parameters/Id" },
            { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration start; the requested range may not exceed 14 days." },
            { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "Calibration end; defaults to now." },
          ],
          responses: {
            "200": { description: "Room, floor, house, and sensor moisture-response comparison", content: { "application/json": { schema: { type: "object", required: ["moistureResponse"], properties: { moistureResponse: { $ref: "#/components/schemas/MoistureResponseResult" } } } } } },
            "400": { description: "Malformed timestamp or calibration range" },
            "404": { $ref: "#/components/responses/NotFound" },
            "422": { description: "The enabled paired climate-sensor scope exceeds the bounded comparison limit" },
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
  "/houses/{id}/floors/{floorId}/roomplan-import": {
        post: {
          tags: ["Digital twin"],
          operationId: "importAppleRoomPlanFloor",
          description: "Conflict-safe native iOS RoomPlan import. Only reviewed parametric geometry is accepted; camera imagery and raw RoomPlan data are rejected.",
          parameters: [
            { $ref: "#/components/parameters/Id" },
            { name: "floorId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["source", "capturedAt", "expectedHouseUpdatedAt", "floor"],
                  properties: {
                    source: { const: "apple-roomplan" },
                    capturedAt: { type: "string", format: "date-time" },
                    expectedHouseUpdatedAt: { type: "string", format: "date-time" },
                    floor: { $ref: "#/components/schemas/Floor" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Imported reviewed floor geometry and updated Home",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["house", "floor"],
                    properties: {
                      house: { $ref: "#/components/schemas/House" },
                      floor: { $ref: "#/components/schemas/Floor" },
                    },
                  },
                },
              },
            },
            "400": { description: "Malformed, image-bearing, unscaled, or unbounded RoomPlan geometry" },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "The Home changed after scanning, the floor would orphan linked records, or shared-Home policy prevents replacement" },
          },
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
  "/forecast": { get: { tags: ["Telemetry"], operationId: "forecast", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }, { name: "hours", in: "query", schema: { type: "integer", minimum: 1, maximum: 168, default: 12 } }, { name: "horizonMinutes", in: "query", schema: { type: "integer", minimum: 0, maximum: 10080, default: 0 }, description: "Compatibility horizon; when greater than zero it takes precedence over hours." }], responses: { "200": { description: "Backtested temperature and humidity forecasts with 90% intervals; empty for a sensor whose forecast does not beat \"no change\"", content: { "application/json": { schema: { type: "object", required: ["generatedAt", "model", "series"], properties: { generatedAt: { type: "string", format: "date-time" }, model: { const: "backtested-v2" }, series: { type: "array", items: { type: "object", required: ["sensorId", "forecast"], properties: { sensorId: { type: "string" }, forecast: { type: "array", items: { $ref: "#/components/schemas/ForecastPoint" } } } } }, forecast: { type: "array", items: { $ref: "#/components/schemas/ForecastPoint" } } } } } } } } } },
} as const;
