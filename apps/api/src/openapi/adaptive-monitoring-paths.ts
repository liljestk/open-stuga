import { ADAPTIVE_METRICS, ADAPTIVE_MODES, ADAPTIVE_STATES, ADAPTIVE_REVIEW_DISPOSITIONS } from "@climate-twin/contracts";

const text = { type: "string" } as const;
const nullableText = { type: ["string", "null"] } as const;
const number = { type: "number" } as const;
const nullableNumber = { type: ["number", "null"] } as const;
const integer = { type: "integer", minimum: 0 } as const;
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: object) => ({ type: "array", items });
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: "object", additionalProperties: false, required: Object.keys(properties).filter(k => !optional.includes(k)), properties,
});
const page = (name: string) => object({ items: array(reference(name)), nextCursor: nullableText });
const dataMode = { enum: ["live", "demo"] };
const scope = [{ name: "houseId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }];
const findingScope = [...scope, { name: "findingId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }];
const modeQuery = { name: "dataMode", in: "query", required: true, schema: dataMode };
const query = (name: string, schema = text as object) => ({ name, in: "query", schema });
const content = (schema: string) => ({ "application/json": { schema: reference(schema) } });
function operation(id: string, response: string, options: { parameters: object[]; body?: string; description: string }) {
  return { operationId: id, servers: [{ url: "/api/v2" }], tags: ["Measurements"], description: options.description,
    parameters: options.parameters, ...(options.body ? { requestBody: { required: true, content: content(options.body) } } : {}),
    responses: { "200": { description: "Versioned, bounded adaptive monitoring result", content: content(response) },
      "400": { description: "Malformed input" }, "403": { description: "Write, diagnostic or remote Home access denied" },
      "404": { description: "Home or finding is not visible" }, "409": { description: "Mode, revision, idempotency or continuation conflict" },
      "422": { description: "Reference or promotion evidence is not qualified" }, "503": { description: "Stored evidence unavailable" } } };
}
export const adaptiveMonitoringPaths = {
  "/monitoring/houses/{houseId}/adaptive": { get: operation("getAdaptiveMonitoring", "AdaptiveSnapshot", {
    parameters: [...scope, modeQuery, query("streamCursor"), query("findingCursor"), query("kind", { enum: ["climate-departure", "sensor-comparison"] })],
    description: "Reads persisted local learning state. Off by default; a read never fits models or scans telemetry. Shadow diagnostics are Owner/Admin-only.",
  }) },
  "/monitoring/houses/{houseId}/adaptive/findings": { get: operation("listAdaptiveFindings", "AdaptiveFindingPage", {
    parameters: [...scope, modeQuery, query("cursor"), query("metric", { enum: ADAPTIVE_METRICS }), query("kind", { enum: ["climate-departure", "sensor-comparison"] }),
      query("state", { enum: ["candidate", "presented", "resolved", "expired"] }), query("activeOnly", { type: "boolean", default: false }), query("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 })],
    description: "Keyset-paged, authorized finding episodes; shadow candidates are restricted to administrators.",
  }) },
  "/monitoring/houses/{houseId}/adaptive/findings/{findingId}": { get: operation("getAdaptiveFinding", "AdaptiveFindingDetail", {
    parameters: [...findingScope, modeQuery, query("cursor")], description: "One episode with bounded, administrator-only revision history.",
  }) },
  "/monitoring/houses/{houseId}/adaptive/settings": { patch: operation("updateAdaptiveSettings", "AdaptiveSettings", {
    parameters: scope, body: "AdaptiveSettingsPatch", description: "Owner/Admin opt-in, reference groups and explicit baseline resets. Advisory requires a trusted evaluation receipt.",
  }) },
  "/monitoring/houses/{houseId}/adaptive/findings/{findingId}/reviews": { post: operation("reviewAdaptiveFinding", "AdaptiveFinding", {
    parameters: findingScope, body: "AdaptiveReviewInput", description: "An idempotent, revision-checked personal review; never resolves a finding or creates a fault label automatically.",
  }) },
};
export const adaptiveMonitoringSchemas = {
  AdaptiveReferenceGroup: object({ sensorId: text, peerIds: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: text }, designatedReference: { type: "boolean" } }),
  AdaptiveSettings: object({ revision: integer, mode: { enum: ADAPTIVE_MODES }, enabledAt: nullableText,
    referenceGroups: array(reference("AdaptiveReferenceGroup")), promotionReceiptId: nullableText }),
  AdaptiveSettingsPatch: object({ dataMode, baseRevision: integer, mode: { enum: ADAPTIVE_MODES },
    referenceGroups: { type: "array", maxItems: 80, items: reference("AdaptiveReferenceGroup") },
    resetBaseline: object({ sensorId: text, reason: { type: "string", minLength: 1, maxLength: 1000 } }),
    promotionReceiptId: { type: "string", minLength: 1, maxLength: 200 } }, ["mode", "referenceGroups", "resetBaseline", "promotionReceiptId"]),
  AdaptiveEvaluation: object({ model: { enum: ["daily-profile", "thermal-relaxation", "reference-offset"] },
    evaluatedAt: text, trainingCutoff: text, calibrationHours: integer, holdoutHours: integer,
    coverage: nullableNumber, mae: nullableNumber, baselineMae: nullableNumber, qualified: { type: "boolean" }, reason: text }),
  AdaptiveStream: object({ id: text, sensorId: text, sensorName: text, floorId: text, room: text,
    metric: { enum: ADAPTIVE_METRICS }, kind: { enum: ["climate-departure", "sensor-comparison"] },
    epoch: text, epochStartedAt: text, state: { enum: ADAPTIVE_STATES }, reason: text, usableHours: integer,
    evaluatedThrough: nullableText, evaluation: { anyOf: [reference("AdaptiveEvaluation"), { type: "null" }] } }),
  AdaptiveReview: object({ id: text, revision: integer, disposition: { enum: ADAPTIVE_REVIEW_DISPOSITIONS }, note: text, recordedAt: text }),
  AdaptiveReviewInput: object({ dataMode, baseRevision: integer, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    disposition: { enum: ADAPTIVE_REVIEW_DISPOSITIONS }, note: { type: "string", maxLength: 2000 } }, ["note"]),
  AdaptiveFinding: object({ id: text, revision: integer, houseId: text, propertyId: text, sensorId: text, sensorName: text,
    floorId: text, room: text, epoch: text, metric: { enum: ADAPTIVE_METRICS }, kind: { enum: ["climate-departure", "sensor-comparison"] },
    direction: { enum: ["high", "low"] }, severity: { const: "notice" }, state: { enum: ["candidate", "presented", "resolved", "expired"] },
    firstEvidenceAt: text, lastEvidenceAt: text, recordedAt: text, freshness: { enum: ["fresh", "stale"] },
    observed: number, expected: number, low: number, high: number, unit: text, coverage: number,
    sourceIds: array(text), contextGaps: array(text), modelId: text, review: { anyOf: [reference("AdaptiveReview"), { type: "null" }] } }),
  AdaptiveFindingPage: page("AdaptiveFinding"),
  AdaptiveFindingDetail: object({ finding: reference("AdaptiveFinding"), revisions: page("AdaptiveFinding") }),
  AdaptiveSnapshot: object({ apiVersion: { const: "1.0" }, dataMode, generatedAt: text, evaluatedAt: text,
    completeness: { enum: ["complete", "partial", "unavailable"] },
    warnings: array(object({ code: text, message: text })),
    provenance: object({ algorithmKey: text, algorithmVersion: text, evaluatedAt: text, sourceIds: array(text) }),
    houseId: text, settings: reference("AdaptiveSettings"), state: { enum: ADAPTIVE_STATES }, reason: text,
    evaluatedThrough: nullableText, streams: page("AdaptiveStream"), findings: page("AdaptiveFinding"),
    counts: object({ streams: integer, ready: integer, findings: integer }) }),
};
