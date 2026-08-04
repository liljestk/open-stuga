import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { STUGBY_MEDIA_TYPE } from "@climate-twin/stuguby-protocol";
import { spatialJsonResponse, spatialRequestBody } from "./part-01.js";

export const localAuthPaths = {
  "/auth/setup": {
    post: {
      tags: ["Context"], operationId: "setupLocalOwner",
      security: [],
      description: "Creates the first local Owner. Restricted to loopback/private trusted proxy requests unless a bootstrap secret is configured.",
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalAuthCredentials" }),
      responses: { "201": spatialJsonResponse("Authenticated Owner session.", { $ref: "#/components/schemas/AppSession" }), "403": { description: "Setup request is neither local nor bootstrap-secret authorized" }, "409": { description: "Workspace is already initialized" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/register": {
    post: {
      tags: ["Context"], operationId: "registerLocalInvitation",
      security: [],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalInvitationRegistrationInput" }),
      responses: { "201": spatialJsonResponse("Authenticated invited-member session.", { $ref: "#/components/schemas/AppSession" }), "404": { description: "Invitation is invalid or expired" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Context"], operationId: "loginLocalMember",
      security: [],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/LocalAuthCredentials" }),
      responses: { "200": spatialJsonResponse("Authenticated local session.", { $ref: "#/components/schemas/AppSession" }), "401": { description: "Invalid credentials" }, "429": { description: "Authentication attempt rate limited" } },
    },
  },
  "/auth/logout": {
    post: { tags: ["Context"], operationId: "logoutLocalMember", security: [{ localSession: [], csrfToken: [] }], responses: { "204": { description: "Session revoked and cookies cleared" } } },
  },
  "/tenant/members": {
    get: {
      tags: ["Context"], operationId: "listLocalWorkspaceMembers",
      security: [{ localSession: [] }],
      responses: { "200": spatialJsonResponse("Current members and outstanding invitations.", { $ref: "#/components/schemas/TenantMembersResponse" }) },
    },
    post: {
      tags: ["Context"], operationId: "inviteLocalWorkspaceMember",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({ $ref: "#/components/schemas/TenantMemberCreateInput" }),
      responses: { "201": spatialJsonResponse("One-time invitation token and activation path.", { $ref: "#/components/schemas/TenantInvitationCreated" }), "409": { description: "Member already exists" } },
    },
  },
  "/tenant/members/{email}/access": {
    parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
    put: {
      tags: ["Context"], operationId: "updateLocalWorkspaceMemberAccess",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({ type: "object", additionalProperties: false, required: ["grants"], properties: { grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } } }),
      responses: { "200": spatialJsonResponse("Updated guest access grants.", { type: "object", required: ["member"], properties: { member: { $ref: "#/components/schemas/TenantMemberSummary" } } }), "404": { description: "Member not found" } },
    },
  },
  "/tenant/members/{email}": {
    parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
    delete: { tags: ["Context"], operationId: "removeLocalWorkspaceMember", security: [{ localSession: [], csrfToken: [] }], responses: { "204": { description: "Member or invitation removed" }, "404": { description: "Member not found" } } },
  },
  "/security/audit-events": {
    get: {
      tags: ["Security"], operationId: "listSecurityAuditEvents",
      description: "Owner/Admin-only append-only evidence for authentication, membership, credential, and grant lifecycle changes. Secret material is never recorded.",
      security: [{ localSession: [] }],
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 } },
      ],
      responses: {
        "200": spatialJsonResponse("Newest security audit events first.", { $ref: "#/components/schemas/SecurityAuditEventsResponse" }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/health": {
    get: {
      tags: ["Context"], operationId: "getHostSystemHealth",
      description: "Owner/Admin-only host CPU, API event-loop responsiveness, memory, database metrics, data-volume storage and forecast, uptime, temperature, alert delivery, and sustained strain alerts.",
      security: [{ localSession: [] }],
      responses: {
        "200": spatialJsonResponse("Current Stugu host health.", {
          type: "object",
          additionalProperties: false,
          required: ["state", "sampledAt", "hostname", "platform", "architecture", "release", "hostUptimeSeconds", "serviceUptimeSeconds", "cpu", "memory", "storage", "database", "alertDelivery", "alerts"],
          properties: {
            state: { enum: ["healthy", "warning", "critical", "unknown"] },
            sampledAt: { type: "string", format: "date-time" },
            hostname: { type: "string" },
            platform: { type: "string" },
            architecture: { type: "string" },
            release: { type: "string" },
            hostUptimeSeconds: { type: "integer", minimum: 0 },
            serviceUptimeSeconds: { type: "integer", minimum: 0 },
            cpu: { type: "object", additionalProperties: true },
            memory: { type: "object", additionalProperties: true },
            storage: { type: "object", additionalProperties: true },
            database: { type: "object", additionalProperties: true },
            alertDelivery: { type: "object", additionalProperties: true },
            alerts: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/metrics": {
    get: {
      tags: ["Context"], operationId: "getHostSystemPrometheusMetrics",
      description: "Prometheus exposition of the same host-health signals and active alert gauges. Accepts an Owner/Admin session or the optional machine INGEST_API_KEY.",
      security: [{ localSession: [] }, { ingestKey: [] }],
      responses: {
        "200": {
          description: "Prometheus text exposition format.",
          content: { "text/plain": { schema: { type: "string" } } },
        },
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/error-logs": {
    get: {
      tags: ["Context"], operationId: "exportSystemErrorLogs",
      description: "Download the bounded, redacted system error ledger as newline-delimited JSON. Owner/Admin only.",
      security: [{ localSession: [] }],
      responses: {
        "200": {
          description: "Redacted error-log export.",
          content: { "application/x-ndjson": { schema: { type: "string", format: "binary" } } },
        },
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/updates": {
    get: {
      tags: ["Context"], operationId: "getSystemUpdateStatus",
      description: "Owner/Admin-only current/latest versions, GitHub release notes, schedule, agent capability, and operation state.",
      security: [{ localSession: [] }],
      responses: {
        "200": spatialJsonResponse("Current system update status.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/storage": {
    get: {
      tags: ["Context"], operationId: "getSystemStorageStatus",
      description: "Owner/Admin-only primary telemetry and recovery-set storage configuration, host-agent capability, and migration state.",
      security: [{ localSession: [] }],
      responses: {
        "200": spatialJsonResponse("Current storage configuration and operation status.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner or Admin role required" },
      },
    },
    put: {
      tags: ["Context"], operationId: "updateSystemStorage",
      description: "Queues a journaled host storage migration. TimescaleDB accepts managed or local block storage; NAS is recovery-set only.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({
        type: "object",
        additionalProperties: false,
        required: ["settings", "expectedRevision", "confirmation"],
        properties: {
          settings: { type: "object", additionalProperties: true },
          expectedRevision: { type: "string", pattern: "^[0-9a-f]{64}$" },
          confirmation: { enum: ["APPLY_STORAGE", "MOVE_STORAGE"] },
        },
      }),
      responses: {
        "202": spatialJsonResponse("Storage change queued for the trusted host agent.", { type: "object", additionalProperties: true }),
        "400": { description: "Invalid or unsafe storage settings" },
        "409": { description: "Stale settings or another maintenance operation is active" },
        "503": { description: "Compatible host storage agent unavailable" },
      },
    },
  },
  "/system/updates/events": {
    get: {
      tags: ["Context"], operationId: "streamSystemUpdateStatus",
      description: "Owner/Admin-only live system-update operation status. The browser reconnects while application containers restart.",
      security: [{ localSession: [] }],
      responses: {
        "200": {
          description: "Server-sent system-update status changes and keep-alive heartbeats.",
          content: { "text/event-stream": { schema: { type: "string" } } },
          "x-sse-event-schemas": {
            "system-update": { type: "object", additionalProperties: true },
            authorization: { $ref: "#/components/schemas/StreamAuthorizationEvent" },
          },
        },
        "403": { description: "Owner or Admin role required" },
        "429": { description: "Per-account or global event-stream limit reached" },
      },
    },
  },
  "/system/updates/check": {
    post: {
      tags: ["Context"], operationId: "checkSystemUpdates",
      description: "Refreshes release metadata from the configured public GitHub repository without installing.",
      security: [{ localSession: [], csrfToken: [] }],
      responses: {
        "200": spatialJsonResponse("Refreshed system update status.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/updates/settings": {
    patch: {
      tags: ["Context"], operationId: "updateSystemUpdateSettings",
      description: "Sets manual/automatic policy, release channel, check interval, and local maintenance windows.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { enum: ["manual", "automatic"] },
          includePrereleases: { type: "boolean" },
          checkIntervalHours: { enum: [6, 12, 24, 168] },
          updateTime: { type: "string", pattern: "^[0-2][0-9]:[0-5][0-9]$" },
          updateDays: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } },
          timezone: { type: "string", maxLength: 100 },
        },
      }),
      responses: {
        "200": spatialJsonResponse("Saved update settings and calculated next window.", { type: "object", additionalProperties: true }),
        "400": { description: "Invalid update settings" },
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/system/updates/install": {
    post: {
      tags: ["Context"], operationId: "installLatestSystemUpdate",
      description: "Queues the latest eligible release for the connected external update agent.",
      security: [{ localSession: [], csrfToken: [] }],
      responses: {
        "202": spatialJsonResponse("Update request queued.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner or Admin role required" },
        "409": { description: "No update is available or another update is active" },
        "503": { description: "External update agent is unavailable" },
      },
    },
  },
  "/system/updates/operations": {
    post: {
      tags: ["Context"], operationId: "requestSystemUpdateOperation",
      description: "Queues a revision-bound unified update, exact host restart/cancel action, or application retry. Owner/Admin only.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "expectedRevision"],
            properties: {
              action: { const: "update-everything" },
              expectedRevision: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "expectedRevision", "workflowId", "hostOperationId", "targetVersion", "targetGeneration", "targetDigest", "confirmation"],
            properties: {
              action: { const: "activate-host" },
              expectedRevision: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
              workflowId: { type: "string", format: "uuid" },
              hostOperationId: { type: "string", format: "uuid" },
              targetVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$" },
              targetGeneration: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
              targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              confirmation: { const: "RESTART_AND_INSTALL" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "expectedRevision", "workflowId", "hostOperationId", "targetVersion", "targetGeneration", "targetDigest"],
            properties: {
              action: { const: "cancel-host" },
              expectedRevision: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
              workflowId: { type: "string", format: "uuid" },
              hostOperationId: { type: "string", format: "uuid" },
              targetVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$" },
              targetGeneration: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
              targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "expectedRevision", "workflowId"],
            properties: {
              action: { const: "retry-application" },
              expectedRevision: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
              workflowId: { type: "string", format: "uuid" },
            },
          },
        ],
      }),
      responses: {
        "202": spatialJsonResponse("System update operation accepted.", { type: "object", additionalProperties: true }),
        "400": { description: "Malformed or unsupported operation request" },
        "403": { description: "Owner or Admin role required" },
        "409": { description: "Stale revision, identity mismatch, or unsafe current state" },
        "503": { description: "Compatible update agent or host bridge unavailable" },
      },
    },
  },
  "/cloudflare/setup": {
    get: {
      tags: ["Context"],
      operationId: "getCloudflareSetupStatus",
      description: "Owner/Admin status for UI-managed Cloudflare setup. Sensitive changes remain local-machine-only.",
      security: [{ localSession: [] }],
      responses: {
        "200": spatialJsonResponse("Cloudflare setup capability, configuration summary, and operation state.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner or Admin role required" },
      },
    },
  },
  "/cloudflare/setup/start": {
    post: {
      tags: ["Context"],
      operationId: "startCloudflareSetup",
      description: "From the local Stugu UI, registers or reuses a PKCE OAuth client and begins one-time Cloudflare approval.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: spatialRequestBody({
        type: "object",
        additionalProperties: false,
        required: ["mode", "hostname", "zone", "ownerEmail"],
        properties: {
          mode: { enum: ["remote-ui", "stuguby-coordinator"] },
          hostname: { type: "string", format: "hostname" },
          zone: { type: "string", format: "hostname" },
          ownerEmail: { type: "string", format: "email" },
          accountId: { type: ["string", "null"], pattern: "^[a-fA-F0-9]{32}$" },
          zoneId: { type: ["string", "null"], pattern: "^[a-fA-F0-9]{32}$" },
          oauthClientToken: { type: ["string", "null"], writeOnly: true },
          runtimeToken: { type: ["string", "null"], writeOnly: true },
        },
      }),
      responses: {
        "202": spatialJsonResponse("Cloudflare authorization URL and non-secret operation state.", { type: "object", additionalProperties: true }),
        "403": { description: "Owner/Admin role and local-machine access required" },
        "409": { description: "Another setup operation is active or the existing deployment conflicts" },
        "503": { description: "Trusted host agent unavailable" },
      },
    },
  },
  "/cloudflare/setup/oauth/callback": {
    get: {
      tags: ["Context"],
      operationId: "completeCloudflareSetupOAuth",
      description: "Exact loopback OAuth callback protected by cryptographic state and PKCE.",
      security: [],
      responses: {
        "200": { description: "Approval accepted and queued.", content: { "text/html": { schema: { type: "string" } } } },
        "400": { description: "Approval was refused, expired, or did not match an active setup" },
      },
    },
  },
  "/internal/cloudflare-setup/claims/{id}": {
    parameters: [{ $ref: "#/components/parameters/Id" }],
    get: {
      tags: ["Context"],
      operationId: "claimCloudflareSetupCredentials",
      description: "Internal one-time in-memory credential handoff to the trusted host agent. The bundled web proxy blocks this path.",
      security: [],
      responses: {
        "200": spatialJsonResponse("One-time setup claim.", {
          type: "object",
          additionalProperties: false,
          required: ["schema", "provisionToken", "accessToken", "oauthClientId"],
          properties: {
            schema: { const: "stugu-cloudflare-setup-claim/v1" },
            provisionToken: { type: "string", writeOnly: true },
            accessToken: { type: "string", writeOnly: true },
            oauthClientId: { type: "string" },
          },
        }),
        "404": { description: "Claim absent, expired, already consumed, or incorrectly authorized" },
      },
    },
  },
} as const;

export const localAuthSchemas = {
  LocalAuthCredentials: {
    type: "object", additionalProperties: false, required: ["email", "password"],
    properties: { email: { type: "string", format: "email", maxLength: 320 }, password: { type: "string", minLength: 12, maxLength: 1024, writeOnly: true } },
  },
  LocalInvitationRegistrationInput: {
    type: "object", additionalProperties: false, required: ["token", "password"],
    properties: { token: { type: "string", minLength: 32, writeOnly: true }, password: { type: "string", minLength: 12, maxLength: 1024, writeOnly: true }, email: { type: "string", format: "email", maxLength: 320 } },
  },
  GuestAccessGrant: {
    type: "object", additionalProperties: false, required: ["scopeType", "scopeId"],
    properties: { scopeType: { enum: ["property", "house", "area"] }, scopeId: { type: "string", minLength: 1, maxLength: 200 } },
  },
  TenantMemberSummary: {
    type: "object", additionalProperties: false, required: ["email", "role", "grants"],
    properties: { email: { type: "string", format: "email" }, role: { enum: ["owner", "admin", "member", "guest"] }, joinedAt: { type: "string", format: "date-time" }, invitedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" }, grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } },
  },
  TenantMembersResponse: {
    type: "object", additionalProperties: false, required: ["members", "invitations"],
    properties: { members: { type: "array", items: { $ref: "#/components/schemas/TenantMemberSummary" } }, invitations: { type: "array", items: { $ref: "#/components/schemas/TenantMemberSummary" } } },
  },
  TenantMemberCreateInput: {
    type: "object", additionalProperties: false, required: ["email", "role"],
    properties: { email: { type: "string", format: "email" }, role: { enum: ["admin", "member", "guest"] }, grants: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/GuestAccessGrant" } } },
  },
  TenantInvitationCreated: {
    type: "object", additionalProperties: false, required: ["invitation", "registrationToken", "activationPath", "expiresAt"],
    properties: { invitation: { $ref: "#/components/schemas/TenantMemberSummary" }, registrationToken: { type: "string", readOnly: true }, activationPath: { type: "string", description: "Client-side fragment path; the token is never placed in an HTTP query string." }, expiresAt: { type: "string", format: "date-time" } },
  },
  SecurityAuditEvent: {
    type: "object", additionalProperties: false,
    required: ["id", "eventType", "outcome", "actorUserId", "actorRole", "subjectType", "subjectId", "details", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      eventType: { enum: [
        "auth.owner.created", "auth.invitation.accepted", "auth.login", "auth.logout",
        "membership.invitation.created", "membership.grants.replaced", "membership.revoked",
        "integration.credentials.configured", "integration.credentials.rotated", "integration.credentials.revoked",
        "integration.grant.issued", "integration.grant.revoked",
      ] },
      outcome: { enum: ["succeeded", "denied"] },
      actorUserId: { type: ["string", "null"] },
      actorRole: { enum: ["owner", "admin", "member", "guest", "service", null] },
      subjectType: { enum: ["account", "workspace-member", "integration", "integration-grant"] },
      subjectId: { type: "string", minLength: 1, maxLength: 512 },
      details: {
        type: "object", maxProperties: 32,
        additionalProperties: { oneOf: [{ type: "string", maxLength: 512 }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  SecurityAuditEventsResponse: {
    type: "object", additionalProperties: false, required: ["events"],
    properties: { events: { type: "array", items: { $ref: "#/components/schemas/SecurityAuditEvent" } } },
  },
  StreamAuthorizationEvent: {
    type: "object", additionalProperties: false, required: ["status"],
    properties: { status: { enum: ["changed", "expired"] } },
    description: "Final non-sensitive SSE signal requiring clients to purge cached scoped data before reconnecting or signing in.",
  },
} as const;
