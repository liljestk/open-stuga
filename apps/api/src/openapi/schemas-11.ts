const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"], format: "date-time" } as const;

export const schemasPart11 = {
  Nexus433Sample: {
    type: "object",
    additionalProperties: false,
    required: ["temperature", "humidity", "battery", "quality"],
    properties: {
      temperature: { type: "number", minimum: -40, maximum: 60 },
      humidity: { type: "integer", minimum: 0, maximum: 100 },
      battery: { enum: ["ok", "low"] },
      quality: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
  Nexus433Candidate: {
    type: "object",
    additionalProperties: false,
    required: ["id", "providerKey", "senderId", "channel", "firstSeenAt", "lastSeenAt", "expiresAt", "sample"],
    properties: {
      id: { type: "string" },
      providerKey: { type: "string", pattern: "^[0-9a-f]{4}$" },
      senderId: { type: "string", pattern: "^[0-9a-f]{2}$" },
      channel: { type: "integer", minimum: 0, maximum: 2 },
      firstSeenAt: dateTime,
      lastSeenAt: dateTime,
      expiresAt: dateTime,
      sample: { $ref: "#/components/schemas/Nexus433Sample" },
    },
  },
  Nexus433Binding: {
    type: "object",
    additionalProperties: false,
    required: ["id", "sensorId", "providerKey", "senderId", "channel", "revision", "battery", "signalQuality", "available", "lastSeenAt", "lastAcceptedAt", "createdAt"],
    properties: {
      id: { type: "string" },
      sensorId: { type: "string" },
      providerKey: { type: "string", pattern: "^[0-9a-f]{4}$" },
      senderId: { type: "string", pattern: "^[0-9a-f]{2}$" },
      channel: { type: "integer", minimum: 0, maximum: 2 },
      revision: { type: "integer", minimum: 1 },
      battery: { enum: ["ok", "low", null] },
      signalQuality: { type: ["integer", "null"], minimum: 0, maximum: 100 },
      available: { type: "boolean" },
      lastSeenAt: nullableDateTime,
      lastAcceptedAt: nullableDateTime,
      createdAt: dateTime,
    },
  },
  Nexus433Status: {
    type: "object",
    additionalProperties: false,
    required: ["houseId", "capability", "enabled", "revision", "runtime", "brokerConnected", "receiverOnline", "receiverIdentity", "lastMessageAt", "error", "operation"],
    properties: {
      houseId: { type: "string" },
      capability: {
        type: "object",
        additionalProperties: false,
        required: ["available", "gpioChip", "gpioLine"],
        properties: {
          available: { type: "boolean" },
          gpioChip: { type: ["string", "null"] },
          gpioLine: { type: ["integer", "null"], minimum: 0, maximum: 255 },
        },
      },
      enabled: { type: "boolean" },
      revision: { type: "integer", minimum: 0 },
      runtime: { enum: ["unavailable", "disabled", "starting", "connected", "disconnected", "error"] },
      brokerConnected: { type: "boolean" },
      receiverOnline: { type: ["boolean", "null"] },
      receiverIdentity: { type: ["string", "null"] },
      lastMessageAt: nullableDateTime,
      error: { type: ["string", "null"] },
      operation: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "enabled", "phase", "requestedAt", "completedAt", "detail"],
            properties: {
              id: { type: "string" },
              enabled: { type: "boolean" },
              phase: { enum: ["queued", "applying", "complete", "failed"] },
              requestedAt: dateTime,
              completedAt: nullableDateTime,
              detail: { type: ["string", "null"] },
            },
          },
        ],
      },
    },
  },
} as const;
