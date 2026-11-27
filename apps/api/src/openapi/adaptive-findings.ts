import {
  ADAPTIVE_FINDING_STATES, ADAPTIVE_METRICS, ADAPTIVE_MONITORING_STATES, ADAPTIVE_REVIEW_DISPOSITIONS,
  ADAPTIVE_REVIEW_KEY_LIMIT, ADAPTIVE_REVIEW_NOTE_LIMIT, ADAPTIVE_STREAM_REASONS,
} from "@climate-twin/contracts";

const integer = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const revisionFields = {
  revision: integer, state: { enum: ADAPTIVE_FINDING_STATES },
  evidenceAt: { type: "string", format: "date-time" }, recordedAt: { type: "string", format: "date-time" },
};
const findingFields = {
  ...revisionFields, id: string, epochId: string, epochCurrent: { type: "boolean" }, houseId: string, propertyId: string,
  sensorId: string, kind: { enum: ["climate", "sensor-comparison"] }, metric: { enum: ADAPTIVE_METRICS },
  direction: { enum: ["higher", "lower"] }, severity: { const: "notice" },
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const reviewFields = {
  id: string, findingId: string, findingRevision: integer, disposition: { enum: ADAPTIVE_REVIEW_DISPOSITIONS },
  note: { type: ["string", "null"], maxLength: ADAPTIVE_REVIEW_NOTE_LIMIT }, reportedRecovery: { type: "boolean" },
  supersedesReviewId: { type: ["string", "null"] }, recordedAt: { type: "string", format: "date-time" },
};
const dateTime = { type: "string", format: "date-time" };
const optionalDateTime = { type: ["string", "null"], format: "date-time" };
const streamFields = {
  sensorId: string, metric: { enum: ADAPTIVE_METRICS }, purpose: { enum: ["climate", "sensor-comparison"] },
  epochId: { type: ["string", "null"] }, state: { enum: ADAPTIVE_MONITORING_STATES }, reason: { enum: ADAPTIVE_STREAM_REASONS },
  evaluatedThrough: optionalDateTime, coverage: { type: ["number", "null"], minimum: 0, maximum: 1 },
};
const countFields = Object.fromEntries([...ADAPTIVE_MONITORING_STATES, "total"].map((key) => [key, { type: "integer", minimum: 0 }]));
const snapshotFields = {
  apiVersion: { const: "1.0" }, dataMode: { enum: ["live", "demo"] }, houseId: string, snapshotId: string,
  generatedAt: dateTime, evaluatedAt: dateTime, evaluatedThrough: optionalDateTime,
  completeness: { enum: ["complete", "partial", "unavailable"] },
  warnings: { type: "array", items: ref("DerivedAnalyticsWarning") }, provenance: ref("DerivedAnalyticsProvenance"),
  settings: ref("AdaptiveMonitoringSettings"), state: { enum: ADAPTIVE_MONITORING_STATES },
  counts: { type: "object", additionalProperties: false, required: Object.keys(countFields), properties: countFields },
  streams: {
    type: "object", additionalProperties: false, required: ["items", "nextCursor"],
    properties: { items: { type: "array", items: ref("AdaptiveStreamStatus") }, nextCursor: { type: ["string", "null"] } },
  },
  findings: ref("AdaptiveFindingsPage"),
};

export const adaptiveFindingsSchemas = {
  AdaptiveHomeSnapshot: { type: "object", additionalProperties: false, properties: snapshotFields, required: Object.keys(snapshotFields) },
  AdaptiveStreamStatus: { type: "object", additionalProperties: false, properties: streamFields, required: Object.keys(streamFields) },
  AdaptiveFindingRevision: { type: "object", additionalProperties: false, properties: revisionFields, required: Object.keys(revisionFields) },
  AdaptiveShadowFinding: { type: "object", additionalProperties: false, properties: findingFields, required: Object.keys(findingFields) },
  AdaptiveFindingsPage: {
    type: "object", additionalProperties: false, required: ["items", "nextCursor"],
    properties: { items: { type: "array", items: ref("AdaptiveShadowFinding") }, nextCursor: { type: ["string", "null"] } },
  },
  AdaptiveFindingDetail: {
    type: "object", additionalProperties: false, required: ["finding", "revisions", "latestReview"],
    properties: {
      finding: ref("AdaptiveShadowFinding"),
      latestReview: { anyOf: [ref("AdaptiveFindingReview"), { type: "null" }] },
      revisions: {
        type: "object", additionalProperties: false, required: ["items", "nextBeforeRevision"],
        properties: {
          items: { type: "array", items: ref("AdaptiveFindingRevision") },
          nextBeforeRevision: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
  AdaptiveFindingReview: { type: "object", additionalProperties: false, properties: reviewFields, required: Object.keys(reviewFields) },
  AdaptiveFindingReviewWrite: {
    type: "object", additionalProperties: false, required: ["baseRevision", "idempotencyKey", "disposition"],
    properties: {
      baseRevision: { ...integer, maximum: Number.MAX_SAFE_INTEGER },
      idempotencyKey: { ...string, maxLength: ADAPTIVE_REVIEW_KEY_LIMIT, pattern: "^[A-Za-z0-9._~-]+$" },
      disposition: reviewFields.disposition, note: { type: "string", maxLength: ADAPTIVE_REVIEW_NOTE_LIMIT },
      reportedRecovery: reviewFields.reportedRecovery,
    },
  },
};

const scopeParameters = [
  { name: "houseId", in: "path", required: true, schema: { ...string, maxLength: 200 } },
  { name: "dataMode", in: "query", required: true, schema: { enum: ["live", "demo"] } },
  { name: "limit", in: "query", schema: { ...integer, maximum: 100, default: 50 } },
];
const errors = {
  "400": { description: "Invalid query or cursor" },
  "401": { description: "A session is required" },
  "403": { description: "A signed-in Owner or Admin is required" },
  "404": { description: "The Home or finding is unavailable" },
  "409": { description: "The requested data mode does not match the workspace mode" },
};
const route = { servers: [{ url: "/api/v2" }], tags: ["Measurements"] };

export const adaptiveFindingsPaths = {
  "/monitoring/houses/{houseId}/adaptive": {
    get: {
      ...route, operationId: "getAdaptiveHomeSnapshot",
      description: "Reads the current settings, scope-wide stream status and separate pages of streams and shadow findings.",
      parameters: [...scopeParameters,
        { name: "streamCursor", in: "query", schema: { ...string, maxLength: 2400 } },
        { name: "findingCursor", in: "query", schema: { ...string, maxLength: 2400 } },
        { name: "state", in: "query", schema: { enum: ADAPTIVE_FINDING_STATES } },
        { name: "metric", in: "query", schema: { enum: ADAPTIVE_METRICS } }],
      responses: {
        ...errors, "409": { description: "Data mode mismatch or snapshot changed. Read again without a cursor." },
        "200": { description: "Current private Adaptive Home snapshot", content: { "application/json": { schema: ref("AdaptiveHomeSnapshot") } } },
      },
    },
  },
  "/monitoring/houses/{houseId}/adaptive/findings": {
    get: {
      ...route, operationId: "listAdaptiveShadowFindings",
      description: "Lists stored shadow episodes for the selected Home and data mode. Only signed-in Owners and Admins can read shadow diagnostics.",
      parameters: [...scopeParameters, { name: "cursor", in: "query", schema: { ...string, maxLength: 1200 } },
        { name: "state", in: "query", schema: { enum: ADAPTIVE_FINDING_STATES } },
        { name: "metric", in: "query", schema: { enum: ADAPTIVE_METRICS } }],
      responses: { "200": { description: "Page of stored shadow findings", content: { "application/json": { schema: ref("AdaptiveFindingsPage") } } }, ...errors },
    },
  },
  "/monitoring/houses/{houseId}/adaptive/findings/{findingId}": {
    get: {
      ...route, operationId: "getAdaptiveShadowFinding",
      description: "Reads a stored shadow episode and its recorded revisions.",
      parameters: [...scopeParameters, { name: "findingId", in: "path", required: true, schema: { ...string, maxLength: 80 } },
        { name: "beforeRevision", in: "query", schema: integer }],
      responses: { "200": { description: "Stored shadow episode and revision page", content: { "application/json": { schema: ref("AdaptiveFindingDetail") } } }, ...errors },
    },
  },
  "/monitoring/houses/{houseId}/adaptive/findings/{findingId}/reviews": {
    post: {
      ...route, operationId: "recordAdaptiveFindingReview",
      description: "Records a private review for the signed-in Owner or Admin against the current finding revision. The same key and review content return the original review.",
      parameters: [...scopeParameters.slice(0, 2), { name: "findingId", in: "path", required: true, schema: { ...string, maxLength: 80 } }],
      requestBody: { required: true, content: { "application/json": { schema: ref("AdaptiveFindingReviewWrite") } } },
      responses: {
        ...errors, "409": { description: "Data mode, finding revision or idempotency key conflicts with the request" },
        "200": { description: "Recorded review", content: { "application/json": { schema: ref("AdaptiveFindingReview") } } },
      },
    },
  },
};
