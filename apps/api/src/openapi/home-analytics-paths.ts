export const homeAnalyticsPaths = {
  "/analytics/calendar-comparison": {
    post: {
      servers: [{ url: "/api/v2" }],
      tags: ["Measurements"],
      operationId: "compareCalendarPeriods",
      description: "Compares complete Home-local calendar periods. The server owns timezone resolution, evidence windows, aggregation, alignment, and summaries.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CalendarComparisonRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Server-aligned per-sensor and combined calendar series",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CalendarComparisonResponse" },
            },
          },
        },
        "400": { description: "Malformed intent or browser-supplied range/timezone field" },
        "404": { description: "The Home, sensor, or measurement is unavailable" },
        "409": { description: "Requested dataMode does not match the local database mode" },
        "422": { description: "The aggregation or selected period is unavailable" },
        "503": { description: "Complete telemetry history is temporarily unavailable" },
      },
    },
  },
  "/monitoring/houses": {
    get: {
      servers: [{ url: "/api/v2" }],
      tags: ["Measurements"],
      operationId: "listHomeMonitoring",
      description: "Returns authoritative monitoring status, coverage, alert counts, and blockers for every visible Home.",
      parameters: [{
        name: "dataMode",
        in: "query",
        required: true,
        schema: { enum: ["live", "demo"] },
      }],
      responses: {
        "200": {
          description: "Versioned monitoring summaries",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/HomeMonitoringCollectionResponse" },
            },
          },
        },
        "400": { description: "dataMode is missing or invalid" },
        "409": { description: "Requested dataMode does not match the local database mode" },
      },
    },
  },
  "/monitoring/houses/{houseId}": {
    get: {
      servers: [{ url: "/api/v2" }],
      tags: ["Measurements"],
      operationId: "getHomeMonitoring",
      description: "Returns authoritative monitoring detail, freshness, and ranked insight codes for one visible Home.",
      parameters: [
        {
          name: "houseId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 200 },
        },
        {
          name: "dataMode",
          in: "query",
          required: true,
          schema: { enum: ["live", "demo"] },
        },
        {
          name: "include",
          in: "query",
          schema: { const: "insights" },
        },
      ],
      responses: {
        "200": {
          description: "Versioned monitoring detail and insights",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/HomeMonitoringDetailResponse" },
            },
          },
        },
        "400": { description: "dataMode or include is invalid" },
        "404": { description: "The Home is absent or outside the caller's visibility" },
        "409": { description: "Requested dataMode does not match the local database mode" },
      },
    },
  },
} as const;
