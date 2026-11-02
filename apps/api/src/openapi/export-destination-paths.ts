import { jsonRequestBody, jsonResponse } from "./support/index.js";

const statusReference = { $ref: "#/components/schemas/ExportDestinationStatus" } as const;
const providerParameter = {
  name: "provider", in: "path", required: true, schema: { enum: ["dropbox", "google-drive"] },
} as const;

export const exportDestinationPaths = {
  "/system/export-destinations": {
    get: {
      tags: ["Context"], operationId: "getExportDestinations",
      description: "The signed-in Owner/Admin's choice of where the scheduled CSV exports they set up go (the shared NAS, or a Dropbox or Google Drive of their own), the cloud drives they connected, and their sign-in in progress. Nobody sees another person's drives. Refresh tokens are never returned.",
      security: [{ localSession: [] }],
      responses: {
        "200": jsonResponse("Export destination status.", statusReference),
        "403": { description: "Owner or Admin role required" },
      },
    },
    put: {
      tags: ["Context"], operationId: "selectExportDestination",
      description: "Chooses where the signed-in person's scheduled exports go, in every Home. A cloud drive must be connected first.",
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
      description: "Abandons the signed-in person's cloud sign-in in progress, if any. Connected accounts are kept.",
      security: [{ localSession: [], csrfToken: [] }],
      responses: { "200": jsonResponse("Export destination status without a pending sign-in.", statusReference) },
    },
  },
  "/system/export-destinations/{provider}/connect": {
    post: {
      tags: ["Context"], operationId: "connectExportDestination",
      description: "Starts a sign-in to the signed-in person's own account. Dropbox returns a page to open whose code is pasted back; Google Drive returns a short code to enter at Google's device page and finishes on its own once approved. Connecting also selects the drive for that person's exports.",
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
  "/system/export-destinations/{provider}/app": {
    put: {
      tags: ["Context"], operationId: "saveExportDestinationApp",
      description: "Saves the provider app an Owner/Admin registered for this installation: a Dropbox app key, or a Google \"TVs and Limited Input devices\" client ID and secret. It is shared by everyone who signs in on this installation. It replaces a built-in app, never one set by deployment environment variables, and is refused while anyone's account is connected through the current app. The client secret is never returned.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [providerParameter],
      requestBody: jsonRequestBody({
        oneOf: [
          {
            type: "object", additionalProperties: false, required: ["appKey"],
            properties: { appKey: { type: "string", pattern: "^[A-Za-z0-9]{8,64}$", description: "Dropbox only." } },
          },
          {
            type: "object", additionalProperties: false, required: ["clientId", "clientSecret"],
            properties: {
              clientId: { type: "string", pattern: "\\.apps\\.googleusercontent\\.com$", description: "Google Drive only." },
              clientSecret: { type: "string", minLength: 8, maxLength: 512, writeOnly: true },
            },
          },
        ],
      }),
      responses: {
        "200": jsonResponse("Export destination status with the provider available.", statusReference),
        "400": { description: "Missing or malformed app values" },
        "404": { description: "Unknown provider" },
        "409": { description: "Environment variables set this app, or someone's account is connected through it" },
      },
    },
    delete: {
      tags: ["Context"], operationId: "removeExportDestinationApp",
      description: "Forgets the app entered in Stugu. The provider falls back to the built-in app, or becomes unavailable. Refused while anyone's account is connected through it.",
      security: [{ localSession: [], csrfToken: [] }],
      parameters: [providerParameter],
      responses: {
        "200": jsonResponse("Export destination status without the entered app.", statusReference),
        "404": { description: "Unknown provider" },
        "409": { description: "Environment variables set this app, or someone's account is connected through it" },
      },
    },
  },
  "/system/export-destinations/{provider}": {
    delete: {
      tags: ["Context"], operationId: "disconnectExportDestination",
      description: "Forgets the signed-in person's cloud account and revokes its access when the provider allows. That person's exports switch back to the NAS if this drive was selected; files already uploaded are kept.",
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
    required: ["provider", "available", "appSource", "connected", "accountLabel", "connectedAt"],
    properties: {
      provider: { enum: ["dropbox", "google-drive"] },
      available: { type: "boolean", description: "False until this installation has the provider's app ID." },
      appSource: {
        enum: ["environment", "protected-file", "built-in", null],
        description: "Where the app ID comes from: deployment environment variables (not editable in Stugu), an app an Owner/Admin entered in Stugu, or the project's built-in app. Null while there is none.",
      },
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
