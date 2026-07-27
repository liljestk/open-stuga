import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, stugubyRequestBody, stugubyResponse } from "./part-01.js";

export const operationalOrchestrationPaths = {
  "/properties/{id}/energy-optimization": { get: { tags: ["Energy"], operationId: "getEnergyOptimization", parameters: [{ $ref: "#/components/parameters/Id" }, { name: "windowHours", in: "query", schema: { type: "integer", minimum: 1, maximum: 12, default: 2 } }], responses: { "200": { description: "Transparent, read-only energy optimization report", content: { "application/json": { schema: { type: "object", required: ["report"], properties: { report: { type: "object" } } } } } } } } },
  "/notification-deliveries": { get: { tags: ["Alerts"], operationId: "listNotificationDeliveries", parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }], responses: { "200": { description: "Redacted durable delivery ledger", content: { "application/json": { schema: { type: "object", required: ["deliveries"], properties: { deliveries: { type: "array", items: { type: "object" } } } } } } } } } },
  "/notification-deliveries/{id}/retry": { post: { tags: ["Alerts"], operationId: "retryNotificationDelivery", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Dead-lettered delivery reset for retry", content: { "application/json": { schema: { type: "object", required: ["delivery"], properties: { delivery: { type: "object" } } } } } }, "409": { description: "Delivery is not retryable" } } } },
  "/action-playbooks": {
    get: { tags: ["Alerts"], operationId: "listActionPlaybooks", parameters: [{ name: "metric", in: "query", schema: { type: "string" } }, { name: "enabled", in: "query", schema: { type: "boolean" } }], responses: { "200": { description: "Reusable action playbooks", content: { "application/json": { schema: { type: "object", required: ["playbooks"], properties: { playbooks: { type: "array", items: { type: "object" } } } } } } } } },
    post: { tags: ["Alerts"], operationId: "createActionPlaybook", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": { description: "Created playbook", content: { "application/json": { schema: { type: "object", required: ["playbook"], properties: { playbook: { type: "object" } } } } } } } },
  },
  "/action-playbooks/{id}": { patch: { tags: ["Alerts"], operationId: "updateActionPlaybook", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "Updated playbook", content: { "application/json": { schema: { type: "object", required: ["playbook"], properties: { playbook: { type: "object" } } } } } } } } },
  "/alerts/{id}/action-playbooks": { get: { tags: ["Alerts"], operationId: "listAlertActionPlaybooks", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Enabled playbooks matching an alert metric", content: { "application/json": { schema: { type: "object", required: ["playbooks"], properties: { playbooks: { type: "array", items: { type: "object" } } } } } } } } } },
  "/action-runs": {
    get: { tags: ["Alerts"], operationId: "listActionRuns", parameters: [{ name: "active", in: "query", schema: { type: "boolean" } }, { name: "houseId", in: "query", schema: { type: "string" } }, { name: "sensorId", in: "query", schema: { type: "string" } }, { name: "alertEventId", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } }], responses: { "200": { description: "Before/after action evidence", content: { "application/json": { schema: { type: "object", required: ["runs"], properties: { runs: { type: "array", items: { type: "object" } } } } } } }, "400": { description: "Invalid house identifier or limit" }, "404": { description: "House not found or not visible" } } },
    post: { tags: ["Alerts"], operationId: "startActionRun", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["playbookId", "sensorId"] } } } }, responses: { "201": { description: "Action started with a fresh baseline", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } }, "400": { description: "Invalid action run" }, "404": { description: "Playbook, sensor, or maintenance task not found" }, "409": { description: "Baseline unavailable, action already active, or linked alert/task scope mismatch" } } },
  },
  "/action-runs/{id}/complete": { post: { tags: ["Alerts"], operationId: "completeActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Action completed and automatic verification scheduled", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } } } } },
  "/action-runs/{id}/cancel": { post: { tags: ["Alerts"], operationId: "cancelActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: ["string", "null"] } } } } } }, responses: { "200": { description: "Action run cancelled", content: { "application/json": { schema: { type: "object", required: ["run"], properties: { run: { type: "object" } } } } } } } } },
  "/data-export/preview": { get: { tags: ["Context"], operationId: "previewDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Counts and sensitive categories before export", content: { "application/json": { schema: { type: "object", required: ["preview"], properties: { preview: { type: "object" } } } } } } } } },
  "/data-export": { get: { tags: ["Context"], operationId: "downloadDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Versioned, privacy-scoped streaming JSON export", content: { "application/json": { schema: { type: "object" } } } } } } },
  "/backups/status": { get: { tags: ["Context"], operationId: "getBackupStatus", responses: { "200": { description: "Backup scheduler and isolated restore-drill status", content: { "application/json": { schema: { type: "object", required: ["backup"], properties: { backup: { type: "object" } } } } } } } } },
  "/backups": { post: { tags: ["Context"], operationId: "requestBackup", responses: { "202": { description: "Atomic backup request accepted by the scheduler", content: { "application/json": { schema: { type: "object", required: ["backup"], properties: { backup: { type: "object" } } } } } } } } },
  "/setup/doctor": { get: { tags: ["Integrations"], operationId: "runSetupDoctor", responses: { "200": { description: "Installation readiness checks", content: { "application/json": { schema: { type: "object", required: ["report"], properties: { report: { type: "object" } } } } } } } } },
  "/sensors/{id}/label": { get: { tags: ["Digital twin"], operationId: "getSensorLabel", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Printable and QR-ready local sensor label descriptor", content: { "application/json": { schema: { type: "object", required: ["label"], properties: { label: { type: "object" } } } } } } } } },
  "/setup/bulk-sensor-mappings": { post: { tags: ["Integrations"], operationId: "bulkMapSensors", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId", "mappings"], properties: { houseId: { type: "string" }, mappings: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } } } } } }, responses: { "200": { description: "Atomically validated and saved sensor mappings", content: { "application/json": { schema: { type: "object", required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/Sensor" } } } } } } } } } },
} as const;

