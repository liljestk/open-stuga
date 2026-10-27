

export const mcpToolDefinitionsPart03 = [
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
        name: "list_observations",
        description: "List manual leak, condensation, mould, ventilation, maintenance, and note observations.",
        inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
      },
] as const;
