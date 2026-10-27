import { alertRuleProperties, confirmationProperty, measurementDefinitionProperties, measurementSampleSchema, readingInputSchema } from "./04-point-schema-to-summarize-mcp-stuguby.js";

export const mcpToolDefinitionsPart03 = [
  {
        name: "create_measurement_definition",
        description: "Create a custom numeric measurement definition.",
        inputSchema: {
          type: "object",
          properties: {
            definition: {
              type: "object",
              properties: { id: { type: "string" }, ...measurementDefinitionProperties },
              required: ["id", "labels", "unit"],
              additionalProperties: false,
            },
          },
          required: ["definition"],
          additionalProperties: false,
        },
      },
  {
        name: "update_measurement_definition",
        description: "Update mutable fields of an existing measurement definition.",
        inputSchema: {
          type: "object",
          properties: {
            metric: { type: "string" },
            patch: { type: "object", properties: measurementDefinitionProperties, minProperties: 1, additionalProperties: false },
          },
          required: ["metric", "patch"],
          additionalProperties: false,
        },
      },
  {
        name: "disable_measurement_definition",
        description: "Disable a measurement definition without deleting its historical samples or alert rules.",
        inputSchema: { type: "object", properties: { metric: { type: "string" } }, required: ["metric"], additionalProperties: false },
      },
  {
        name: "ingest_measurements",
        description: "Atomically persist 1-1000 validated registry measurement samples with server-assigned API provenance and durable alert evaluation. A separate API process's SSE bus is unavailable to the isolated MCP process.",
        inputSchema: { type: "object", properties: { samples: { type: "array", minItems: 1, maxItems: 1000, items: measurementSampleSchema } }, required: ["samples"], additionalProperties: false },
      },
  {
        name: "import_measurements",
        description: "Duplicate-safe import of 1-10000 historical measurement samples without live events or alert evaluation.",
        inputSchema: { type: "object", properties: { samples: { type: "array", minItems: 1, maxItems: 10000, items: measurementSampleSchema } }, required: ["samples"], additionalProperties: false },
      },
  {
        name: "ingest_readings",
        description: "Ingest 1-1000 validated v1 temperature/humidity readings plus optional registry projections.",
        inputSchema: { type: "object", properties: { readings: { type: "array", minItems: 1, maxItems: 1000, items: readingInputSchema } }, required: ["readings"], additionalProperties: false },
      },
  {
        name: "get_measurement_snapshot",
        description: "Get the latest independently timestamped sample for every registered metric on each sensor, optionally scoped to one house.",
        inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
      },
  {
        name: "query_measurement_history",
        description: "Query independently timestamped samples for any registered metric.",
        inputSchema: {
          type: "object",
          properties: { sensorId: { type: "string" }, metric: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 50000 } },
          required: ["sensorId", "metric", "from", "to"], additionalProperties: false,
        },
      },
  {
        name: "forecast_measurement",
        description: "Forecast one registered metric when its definition explicitly enables forecasting.",
        inputSchema: {
          type: "object",
          properties: { sensorId: { type: "string" }, metric: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } },
          required: ["sensorId", "metric"], additionalProperties: false,
        },
      },
  {
        name: "get_sensor_snapshot",
        description: "Get one sensor, its position, and its latest temperature/humidity reading.",
        inputSchema: { type: "object", properties: { sensorId: { type: "string" } }, required: ["sensorId"], additionalProperties: false },
      },
  {
        name: "query_history",
        description: "Query durable sensor history over an ISO date-time range.",
        inputSchema: {
          type: "object",
          properties: { sensorId: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 50000 } },
          required: ["sensorId", "from", "to"], additionalProperties: false,
        },
      },
  {
        name: "forecast_sensor",
        description: "Return a bounded linear baseline forecast and confidence bands for a sensor.",
        inputSchema: { type: "object", properties: { sensorId: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["sensorId"], additionalProperties: false },
      },
  {
        name: "list_active_alerts",
        description: "List unresolved climate alert events.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "list_alert_rules",
        description: "List all configured alert rules.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "create_alert_rule",
        description: "Create a metric threshold alert rule.",
        inputSchema: {
          type: "object",
          properties: {
            rule: {
              type: "object",
              properties: { id: { type: "string" }, ...alertRuleProperties },
              required: ["name", "metric", "operator", "threshold", "durationSeconds", "severity"],
              additionalProperties: false,
            },
          },
          required: ["rule"],
          additionalProperties: false,
        },
      },
  {
        name: "update_alert_rule",
        description: "Update mutable fields of an alert rule.",
        inputSchema: {
          type: "object",
          properties: { ruleId: { type: "string" }, patch: { type: "object", properties: alertRuleProperties, minProperties: 1, additionalProperties: false } },
          required: ["ruleId", "patch"],
          additionalProperties: false,
        },
      },
  {
        name: "delete_alert_rule",
        description: "Permanently delete an alert rule. Requires confirm=true.",
        inputSchema: { type: "object", properties: { ruleId: { type: "string" }, ...confirmationProperty }, required: ["ruleId", "confirm"], additionalProperties: false },
      },
  {
        name: "list_alert_events",
        description: "List recent alert events, optionally only unresolved events.",
        inputSchema: { type: "object", properties: { activeOnly: { type: "boolean", default: false }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }, additionalProperties: false },
      },
  {
        name: "list_notification_deliveries",
        description: "List recent webhook and Telegram notification-delivery state, including retry/dead-letter status but no credentials.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
          additionalProperties: false,
        },
      },
  {
        name: "list_action_playbooks",
        description: "List advisory action playbooks, optionally for one metric or only enabled playbooks.",
        inputSchema: {
          type: "object",
          properties: {
            metric: { type: "string", minLength: 1, maxLength: 200 },
            enabledOnly: { type: "boolean", default: false },
          },
          additionalProperties: false,
        },
      },
  {
        name: "list_action_runs",
        description: "List recent guided action runs, optionally filtered by Home, sensor, alert, or active state.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            sensorId: { type: "string", minLength: 1, maxLength: 200 },
            alertEventId: { type: "string", minLength: 1, maxLength: 200 },
            activeOnly: { type: "boolean", default: false },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 500 },
          },
          additionalProperties: false,
        },
      },
  {
        name: "acknowledge_alert",
        description: "Acknowledge an alert event at the current server time.",
        inputSchema: { type: "object", properties: { alertId: { type: "string" } }, required: ["alertId"], additionalProperties: false },
      },
  {
        name: "list_observations",
        description: "List manual leak, condensation, mould, ventilation, maintenance, and note observations.",
        inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
      },
] as const;
