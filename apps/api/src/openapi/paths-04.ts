import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

export const pathsPart04 = {
  "/integrations/sensor-data-gaps": {
        get: {
          tags: ["Integrations"],
          operationId: "listSensorDataGaps",
          description: "Lists durable sensor/metric outage intervals and their recovery outcomes.",
          parameters: [
            { $ref: "#/components/parameters/HouseIdQuery" },
            { name: "sensorId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 } },
          ],
          responses: {
            "200": {
              description: "Detected sensor data gaps",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["gaps"],
                    properties: {
                      gaps: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["id", "sensorId", "metric", "source", "startedAt", "detectedAt", "endedAt", "recoveryState", "recoverableUntil", "recoveryCompleteness", "recoveredPoints", "attemptCount", "lastAttemptAt", "nextAttemptAt", "recoveryError"],
                          properties: {
                            id: { type: "integer" },
                            sensorId: { type: "string" },
                            metric: { type: "string" },
                            source: { enum: ["home-assistant", "tp-link"] },
                            startedAt: { type: "string", format: "date-time" },
                            detectedAt: { type: "string", format: "date-time" },
                            endedAt: { type: ["string", "null"], format: "date-time" },
                            recoveryState: { enum: ["open", "pending", "running", "complete", "partial", "failed", "not-supported"] },
                            recoverableUntil: { type: ["string", "null"], format: "date-time", description: "Known local retention deadline; null means source-managed or unknown, not unlimited." },
                            recoveryCompleteness: { enum: ["unknown", "none", "partial", "complete"] },
                            recoveredPoints: { type: "integer", minimum: 0 },
                            attemptCount: { type: "integer", minimum: 0 },
                            lastAttemptAt: { type: ["string", "null"], format: "date-time" },
                            nextAttemptAt: { type: ["string", "null"], format: "date-time" },
                            recoveryError: { type: ["string", "null"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
  "/integrations/discover": { post: { tags: ["Integrations"], operationId: "discoverIntegrations", requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { houseId: { type: "string" }, tpLinkUsername: { type: "string" }, tpLinkPassword: { type: "string", writeOnly: true } } } } } }, responses: { "200": { description: "Best-effort LAN discovery results for Home Assistant, supported TP-Link devices, and Gree-compatible heat pumps", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationDiscoveryResult" } } } } } } },
  "/integrations/discovery-jobs": { post: { tags: ["Integrations"], operationId: "startIntegrationDiscovery", description: "Starts owner-scoped LAN discovery which continues after the initiating request or page closes. Reuses an already-running job for the same Home.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["houseId"], properties: { houseId: { type: "string" }, tpLinkUsername: { type: "string" }, tpLinkPassword: { type: "string", writeOnly: true } } } } } }, responses: { "202": { description: "Discovery job accepted", content: { "application/json": { schema: { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/IntegrationDiscoveryJob" } } } } } } } } },
  "/integrations/discovery-jobs/latest": { get: { tags: ["Integrations"], operationId: "latestIntegrationDiscovery", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Latest unexpired discovery job owned by the signed-in account", content: { "application/json": { schema: { type: "object", required: ["job"], properties: { job: { oneOf: [{ $ref: "#/components/schemas/IntegrationDiscoveryJob" }, { type: "null" }] } } } } } } } } },
  "/integrations/discovery-jobs/events": { get: { tags: ["Integrations"], operationId: "streamIntegrationDiscovery", parameters: [{ name: "jobId", in: "query", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Owner-scoped integration-discovery server-sent events, beginning with the current job snapshot and ending with an authorization event if access changes.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { "integration-discovery": { $ref: "#/components/schemas/IntegrationDiscoveryJob" }, authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } }, "404": { $ref: "#/components/responses/NotFound" } } } },
  "/integrations/discovery-jobs/{id}": { get: { tags: ["Integrations"], operationId: "getIntegrationDiscovery", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Owner-scoped discovery job snapshot", content: { "application/json": { schema: { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/IntegrationDiscoveryJob" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } } },
  "/integrations/home-assistant/config": { put: { tags: ["Integrations"], operationId: "configureHomeAssistant", description: "Write-only server-side credential setup; responses never contain the saved URL or token.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HomeAssistantConfigInput" } } } }, responses: { "200": { description: "Credentials saved and connection started", content: { "application/json": { schema: { type: "object", required: ["ok", "configured", "integration"], properties: { ok: { const: true }, configured: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "400": { description: "Invalid URL or token" } } } },
  "/integrations/home-assistant/config/{houseId}": {
        patch: {
          tags: ["Integrations"], operationId: "moveHouseHomeAssistant",
          description: "Moves the saved write-only Home Assistant connection to another House without returning or re-entering credentials. Existing sensor entity mappings remain on the source House.",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId"], properties: { houseId: { type: "string", minLength: 1 } }, additionalProperties: false } } } },
          responses: {
            "200": { description: "Home Assistant connection moved", content: { "application/json": { schema: { type: "object", required: ["ok", "fromHouseId", "houseId", "integration"], properties: { ok: { const: true }, fromHouseId: { type: "string" }, houseId: { type: "string" }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "The target House already has a Home Assistant assignment" },
          },
        },
        delete: { tags: ["Integrations"], operationId: "disconnectHouseHomeAssistant", parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "House Home Assistant credentials deleted", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
  "/integrations/home-assistant/setup": { get: { tags: ["Integrations"], operationId: "homeAssistantSetup", responses: { "200": { description: "Environment and entity-map setup help", content: { "application/json": { schema: { type: "object", required: ["configured", "steps", "entityMapSchema", "notes"], additionalProperties: true } } } } } } },
  "/integrations/home-assistant/test": { post: { tags: ["Integrations"], operationId: "homeAssistantStatusTest", responses: { "200": { description: "Status of the environment-configured bridge", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
  "/integrations/home-assistant/test-draft": { post: { tags: ["Integrations"], operationId: "testHomeAssistantDraft", description: "Temporarily verifies draft credentials and streaming permission without saving them or activating real-data mode.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/HomeAssistantConfigInput" } } } }, responses: { "200": { description: "Non-persisting credential test result", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
  "/integrations/tp-link/setup": { get: { tags: ["Integrations"], operationId: "tpLinkSetup", responses: { "200": { description: "Direct H100/H200/H500 climate-child and capability-based energy-device setup help", content: { "application/json": { schema: { type: "object", required: ["configured", "supportedHubs", "supportedClimateSensors", "supportedEnergyDevices", "steps", "sensorPatchSchema", "deviceMapSchema", "notes"], additionalProperties: true } } } } } } },
  "/integrations/tp-link/config": { put: { tags: ["Integrations"], operationId: "configureTpLink", description: "Creates or updates one house-scoped, write-only TP-Link connection. The request may provide new credentials or reference another saved TP-Link connection whose private credentials are reused server-side. Stable device identity is used to follow safe address changes, while a connection id cannot be reassigned to different physical hardware. Responses never contain account credentials.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TpLinkConfigInput" } } } }, responses: { "200": { description: "Credentials saved and house connection started", content: { "application/json": { schema: { type: "object", required: ["ok", "configured", "created", "connectionId", "houseId", "deviceId", "sourceType", "sourceModel", "sourceAlias", "integration"], properties: { ok: { const: true }, configured: { const: true }, created: { type: "boolean", description: "True when a new physical source connection was created; false when an existing connection was updated." }, connectionId: { type: "string" }, houseId: { type: "string" }, deviceId: { type: ["string", "null"], description: "Stable local source identity used to continue direct energy-device setup." }, sourceType: { type: ["string", "null"], enum: ["hub", "energy-device", null] }, sourceModel: { type: ["string", "null"] }, sourceAlias: { type: ["string", "null"] }, warning: { type: ["string", "null"], description: "A non-fatal local capability limitation detected while validating the source." }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "400": { description: "Invalid device address or credentials" }, "409": { description: "The stable device identity conflicts with the requested connection or another House assignment" } } } },
  "/integrations/tp-link/config/{connectionId}": {
        patch: {
          tags: ["Integrations"], operationId: "moveTpLinkConnection",
          description: "Moves a saved write-only TP-Link connection to another House without returning or re-entering credentials. Direct sensor bindings on the source House are detached while sensor history and placement remain.",
          parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string", minLength: 1 } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["houseId"], properties: { houseId: { type: "string", minLength: 1 } }, additionalProperties: false } } } },
          responses: {
            "200": { description: "TP-Link connection moved", content: { "application/json": { schema: { type: "object", required: ["ok", "fromHouseId", "houseId", "detachedSensorIds", "integration"], properties: { ok: { const: true }, fromHouseId: { type: "string" }, houseId: { type: "string" }, detachedSensorIds: { type: "array", items: { type: "string" } }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "The same physical TP-Link endpoint is already assigned to the target House" },
          },
        },
        delete: { tags: ["Integrations"], operationId: "disconnectTpLinkConnection", parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "House TP-Link connection deleted; affected sensors retain history and placement while their direct bindings are detached", content: { "application/json": { schema: { type: "object", required: ["ok", "detachedSensorIds", "integration"], properties: { ok: { const: true }, detachedSensorIds: { type: "array", items: { type: "string" } }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
  "/integrations/tp-link/devices": { get: { tags: ["Integrations"], operationId: "listTpLinkDevices", responses: { "200": { description: "Sanitized climate, contact, and energy devices seen by the local bridge, including their current Stugu assignment", content: { "application/json": { schema: { type: "object", required: ["devices"], properties: { devices: { type: "array", items: { $ref: "#/components/schemas/TpLinkDiscoveredDevice" } } } } } } } } } },
  "/integrations/tp-link/history-export/jobs": { get: { tags: ["Integrations"], operationId: "listTapoHistoryExportJobs", responses: { "200": jsonResponse("Durable automated Tapo history-export jobs and non-secret automation health", { type: "object", additionalProperties: false, required: ["enabled", "automation", "jobs"], properties: { enabled: { type: "boolean" }, automation: { type: "object", additionalProperties: false, required: ["operational", "canaryPending", "waitingEmails", "maxPendingEmails", "exportIntervalMinutes", "canaryApprovalMaxAgeDays", "mailbox", "lastWorkerSeenAt", "deploymentFingerprintPrefix"], properties: { operational: { type: "boolean" }, canaryPending: { type: "boolean" }, waitingEmails: { type: "integer", minimum: 0 }, maxPendingEmails: { type: "integer", minimum: 1 }, exportIntervalMinutes: { type: "integer", enum: [1, 15, 30, 60, 360, 720, 1440] }, canaryApprovalMaxAgeDays: { type: "integer", minimum: 1 }, mailbox: { type: "object", additionalProperties: false, required: ["lastSuccessfulPollAt", "lastErrorAt", "lastErrorCode", "consecutiveFailures", "budgetExhaustions"], properties: { lastSuccessfulPollAt: { type: ["string", "null"], format: "date-time" }, lastErrorAt: { type: ["string", "null"], format: "date-time" }, lastErrorCode: { type: ["string", "null"] }, consecutiveFailures: { type: "integer", minimum: 0 }, budgetExhaustions: { type: "integer", minimum: 0 } } }, lastWorkerSeenAt: { type: ["string", "null"], format: "date-time" }, deploymentFingerprintPrefix: { type: ["string", "null"] } } }, jobs: { type: "array", items: { $ref: "#/components/schemas/TapoHistoryExportJob" } } } }) } } },
  "/integrations/tp-link/history-export/canary": { post: { tags: ["Integrations"], operationId: "createTapoHistoryExportCanary", description: "Owner/admin acceptance gate. Queues a fresh bounded Appium/email job whose staged rows are excluded from automatic gap ingestion.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["sensorId", "metric", "from", "to"], properties: { sensorId: { type: "string", minLength: 1 }, metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } }), responses: { "202": jsonResponse("Fresh canary queued", { type: "object", additionalProperties: false, required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "403": { description: "Owner or admin role required" }, "409": { description: "Tapo automation or target binding is not ready" }, "422": { description: "Canary range is invalid" } } } },
  "/integrations/tp-link/history-export/backfill": { post: { tags: ["Integrations"], operationId: "createTapoHistoryBackfill", description: "Owner/admin request for a durable TP-Link temperature or humidity backfill. The coordinator uses local retention first, then segments the configured Tapo fallback, for an explicit range of at most 730 days.", requestBody: jsonRequestBody({ type: "object", additionalProperties: false, required: ["sensorId", "metric", "from", "to"], properties: { sensorId: { type: "string", minLength: 1 }, metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } }), responses: { "202": jsonResponse("Historical recovery gap recorded or rearmed", { type: "object", additionalProperties: false, required: ["gap"], properties: { gap: { type: "object", required: ["id", "sensorId", "metric", "source", "startedAt", "endedAt", "recoveryState"], properties: { id: { type: "integer" }, sensorId: { type: "string" }, metric: { type: "string" }, source: { const: "tp-link" }, startedAt: { type: "string", format: "date-time" }, endedAt: { type: "string", format: "date-time" }, recoveryState: { enum: ["pending", "running", "complete", "partial", "failed", "not-supported"] } } } } }), "403": { description: "Owner or admin role required" }, "409": { description: "Tapo history or the target binding is not ready" }, "422": { description: "Backfill range is invalid" } } } },
  "/integrations/tp-link/history-export/jobs/{id}/retry": { post: { tags: ["Integrations"], operationId: "retryTapoHistoryExportJob", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Export job requeued with a fresh attempt budget", { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "409": { description: "Job is not retryable" } } } },
  "/integrations/tp-link/history-export/jobs/{id}": { delete: { tags: ["Integrations"], operationId: "cancelTapoHistoryExportJob", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Export job cancelled", { type: "object", required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryExportJob" } } }), "404": { $ref: "#/components/responses/NotFound" } } } },
  "/internal/tapo-history/jobs/claim": { get: { tags: ["Integrations"], operationId: "claimTapoHistoryExportJob", security: [{ tapoWorkerBearer: [] }], parameters: [{ name: "workerId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }, { name: "deploymentFingerprint", in: "query", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], responses: { "200": jsonResponse("Leased Appium export job with an opaque capability token", { $ref: "#/components/schemas/TapoHistoryWorkerClaim" }), "204": { description: "No runnable export job or matching fresh canary approval" }, "400": { description: "Missing or mismatched deployment fingerprint attestation" }, "401": { description: "Invalid worker token" } } } },
  "/internal/tapo-history/jobs/{id}/heartbeat": { post: { tags: ["Integrations"], operationId: "heartbeatTapoHistoryExportJob", security: [{ tapoWorkerBearer: [] }], parameters: [{ $ref: "#/components/parameters/Id" }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/TapoHistoryWorkerLeaseInput" }), responses: { "200": jsonResponse("Worker lease extended", { $ref: "#/components/schemas/TapoHistoryWorkerLease" }), "409": { description: "Worker lease or deployment attestation was lost" } } } },
  "/internal/tapo-history/jobs/{id}/status": { post: { tags: ["Integrations"], operationId: "updateTapoHistoryExportJobStatus", security: [{ tapoWorkerBearer: [] }], parameters: [{ $ref: "#/components/parameters/Id" }, { name: "X-Tapo-Deployment-Fingerprint", in: "header", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/TapoHistoryWorkerStatusInput" }), responses: { "200": jsonResponse("Worker-owned export state updated", { type: "object", additionalProperties: false, required: ["job"], properties: { job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" } } }), "409": { description: "Worker lease or deployment attestation was lost" } } } },
  "/integrations/tp-link/test": { post: { tags: ["Integrations"], operationId: "tpLinkStatusTest", responses: { "200": { description: "Status of the direct local TP-Link bridge", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
  "/integrations/tp-link/test-draft": { post: { tags: ["Integrations"], operationId: "testTpLinkDraft", description: "Runs one isolated helper poll with draft credentials without saving or activating them.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TpLinkDraftInput" } } } }, responses: { "200": { description: "Non-persisting credential test result", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } } } } },
  "/integrations/telegram/discover": {
        post: {
          tags: ["Integrations"], operationId: "discoverTelegramChat",
          description: "Verifies a write-only bot token and lists only private chats that have already sent the bot a message (normally /start).",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramDiscoveryInput" } } } },
          responses: {
            "200": { description: "Verified bot and private-chat candidates", content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramDiscoveryResult" } } } },
            "400": { description: "Invalid token, or Telegram rejected the credentials" },
            "503": { description: "Telegram is unavailable or rate limiting requests" },
          },
        },
      },
  "/integrations/telegram/config": {
        put: {
          tags: ["Integrations"], operationId: "configureTelegram",
          description: "Verifies and stores a bot token and one private-chat identifier in the local secrets file. The token is write-only and never returned.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramConfigInput" } } } },
          responses: {
            "200": { description: "Telegram delivery configured", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationConfigurationResult" } } } },
            "400": { description: "Invalid credentials, chat identifier, or non-private chat" },
            "503": { description: "Telegram is unavailable or rate limiting requests" },
          },
        },
        delete: { tags: ["Integrations"], operationId: "disconnectTelegram", description: "Deletes the locally stored Telegram credentials.", responses: { "200": { description: "Telegram credentials deleted", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } } } },
      },
  "/integrations/telegram/test": {
        post: { tags: ["Integrations"], operationId: "testTelegram", description: "Sends a protected test message to the configured private chat.", responses: { "200": { description: "Test message accepted by Telegram", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationTestResult" } } } }, "409": { description: "Telegram is not configured" }, "503": { description: "Telegram is unavailable or rate limiting requests" } } },
      },
  "/integrations/telegram/setup": {
        get: { tags: ["Integrations"], operationId: "telegramSetup", responses: { "200": { description: "Guided BotFather, private-chat pairing, security, and alert-rule setup metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/TelegramSetup" } } } } } },
      },
  "/integrations/apple-notes/grants": {
        get: { tags: ["Integrations"], operationId: "listAppleNotesGrants", description: "Lists redacted, house-scoped Shortcut grants. Raw bearer tokens are never returned.", responses: { "200": { description: "Active Apple Notes Shortcut grants", content: { "application/json": { schema: { type: "object", required: ["grants"], properties: { grants: { type: "array", items: { $ref: "#/components/schemas/AppleNotesGrantSummary" } } } } } } } } },
        post: {
          tags: ["Integrations"], operationId: "createAppleNotesGrant",
          description: "Creates a house-scoped Shortcut grant and returns its bearer token exactly once. Only a token hash is persisted.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesGrantInput" } } } },
          responses: { "201": { description: "Created grant with one-time bearer token", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesGrantCreated" } } } }, "404": { description: "House not found" } },
        },
      },
  "/integrations/apple-notes/grants/{id}": {
        delete: { tags: ["Integrations"], operationId: "revokeAppleNotesGrant", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Grant revoked", content: { "application/json": { schema: { type: "object", required: ["ok", "integration"], properties: { ok: { const: true }, integration: { $ref: "#/components/schemas/IntegrationStatus" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
  "/integrations/apple-notes/setup": {
        get: { tags: ["Integrations"], operationId: "appleNotesSetup", responses: { "200": { description: "Guided iOS Shortcuts bridge recipes, limitations, and endpoint metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesSetup" } } } } } },
      },
  "/integrations/apple-notes/snapshot": {
        get: {
          tags: ["Integrations"], operationId: "appleNotesSnapshot", security: [{ notesGrant: [] }],
          description: "Returns a generated, read-only maintenance snapshot for the grant's house. Stugu remains the source of truth.",
          parameters: [{ name: "houseId", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Generated maintenance snapshot", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesSnapshot" } } } }, "401": { description: "Missing or invalid Shortcut grant" }, "403": { description: "Grant is scoped to another house" }, "404": { description: "House not found" } },
        },
      },
  "/integrations/apple-notes/capture": {
        post: {
          tags: ["Integrations"], operationId: "captureAppleNotesMaintenance", security: [{ notesGrant: [] }],
          description: "Creates one maintenance task from a Shortcut command. Retrying an identical operationId is idempotent; reusing it with changed content is a conflict.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureInput" } } } },
          responses: { "200": { description: "Identical command was already applied", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureResult" } } } }, "201": { description: "Maintenance task created", content: { "application/json": { schema: { $ref: "#/components/schemas/AppleNotesMaintenanceCaptureResult" } } } }, "401": { description: "Missing or invalid Shortcut grant" }, "403": { description: "Grant is scoped to another house" }, "409": { description: "operationId was reused with different content" }, "422": { description: "Invalid maintenance command" } },
        },
      },
  "/mock/scenarios": { get: { tags: ["Testing"], operationId: "listMockScenarios", responses: { "200": { description: "Scenarios", content: { "application/json": { schema: { type: "object", required: ["scenarios", "active", "enabled"], properties: { scenarios: { type: "array", items: { $ref: "#/components/schemas/MockScenario" } }, active: { $ref: "#/components/schemas/MockScenarioId" }, enabled: { type: "boolean" } } } } } } } } },
  "/mock/scenario": {
        put: { tags: ["Testing"], operationId: "selectMockScenario", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["scenario"], properties: { scenario: { $ref: "#/components/schemas/MockScenarioId" } } } } } }, responses: { "200": { description: "Selected scenario", content: { "application/json": { schema: { type: "object", required: ["active"], properties: { active: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } },
        post: { tags: ["Testing"], operationId: "selectMockScenarioCompatibility", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { scenarioId: { $ref: "#/components/schemas/MockScenarioId" }, scenario: { $ref: "#/components/schemas/MockScenarioId" } }, anyOf: [{ required: ["scenarioId"] }, { required: ["scenario"] }] } } } }, responses: { "200": { description: "Selected scenario", content: { "application/json": { schema: { type: "object", required: ["ok", "active"], properties: { ok: { const: true }, active: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } },
      },
  "/mock/tick": { post: { tags: ["Testing"], operationId: "generateMockTick", responses: { "201": { description: "Generated readings", content: { "application/json": { schema: { type: "object", required: ["readings", "scenario"], properties: { readings: { type: "array", items: { $ref: "#/components/schemas/Reading" } }, scenario: { $ref: "#/components/schemas/MockScenarioId" } } } } } } } } },
  "/replay": {
        get: { tags: ["Testing"], operationId: "replayStatus", responses: { "200": { description: "Replay state", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
        post: { tags: ["Testing"], operationId: "startReplay", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReplayInput" } } } }, responses: { "202": { description: "Replay started", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
        delete: { tags: ["Testing"], operationId: "stopReplay", responses: { "200": { description: "Replay stopped", content: { "application/json": { schema: { type: "object", required: ["replay"], properties: { replay: { $ref: "#/components/schemas/ReplayState" } } } } } } } },
      },
} as const;
