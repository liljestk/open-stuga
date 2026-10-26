import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

const minuteAnalyticsResolution = {
  type: "string",
  pattern: "^(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|1[0-3][0-9]{2}|14[0-3][0-9]|1440)m$",
  description: "A whole-minute bucket from 1m through 1440m.",
} as const;
const analyticsResolution = {
  anyOf: [{ enum: ["auto", "raw", "1h", "1d"] }, minuteAnalyticsResolution],
} as const;
const resolvedAnalyticsResolution = {
  anyOf: [{ enum: ["raw", "1h", "1d"] }, minuteAnalyticsResolution],
} as const;

export const schemasPart01 = {
  ...localAuthSchemas,
  ...spatialLayerSchemas,
  MeasurementDefinition: {
          type: "object",
          required: ["id", "labels", "unit", "dimension", "allowedUnits", "kind", "defaultAggregation", "genericHistoryEnabled", "genericStatsEnabled", "precision", "validMin", "validMax", "displayMin", "displayMax", "interpolationDelta", "colorScale", "builtin", "enabled", "spatialInterpolation", "forecastSupported"],
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$", maxLength: 64 },
            labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
            unit: { type: "string", description: "Empty for dimensionless built-in measurements." },
            dimension: { type: "string", minLength: 1 },
            allowedUnits: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string" } },
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
            resolution: analyticsResolution,
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
            unscaledValue: { type: "number" },
          },
        },
  AnalyticsFindingWeatherAdjustment: {
          type: "object", additionalProperties: false,
          required: ["driver", "slope", "currentDriver", "baselineDriverMedian", "unadjustedBaselineMedian"],
          properties: {
            driver: { enum: ["heating-degree-hours", "outdoor-temperature"] }, baseTemperatureC: { type: "number" },
            slope: { type: "number" }, currentDriver: { type: "number" }, baselineDriverMedian: { type: "number" },
            unadjustedBaselineMedian: { type: "number" },
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
            zScore: { type: "number" }, qValue: { type: "number", minimum: 0, maximum: 1 },
            spreadBasis: { enum: ["between-years", "assumed", "day-to-day", "resolution", "counts"] },
            weatherAdjustment: { $ref: "#/components/schemas/AnalyticsFindingWeatherAdjustment" },
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
            seriesTested: { type: "integer", minimum: 0 }, falseDiscoveryRate: { type: "number", exclusiveMinimum: 0, maximum: 1 },
          },
        },
  DailyAnalyticsFindingsResponse: {
          type: "object", additionalProperties: false, required: ["snapshot", "status"],
          properties: {
            snapshot: { oneOf: [{ $ref: "#/components/schemas/DailyAnalyticsFindingsSnapshot" }, { type: "null" }] },
            status: { type: "object", additionalProperties: false, required: ["state", "lastAttemptAt", "lastError"], properties: {
              state: { enum: ["pending", "ready", "failed", "stale-algorithm"] },
              lastAttemptAt: { type: ["string", "null"], format: "date-time" },
              lastError: { type: ["string", "null"] },
              expectedAlgorithmVersion: { type: "string" },
              actualAlgorithmVersion: { type: "string" },
            } },
          },
        },
  DerivedAnalyticsWarning: {
          type: "object", additionalProperties: false, required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
        },
  DerivedAnalyticsProvenance: {
          type: "object", additionalProperties: false,
          required: ["algorithmKey", "algorithmVersion", "evaluatedAt", "sourceIds"],
          properties: {
            algorithmKey: { type: "string" },
            algorithmVersion: { type: "string" },
            evaluatedAt: { type: "string", format: "date-time" },
            sourceIds: { type: "array", uniqueItems: true, items: { type: "string" } },
            archiveState: { enum: ["not-configured", "not-ready", "merged", "failed"] },
            truthClass: { const: "derived" },
            archiveStates: { type: "array", items: { type: "string" } },
          },
        },
  OpeningActivityRequest: {
          type: "object", additionalProperties: false,
          required: ["apiVersion", "requestId", "houseId", "dataMode", "range"],
          properties: {
            apiVersion: { const: "1.0" },
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            dataMode: { enum: ["live", "demo"] },
            range: {
              type: "object", additionalProperties: false, required: ["start", "end"],
              properties: {
                start: { type: "string", format: "date-time" },
                end: { type: "string", format: "date-time" },
              },
            },
            elementIds: {
              type: "array", maxItems: 500, uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
        },
  OpeningActivityTarget: {
          type: "object", additionalProperties: false,
          required: ["key", "floorId", "floorName", "elementId", "kind", "label", "ordinal"],
          properties: {
            key: { type: "string" },
            floorId: { type: "string" },
            floorName: { type: "string" },
            elementId: { type: "string" },
            kind: { enum: ["door", "window"] },
            label: { type: ["string", "null"] },
            ordinal: { type: "integer", minimum: 1 },
          },
        },
  OpeningActivitySeries: {
          type: "object", additionalProperties: false,
          required: ["target", "segments", "records", "observationCount", "openedCount", "closedCount", "confirmedOpenMs", "longestOpenMs", "currentState", "currentSince", "lastObservedAt"],
          properties: {
            target: { $ref: "#/components/schemas/OpeningActivityTarget" },
            segments: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["state", "startedAt", "endedAt"],
                properties: {
                  state: { enum: ["open", "closed"] },
                  startedAt: { type: "string", format: "date-time" },
                  endedAt: { type: "string", format: "date-time" },
                },
              },
            },
            records: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["id", "observedAt", "state", "source", "transition"],
                properties: {
                  id: { type: "string" },
                  observedAt: { type: "string", format: "date-time" },
                  state: { enum: ["open", "closed", "unknown"] },
                  source: { enum: ["manual", "home-assistant", "tapo", "api"] },
                  transition: { enum: ["opened", "closed", "unknown", "initial"] },
                },
              },
            },
            observationCount: { type: "integer", minimum: 0 },
            openedCount: { type: "integer", minimum: 0 },
            closedCount: { type: "integer", minimum: 0 },
            confirmedOpenMs: { type: "number", minimum: 0 },
            longestOpenMs: { type: "number", minimum: 0 },
            currentState: { enum: ["open", "closed", "unknown"] },
            currentSince: { type: ["string", "null"], format: "date-time" },
            lastObservedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
  OpeningActivityResponse: {
          type: "object", additionalProperties: false,
          required: ["apiVersion", "requestId", "houseId", "dataMode", "range", "generatedAt", "complete", "truncated", "archiveState", "series", "warnings", "provenance"],
          properties: {
            apiVersion: { const: "1.0" },
            requestId: { type: "string" },
            houseId: { type: "string" },
            dataMode: { enum: ["live", "demo"] },
            range: {
              type: "object", additionalProperties: false, required: ["start", "end"],
              properties: {
                start: { type: "string", format: "date-time" },
                end: { type: "string", format: "date-time" },
              },
            },
            generatedAt: { type: "string", format: "date-time" },
            complete: { type: "boolean" },
            truncated: { type: "boolean" },
            archiveState: { enum: ["not-configured", "not-ready", "merged", "failed"] },
            series: { type: "array", items: { $ref: "#/components/schemas/OpeningActivitySeries" } },
            warnings: { type: "array", items: { $ref: "#/components/schemas/DerivedAnalyticsWarning" } },
            provenance: { $ref: "#/components/schemas/DerivedAnalyticsProvenance" },
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
            resolution: resolvedAnalyticsResolution,
            series: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["entityId", "entityLabel", "measurementId", "canonicalUnit", "truthClass", "aggregation", "resolution", "points", "summary", "provenance"],
                properties: {
                  entityId: { type: "string" }, entityLabel: { type: "string" }, measurementId: { type: "string" }, canonicalUnit: { type: "string" },
                  truthClass: { enum: ["observed", "derived", "estimated", "inferred", "forecast", "simulated"] },
                  aggregation: { enum: ["raw", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"] },
                  resolution: resolvedAnalyticsResolution,
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
            timestamp: { type: "string", format: "date-time" }, source: { enum: ["mock", "home-assistant", "tp-link", "tuya", "nexus433", "gree", "api", "import", "replay"] },
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
} as const;
