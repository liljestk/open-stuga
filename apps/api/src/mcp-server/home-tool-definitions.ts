

export const homeToolDefinitions = [
  {
        name: "search_locations",
        description: "Search worldwide place and timezone suggestions through Open-Meteo geocoding. The query is sent to that public service only when this tool is called.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 2, maxLength: 120 },
            language: { type: "string", pattern: "^[a-zA-Z]{2}$", default: "en" },
            limit: { type: "integer", minimum: 1, maximum: 10, default: 6 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
  {
        name: "resolve_coordinate_defaults",
        description: "Resolve an IANA timezone for explicitly supplied WGS84 coordinates through Open-Meteo.",
        inputSchema: {
          type: "object",
          properties: {
            latitude: { type: "number", minimum: -90, maximum: 90 },
            longitude: { type: "number", minimum: -180, maximum: 180 },
          },
          required: ["latitude", "longitude"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_weather",
        description: "Read the latest locally stored provider-neutral current conditions, forecast, and warning coverage for a located Home without contacting the provider.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string" },
            hours: { type: "integer", minimum: 1, maximum: 240, default: 48 },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_opening_states",
        description: "Inspect effective door, window, and vent opening states and optionally their bounded observation history.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            at: { type: "string", format: "date-time" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 10_000, default: 10_000 },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_opening_activity",
        description: "Derive canonical door and window timelines, open durations, and transition counts for one Home.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            elementIds: {
              type: "array",
              maxItems: 500,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_electricity_price",
        description: "Inspect the current effective electricity price for one Home and optional bounded price history inherited from its Property.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_energy_cost",
        description: "Calculate read-only energy consumption, price coverage, and cost for one Home energy sensor over a bounded range.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            sensorId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId", "sensorId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_energy_summary",
        description: "Calculate a versioned Home total across every electricity source, preferring cumulative counters and safely integrating power-only plugs.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "query_outdoor_temperature_history",
        description: "Query locally retained outdoor-temperature history for a located Home.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "run_thermal_simulation",
        description: "Fit the experimental first-order room model from observed indoor and outdoor temperatures and return calibration quality, reconstruction, residuals, and an optional constant-outdoor scenario.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string" },
            sensorId: { type: "string" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            horizonHours: { type: "integer", minimum: 0, maximum: 72, default: 12 },
            scenarioOutdoorTemperatureC: { type: "number" },
          },
          required: ["houseId", "sensorId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_thermal_isolation",
        description: "Compare the experimental thermal-isolation model across up to 64 enabled temperature sensors in one Home.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "list_sensors",
        description: "Discover configured sensors, optionally scoped to one house.",
        inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
      },
  {
        name: "list_measurement_definitions",
        description: "List the registry of built-in and custom measurement definitions, units, ranges, and capabilities.",
        inputSchema: { type: "object", properties: { includeDisabled: { type: "boolean" } }, additionalProperties: false },
      },
] as const;