export const trackingPathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 200 },
});

export const trackingObject = { type: "object", additionalProperties: true } as const;

export const trackingObserverSecurity = [{ localSession: [] }, { trackingObserverBearer: [] }] as const;

export const trackingObserverBearerSecurity = [{ trackingObserverBearer: [] }] as const;

export const trackingPaths = {
  "/tracking/capabilities": {
    get: { tags: ["Equipment tracking"], operationId: "getTrackingCapabilities", responses: { "200": jsonResponse("Feature-gated BLE tracking capabilities and wire protocol.", { $ref: "#/components/schemas/TrackingCapabilities" }) } },
  },
  "/properties/{propertyId}/tracking-settings": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "getTrackingSettings", responses: { "200": jsonResponse("Property tracking thresholds and boundary.", { type: "object", required: ["settings"], properties: { settings: { $ref: "#/components/schemas/TrackingPropertySettings" } } }) } },
    patch: { tags: ["Equipment tracking"], operationId: "updateTrackingSettings", requestBody: jsonRequestBody(trackingObject), responses: { "200": jsonResponse("Updated property tracking settings.", { type: "object", required: ["settings"], properties: { settings: { $ref: "#/components/schemas/TrackingPropertySettings" } } }) } },
  },
  "/tracking/tags": {
    get: { tags: ["Equipment tracking"], operationId: "listTrackingTags", parameters: [{ name: "propertyId", in: "query", required: true, schema: { type: "string" } }], responses: { "200": jsonResponse("Registered tags without secret material.", { type: "object", required: ["tags"], properties: { tags: { type: "array", items: { $ref: "#/components/schemas/TrackingTag" } } } }) } },
    post: { tags: ["Equipment tracking"], operationId: "createTrackingTag", requestBody: jsonRequestBody(trackingObject), responses: { "201": jsonResponse("Provisioned tag; secret material is returned only in this response.", trackingObject) } },
  },
  "/tracking/tags/{tagId}/claim": {
    parameters: [trackingPathParameter("tagId")],
    post: { tags: ["Equipment tracking"], operationId: "claimTrackingTag", responses: { "200": jsonResponse("Claimed tag.", { type: "object", required: ["tag"], properties: { tag: { $ref: "#/components/schemas/TrackingTag" } } }) } },
  },
  "/tracking/tags/{tagId}/assign": {
    parameters: [trackingPathParameter("tagId")],
    post: { tags: ["Equipment tracking"], operationId: "assignTrackingTag", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["equipmentId"], properties: { equipmentId: { type: "string", minLength: 1 } } }), responses: { "201": jsonResponse("Created an immutable-history asset/tag assignment.", trackingObject) } },
  },
  "/tracking/tags/{tagId}/assignment": {
    parameters: [trackingPathParameter("tagId")],
    delete: { tags: ["Equipment tracking"], operationId: "unassignTrackingTag", responses: { "200": jsonResponse("Closed the active asset/tag assignment.", trackingObject) } },
  },
  "/tracking/tags/{tagId}/rotate-secret": {
    parameters: [trackingPathParameter("tagId")],
    post: { tags: ["Equipment tracking"], operationId: "rotateTrackingTagSecret", responses: { "200": jsonResponse("Rotated tag secret; new material is returned only in this response.", trackingObject) } },
  },
  "/properties/{propertyId}/tracking-observers": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "listTrackingObservers", responses: { "200": jsonResponse("Property gateways and authorized mobile observers.", { type: "object", required: ["observers"], properties: { observers: { type: "array", items: { $ref: "#/components/schemas/TrackingObserver" } } } }) } },
  },
  "/tracking/observers/register": {
    post: { tags: ["Equipment tracking"], operationId: "registerTrackingObserver", requestBody: jsonRequestBody(trackingObject), responses: { "201": jsonResponse("Registered observer; the opaque credential is returned only once.", trackingObject) } },
  },
  "/tracking/observers/{observerId}": {
    parameters: [trackingPathParameter("observerId")],
    patch: { tags: ["Equipment tracking"], operationId: "updateTrackingObserver", requestBody: jsonRequestBody(trackingObject), responses: { "200": jsonResponse("Updated observer metadata or status.", { type: "object", required: ["observer"], properties: { observer: { $ref: "#/components/schemas/TrackingObserver" } } }) } },
  },
  "/tracking/observers/{observerId}/heartbeat": {
    parameters: [trackingPathParameter("observerId")],
    post: { security: trackingObserverBearerSecurity, tags: ["Equipment tracking"], operationId: "heartbeatTrackingObserver", requestBody: jsonRequestBody(trackingObject), responses: { "200": jsonResponse("Updated observer health.", { type: "object", required: ["observer"], properties: { observer: { $ref: "#/components/schemas/TrackingObserver" } } }) } },
  },
  "/tracking/observers/{observerId}/position": {
    parameters: [trackingPathParameter("observerId")],
    post: { tags: ["Equipment tracking"], operationId: "positionTrackingObserver", requestBody: jsonRequestBody(trackingObject), responses: { "200": jsonResponse("Updated fixed gateway position and zone.", { type: "object", required: ["observer"], properties: { observer: { $ref: "#/components/schemas/TrackingObserver" } } }) } },
  },
  "/tracking/observations:batch": {
    post: { security: trackingObserverSecurity, tags: ["Equipment tracking"], operationId: "ingestTrackingObservations", requestBody: jsonRequestBody({ $ref: "#/components/schemas/TrackingObservationBatchInput" }), responses: { "200": jsonResponse("Idempotent observation admission results.", { $ref: "#/components/schemas/TrackingObservationBatchResult" }) } },
  },
  "/properties/{propertyId}/equipment-loans": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment"], operationId: "listEquipmentLoans", parameters: [{ name: "equipmentId", in: "query", schema: { type: "string", minLength: 1, maxLength: 200 } }, { name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }], responses: { "200": jsonResponse("Property equipment borrowing history.", { type: "object", additionalProperties: false, required: ["loans"], properties: { loans: { type: "array", items: { $ref: "#/components/schemas/EquipmentLoan" } } } }) } },
  },
  "/area-equipment/{equipmentId}/borrow": {
    parameters: [trackingPathParameter("equipmentId")],
    post: { tags: ["Equipment"], operationId: "borrowEquipment", requestBody: jsonRequestBody({ $ref: "#/components/schemas/EquipmentBorrowInput" }), responses: { "201": jsonResponse("Equipment checked out to the authenticated Property member.", { type: "object", additionalProperties: false, required: ["loan"], properties: { loan: { $ref: "#/components/schemas/EquipmentLoan" } } }), "409": { description: "Equipment is already borrowed" } } },
  },
  "/equipment-loans/{loanId}/return": {
    parameters: [trackingPathParameter("loanId")],
    post: { tags: ["Equipment"], operationId: "returnEquipment", requestBody: jsonRequestBody({ $ref: "#/components/schemas/EquipmentReturnInput" }), responses: { "200": jsonResponse("Equipment returned; repeated returns are idempotent.", { type: "object", additionalProperties: false, required: ["loan"], properties: { loan: { $ref: "#/components/schemas/EquipmentLoan" } } }) } },
  },
  "/properties/{propertyId}/member-locations": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "listPropertyMemberLocations", description: "Current explicitly shared member positions only; expired entries and location trails are omitted.", responses: { "200": jsonResponse("Active Property member locations.", { type: "object", additionalProperties: false, required: ["locations"], properties: { locations: { type: "array", items: { $ref: "#/components/schemas/PropertyMemberLocation" } } } }) } },
  },
  "/properties/{propertyId}/member-location": {
    parameters: [trackingPathParameter("propertyId")],
    put: { tags: ["Equipment tracking"], operationId: "sharePropertyMemberLocation", description: "Explicitly starts or refreshes foreground, time-limited sharing for the authenticated member.", requestBody: jsonRequestBody({ $ref: "#/components/schemas/PropertyMemberLocationInput" }), responses: { "200": jsonResponse("Current shared position.", { type: "object", additionalProperties: false, required: ["location"], properties: { location: { $ref: "#/components/schemas/PropertyMemberLocation" } } }) } },
    delete: { tags: ["Equipment tracking"], operationId: "stopPropertyMemberLocation", description: "Immediately removes the authenticated member's current shared position.", responses: { "204": { description: "Location sharing stopped and current position removed" } } },
  },
  "/properties/{propertyId}/tracked-assets": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "listTrackedEquipment", responses: { "200": jsonResponse("Current state for assigned equipment.", trackingObject), "413": { description: "The Property inventory exceeds the supported tracking join size." } } },
  },
  "/assets/{equipmentId}/position": {
    parameters: [trackingPathParameter("equipmentId")],
    get: { tags: ["Equipment tracking"], operationId: "getTrackedEquipmentPosition", responses: { "200": jsonResponse("Current uncertainty-aware position estimate.", trackingObject) } },
  },
  "/assets/{equipmentId}/position-history": {
    parameters: [trackingPathParameter("equipmentId")],
    get: { tags: ["Equipment tracking"], operationId: "getTrackedEquipmentPositionHistory", parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }], responses: { "200": jsonResponse("Versioned derived position history.", trackingObject) } },
  },
  "/assets/{equipmentId}/observations": {
    parameters: [trackingPathParameter("equipmentId")],
    get: { tags: ["Equipment tracking"], operationId: "getTrackedEquipmentEvidence", parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }], responses: { "200": jsonResponse("Auditable raw evidence; mobile coordinates are role-redacted.", trackingObject) } },
  },
  "/assets/{equipmentId}/tracking-scan-token": {
    parameters: [trackingPathParameter("equipmentId")],
    get: { tags: ["Equipment tracking"], operationId: "createTrackingScanToken", responses: { "200": jsonResponse("Short-lived rotating identifiers for an authorized foreground Find session.", { $ref: "#/components/schemas/TrackingScanToken" }) } },
  },
  "/properties/{propertyId}/tracking-map-snapshot": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "getTrackingMapSnapshot", responses: { "200": jsonResponse("Sequence-consistent tracking map snapshot.", { $ref: "#/components/schemas/TrackingMapSnapshot" }), "413": { description: "The Property inventory exceeds the supported tracking join size." } } },
  },
  "/properties/{propertyId}/tracking-stream": {
    parameters: [trackingPathParameter("propertyId")],
    get: { tags: ["Equipment tracking"], operationId: "streamTrackingUpdates", description: "Ordered SSE updates. Reconnect with Last-Event-ID and refresh the snapshot when the server emits snapshot-required.", parameters: [{ name: "sequence", in: "query", schema: { type: "integer", minimum: 0 } }], responses: { "200": { description: "Ordered equipment tracking event stream.", content: { "text/event-stream": { schema: { type: "string" } } } } } },
  },
} as const;

