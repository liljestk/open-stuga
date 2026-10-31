import { jsonRequestBody, jsonResponse } from "./support/index.js";

const statusReference = { $ref: "#/components/schemas/ExportDestinationStatus" } as const;
const providerParameter = {
  name: "provider", in: "path", required: true, schema: { enum: ["dropbox", "google-drive"] },
} as const;

export const exportDestinationPaths = {
  "/system/export-destinations": {
    get: {
      tags: ["Context"], operationId: "getExportDestinations",
      description: "Owner/Admin-only choice of where scheduled CSV exports go (the shared NAS, Dropbox, or Google Drive), connected cloud accounts, and any sign-in in progress. Refresh tokens are never returned.",
      security: [{ localSession: [] }],
      responses: {
        "200": jsonResponse("Export destination status.", statusReference),
        "403": { description: "Owner or Admin role required" },
      },
    },
    put: {
      tags: ["Context"], operationId: "selectExportDestination",
      description: "Chooses the destination for every Home's scheduled exports. A cloud drive must be connected first.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: jsonRequestBody({
        type: "object", additionalProperties: false, required: ["selected"],
        properties: { selected: { enum: ["nas", "dropbox", "google-drive"] } },
      }),
      responses: {
        "200": jsonResponse("Updated export destination status.", statusReference),
        "400": { description: "Unknown destination" },
        "409": { description: "The cloud drive is not connected" },
      },
    },
  },
  "/system/export-destinations/connection": {
    delete: {
      tags: ["Context"], operationId: "cancelExportDestinationConnection",
      description: "Abandons the cloud sign-in in progress, if any. Connected accounts are kept.",
      security: [{ localSession: [], csrfToken: [] }],
      responses: { "200": jsonResponse("Export destination status without a pending sign-in.", statusReference) },
    },
  },
  "/system/export-destinations/{provider}/connect": {
    post: {
      tags: ["Context"], operationId: "connectExportDestination",
      description: "Starts a sign-in. Dropbox returns a page to open whose code is pasted back; Google Drive returns a short code to enter at Google's device page and finishes on its own once approved. Connecting also selects the drive.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [providerParameter],
      responses: {
        "200": jsonResponse("Export destination status with the pending sign-in.", statusReference),
        "404": { description: "Unknown provider" },
        "409": { description: "The provider is not set up on this installation" },
        "502": { description: "The provider could not start a sign-in" },
      },
    },
  },
  "/system/export-destinations/{provider}/code": {
    post: {
      tags: ["Context"], operationId: "submitExportDestinationCode",
      description: "Finishes a Dropbox sign-in with the code Dropbox showed after Allow.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [providerParameter],
      requestBody: jsonRequestBody({
        type: "object", additionalProperties: false, required: ["connectionId", "code"],
        properties: { connectionId: { type: "string", format: "uuid" }, code: { type: "string", minLength: 8, maxLength: 512 } },
      }),
      responses: {
        "200": jsonResponse("Connected export destination status.", statusReference),
        "400": { description: "Missing, malformed, or rejected code" },
        "409": { description: "No matching sign-in is in progress" },
        "502": { description: "Dropbox could not be reached" },
      },
    },
  },
  "/system/export-destinations/{provider}": {
    delete: {
      tags: ["Context"], operationId: "disconnectExportDestination",
      description: "Forgets the cloud account and revokes its access when the provider allows. Exports switch back to the NAS if this drive was selected; files already uploaded are kept.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [providerParameter],
      responses: {
        "200": jsonResponse("Export destination status after disconnecting.", statusReference),
        "404": { description: "Unknown provider" },
      },
    },
  },
};

const timestamp = { type: ["string", "null"], format: "date-time" } as const;

export const exportDestinationSchemas = {
  CloudExportAccount: {
    type: "object", additionalProperties: false,
    required: ["provider", "available", "connected", "accountLabel", "connectedAt"],
    properties: {
      provider: { enum: ["dropbox", "google-drive"] },
      available: { type: "boolean", description: "False until this installation has the provider's app ID." },
      connected: { type: "boolean" },
      accountLabel: { type: ["string", "null"], maxLength: 320 },
      connectedAt: timestamp,
    },
  },
  CloudExportConnection: {
    type: "object", additionalProperties: false,
    required: ["id", "provider", "method", "url", "userCode", "expiresAt", "error"],
    properties: {
      id: { type: "string", format: "uuid" },
      provider: { enum: ["dropbox", "google-drive"] },
      method: { enum: ["paste-code", "enter-code"] },
      url: { type: "string", format: "uri" },
      userCode: { type: ["string", "null"] },
      expiresAt: { type: "string", format: "date-time" },
      error: { type: ["string", "null"] },
    },
  },
  ExportDestinationStatus: {
    type: "object", additionalProperties: false,
    required: ["selected", "ready", "nasConnected", "accounts", "connection"],
    properties: {
      selected: { enum: ["nas", "dropbox", "google-drive"] },
      ready: { type: "boolean" },
      nasConnected: { type: "boolean" },
      accounts: { type: "array", items: { $ref: "#/components/schemas/CloudExportAccount" } },
      connection: { oneOf: [{ $ref: "#/components/schemas/CloudExportConnection" }, { type: "null" }] },
    },
  },
};
