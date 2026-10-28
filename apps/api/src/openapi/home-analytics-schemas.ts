import { ANALYTICS_AGGREGATIONS } from "@climate-twin/contracts";
const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"], format: "date-time" } as const;
const archiveState = { enum: ["not-configured", "not-ready", "merged", "failed"] } as const;
const completeness = { enum: ["complete", "partial", "unavailable"] } as const;
const analyticsAggregation = { enum: ANALYTICS_AGGREGATIONS } as const;
const resolvedAggregation = {
  enum: ["raw", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"],
} as const;
const calendarUnit = { enum: ["day", "week", "month", "year", "decade"] } as const;
const qualityFilter = {
  type: "object",
  additionalProperties: false,
  required: ["include"],
  properties: {
    include: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { enum: ["good", "estimated", "stale"] },
    },
  },
} as const;

export const homeAnalyticsSchemas = {
  HomePulseCoverage: {
    type: "object",
    additionalProperties: false,
    required: [
      "enabledSensors", "freshSensors", "estimatedSensors", "agingSensors",
      "staleSensors", "sensorsWithoutData",
    ],
    properties: {
      enabledSensors: { type: "integer", minimum: 0 },
      freshSensors: { type: "integer", minimum: 0 },
      estimatedSensors: { type: "integer", minimum: 0 },
      agingSensors: { type: "integer", minimum: 0 },
      staleSensors: { type: "integer", minimum: 0 },
      sensorsWithoutData: { type: "integer", minimum: 0 },
    },
  },
  HomeMonitoringBlocker: {
    type: "object",
    additionalProperties: false,
    required: [
      "id", "kind", "code", "parameters", "fallbackMessage", "count",
      "sensorIds", "evidenceAt", "acknowledged",
    ],
    properties: {
      id: { type: "string" },
      kind: {
        enum: [
          "critical-alert", "warning-alert", "information-alert", "no-sensors",
          "missing-data", "stale-data", "source-disconnected", "estimated-data",
          "aging-data",
        ],
      },
      code: { type: "string", pattern: "^monitoring\\.blocker\\." },
      parameters: { type: "object", additionalProperties: true },
      fallbackMessage: { type: "string" },
      count: { type: "integer", minimum: 0 },
      sensorIds: { type: "array", uniqueItems: true, items: { type: "string" } },
      evidenceAt: nullableDateTime,
      acknowledged: { type: "boolean" },
    },
  },
  HomeMonitoringSummary: {
    type: "object",
    additionalProperties: false,
    required: [
      "houseId", "generatedAt", "status", "pulseStatus", "coverage",
      "activeAlertCount", "blockers",
    ],
    properties: {
      houseId: { type: "string" },
      generatedAt: dateTime,
      status: {
        enum: ["action-required", "inspection-recommended", "monitoring-ok", "unknown"],
      },
      pulseStatus: { enum: ["critical", "attention", "watch", "steady", "unknown"] },
      coverage: { $ref: "#/components/schemas/HomePulseCoverage" },
      activeAlertCount: { type: "integer", minimum: 0 },
      blockers: {
        type: "array",
        items: { $ref: "#/components/schemas/HomeMonitoringBlocker" },
      },
    },
  },
  HomeInsightFreshness: {
    type: "object",
    additionalProperties: false,
    required: ["state", "evidenceAt", "ageMinutes"],
    properties: {
      state: { enum: ["fresh", "estimated", "aging", "stale", "unknown"] },
      evidenceAt: nullableDateTime,
      ageMinutes: { type: ["number", "null"], minimum: 0 },
    },
  },
  HomePulseSensorCoverage: {
    type: "object",
    additionalProperties: false,
    required: ["sensorId", "freshness", "requiredMetrics"],
    properties: {
      sensorId: { type: "string" },
      freshness: { $ref: "#/components/schemas/HomeInsightFreshness" },
      requiredMetrics: { type: "array", uniqueItems: true, items: { type: "string" } },
    },
  },
  HomeMonitoringEvidenceSource: {
    type: "object",
    additionalProperties: false,
    required: ["sensorId", "metric", "observedAt", "source", "quality", "freshness"],
    properties: {
      sensorId: { type: "string" },
      metric: { type: "string" },
      observedAt: dateTime,
      source: { enum: ["mock", "home-assistant", "tp-link", "tuya", "nexus433", "gree", "api", "import", "replay"] },
      quality: { enum: ["good", "estimated", "stale"] },
      freshness: { $ref: "#/components/schemas/HomeInsightFreshness" },
    },
  },
  HomeInsight: {
    type: "object",
    additionalProperties: false,
    required: [
      "id", "rank", "kind", "severity", "priority", "titleCode", "summaryCode",
      "actionCode", "parameters", "fallbackTitle", "fallbackSummary",
      "fallbackAction", "target", "evidence", "freshness", "confidence",
    ],
    properties: {
      id: { type: "string" },
      rank: { type: "integer", minimum: 0 },
      kind: {
        enum: [
          "active-alert", "humidity", "indoor-air", "temperature",
          "temperature-balance", "sensor-coverage", "setup",
        ],
      },
      severity: { enum: ["critical", "warning", "notice", "info"] },
      priority: { type: "number" },
      titleCode: { type: "string", pattern: "^monitoring\\.insight\\." },
      summaryCode: { type: "string", pattern: "^monitoring\\.insight\\." },
      actionCode: { type: "string", pattern: "^monitoring\\.insight\\." },
      parameters: { type: "object", additionalProperties: true },
      fallbackTitle: { type: "string" },
      fallbackSummary: { type: "string" },
      fallbackAction: { type: "string" },
      target: { type: "object", additionalProperties: true, required: ["houseId"] },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["label", "value"],
          properties: {
            label: { type: "string" },
            value: { oneOf: [{ type: "number" }, { type: "string" }] },
            unit: { type: "string" },
            metric: { type: "string" },
            sensorId: { type: "string" },
            observedAt: dateTime,
            source: { enum: ["mock", "home-assistant", "tp-link", "tuya", "nexus433", "gree", "api", "import", "replay"] },
            quality: { enum: ["good", "estimated", "stale"] },
            freshness: { $ref: "#/components/schemas/HomeInsightFreshness" },
          },
        },
      },
      freshness: { $ref: "#/components/schemas/HomeInsightFreshness" },
      confidence: {
        type: "object",
        additionalProperties: false,
        required: ["level", "score", "reasonCode", "fallbackReason"],
        properties: {
          level: { enum: ["high", "medium", "low"] },
          score: { type: "number", minimum: 0, maximum: 1 },
          reasonCode: { type: "string", pattern: "^monitoring\\.confidence\\." },
          fallbackReason: { type: "string" },
        },
      },
      safetyNote: { type: "string" },
    },
  },
  HomeMonitoringEnvelope: {
    type: "object",
    required: [
      "apiVersion", "dataMode", "algorithm", "generatedAt", "evaluatedAt",
      "completeness", "warnings", "provenance", "evidenceSources",
    ],
    properties: {
      apiVersion: { const: "1.0" },
      dataMode: { enum: ["live", "demo"] },
      algorithm: {
        type: "object",
        additionalProperties: false,
        required: ["key", "version"],
        properties: {
          key: { const: "home-monitoring" },
          version: { const: "home-monitoring-v2.0.0" },
        },
      },
      generatedAt: dateTime,
      evaluatedAt: dateTime,
      completeness,
      warnings: {
        type: "array",
        items: { $ref: "#/components/schemas/DerivedAnalyticsWarning" },
      },
      provenance: { $ref: "#/components/schemas/DerivedAnalyticsProvenance" },
      evidenceSources: {
        type: "array",
        items: { $ref: "#/components/schemas/HomeMonitoringEvidenceSource" },
      },
    },
  },
  HomeMonitoringCollectionResponse: {
    unevaluatedProperties: false,
    allOf: [
      { $ref: "#/components/schemas/HomeMonitoringEnvelope" },
      {
        type: "object",
        required: ["houses"],
        properties: {
          houses: {
            type: "array",
            items: { $ref: "#/components/schemas/HomeMonitoringSummary" },
          },
        },
      },
    ],
  },
  HomeMonitoringDetailResponse: {
    unevaluatedProperties: false,
    allOf: [
      { $ref: "#/components/schemas/HomeMonitoringEnvelope" },
      {
        type: "object",
        required: [
          "house", "sensorCoverage", "insights", "advisoryCode", "fallbackAdvisory",
        ],
        properties: {
          house: { $ref: "#/components/schemas/HomeMonitoringSummary" },
          sensorCoverage: {
            type: "array",
            items: { $ref: "#/components/schemas/HomePulseSensorCoverage" },
          },
          insights: {
            type: "array",
            items: { $ref: "#/components/schemas/HomeInsight" },
          },
          advisoryCode: { const: "monitoring.advisory" },
          fallbackAdvisory: { type: "string" },
        },
      },
    ],
  },
  CalendarComparisonAnchor: {
    type: "object",
    additionalProperties: false,
    required: ["month", "day", "week"],
    properties: {
      month: { type: "integer", minimum: 1, maximum: 12 },
      day: { type: "integer", minimum: 1, maximum: 31 },
      week: { type: "integer", minimum: 1, maximum: 53 },
    },
  },
  CalendarComparisonRequest: {
    type: "object",
    additionalProperties: false,
    required: [
      "apiVersion", "requestId", "houseId", "dataMode", "sensorIds",
      "measurementId", "unit", "anchor", "aggregation", "qualityFilter",
    ],
    properties: {
      apiVersion: { const: "1.0" },
      requestId: { type: "string", minLength: 1, maxLength: 200 },
      houseId: { type: "string", minLength: 1, maxLength: 200 },
      dataMode: { enum: ["live", "demo"] },
      sensorIds: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
      measurementId: { type: "string", minLength: 1, maxLength: 200 },
      unit: calendarUnit,
      anchor: { $ref: "#/components/schemas/CalendarComparisonAnchor" },
      selectedPeriodKeys: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
      aggregation: analyticsAggregation,
      qualityFilter,
    },
  },
  CalendarComparisonPeriod: {
    type: "object",
    additionalProperties: false,
    required: [
      "key", "unit", "start", "end", "naturalEnd", "year", "month",
      "day", "week", "decade", "partial",
    ],
    properties: {
      key: { type: "string" },
      unit: calendarUnit,
      start: dateTime,
      end: dateTime,
      naturalEnd: dateTime,
      year: { type: "integer" },
      month: { type: ["integer", "null"], minimum: 1, maximum: 12 },
      day: { type: ["integer", "null"], minimum: 1, maximum: 31 },
      week: { type: ["integer", "null"], minimum: 1, maximum: 53 },
      decade: { type: ["integer", "null"] },
      partial: { type: "boolean" },
    },
  },
  CalendarComparisonBucket: {
    type: "object",
    additionalProperties: false,
    required: ["key", "slot", "order", "index", "start", "end", "partial"],
    properties: {
      key: { type: "string" },
      slot: { type: "string" },
      order: { type: "integer" },
      index: { type: "integer", minimum: 0 },
      start: dateTime,
      end: dateTime,
      partial: { type: "boolean" },
    },
  },
  CalendarComparisonValue: {
    type: "object",
    required: ["value", "minimum", "maximum", "sampleCount", "coverage"],
    properties: {
      value: { type: "number" },
      minimum: { type: ["number", "null"] },
      maximum: { type: ["number", "null"] },
      sampleCount: { type: "integer", minimum: 0 },
      coverage: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  CalendarComparisonSeries: {
    type: "object",
    additionalProperties: false,
    required: [
      "id", "sourceId", "sourceLabel", "combination", "period",
      "aggregation", "points", "summary",
    ],
    properties: {
      id: { type: "string" },
      sourceId: { type: "string" },
      sourceLabel: { type: "string" },
      combination: { enum: ["single", "mean", "sum"] },
      period: { $ref: "#/components/schemas/CalendarComparisonPeriod" },
      aggregation: resolvedAggregation,
      points: {
        type: "array",
        items: {
          allOf: [
            { $ref: "#/components/schemas/CalendarComparisonValue" },
            {
              type: "object",
              required: ["bucket"],
              properties: {
                bucket: { $ref: "#/components/schemas/CalendarComparisonBucket" },
              },
            },
          ],
        },
      },
      summary: {
        oneOf: [
          {
            allOf: [
              { $ref: "#/components/schemas/CalendarComparisonValue" },
              {
                type: "object",
                required: ["bucketCount"],
                properties: { bucketCount: { type: "integer", minimum: 0 } },
              },
            ],
          },
          { type: "null" },
        ],
      },
    },
  },
  CalendarComparisonResponse: {
    type: "object",
    additionalProperties: false,
    required: [
      "apiVersion", "requestId", "houseId", "dataMode", "measurementId",
      "unit", "anchor", "aggregation", "qualityFilter", "candidates",
      "selectedPeriods", "series", "comparisons", "archiveState", "generatedAt",
      "evaluatedAt", "completeness", "warnings", "provenance",
    ],
    properties: {
      apiVersion: { const: "1.0" },
      requestId: { type: "string" },
      houseId: { type: "string" },
      dataMode: { enum: ["live", "demo"] },
      measurementId: { type: "string" },
      unit: calendarUnit,
      anchor: { $ref: "#/components/schemas/CalendarComparisonAnchor" },
      aggregation: analyticsAggregation,
      qualityFilter,
      candidates: {
        type: "array",
        items: { $ref: "#/components/schemas/CalendarComparisonPeriod" },
      },
      selectedPeriods: {
        type: "array",
        maxItems: 2,
        items: { $ref: "#/components/schemas/CalendarComparisonPeriod" },
      },
      series: {
        type: "array",
        items: { $ref: "#/components/schemas/CalendarComparisonSeries" },
      },
      comparisons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "sourceId", "currentSeriesId", "baselineSeriesId",
            "commonCompletedBucketCount", "difference",
          ],
          properties: {
            sourceId: { type: "string" },
            currentSeriesId: { type: "string" },
            baselineSeriesId: { type: "string" },
            commonCompletedBucketCount: { type: "integer", minimum: 0 },
            difference: { type: ["number", "null"] },
          },
        },
      },
      archiveState,
      generatedAt: dateTime,
      evaluatedAt: dateTime,
      completeness,
      warnings: {
        type: "array",
        items: { $ref: "#/components/schemas/DerivedAnalyticsWarning" },
      },
      provenance: { $ref: "#/components/schemas/DerivedAnalyticsProvenance" },
    },
  },
} as const;