export const stugubyIdParameter = { name: "stugubyId", in: "path", required: true, schema: { type: "string", format: "uuid" } } as const;

export const stugubyNodeSecurity = [{ stugubyNodeSignature: [] }] as const;

export const stugubyObject = { type: "object", additionalProperties: true } as const;

export const stugubyPaths = {
  "/stugbys": {
    get: { tags: ["Stuguby"], operationId: "listStugubys", responses: { "200": jsonResponse("Local node identity, server-owned coordinator origin, and joined Stugubys.", stugubyObject) } },
    post: { tags: ["Stuguby"], operationId: "createStuguby", description: "Creates a coordinator-led federation at the server-owned STUGBY_PUBLIC_ORIGIN. Joining or creating shares no Home data.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", maxLength: 200 }, description: { type: ["string", "null"] } } }), responses: { "201": jsonResponse("Created Stuguby.", stugubyObject), "503": { description: "A public coordinator origin is not configured" } } },
  },
  "/stugbys/configuration": { put: { tags: ["Stuguby"], operationId: "configureStugubyCoordinator", description: "Verifies and saves the server-owned public HTTPS coordinator origin when deployment configuration did not provide one.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["publicOrigin"], properties: { publicOrigin: { type: "string", format: "uri" } } }), responses: { "200": jsonResponse("Verified and saved coordinator configuration.", { type: "object", required: ["publicOrigin"], properties: { publicOrigin: { type: "string", format: "uri" } } }), "409": { description: "The origin is deployment-managed or already pinned by an established Stuguby" }, "422": { description: "The secure Stugu address could not be reached and verified" } } } },
  "/stugbys/join": { post: { tags: ["Stuguby"], operationId: "joinStuguby", description: "Consumes a one-time node invitation. No dataset is shared by joining.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["coordinatorUrl", "invitationId", "joinSecret"], properties: { coordinatorUrl: { type: "string", format: "uri" }, invitationId: { type: "string" }, joinSecret: { type: "string", writeOnly: true } } }), responses: { "201": jsonResponse("Joined Stuguby.", stugubyObject) } } },
  "/stugbys/{stugubyId}": { parameters: [stugubyIdParameter], get: { tags: ["Stuguby"], operationId: "getStuguby", responses: { "200": jsonResponse("Roster, grants, Property adoption, queues, conflicts, recovery state, and remote projections.", stugubyObject) } }, delete: { tags: ["Stuguby"], operationId: "deleteStuguby", description: "Permanently removes local federation state after memberships, grants, and replica-deletion acknowledgements are closed. Local Home data is unchanged.", responses: { "204": { description: "Stuguby deleted from this Stugu" }, "409": { description: "Membership, sharing, or deletion obligations remain active" } } } },
  "/stugbys/{stugubyId}/invitations": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "createStugubyInvitation", requestBody: jsonRequestBody({ type: "object", required: ["role"], properties: { role: { enum: ["property-manager", "participant", "viewer"] }, localLabel: { type: "string", maxLength: 200, description: "Private name or email retained only by this Stugu installation." }, expiresAt: { type: "string", format: "date-time" } } }), responses: { "201": jsonResponse("One-time invitation; its join secret is returned only once.", stugubyObject), "503": { description: "The configured coordinator origin is unavailable or does not match this Stuguby" } } } },
  "/stugbys/{stugubyId}/invitations/{invitationId}": { parameters: [stugubyIdParameter, { name: "invitationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], delete: { tags: ["Stuguby"], operationId: "revokeStugubyInvitation", responses: { "204": { description: "Invitation revoked" } } } },
  "/stugbys/{stugubyId}/members/{nodeId}": { parameters: [stugubyIdParameter, { name: "nodeId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], patch: { tags: ["Stuguby"], operationId: "updateStugubyMember", description: "Deactivation fails while grants or replica-deletion acknowledgements remain outstanding.", requestBody: jsonRequestBody({ type: "object", required: ["role", "state"], properties: { role: { enum: ["steward", "property-manager", "participant", "viewer"] }, state: { enum: ["active", "suspended", "left", "revoked"] } } }), responses: { "200": jsonResponse("Updated node membership.", stugubyObject), "409": { description: "Shared data or deletion acknowledgement is still outstanding" } } } },
  "/stugbys/{stugubyId}/members/{nodeId}/label": { parameters: [stugubyIdParameter, { name: "nodeId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], patch: { tags: ["Stuguby"], operationId: "updateStugubyMemberLabel", description: "Updates a private local label. The value is never sent through the Stuguby protocol.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["localLabel"], properties: { localLabel: { type: ["string", "null"], maxLength: 200 } } }), responses: { "200": jsonResponse("Updated private member label.", stugubyObject) } } },
  "/stugbys/{stugubyId}/property": { parameters: [stugubyIdParameter], get: { tags: ["Stuguby"], operationId: "getStugubySharedProperty", responses: { "200": jsonResponse("Coordinator-owned shared Property aggregate.", stugubyObject) } }, put: { tags: ["Stuguby"], operationId: "updateStugubySharedProperty", description: "Queues or applies a collaborative shared Property update. The coordinator is authoritative for same-field conflicts. Integration and control fields are rejected.", requestBody: jsonRequestBody({ type: "object", required: ["baseRevision", "property"], properties: { baseRevision: { type: "integer", minimum: 1 }, property: stugubyObject } }), responses: { "200": jsonResponse("Updated or queued shared Property.", stugubyObject), "409": { description: "Policy, role, or revision conflict" } } } },
  "/stugbys/{stugubyId}/property/adopt": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "adoptStugubyProperty", description: "Connects the Host's selected local Property or materializes the Host Property on a Client. Connecting a Host Property publishes a recommended read-only overview of its Homes.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, properties: { localPropertyId: { type: "string" } } }), responses: { "201": jsonResponse("Connected shared Property.", stugubyObject) } } },
  "/stugbys/{stugubyId}/property/migrate": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "migrateLocalPropertyIntoStuguby", description: "Client-only operation that moves every Home and Property item into the adopted Host Property, deletes the empty source Property, preserves local Home authority and history, and creates recommended read-only Home overview grants.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["sourcePropertyId", "confirmation"], properties: { sourcePropertyId: { type: "string" }, confirmation: { const: "MIGRATE" } } }), responses: { "200": jsonResponse("Moved Property content while retaining local Home identities, history, and authority.", stugubyObject), "409": { description: "Property cannot be migrated" } } } },
  "/stugbys/{stugubyId}/property/disconnect": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "disconnectStugubyProperty", description: "Explicit permanent disconnect. Promotes the inherited Property and only complete, designated recovery Homes; temporary outages never trigger this.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["confirmation"], properties: { confirmation: { const: "DISCONNECT" } } }), responses: { "200": jsonResponse("Disconnected Property and eligible recovery Homes.", stugubyObject), "409": { description: "A designated recovery copy is incomplete" } } } },
  "/stugbys/{stugubyId}/property-conflicts/{commandId}/resolve": { parameters: [stugubyIdParameter, { name: "commandId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], post: { tags: ["Stuguby"], operationId: "resolveStugubyPropertyConflict", description: "Marks a Server-wins Property conflict as reviewed.", responses: { "204": { description: "Conflict marked reviewed" }, "404": { description: "Open conflict not found" } } } },
  "/stugbys/{stugubyId}/grants": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "createStugubyShareGrant", description: "Creates an explicit per-Home grant. A Home may have only one active grant in a Stuguby. Homes are read-only by default; the owner may enable synchronized edits or designate one full-recovery successor.", requestBody: jsonRequestBody(stugubyObject), responses: { "201": jsonResponse("Created share grant.", stugubyObject), "409": { description: "The Home already has an active share grant." } } } },
  "/stugbys/{stugubyId}/publications/{houseId}": { parameters: [stugubyIdParameter, { name: "houseId", in: "path", required: true, schema: { type: "string" } }], get: { tags: ["Stuguby"], operationId: "getLocalStugubyPublicationCatalog", description: "Local-admin-only mapping used to select a Home's sensors by federation publication ID. It is never sent as a federation dataset.", responses: { "200": jsonResponse("Local publication catalog.", stugubyObject) } } },
  "/stugbys/{stugubyId}/grants/{grantId}": { parameters: [stugubyIdParameter, { name: "grantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], put: { tags: ["Stuguby"], operationId: "updateStugubyShareGrant", description: "Tombstones the previous epoch before publishing the replacement.", requestBody: jsonRequestBody(stugubyObject), responses: { "200": jsonResponse("Updated share grant.", stugubyObject) } }, delete: { tags: ["Stuguby"], operationId: "revokeStugubyShareGrant", responses: { "200": jsonResponse("Revoked grant and queued replica purge.", stugubyObject) } } },
  "/stugbys/{stugubyId}/grants/{grantId}/republish": { parameters: [stugubyIdParameter, { name: "grantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], post: { tags: ["Stuguby"], operationId: "republishStugubyGrant", responses: { "202": jsonResponse("Fresh snapshots queued.", { type: "object", required: ["queued"], properties: { queued: { const: true } } }) } } },
  "/stugbys/{stugubyId}/sync": { parameters: [stugubyIdParameter], post: { tags: ["Stuguby"], operationId: "syncStuguby", responses: { "200": jsonResponse("Outbox flushed and durable coordinator cursor pulled.", stugubyObject) } } },
  "/stugbys/{stugubyId}/telemetry": { parameters: [stugubyIdParameter], get: { tags: ["Stuguby"], operationId: "queryStugubyRemoteTelemetry", description: "Queries the separate read-only remote telemetry projection.", responses: { "200": jsonResponse("Granted remote samples.", { type: "object", required: ["samples"], properties: { samples: { type: "array", items: stugubyObject } } }) } } },
  "/stugbys/{stugubyId}/assets/{digest}": { parameters: [stugubyIdParameter, { name: "digest", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], get: { tags: ["Stuguby"], operationId: "downloadLocalStugubyAsset", description: "Returns a locally cached, access-controlled floor-plan or recovery asset.", responses: { "200": { description: "Granted image or 3D Home asset", content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } }, "model/gltf+json": { schema: { type: "string", format: "binary" } }, "model/gltf-binary": { schema: { type: "string", format: "binary" } } } }, "404": { description: "Asset or Stuguby not found" } } } },
  "/stugby-protocol/join": { post: { security: [], tags: ["Stuguby"], operationId: "acceptStugubyNodeJoin", description: "One-time Ed25519-proven node admission.", requestBody: stugubyRequestBody(stugubyObject), responses: { "201": stugubyResponse("Activated node membership.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/events": { parameters: [stugubyIdParameter], get: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "pullStugubyEvents", description: "Cursor-resumable durable event page.", responses: { "200": stugubyResponse("Signed event page.", stugubyObject) } }, post: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "publishStugubyEvents", description: "At-least-once signed event batch admitted against grants, roles, and edit policies.", requestBody: stugubyRequestBody(stugubyObject), responses: { "200": stugubyResponse("Accepted and duplicate event ids.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/events/stream": { parameters: [stugubyIdParameter], get: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "streamStugubyAvailability", description: "SSE carries only durable cursor-availability notifications; event bodies are pulled over HTTPS.", responses: { "200": { description: "Server-Sent Events", content: { "text/event-stream": { schema: { type: "string" } } } } } } },
  "/stugby-protocol/stugbys/{stugubyId}/blobs/{digest}": { parameters: [stugubyIdParameter, { name: "digest", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], get: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "downloadStugubyBlob", responses: { "200": { description: "Audience-authorized content-addressed Home asset", content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } }, "model/gltf+json": { schema: { type: "string", format: "binary" } }, "model/gltf-binary": { schema: { type: "string", format: "binary" } } } } } }, put: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "uploadStugubyBlob", responses: { "201": stugubyResponse("Validated content-addressed Home asset.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/property": { parameters: [stugubyIdParameter], put: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "forwardStugubyPropertyUpdate", requestBody: stugubyRequestBody(stugubyObject), responses: { "200": stugubyResponse("Updated coordinator-owned Property.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/property-commands": { parameters: [stugubyIdParameter], post: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "applyStugubyPropertyCommand", description: "Applies one durable collaborative Property command with Server-authoritative same-field conflict handling.", requestBody: stugubyRequestBody(stugubyObject), responses: { "200": stugubyResponse("Applied or conflicted Property command.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/home-commands": { parameters: [stugubyIdParameter], post: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "applyStugubyHomeCommand", description: "Applies a durable Home command only when the authoritative owner enabled synchronized edits.", requestBody: stugubyRequestBody(stugubyObject), responses: { "200": stugubyResponse("Applied or conflicted Home command.", stugubyObject) } } },
  "/stugby-protocol/stugbys/{stugubyId}/deletion-receipts": { parameters: [stugubyIdParameter], post: { security: stugubyNodeSecurity, tags: ["Stuguby"], operationId: "acknowledgeStugubyDeletion", responses: { "204": { description: "Replica purge acknowledged" } } } },
} as const;
