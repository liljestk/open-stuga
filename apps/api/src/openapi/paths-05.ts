export const pathsPart05 = {
  "/integrations/gree/discover": {
    post: {
      tags: ["Integrations"],
      operationId: "discoverGree",
      description: "Runs a non-binding local scan for compatible Gree-protocol heat pumps. No integration is created and no device setting is changed.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["houseId"],
              properties: { houseId: { type: "string", minLength: 1 } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Sanitized Gree-compatible devices visible on the local network",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["devices"],
                properties: {
                  devices: {
                    type: "array",
                    items: { $ref: "#/components/schemas/GreeDiscoveredDevice" },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/integrations/gree/config": {
    put: {
      tags: ["Integrations"],
      operationId: "configureGree",
      description: "Explicitly binds a discovered Gree-compatible heat pump for read-only local state. The protocol binding key is stored server-side and is never returned.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GreeConfigInput" },
          },
        },
      },
      responses: {
        "200": {
          description: "Heat pump added and polling started",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["ok", "configured", "connectionId", "houseId", "state", "integration"],
                properties: {
                  ok: { const: true },
                  configured: { const: true },
                  connectionId: { type: "string" },
                  houseId: { type: "string" },
                  state: { $ref: "#/components/schemas/HeatPumpState" },
                  integration: { $ref: "#/components/schemas/IntegrationStatus" },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "The physical heat pump is already configured or its inventory identity conflicts" },
        "422": { description: "The heat pump could not be bound on the local network" },
      },
    },
  },
  "/integrations/gree/config/{connectionId}": {
    delete: {
      tags: ["Integrations"],
      operationId: "disconnectGree",
      description: "Deletes the saved local binding key and stops polling. Equipment inventory and previously recorded state history are retained.",
      parameters: [{
        name: "connectionId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      }],
      responses: {
        "200": {
          description: "Heat-pump connection removed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["ok", "integration"],
                properties: {
                  ok: { const: true },
                  integration: { $ref: "#/components/schemas/IntegrationStatus" },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/heat-pumps": {
    get: {
      tags: ["Integrations"],
      operationId: "listHeatPumpStates",
      description: "Returns the latest typed state for active direct Gree-compatible heat-pump connections.",
      parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }],
      responses: {
        "200": {
          description: "Current heat-pump states visible to the signed-in account",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["states"],
                properties: {
                  states: {
                    type: "array",
                    items: { $ref: "#/components/schemas/HeatPumpState" },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/heat-pumps/{connectionId}/history": {
    get: {
      tags: ["Integrations"],
      operationId: "getHeatPumpStateHistory",
      description: "Returns bounded timestamped observation history for one visible heat pump, including unchanged polls.",
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1 },
        },
        { $ref: "#/components/parameters/FromQuery" },
        { $ref: "#/components/parameters/ToQuery" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 250 },
        },
      ],
      responses: {
        "200": {
          description: "Heat-pump state observation history, newest first",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["states"],
                properties: {
                  states: {
                    type: "array",
                    items: { $ref: "#/components/schemas/HeatPumpState" },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "503": { description: "Complete retained history requires the temporarily unavailable telemetry archive" },
      },
    },
  },
} as const;
