const houseQuery = {
  name: "houseId",
  in: "query",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 200 },
} as const;

export const pathsPart07 = {
  "/integrations/nexus433/status": {
    get: {
      tags: ["Integrations"], operationId: "getNexus433Status", parameters: [houseQuery],
      responses: { "200": { description: "Receiver capability and state", content: { "application/json": { schema: { $ref: "#/components/schemas/Nexus433Status" } } } } },
    },
  },
  "/integrations/nexus433/config": {
    put: {
      tags: ["Integrations"], operationId: "configureNexus433",
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["houseId", "enabled"],
        properties: { houseId: { type: "string" }, enabled: { type: "boolean" }, expectedRevision: { type: "integer", minimum: 0 } },
      } } } },
      responses: { "202": { description: "Host change queued", content: { "application/json": { schema: { $ref: "#/components/schemas/Nexus433Status" } } } }, "409": { description: "Receiver assignment changed or belongs to another Home" } },
    },
  },
  "/integrations/nexus433/candidates": {
    get: {
      tags: ["Integrations"], operationId: "listNexus433Candidates", parameters: [houseQuery],
      responses: { "200": { description: "Recently observed unassigned senders", content: { "application/json": { schema: { type: "object", required: ["candidates"], properties: { candidates: { type: "array", items: { $ref: "#/components/schemas/Nexus433Candidate" } } } } } } } },
    },
  },
  "/integrations/nexus433/bindings": {
    get: {
      tags: ["Integrations"], operationId: "listNexus433Bindings", parameters: [houseQuery],
      responses: { "200": { description: "Current logical sensor bindings", content: { "application/json": { schema: { type: "object", required: ["bindings"], properties: { bindings: { type: "array", items: { $ref: "#/components/schemas/Nexus433Binding" } } } } } } } },
    },
    post: {
      tags: ["Integrations"], operationId: "bindNexus433Candidate",
      description: "Binds a discovered sender to an existing Sensor, or atomically creates and binds a Sensor.",
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["houseId", "candidateId"],
        properties: { houseId: { type: "string" }, candidateId: { type: "string" }, sensorId: { type: "string" }, sensor: { $ref: "#/components/schemas/SensorInput" } },
      } } } },
      responses: { "201": { description: "Sender bound", content: { "application/json": { schema: { type: "object", required: ["binding"], properties: { binding: { $ref: "#/components/schemas/Nexus433Binding" }, sensor: { $ref: "#/components/schemas/Sensor" } } } } } }, "409": { description: "Sender or Sensor is already bound" } },
    },
  },
  "/integrations/nexus433/bindings/{sensorId}/reconnect": {
    post: {
      tags: ["Integrations"], operationId: "reconnectNexus433Sensor",
      parameters: [{ name: "sensorId", in: "path", required: true, schema: { type: "string" } }],
      description: "Replaces a battery-reset sender identity while preserving the Sensor UUID and history.",
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["houseId", "candidateId", "expectedRevision"],
        properties: { houseId: { type: "string" }, candidateId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 } },
      } } } },
      responses: { "200": { description: "Logical Sensor reconnected", content: { "application/json": { schema: { type: "object", required: ["binding"], properties: { binding: { $ref: "#/components/schemas/Nexus433Binding" } } } } } }, "409": { description: "Binding changed concurrently" } },
    },
  },
} as const;
