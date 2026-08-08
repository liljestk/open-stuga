import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";

export const spatialLayerSchemas = {
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
  SpatialInferenceSession: {
    type: "object", additionalProperties: false,
    required: ["id", "partition", "houseId", "status", "startedAt", "expiresAt", "cadenceMinutes", "nextRunAt", "lastScheduledAt", "stoppedAt", "createdBy", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" }, partition: { $ref: "#/components/schemas/SpatialPartition" }, houseId: { type: "string" },
      status: { enum: ["active", "stopped", "expired"] }, startedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" },
      cadenceMinutes: { type: "integer", minimum: 5, maximum: 60 }, nextRunAt: { type: "string", format: "date-time" },
      lastScheduledAt: { type: ["string", "null"], format: "date-time" }, stoppedAt: { type: ["string", "null"], format: "date-time" },
      createdBy: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
    },
  },
  SpatialInferenceSessionResponse: {
    type: "object", additionalProperties: false, required: ["session"],
    properties: { session: { oneOf: [{ $ref: "#/components/schemas/SpatialInferenceSession" }, { type: "null" }] } },
  },
  SpatialInferenceSessionStartInput: {
    type: "object", additionalProperties: false,
    properties: {
      durationMinutes: { type: "integer", minimum: 15, maximum: 240, default: 60 },
      cadenceMinutes: { type: "integer", minimum: 5, maximum: 60, default: 10 },
    },
  },
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
