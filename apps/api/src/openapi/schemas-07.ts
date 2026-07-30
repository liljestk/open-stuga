import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { jsonRequestBody, jsonResponse, localAuthPaths, localAuthSchemas, operationalOrchestrationPaths, spatialHouseResourcePath, spatialJsonResponse, spatialLayerPaths, spatialLayerSchemas, spatialRequestBody, spatialScopePaths, spatialScopeQueryParameters, stugubyIdParameter, stugubyNodeSecurity, stugubyObject, stugubyPaths, stugubyRequestBody, stugubyResponse, trackingObject, trackingObserverBearerSecurity, trackingObserverSecurity, trackingPathParameter, trackingPaths } from "./support/index.js";
import type { OpenApiSchema } from "./support/index.js";

export const schemasPart07 = {
  AppleNotesMaintenanceCaptureResult: {
          type: "object", additionalProperties: false, required: ["ok", "deduplicated", "task", "receipt"],
          properties: { ok: { const: true }, deduplicated: { type: "boolean" }, task: { $ref: "#/components/schemas/MaintenanceTask" }, receipt: { type: "string" } },
        },
  HomeAssistantConfigInput: {
          type: "object",
          required: ["url", "token"],
          properties: {
            houseId: { type: "string", minLength: 1, description: "House which owns this Home Assistant connection." },
            url: { type: "string", format: "uri", maxLength: 2048, description: "HTTP(S) Home Assistant address without embedded credentials." },
            token: { type: "string", minLength: 1, maxLength: 8192, writeOnly: true },
          },
        },
  TpLinkConfigInput: {
          type: "object",
          required: ["host"],
          oneOf: [
            { required: ["username", "password"] },
            { required: ["credentialSourceConnectionId"] },
          ],
          properties: {
            houseId: { type: "string", minLength: 1, description: "House which owns this TP-Link connection." },
            connectionId: { type: "string", minLength: 1, description: "Existing connection to update; omitted when adding another hub or socket." },
            credentialSourceConnectionId: { type: "string", minLength: 1, writeOnly: true, description: "Saved TP-Link connection whose private account credentials should be reused. Mutually exclusive with username and password." },
            host: { type: "string", minLength: 1, maxLength: 253 },
            username: { type: "string", minLength: 1, maxLength: 320, writeOnly: true },
            password: { type: "string", minLength: 1, maxLength: 4096, writeOnly: true },
          },
        },
  TpLinkDraftInput: {
          type: "object",
          required: ["host", "username", "password"],
          properties: {
            host: { type: "string", minLength: 1, maxLength: 253 },
            username: { type: "string", minLength: 1, maxLength: 320, writeOnly: true },
            password: { type: "string", minLength: 1, maxLength: 4096, writeOnly: true },
          },
        },
  TapoHistoryExportJob: {
          type: "object", additionalProperties: false,
          required: ["id", "canary", "provider", "sensorId", "deviceId", "deviceName", "timeZone", "metric", "expectedRecipient", "from", "to", "intervalMinutes", "status", "attemptCount", "maxAttempts", "availableAt", "leaseOwner", "leaseExpiresAt", "heartbeatAt", "submittedAt", "mailboxMessageId", "sourceArtifactSha256", "sourceArtifactBytes", "parserVersion", "sourceSchemaSignature", "stagedSampleCount", "consumedSampleCount", "lastError", "attentionReason", "detail", "createdAt", "updatedAt", "completedAt"],
          properties: {
            id: { type: "string", format: "uuid" }, canary: { type: "boolean", description: "True for an isolated acceptance job whose staged rows are never reused for automatic gap recovery." }, provider: { enum: ["appium", "private-cloud"] },
            sensorId: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" }, timeZone: { type: "string", description: "Immutable IANA timezone snapshot used for app date selection and CSV parsing." }, metric: { type: "string" },
            expectedRecipient: { type: ["string", "null"], format: "email" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
            intervalMinutes: { type: "integer", minimum: 1 }, status: { enum: ["queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"] },
            attemptCount: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1 }, availableAt: { type: "string", format: "date-time" },
            leaseOwner: { type: ["string", "null"] }, leaseExpiresAt: { type: ["string", "null"], format: "date-time" }, heartbeatAt: { type: ["string", "null"], format: "date-time" }, submittedAt: { type: ["string", "null"], format: "date-time", description: "Server time when the current export attempt was confirmed submitted." },
            mailboxMessageId: { type: ["string", "null"] },
            sourceArtifactSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$", description: "SHA-256 of the exact source CSV bytes, retained for audit without exposing the mailbox capability." },
            sourceArtifactBytes: { type: ["integer", "null"], minimum: 0 },
            parserVersion: { type: ["string", "null"] },
            sourceSchemaSignature: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$", description: "Canonical parsed CSV structure signature fenced by the accepted canary." },
            stagedSampleCount: { type: "integer", minimum: 0 }, consumedSampleCount: { type: "integer", minimum: 0 },
            lastError: { type: ["string", "null"] }, attentionReason: { type: ["string", "null"] }, detail: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
  TapoHistoryWorkerLeaseInput: {
          type: "object", additionalProperties: false, required: ["workerId", "leaseToken"],
          properties: { workerId: { type: "string", minLength: 1, maxLength: 200 }, leaseToken: { type: "string", minLength: 1, maxLength: 500, writeOnly: true } },
        },
  TapoHistoryWorkerJob: {
          type: "object", additionalProperties: false,
          required: ["id", "sensorId", "deviceId", "deviceName", "metric", "from", "to", "timeZone", "intervalMinutes", "expectedRecipient", "status", "attemptCount", "leaseExpiresAt"],
          properties: {
            id: { type: "string", format: "uuid" }, sensorId: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" },
            metric: { enum: ["temperature", "humidity"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
            timeZone: { type: "string", description: "Snapshotted IANA timezone used to turn the UTC gap into app-local calendar dates." },
            intervalMinutes: { type: "integer", minimum: 1 }, expectedRecipient: { type: ["string", "null"], format: "email", writeOnly: true },
            status: { enum: ["queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"] },
            attemptCount: { type: "integer", minimum: 0 }, leaseExpiresAt: { type: ["string", "null"], format: "date-time" },
          },
        },
  TapoHistoryWorkerStatusInput: {
          type: "object", additionalProperties: false, required: ["workerId", "leaseToken", "status"],
          properties: {
            workerId: { type: "string", minLength: 1, maxLength: 200 }, leaseToken: { type: "string", minLength: 1, maxLength: 500, writeOnly: true },
            status: { enum: ["running", "waiting-email", "needs-attention", "failed"] }, detail: { type: ["string", "null"], maxLength: 1000 },
          },
        },
  TapoHistoryWorkerClaim: {
          type: "object", additionalProperties: false, required: ["job", "leaseToken", "serverNow"],
          properties: {
            job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" },
            leaseToken: { type: "string", writeOnly: true },
            serverNow: { type: "string", format: "date-time", description: "API clock sample used to derive a monotonic local lease TTL." },
          },
        },
  TapoHistoryWorkerLease: {
          type: "object", additionalProperties: false, required: ["job", "serverNow"],
          properties: {
            job: { $ref: "#/components/schemas/TapoHistoryWorkerJob" },
            serverNow: { type: "string", format: "date-time", description: "API clock sample used to derive a monotonic local lease TTL." },
          },
        },
  PropertyElectricityConfigInput: {
          type: "object",
          required: ["provider", "endpointUrl", "enabled", "marginCentsPerKwh", "contractType"],
          properties: {
            provider: { enum: ["porssisahko", "custom"] }, endpointUrl: { type: "string", format: "uri" }, enabled: { type: "boolean" },
            marginCentsPerKwh: { type: "number" }, contractType: { enum: ["spot", "fixed", "other"] },
            contractName: { type: ["string", "null"] }, retailer: { type: ["string", "null"] }, monthlyFeeEur: { type: ["number", "null"], minimum: 0 },
          },
        },
  HomeElectricityPricePoint: {
          type: "object", additionalProperties: false,
          required: ["startAt", "endAt", "effectivePriceCentsPerKwh", "effectivePriceEurPerKwh", "fetchedAt"],
          properties: {
            startAt: { type: "string", format: "date-time" }, endAt: { type: "string", format: "date-time" },
            effectivePriceCentsPerKwh: { type: "number" }, effectivePriceEurPerKwh: { type: "number" },
            fetchedAt: { type: "string", format: "date-time" },
          },
        },
  HomeEnergyCost: {
          type: "object", additionalProperties: false,
          required: ["houseId", "sensorId", "from", "to", "measurementBasis", "consumptionKwh", "pricedConsumptionKwh", "costEur", "priceCoveragePercent", "measurementCoverageFrom", "measurementCoverageUntil", "quality", "archiveState", "complete", "calculatedAt"],
          properties: {
            houseId: { type: "string" }, sensorId: { type: "string" },
            from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
            measurementBasis: { enum: ["energy_counter", "integrated_power"] },
            consumptionKwh: { type: ["number", "null"] }, pricedConsumptionKwh: { type: ["number", "null"] },
            costEur: { type: ["number", "null"] }, priceCoveragePercent: { type: "number", minimum: 0, maximum: 100 },
            measurementCoverageFrom: { type: ["string", "null"], format: "date-time" },
            measurementCoverageUntil: { type: ["string", "null"], format: "date-time" },
            quality: { enum: ["measured", "estimated", "partial"] },
            archiveState: { enum: ["local-only", "pending", "archived"] },
            complete: { type: "boolean" }, calculatedAt: { type: "string", format: "date-time" },
          },
        },
  HomeEnergySummary: {
          type: "object", additionalProperties: false,
          required: ["schemaVersion", "algorithmVersion", "houseId", "from", "to", "consumptionKwh", "pricedConsumptionKwh", "costEur", "priceCoveragePercent", "quality", "archiveState", "aggregationMode", "complete", "sourceCount", "totalSources", "excludedSourceCount", "failedSourceCount", "contributions", "calculatedAt"],
          properties: {
            schemaVersion: { type: "integer", const: 2 },
            algorithmVersion: { type: "string", const: "home-energy-summary/v2" },
            houseId: { type: "string" },
            from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
            consumptionKwh: { type: ["number", "null"] }, pricedConsumptionKwh: { type: ["number", "null"] },
            costEur: { type: ["number", "null"] }, priceCoveragePercent: { type: "number", minimum: 0, maximum: 100 },
            quality: { enum: ["measured", "estimated", "partial"] },
            archiveState: { enum: ["local-only", "pending", "archived"] },
            aggregationMode: { enum: ["whole_home", "independent_sources", "submeters_only"] },
            complete: { type: "boolean" },
            sourceCount: { type: "integer", minimum: 0 }, totalSources: { type: "integer", minimum: 0 },
            excludedSourceCount: { type: "integer", minimum: 0 },
            failedSourceCount: { type: "integer", minimum: 0 },
            contributions: { type: "array", items: { $ref: "#/components/schemas/HomeEnergyCost" } },
            calculatedAt: { type: "string", format: "date-time" },
          },
        },
  IntegrationStatus: {
          type: "object",
          required: ["homeAssistant", "tpLink", "webhook", "telegram", "appleNotes", "mock", "weather"],
          properties: {
            homeAssistant: { type: "object", required: ["configured", "connected", "lastEventAt", "mappedEntities", "error"], properties: { configured: { type: "boolean" }, connected: { type: "boolean" }, lastEventAt: { type: ["string", "null"], format: "date-time" }, mappedEntities: { type: "integer" }, error: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", required: ["houseId", "configured", "connected", "lastEventAt", "mappedEntities", "error"], properties: { houseId: { type: "string" }, configured: { type: "boolean" }, connected: { type: "boolean" }, lastEventAt: { type: ["string", "null"], format: "date-time" }, mappedEntities: { type: "integer" }, error: { type: ["string", "null"] } } } } } },
            tpLink: { type: "object", required: ["configured", "connected", "lastPollAt", "mappedDevices", "discoveredDevices", "hubModel", "error"], properties: { configured: { type: "boolean" }, connected: { type: "boolean" }, lastPollAt: { type: ["string", "null"], format: "date-time" }, mappedDevices: { type: "integer" }, discoveredDevices: { type: "integer" }, hubModel: { enum: ["H100", "H200", null] }, error: { type: ["string", "null"] }, host: { type: ["string", "null"] }, sourceType: { enum: ["hub", "energy-device", null] }, sourceModel: { type: ["string", "null"] }, sourceAlias: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "houseId", "configured", "connected", "lastPollAt", "mappedDevices", "discoveredDevices", "hubModel", "error"], properties: { id: { type: "string" }, houseId: { type: "string" }, configured: { type: "boolean" }, connected: { type: "boolean" }, lastPollAt: { type: ["string", "null"], format: "date-time" }, mappedDevices: { type: "integer" }, discoveredDevices: { type: "integer" }, hubModel: { enum: ["H100", "H200", null] }, error: { type: ["string", "null"] }, host: { type: ["string", "null"] }, sourceType: { enum: ["hub", "energy-device", null] }, sourceModel: { type: ["string", "null"] }, sourceAlias: { type: ["string", "null"] } } } } } },
            gree: { $ref: "#/components/schemas/GreeIntegrationStatus" },
            webhook: { type: "object", required: ["configured", "lastDeliveryAt", "error"], properties: { configured: { type: "boolean" }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] }, destinations: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["id", "lastDeliveryAt", "error"], properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } } } } },
            telegram: { type: "object", required: ["available", "configured", "connected", "botUsername", "chatLabel", "lastDeliveryAt", "error"], properties: { available: { type: "boolean" }, configured: { type: "boolean" }, connected: { type: "boolean" }, botUsername: { type: ["string", "null"] }, chatLabel: { type: ["string", "null"] }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } },
            appleNotes: { type: "object", required: ["available", "configured", "grantCount", "lastSyncAt", "error"], properties: { available: { type: "boolean" }, configured: { type: "boolean" }, grantCount: { type: "integer", minimum: 0 }, lastSyncAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } },
            mock: { type: "object", required: ["enabled", "intervalMs", "mode", "activatedAt"], properties: { enabled: { type: "boolean" }, intervalMs: { type: "integer" }, mode: { enum: ["demo", "real"] }, activatedAt: { type: ["string", "null"], format: "date-time" } } },
            weather: { type: "object", required: ["provider", "configuredHouses", "lastSuccessAt", "error"], properties: { policy: { enum: ["automatic", "fmi", "open-meteo"] }, availableProviders: { type: "array", items: { enum: ["fmi", "open-meteo"] } }, provider: { enum: ["fmi", "open-meteo"] }, configuredHouses: { type: "integer" }, lastSuccessAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] }, connections: { type: "array", items: { type: "object", additionalProperties: false, required: ["houseId", "configured", "provider", "lastSuccessAt", "error"], properties: { houseId: { type: "string" }, configured: { type: "boolean" }, provider: { enum: ["fmi", "open-meteo"] }, lastSuccessAt: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"] } } } } } },
          },
        },
  IntegrationDiscoveryResult: {
          type: "object",
          required: ["homeAssistant", "tpLink", "warnings"],
          properties: {
            homeAssistant: { type: "array", items: { type: "object", required: ["name", "url", "host", "port", "version"], properties: { name: { type: "string" }, url: { type: "string", format: "uri" }, host: { type: "string" }, port: { type: "integer" }, version: { type: ["string", "null"] } } } },
            tpLink: { type: "array", items: { type: "object", required: ["host", "model", "alias", "sourceType"], properties: { host: { type: "string" }, model: { type: "string" }, alias: { type: ["string", "null"] }, sourceType: { enum: ["hub", "energy-device"] }, deviceId: { type: ["string", "null"] }, configuredConnectionId: { type: "string" } } } },
            gree: { type: "array", items: { $ref: "#/components/schemas/GreeDiscoveredDevice" } },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
  IntegrationDiscoveryJob: {
          type: "object",
          additionalProperties: false,
          required: ["id", "houseId", "status", "createdAt", "updatedAt", "expiresAt", "result", "error"],
          properties: {
            id: { type: "string", format: "uuid" },
            houseId: { type: "string" },
            status: { enum: ["running", "completed", "failed"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            expiresAt: { type: "string", format: "date-time" },
            result: { oneOf: [{ $ref: "#/components/schemas/IntegrationDiscoveryResult" }, { type: "null" }] },
            error: { type: ["string", "null"] },
          },
        },
  IntegrationTestResult: { type: "object", required: ["ok", "message"], properties: { ok: { type: "boolean" }, connected: { type: "boolean" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } } },
  MockScenarioId: { type: "string", enum: ["normal", "shower", "leak", "cold-front", "heating-failure"] },
  MockScenario: {
          type: "object",
          required: ["id", "label", "description"],
          properties: { id: { $ref: "#/components/schemas/MockScenarioId" }, label: { type: "string" }, description: { type: "string" } },
        },
  ReplayInput: {
          type: "object",
          properties: {
            sensorIds: { type: "array", items: { type: "string" }, description: "Defaults to every configured sensor." },
            from: { type: "string", format: "date-time", description: "Defaults to one hour before to." },
            to: { type: "string", format: "date-time", description: "Defaults to the server time." },
            speed: { type: "number", minimum: 0.1, maximum: 10000, default: 60 },
          },
        },
  EnergyOptimizationReport: {
          type: "object", additionalProperties: false,
          required: ["propertyId", "generatedAt", "priceCoverageFrom", "priceCoverageUntil", "averagePriceCentsPerKwh", "currentPriceCentsPerKwh", "currentPricePercentile", "suggestedWindows", "recentDailyConsumptionKwh", "estimatedDailyCostEur", "baselinePowerWatts", "peakPowerWatts", "insights", "limitations"],
          properties: {
            propertyId: { type: "string" }, generatedAt: { type: "string", format: "date-time" },
            priceCoverageFrom: { type: ["string", "null"], format: "date-time" }, priceCoverageUntil: { type: ["string", "null"], format: "date-time" },
            averagePriceCentsPerKwh: { type: ["number", "null"] }, currentPriceCentsPerKwh: { type: ["number", "null"] }, currentPricePercentile: { type: ["number", "null"] },
            suggestedWindows: { type: "array", items: { type: "object", additionalProperties: false, required: ["startAt", "endAt", "averagePriceCentsPerKwh", "relativeToAveragePercent", "rank"], properties: { startAt: { type: "string", format: "date-time" }, endAt: { type: "string", format: "date-time" }, averagePriceCentsPerKwh: { type: "number" }, relativeToAveragePercent: { type: "number" }, rank: { enum: ["best", "good", "expensive"] } } } },
            recentDailyConsumptionKwh: { type: ["number", "null"] }, estimatedDailyCostEur: { type: ["number", "null"] }, baselinePowerWatts: { type: ["number", "null"] }, peakPowerWatts: { type: ["number", "null"] },
            insights: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "severity", "title", "explanation", "estimatedSavingsEur"], properties: { id: { type: "string" }, severity: { enum: ["info", "opportunity", "warning"] }, title: { type: "string" }, explanation: { type: "string" }, estimatedSavingsEur: { type: ["number", "null"] } } } },
            limitations: { type: "array", items: { type: "string" } },
          },
        },
  NotificationDeliveryStatus: {
          type: "object", additionalProperties: false,
          required: ["id", "subjectKind", "subjectId", "stage", "sequence", "channel", "destinationId", "attempts", "maxAttempts", "availableAt", "createdAt", "deliveredAt", "deadLetteredAt", "abandonedAt", "lastError"],
          properties: {
            id: { type: "string" }, subjectKind: { enum: ["alert", "maintenance", "action-run"] }, subjectId: { type: "string" },
            stage: { enum: ["initial", "escalation", "reminder", "due", "verification"] }, sequence: { type: "integer", minimum: 0 }, channel: { enum: ["webhook", "telegram", "apns"] }, destinationId: { type: "string" }, attempts: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1, maximum: 100 },
            availableAt: { type: "string", format: "date-time" }, createdAt: { type: "string", format: "date-time" }, deliveredAt: { type: ["string", "null"], format: "date-time" }, deadLetteredAt: { type: ["string", "null"], format: "date-time" }, abandonedAt: { type: ["string", "null"], format: "date-time" }, lastError: { type: ["string", "null"] },
          },
        },
  ActionPlaybook: {
          type: "object", additionalProperties: false,
          required: ["id", "name", "description", "instructions", "metric", "goal", "minimumImprovement", "targetValue", "waitSeconds", "verificationWindowSeconds", "enabled", "builtIn", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" }, name: { type: "string", maxLength: 160 }, description: { type: "string", maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 500 } }, metric: { type: "string" }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" }, builtIn: { type: "boolean", readOnly: true }, createdAt: { type: "string", format: "date-time", readOnly: true }, updatedAt: { type: "string", format: "date-time", readOnly: true },
          },
        },
  ActionPlaybookInput: {
          type: "object", additionalProperties: false,
          required: ["name", "description", "instructions", "metric", "goal", "minimumImprovement", "waitSeconds", "verificationWindowSeconds"],
          properties: {
            id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 160 }, description: { type: "string", minLength: 1, maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, metric: { type: "string", minLength: 1 }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" },
          },
        },
  ActionPlaybookPatch: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 160 }, description: { type: "string", minLength: 1, maxLength: 2_000 }, instructions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, metric: { type: "string", minLength: 1 }, goal: { enum: ["decrease", "increase", "below", "above"] }, minimumImprovement: { type: "number" }, targetValue: { type: ["number", "null"] }, waitSeconds: { type: "number", minimum: 0 }, verificationWindowSeconds: { type: "number", minimum: 0 }, enabled: { type: "boolean" },
          },
        },
  ActionRun: {
          type: "object", additionalProperties: false,
          required: ["id", "playbookId", "alertEventId", "maintenanceTaskId", "sensorId", "metric", "status", "startedAt", "actionCompletedAt", "verifyAfter", "verificationDeadline", "baselineValue", "baselineTimestamp", "resultValue", "resultTimestamp", "improvement", "sampleCount", "operatorNote", "verificationNote", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" }, playbookId: { type: "string" }, alertEventId: { type: ["string", "null"] }, maintenanceTaskId: { type: ["string", "null"] }, sensorId: { type: "string" }, metric: { type: "string" }, status: { enum: ["active", "waiting", "verified", "not-improved", "cancelled"] },
            startedAt: { type: "string", format: "date-time" }, actionCompletedAt: { type: ["string", "null"], format: "date-time" }, verifyAfter: { type: ["string", "null"], format: "date-time" }, verificationDeadline: { type: ["string", "null"], format: "date-time" }, baselineValue: { type: "number" }, baselineTimestamp: { type: "string", format: "date-time" }, resultValue: { type: ["number", "null"] }, resultTimestamp: { type: ["string", "null"], format: "date-time" }, improvement: { type: ["number", "null"] }, sampleCount: { type: "integer", minimum: 0 }, operatorNote: { type: ["string", "null"] }, verificationNote: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
          },
        },
  ActionRunStartInput: {
          type: "object", additionalProperties: false, required: ["playbookId", "sensorId"],
          properties: { playbookId: { type: "string", minLength: 1 }, sensorId: { type: "string", minLength: 1 }, alertEventId: { type: ["string", "null"] }, maintenanceTaskId: { type: ["string", "null"] }, operatorNote: { type: ["string", "null"] } },
        },
  ActionRunCancelInput: { type: "object", additionalProperties: false, properties: { note: { type: ["string", "null"] } } },
  DataExportPreview: {
          type: "object", additionalProperties: false, required: ["schemaVersion", "generatedAt", "privacyLevel", "includesTelemetry", "counts", "sensitiveCategories", "estimatedTelemetryRows"],
          properties: { schemaVersion: { const: "stugu.export/v1" }, generatedAt: { type: "string", format: "date-time" }, privacyLevel: { enum: ["structure", "operations", "full"] }, includesTelemetry: { type: "boolean" }, counts: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, sensitiveCategories: { type: "array", items: { type: "string" } }, estimatedTelemetryRows: { type: "integer", minimum: 0 } },
        },
  DataExportBundle: {
          type: "object", required: ["schemaVersion", "generatedAt", "privacyLevel", "includesTelemetry", "privacyPreview", "data"],
          properties: { schemaVersion: { const: "stugu.export/v1" }, generatedAt: { type: "string", format: "date-time" }, privacyLevel: { enum: ["structure", "operations", "full"] }, includesTelemetry: { type: "boolean" }, privacyPreview: { $ref: "#/components/schemas/DataExportPreview" }, data: { type: "object", additionalProperties: true }, telemetry: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } } },
        },
  BackupOperationStatus: {
          type: "object", additionalProperties: false, required: ["available", "schedulerHealthy", "requestId", "state", "requestedAt", "completedAt", "backupPath", "lastError", "latestVerifiedBackupAt", "latestRestoreDrillAt"],
          properties: { available: { type: "boolean" }, schedulerHealthy: { type: "boolean" }, requestId: { type: ["string", "null"] }, state: { enum: ["idle", "requested", "running", "complete", "failed"] }, requestedAt: { type: ["string", "null"], format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" }, backupPath: { type: ["string", "null"] }, lastError: { type: ["string", "null"] }, latestVerifiedBackupAt: { type: ["string", "null"], format: "date-time" }, latestRestoreDrillAt: { type: ["string", "null"], format: "date-time" } },
        },
  SetupDoctorReport: {
          type: "object", additionalProperties: false, required: ["generatedAt", "overall", "checks"],
          properties: { generatedAt: { type: "string", format: "date-time" }, overall: { enum: ["ready", "attention", "blocked"] }, checks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "category", "status", "title", "detail", "action"], properties: { id: { type: "string" }, category: { enum: ["storage", "telemetry", "integration", "sensors", "notifications", "recovery", "security"] }, status: { enum: ["pass", "warning", "fail", "not-applicable"] }, title: { type: "string" }, detail: { type: "string" }, action: { type: ["string", "null"] } } } } },
        },
  SensorLabelDescriptor: {
          type: "object", additionalProperties: false, required: ["sensorId", "sensorName", "houseName", "roomName", "setupUri"],
          properties: { sensorId: { type: "string" }, sensorName: { type: "string" }, houseName: { type: "string" }, roomName: { type: ["string", "null"] }, setupUri: { type: "string", format: "uri" } },
        },
  BulkSensorMappingsInput: {
          type: "object", additionalProperties: false, required: ["houseId", "mappings"],
          properties: { houseId: { type: "string", minLength: 1 }, mappings: { type: "array", items: { type: "object", additionalProperties: false, required: ["sensorId", "measurementEntityIds"], properties: { sensorId: { type: "string", minLength: 1 }, measurementEntityIds: { type: "object", additionalProperties: { type: "string" } } } } } },
        },
} as const;
