import { jsonRequestBody, jsonResponse } from "./support/index.js";

export const pathsPart03 = {
  "/stream": { get: { tags: ["Telemetry"], operationId: "streamTelemetry", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }], responses: { "200": { description: "Server-sent reading, alert, integration, weather, opening-state, heat-pump, and heartbeat events. Authorization changes emit a final event before closing. Weather snapshots carry a stable SSE id so consumers can deduplicate repeated delivery.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { weather: { $ref: "#/components/schemas/WeatherUpdateEvent" }, opening: { $ref: "#/components/schemas/OpeningStateObservation" }, "heat-pump": { $ref: "#/components/schemas/HeatPumpState" }, authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } } } } },
  "/events": { get: { tags: ["Telemetry"], operationId: "streamTelemetryCompatibility", parameters: [{ $ref: "#/components/parameters/SensorIdsQuery" }], responses: { "200": { description: "Compatibility alias of /stream, kept for the iOS companion: server-sent events including provider-neutral weather snapshots, opening-state observations, Home-scoped heat-pump state, and final authorization changes.", content: { "text/event-stream": {} }, "x-sse-event-schemas": { weather: { $ref: "#/components/schemas/WeatherUpdateEvent" }, opening: { $ref: "#/components/schemas/OpeningStateObservation" }, "heat-pump": { $ref: "#/components/schemas/HeatPumpState" }, authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" } } } } } },
  "/alert-rules": {
        get: { tags: ["Alerts"], operationId: "listAlertRules", responses: { "200": { description: "Rules", content: { "application/json": { schema: { type: "object", required: ["rules"], properties: { rules: { type: "array", items: { $ref: "#/components/schemas/AlertRule" } } } } } } } } },
        post: { tags: ["Alerts"], operationId: "createAlertRule", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AlertRuleInput" } } } }, responses: { "201": { description: "Created rule", content: { "application/json": { schema: { type: "object", required: ["rule"], properties: { rule: { $ref: "#/components/schemas/AlertRule" } } } } } } } },
      },
  "/alert-rules/{id}": {
        patch: { tags: ["Alerts"], operationId: "updateAlertRule", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AlertRulePatch" } } } }, responses: { "200": { description: "Updated rule", content: { "application/json": { schema: { type: "object", required: ["rule"], properties: { rule: { $ref: "#/components/schemas/AlertRule" } } } } } } } },
        delete: { tags: ["Alerts"], operationId: "deleteAlertRule", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } },
      },
  "/alert-events": { get: { tags: ["Alerts"], operationId: "listAlertEvents", parameters: [{ name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }], responses: { "200": { description: "Alert events", content: { "application/json": { schema: { type: "object", required: ["events"], properties: { events: { type: "array", items: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } } },
  "/alert-events/{id}/acknowledge": { post: { tags: ["Alerts"], operationId: "acknowledgeAlert", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Acknowledged alert", content: { "application/json": { schema: { type: "object", required: ["event"], properties: { event: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } },
  "/alerts": { get: { tags: ["Alerts"], operationId: "listAlertsCompatibility", parameters: [{ name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }], responses: { "200": { description: "Compatibility alias of /alert-events under the older alerts key, kept for the iOS companion", content: { "application/json": { schema: { type: "object", required: ["alerts"], properties: { alerts: { type: "array", items: { $ref: "#/components/schemas/AlertEvent" } } } } } } } } } },
  "/alerts/{id}/acknowledge": { post: { tags: ["Alerts"], operationId: "acknowledgeAlertCompatibility", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Compatibility alias of /alert-events/{id}/acknowledge answered with the bare event, kept for the iOS companion", content: { "application/json": { schema: { $ref: "#/components/schemas/AlertEvent" } } } } } } },
  "/ios-notification-registrations/{id}": {
        get: {
          tags: ["Alerts"], operationId: "getIOSNotificationRegistration", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": jsonResponse("Private status for the current account and installation.", { $ref: "#/components/schemas/IOSNotificationStatus" }) },
        },
        put: {
          tags: ["Alerts"], operationId: "saveIOSNotificationRegistration", parameters: [{ $ref: "#/components/parameters/Id" }],
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/IOSNotificationRegistrationInput" }),
          responses: {
            "200": jsonResponse("Saved registration. Provider credentials are never exposed.", { $ref: "#/components/schemas/IOSNotificationStatus" }),
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "Registration conflict or per-account installation limit reached" },
          },
        },
        delete: {
          tags: ["Alerts"], operationId: "deleteIOSNotificationRegistration", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "204": { description: "Registration removed" } },
        },
      },
  "/properties/{id}/energy-optimization": {
        get: {
          tags: ["Energy"], operationId: "getPropertyEnergyOptimization",
          parameters: [{ $ref: "#/components/parameters/Id" }, { name: "windowHours", in: "query", schema: { type: "integer", minimum: 1, maximum: 12, default: 2 } }],
          responses: { "200": jsonResponse("Read-only price and consumption optimization report.", { type: "object", additionalProperties: false, required: ["report"], properties: { report: { $ref: "#/components/schemas/EnergyOptimizationReport" } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/notification-deliveries": {
        get: {
          tags: ["Alerts"], operationId: "listNotificationDeliveries",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } }],
          responses: { "200": jsonResponse("Redacted durable notification delivery ledger.", { type: "object", additionalProperties: false, required: ["deliveries"], properties: { deliveries: { type: "array", items: { $ref: "#/components/schemas/NotificationDeliveryStatus" } } } }) },
        },
      },
  "/notification-deliveries/{id}/retry": {
        post: {
          tags: ["Alerts"], operationId: "retryNotificationDelivery", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": jsonResponse("Delivery returned to the durable outbox.", { type: "object", additionalProperties: false, required: ["delivery"], properties: { delivery: { $ref: "#/components/schemas/NotificationDeliveryStatus" } } }), "403": { description: "Owner or Admin role required" }, "409": { description: "Delivery is not retryable" } },
        },
      },
  "/action-playbooks": {
        get: {
          tags: ["Alerts"], operationId: "listActionPlaybooks",
          parameters: [{ name: "metric", in: "query", schema: { type: "string" } }, { name: "enabled", in: "query", schema: { type: "boolean", default: false } }],
          responses: { "200": jsonResponse("Reusable evidence-based response playbooks.", { type: "object", additionalProperties: false, required: ["playbooks"], properties: { playbooks: { type: "array", items: { $ref: "#/components/schemas/ActionPlaybook" } } } }) },
        },
        post: {
          tags: ["Alerts"], operationId: "createActionPlaybook", requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionPlaybookInput" }),
          responses: { "201": jsonResponse("Created action playbook.", { type: "object", additionalProperties: false, required: ["playbook"], properties: { playbook: { $ref: "#/components/schemas/ActionPlaybook" } } }), "400": { description: "Invalid playbook" } },
        },
      },
  "/action-playbooks/{id}": {
        patch: {
          tags: ["Alerts"], operationId: "updateActionPlaybook", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionPlaybookPatch" }),
          responses: { "200": jsonResponse("Updated action playbook.", { type: "object", additionalProperties: false, required: ["playbook"], properties: { playbook: { $ref: "#/components/schemas/ActionPlaybook" } } }), "400": { description: "Invalid playbook or invalid merged update" }, "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/alerts/{id}/action-playbooks": {
        get: {
          tags: ["Alerts"], operationId: "listAlertActionPlaybooks", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": jsonResponse("Enabled playbooks matching the alert metric.", { type: "object", additionalProperties: false, required: ["playbooks"], properties: { playbooks: { type: "array", items: { $ref: "#/components/schemas/ActionPlaybook" } } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/action-runs": {
        get: {
          tags: ["Alerts"], operationId: "listActionRuns",
          parameters: [{ name: "houseId", in: "query", schema: { type: "string" } }, { name: "sensorId", in: "query", schema: { type: "string" } }, { name: "alertEventId", in: "query", schema: { type: "string" } }, { name: "active", in: "query", schema: { type: "boolean", default: false } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } }],
          responses: { "200": jsonResponse("Durable before-and-after action evidence.", { type: "object", additionalProperties: false, required: ["runs"], properties: { runs: { type: "array", items: { $ref: "#/components/schemas/ActionRun" } } } }), "400": { description: "Invalid house identifier or limit" }, "404": { $ref: "#/components/responses/NotFound" } },
        },
        post: {
          tags: ["Alerts"], operationId: "startActionRun", requestBody: jsonRequestBody({ $ref: "#/components/schemas/ActionRunStartInput" }),
          responses: { "201": jsonResponse("Started action run with a captured baseline.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "400": { description: "Invalid action run" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Baseline unavailable, action already active, or linked alert/task scope mismatch" } },
        },
      },
  "/action-runs/{id}/complete": {
        post: {
          tags: ["Alerts"], operationId: "completeActionRun", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": jsonResponse("Action marked complete and automatic verification scheduled.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/action-runs/{id}/cancel": {
        post: {
          tags: ["Alerts"], operationId: "cancelActionRun", parameters: [{ $ref: "#/components/parameters/Id" }], requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ActionRunCancelInput" } } } },
          responses: { "200": jsonResponse("Cancelled action run.", { type: "object", additionalProperties: false, required: ["run"], properties: { run: { $ref: "#/components/schemas/ActionRun" } } }), "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/data-export/preview": {
        get: {
          tags: ["Context"], operationId: "previewDataExport", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }],
          responses: { "200": jsonResponse("Counts and privacy-sensitive categories included by a prospective export.", { type: "object", additionalProperties: false, required: ["preview"], properties: { preview: { $ref: "#/components/schemas/DataExportPreview" } } }) },
        },
      },
  "/data-export": {
        get: {
          tags: ["Context"], operationId: "exportData", parameters: [{ name: "privacyLevel", in: "query", schema: { enum: ["structure", "operations", "full"], default: "operations" } }, { name: "includeTelemetry", in: "query", schema: { type: "boolean", default: false } }],
          responses: { "200": jsonResponse("Streaming, downloadable local data export.", { $ref: "#/components/schemas/DataExportBundle" }) },
        },
      },
  "/houses/{houseId}/scheduled-data-exports": {
        get: {
          tags: ["Context"], operationId: "listScheduledDataExports",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResponse("Home-owned scheduled exports to the shared NAS destination.", { type: "object", additionalProperties: false, required: ["exports"], properties: { exports: { type: "array", items: { $ref: "#/components/schemas/ScheduledDataExport" } } } }) },
        },
        post: {
          tags: ["Context"], operationId: "createScheduledDataExport",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/ScheduledDataExportInput" }),
          responses: { "201": jsonResponse("Scheduled export created.", { type: "object", additionalProperties: false, required: ["export"], properties: { export: { $ref: "#/components/schemas/ScheduledDataExport" } } }), "409": { description: "A NAS destination must be configured first" } },
        },
      },
  "/houses/{houseId}/scheduled-data-exports/{id}": {
        put: {
          tags: ["Context"], operationId: "updateScheduledDataExport",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/Id" }],
          requestBody: jsonRequestBody({ $ref: "#/components/schemas/ScheduledDataExportUpdate" }),
          responses: { "200": jsonResponse("Scheduled export updated.", { type: "object", additionalProperties: false, required: ["export"], properties: { export: { $ref: "#/components/schemas/ScheduledDataExport" } } }), "409": { description: "Revision conflict, active run, or missing NAS destination" } },
        },
        delete: {
          tags: ["Context"], operationId: "deleteScheduledDataExport",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/Id" }],
          responses: { "204": { description: "Schedule deleted; existing NAS files are retained" }, "409": { description: "The schedule is running" } },
        },
      },
  "/houses/{houseId}/scheduled-data-exports/{id}/run": {
        post: {
          tags: ["Context"], operationId: "runScheduledDataExport",
          parameters: [{ name: "houseId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/Id" }],
          responses: { "202": jsonResponse("CSV generation staged for the isolated NAS worker.", { type: "object", additionalProperties: false, required: ["export"], properties: { export: { $ref: "#/components/schemas/ScheduledDataExport" } } }), "409": { description: "The schedule is already running or the NAS is unavailable" } },
        },
      },
  "/backups/status": {
        get: { tags: ["Context"], operationId: "getBackupStatus", responses: { "200": jsonResponse("Backup scheduler and restore-drill status.", { type: "object", additionalProperties: false, required: ["backup"], properties: { backup: { $ref: "#/components/schemas/BackupOperationStatus" } } }) } },
      },
  "/backups": {
        post: { tags: ["Context"], operationId: "requestBackup", responses: { "202": jsonResponse("Verified backup requested.", { type: "object", additionalProperties: false, required: ["backup"], properties: { backup: { $ref: "#/components/schemas/BackupOperationStatus" } } }) } },
      },
  "/setup/doctor": {
        get: { tags: ["Integrations"], operationId: "runSetupDoctor", responses: { "200": jsonResponse("Installation readiness report.", { type: "object", additionalProperties: false, required: ["report"], properties: { report: { $ref: "#/components/schemas/SetupDoctorReport" } } }) } },
      },
  "/sensors/{id}/label": {
        get: { tags: ["Digital twin"], operationId: "getSensorLabel", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": jsonResponse("Printable sensor identity label descriptor.", { type: "object", additionalProperties: false, required: ["label"], properties: { label: { $ref: "#/components/schemas/SensorLabelDescriptor" } } }), "404": { $ref: "#/components/responses/NotFound" } } },
      },
  "/setup/bulk-sensor-mappings": {
        post: { tags: ["Integrations"], operationId: "bulkUpdateSensorMappings", requestBody: jsonRequestBody({ $ref: "#/components/schemas/BulkSensorMappingsInput" }), responses: { "200": jsonResponse("All sensor bindings saved atomically.", { type: "object", additionalProperties: false, required: ["sensors"], properties: { sensors: { type: "array", items: { $ref: "#/components/schemas/Sensor" } } } }), "400": { description: "Invalid mapping table" } } },
      },
  "/observations": {
        get: { tags: ["Context"], operationId: "listObservations", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Manual observations", content: { "application/json": { schema: { type: "object", required: ["observations"], properties: { observations: { type: "array", items: { $ref: "#/components/schemas/ManualObservation" } } } } } } } } },
        post: { tags: ["Context"], operationId: "createObservation", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ObservationInput" } } } }, responses: { "201": { description: "Created observation", content: { "application/json": { schema: { $ref: "#/components/schemas/ManualObservation" } } } } } },
      },
  "/observations/{id}": {
        patch: {
          tags: ["Context"], operationId: "updateObservation", parameters: [{ $ref: "#/components/parameters/Id" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ObservationPatch" } } } },
          responses: {
            "200": { description: "Updated observation", content: { "application/json": { schema: { $ref: "#/components/schemas/ManualObservation" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "baseRevision is stale" },
            "422": { description: "Invalid time, lifecycle, or house/floor/sensor relationship" },
          },
        },
        delete: {
          tags: ["Context"], operationId: "deleteObservation", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: {
            "204": { description: "Permanently deleted" },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "Observation is linked to maintenance and must be explicitly unlinked first" },
          },
        },
      },
  "/observations/{id}/revisions": {
        get: {
          tags: ["Context"], operationId: "listObservationRevisions", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: {
            "200": { description: "Append-only observation revisions", content: { "application/json": { schema: { type: "object", required: ["revisions"], properties: { revisions: { type: "array", items: { $ref: "#/components/schemas/ObservationRevision" } } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
  "/maintenance-tasks": {
        get: {
          tags: ["Context"], operationId: "listMaintenanceTasks",
          parameters: [{ $ref: "#/components/parameters/PropertyIdQuery" }, { $ref: "#/components/parameters/HouseIdQuery" }, { $ref: "#/components/parameters/AreaIdQuery" }, { $ref: "#/components/parameters/EquipmentIdQuery" }, { $ref: "#/components/parameters/CollectionLimitQuery" }, { $ref: "#/components/parameters/CollectionOffsetQuery" }],
          responses: { "200": { description: "Property, house, area, or equipment maintenance tasks", content: { "application/json": { schema: { type: "object", required: ["maintenanceTasks"], properties: { maintenanceTasks: { type: "array", items: { $ref: "#/components/schemas/MaintenanceTask" } } } } } } } },
        },
        post: {
          tags: ["Context"], operationId: "createMaintenanceTask",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTaskInput" } } } },
          responses: {
            "201": { description: "Created maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "Maintenance id conflict or linked observation belongs to another house" },
            "422": { description: "Invalid maintenance schedule or relationship" },
          },
        },
      },
  "/maintenance-tasks/{id}": {
        get: {
          tags: ["Context"], operationId: "getMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: {
            "200": { description: "Maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        patch: {
          tags: ["Context"], operationId: "updateMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTaskPatch" } } } },
          responses: {
            "200": { description: "Updated maintenance task", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceTask" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "baseRevision is stale or an evidence link crosses house scope" },
            "422": { description: "Invalid maintenance schedule or lifecycle transition" },
          },
        },
        delete: {
          tags: ["Context"], operationId: "deleteMaintenanceTask", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "204": { description: "Permanently deleted" }, "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
  "/maintenance-tasks/{id}/revisions": {
        get: {
          tags: ["Context"], operationId: "listMaintenanceTaskRevisions", parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: {
            "200": { description: "Append-only maintenance task revisions", content: { "application/json": { schema: { type: "object", required: ["revisions"], properties: { revisions: { type: "array", items: { $ref: "#/components/schemas/MaintenanceTaskRevision" } } } } } } },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
  "/parameters": {
        get: { tags: ["Context"], operationId: "listStaticParameters", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Static parameters", content: { "application/json": { schema: { type: "object", required: ["parameters"], properties: { parameters: { type: "array", items: { $ref: "#/components/schemas/StaticParameter" } } } } } } } } },
        post: { tags: ["Context"], operationId: "upsertStaticParameter", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameterInput" } } } }, responses: { "200": { description: "Saved parameter", content: { "application/json": { schema: { type: "object", required: ["parameter"], properties: { parameter: { $ref: "#/components/schemas/StaticParameter" } } } } } } } },
      },
  "/parameters/{id}": { delete: { tags: ["Context"], operationId: "deleteStaticParameter", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } } },
  "/static-parameters": {
        get: { tags: ["Context"], operationId: "listStaticParametersCompatibility", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Compatibility alias of /parameters", content: { "application/json": { schema: { type: "object", required: ["parameters"], properties: { parameters: { type: "array", items: { $ref: "#/components/schemas/StaticParameter" } } } } } } } } },
        post: { tags: ["Context"], operationId: "saveStaticParameterCompatibility", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameterInput" } } } }, responses: { "201": { description: "Saved parameter", content: { "application/json": { schema: { $ref: "#/components/schemas/StaticParameter" } } } } } },
      },
  "/assets": {
        get: { tags: ["Digital twin"], operationId: "listAssets", parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }], responses: { "200": { description: "Floor plan and 3D asset metadata", content: { "application/json": { schema: { type: "object", required: ["assets"], properties: { assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } } } } } } } } },
        post: { tags: ["Digital twin"], operationId: "uploadAsset", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AssetUploadInput" } } } }, responses: { "201": { description: "Uploaded base64 asset", content: { "application/json": { schema: { type: "object", required: ["asset", "url"], properties: { asset: { $ref: "#/components/schemas/Asset" }, url: { type: "string" } } } } } }, "413": { description: "Decoded asset exceeds 10 MiB" }, "415": { description: "Unsupported asset media type" } } },
      },
  "/assets/{id}": { get: { tags: ["Digital twin"], operationId: "downloadAsset", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "200": { description: "Asset bytes", content: { "*/*": { schema: { type: "string", contentEncoding: "base64" } } } } } }, delete: { tags: ["Digital twin"], operationId: "deleteAsset", parameters: [{ $ref: "#/components/parameters/Id" }], responses: { "204": { description: "Deleted" } } } },
  "/integrations/status": { get: { tags: ["Integrations"], operationId: "integrationStatus", responses: { "200": { description: "Redacted integration status", content: { "application/json": { schema: { $ref: "#/components/schemas/IntegrationStatus" } } } } } } },
} as const;
