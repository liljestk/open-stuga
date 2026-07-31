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
  "/integrations/tuya/discover": {
    post: {
      tags: ["Integrations"],
      operationId: "discoverTuyaLanDevices",
      security: [{ localSession: [], csrfToken: [] }],
      description: "Owner/Admin-only, non-binding LAN discovery for Tuya devices. Raw device identities appear only in this setup response.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["houseId"],
              properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Tuya LAN advertisements visible to this Stugu host",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["devices"],
                properties: {
                  devices: {
                    type: "array",
                    items: { $ref: "#/components/schemas/TuyaDiscoveredDevice" },
                  },
                },
              },
            },
          },
        },
        "403": { description: "Owner or Admin role required" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/integrations/tuya/config": {
    put: {
      tags: ["Integrations"],
      operationId: "configureTuyaLanDevice",
      security: [{ localSession: [], csrfToken: [] }],
      description: "Owner/Admin-only local verification and binding. The local key and raw device identity are write-only and remain in Stugu's protected integration-secret store.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TuyaConfigInput" },
          },
        },
      },
      responses: {
        "200": {
          description: "Verified device saved and supervised polling started",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["ok", "configured", "connectionId", "state", "integration"],
                properties: {
                  ok: { const: true },
                  configured: { const: true },
                  connectionId: { type: "string" },
                  state: { $ref: "#/components/schemas/ConnectedDeviceState" },
                  integration: { $ref: "#/components/schemas/IntegrationStatus" },
                },
              },
            },
          },
        },
        "400": { description: "Malformed credentials, protocol, placement, or non-local address" },
        "403": { description: "Owner or Admin role required" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Device, inventory identity, or concurrent setup conflict" },
        "422": { description: "Local verification failed or the datapoint profile is unsupported" },
      },
    },
  },
  "/integrations/tuya/config/{connectionId}": {
    delete: {
      tags: ["Integrations"],
      operationId: "disconnectTuyaLanDevice",
      security: [{ localSession: [], csrfToken: [] }],
      description: "Owner/Admin-only credential revocation. Polling stops; inventory and measured energy history are retained.",
      parameters: [{
        name: "connectionId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      }],
      responses: {
        "200": {
          description: "Tuya connection removed",
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
        "403": { description: "Owner or Admin role required" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/connected-devices": {
    get: {
      tags: ["Digital twin"],
      operationId: "listConnectedDevices",
      description: "Returns provider-neutral current device state. Provider credentials, raw datapoints, and Tuya device identities are excluded.",
      parameters: [{ $ref: "#/components/parameters/HouseIdQuery" }],
      responses: {
        "200": {
          description: "Current connected-device states visible to this account",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["devices"],
                properties: {
                  devices: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ConnectedDeviceState" },
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
  "/connected-devices/{connectionId}/placement": {
    patch: {
      tags: ["Digital twin"],
      operationId: "placeConnectedDevice",
      security: [{ localSession: [], csrfToken: [] }],
      description: "Updates the shared 2D/3D Home placement. Metering is disabled while a metered device is unplaced.",
      parameters: [{
        name: "connectionId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ConnectedDevicePlacementPatch" },
          },
        },
      },
      responses: {
        "200": {
          description: "Placement saved",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["state", "energySensorId"],
                properties: {
                  state: {
                    oneOf: [
                      { $ref: "#/components/schemas/ConnectedDeviceState" },
                      { type: "null" },
                    ],
                  },
                  energySensorId: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "422": { description: "Placement is incomplete or outside the selected Home floor" },
      },
    },
  },
  "/connected-devices/{connectionId}/commands": {
    post: {
      tags: ["Digital twin"],
      operationId: "commandConnectedDevice",
      security: [{ localSession: [], csrfToken: [] }],
      description: "Sends a bounded absolute command. operationId makes same-payload retries idempotent.",
      parameters: [{
        name: "connectionId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ConnectedDeviceCommand" },
          },
        },
      },
      responses: {
        "200": {
          description: "Device-confirmed state, including idempotent retries",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["ok", "deduplicated", "state"],
                properties: {
                  ok: { const: true },
                  deduplicated: { type: "boolean" },
                  state: { $ref: "#/components/schemas/ConnectedDeviceState" },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "operationId conflict or a matching command is still in progress" },
        "422": { description: "Command is unsupported or outside the verified profile bounds" },
        "503": { description: "The local device did not confirm the command" },
      },
    },
  },
} as const;
