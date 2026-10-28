const evidenceState = { enum: ["ready", "limited", "unavailable"] } as const;

const durableDerivedResponse = (kind: string, resultSchema: string) => ({
  type: "object",
  additionalProperties: false,
  required: [
    "apiVersion", "kind", "houseId", "dataMode", "windowDays", "cutoff",
    "state", "stale", "result", "artifact", "job",
  ],
  properties: {
    apiVersion: { const: "1.0" },
    kind: { const: kind },
    houseId: { type: "string" },
    dataMode: { enum: ["live", "demo"] },
    windowDays: { type: "integer", minimum: 1, maximum: 30 },
    cutoff: { type: "string", format: "date-time" },
    state: { enum: ["idle", "ready", "queued", "refreshing", "failed"] },
    stale: { type: "boolean" },
    result: { oneOf: [{ $ref: resultSchema }, { type: "null" }] },
    artifact: {
      oneOf: [{
        type: "object",
        additionalProperties: false,
        required: ["id", "generatedAt", "cutoff", "algorithmVersion", "evidenceVersion"],
        properties: {
          id: { type: "integer", minimum: 1 },
          generatedAt: { type: "string", format: "date-time" },
          cutoff: { type: "string", format: "date-time" },
          algorithmVersion: { type: "string" },
          evidenceVersion: { type: "string" },
        },
      }, { type: "null" }],
    },
    job: {
      oneOf: [{
        type: "object",
        additionalProperties: false,
        required: [
          "requestedAt", "startedAt", "completedAt", "nextAttemptAt", "attemptCount",
          "errorCode", "errorMessage",
        ],
        properties: {
          requestedAt: { type: "string", format: "date-time" },
          startedAt: { type: ["string", "null"], format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          nextAttemptAt: { type: ["string", "null"], format: "date-time" },
          attemptCount: { type: "integer", minimum: 0 },
          errorCode: { type: ["string", "null"] },
          errorMessage: { type: ["string", "null"] },
        },
      }, { type: "null" }],
    },
  },
});

export const derivedAnalyticsSchemas = {
  DurableThermalIsolationResponse: durableDerivedResponse(
    "thermal-isolation",
    "#/components/schemas/ThermalIsolationResult",
  ),
  DurableMoistureResponseResponse: durableDerivedResponse(
    "moisture-response",
    "#/components/schemas/MoistureResponseResult",
  ),
  DurableHomePerformanceResponse: durableDerivedResponse(
    "home-performance",
    "#/components/schemas/HomePerformanceResponse",
  ),
  DerivedAnalyticsCache: {
    type: "object",
    additionalProperties: false,
    required: ["hit", "coalesced", "keyVersion", "ttlSeconds"],
    properties: {
      hit: { type: "boolean" },
      coalesced: { type: "boolean" },
      keyVersion: { type: "string" },
      ttlSeconds: { type: "number", minimum: 0 },
    },
  },
  HomePerformanceRoomExposure: {
    type: "object",
    additionalProperties: false,
    required: [
      "id", "label", "sensorIds", "guideRangePercent", "observedHours",
      "temperatureDegreeHours", "humidityOutsideGuideHours", "co2AboveGuideHours",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      sensorIds: { type: "array", items: { type: "string" } },
      guideRangePercent: { type: "number", minimum: 0, maximum: 100 },
      observedHours: { type: "number", minimum: 0 },
      temperatureDegreeHours: { type: "number", minimum: 0 },
      humidityOutsideGuideHours: { type: "number", minimum: 0 },
      co2AboveGuideHours: { type: "number", minimum: 0 },
      comfortTemperatureLowC: { type: "number" },
      comfortTemperatureHighC: { type: "number" },
    },
  },
  HomePerformanceExposure: {
    type: "object",
    additionalProperties: false,
    required: [
      "state", "guideRangePercent", "observedHours", "temperatureDegreeHours",
      "humidityOutsideGuideHours", "co2AboveGuideHours", "worstRoom", "rooms",
    ],
    properties: {
      state: evidenceState,
      guideRangePercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
      observedHours: { type: "number", minimum: 0 },
      temperatureDegreeHours: { type: "number", minimum: 0 },
      humidityOutsideGuideHours: { type: "number", minimum: 0 },
      co2AboveGuideHours: { type: "number", minimum: 0 },
      worstRoom: {
        oneOf: [
          { $ref: "#/components/schemas/HomePerformanceRoomExposure" },
          { type: "null" },
        ],
      },
      rooms: {
        type: "array",
        items: { $ref: "#/components/schemas/HomePerformanceRoomExposure" },
      },
      excludedRooms: { type: "array", items: { type: "string" } },
    },
  },
  HomePerformanceSensorIssue: {
    type: "object",
    additionalProperties: false,
    required: ["code", "sensorId", "sensorName", "metric", "value", "unit"],
    properties: {
      code: { enum: ["low-coverage", "flatline", "changed-baseline"] },
      sensorId: { type: "string" },
      sensorName: { type: "string" },
      metric: { type: "string" },
      value: { type: "number" },
      unit: { type: "string" },
    },
  },
  HomePerformanceResponse: {
    type: "object",
    additionalProperties: false,
    required: [
      "apiVersion", "houseId", "dataMode", "status", "generatedAt", "evaluatedAt",
      "from", "to", "recoveryFrom", "complete", "exposure", "recovery",
      "openingEffectiveness", "energy", "maintenance", "sensorHealth",
      "limitations", "warnings", "provenance", "cache",
    ],
    properties: {
      apiVersion: { const: "1.0" },
      houseId: { type: "string" },
      dataMode: { enum: ["live", "demo"] },
      status: evidenceState,
      generatedAt: { type: "string", format: "date-time" },
      evaluatedAt: { type: "string", format: "date-time" },
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      recoveryFrom: { type: "string", format: "date-time" },
      complete: { type: "boolean" },
      hvacExclusion: { $ref: "#/components/schemas/HvacExclusionSummary" },
      exposure: { $ref: "#/components/schemas/HomePerformanceExposure" },
      recovery: {
        type: "object", additionalProperties: false,
        required: ["state", "episodeCount", "medianHalfLifeMinutes"],
        properties: {
          state: evidenceState,
          episodeCount: { type: "integer", minimum: 0 },
          medianHalfLifeMinutes: { type: ["number", "null"], minimum: 0 },
        },
      },
      openingEffectiveness: {
        type: "object", additionalProperties: false,
        required: [
          "state", "evaluatedEvents", "effectiveEvents",
          "medianClearanceMinutes", "bestOpeningLabel",
        ],
        properties: {
          state: evidenceState,
          evaluatedEvents: { type: "integer", minimum: 0 },
          effectiveEvents: { type: "integer", minimum: 0 },
          medianClearanceMinutes: { type: ["number", "null"], minimum: 0 },
          bestOpeningLabel: { type: ["string", "null"] },
        },
      },
      energy: {
        type: "object", additionalProperties: false,
        required: [
          "state", "energyKwh", "heatingDegreeHours", "energyPerHeatingDegreeHour",
          "comparisonChangePercent", "source",
        ],
        properties: {
          state: evidenceState,
          energyKwh: { type: ["number", "null"], minimum: 0 },
          heatingDegreeHours: { type: "number", minimum: 0 },
          energyPerHeatingDegreeHour: { type: ["number", "null"], minimum: 0 },
          comparisonChangePercent: { type: ["number", "null"] },
          source: { enum: ["heating-meter", "unclassified-electricity", null] },
          heatingBaseTemperatureC: { type: "number" },
          indexMethod: { enum: ["regression", "ratio"] },
          baseLoadKwhPerDay: { type: ["number", "null"] },
          heatingSlopeInterval: {
            oneOf: [
              { type: "object", additionalProperties: false, required: ["low", "high"], properties: { low: { type: "number" }, high: { type: "number" } } },
              { type: "null" },
            ],
          },
          comparisonInterval: {
            oneOf: [
              {
                type: "object", additionalProperties: false, required: ["lowPercent", "highPercent"],
                properties: { lowPercent: { type: "number" }, highPercent: { type: "number" } },
              },
              { type: "null" },
            ],
          },
        },
      },
      maintenance: {
        type: "object", additionalProperties: false,
        required: [
          "state", "evaluatedActions", "improvedActions", "improvementPercent",
          "linkedEvaluatedActions", "completedWithoutMeasurement", "recurringObservations",
        ],
        properties: {
          state: evidenceState,
          evaluatedActions: { type: "integer", minimum: 0 },
          improvedActions: { type: "integer", minimum: 0 },
          improvementPercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
          linkedEvaluatedActions: { type: "integer", minimum: 0 },
          completedWithoutMeasurement: { type: "integer", minimum: 0 },
          recurringObservations: { type: "integer", minimum: 0 },
        },
      },
      sensorHealth: {
        type: "object", additionalProperties: false,
        required: [
          "state", "monitoredSensors", "healthySensors", "coveragePercent", "issues",
        ],
        properties: {
          state: evidenceState,
          monitoredSensors: { type: "integer", minimum: 0 },
          healthySensors: { type: "integer", minimum: 0 },
          coveragePercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
          issues: {
            type: "array",
            items: { $ref: "#/components/schemas/HomePerformanceSensorIssue" },
          },
        },
      },
      limitations: {
        type: "array",
        uniqueItems: true,
        items: {
          enum: [
            "archive-incomplete", "opening-history-missing", "unclassified-energy",
            "maintenance-evidence-missing", "coverage-limited",
          ],
        },
      },
      warnings: {
        type: "array",
        items: { $ref: "#/components/schemas/DerivedAnalyticsWarning" },
      },
      provenance: {
        allOf: [
          { $ref: "#/components/schemas/DerivedAnalyticsProvenance" },
          {
            type: "object",
            required: ["truthClass", "archiveStates"],
            properties: {
              truthClass: { const: "derived" },
              archiveStates: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
      cache: { $ref: "#/components/schemas/DerivedAnalyticsCache" },
    },
  },
} as const;
