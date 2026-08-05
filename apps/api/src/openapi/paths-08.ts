export const pathsPart08 = {
  "/bug-reports": {
    post: {
      tags: ["Security"],
      operationId: "submitBugReport",
      summary: "Submit a privacy-reviewed bug report",
      description: "Forwards a bounded report to the deployment-owned relay. The response intentionally contains no private repository or issue URL.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["description"],
              properties: {
                description: { type: "string", minLength: 3, maxLength: 4_000 },
                contactEmail: { type: "string", format: "email", maxLength: 254 },
                diagnostics: {
                  type: "object",
                  additionalProperties: false,
                  required: ["appVersion", "page", "route", "occurredAt", "locale", "userAgent", "recentErrors"],
                  properties: {
                    appVersion: { type: "string", maxLength: 100 },
                    page: { type: "string", maxLength: 200 },
                    route: { type: "string", maxLength: 500 },
                    occurredAt: { type: "string", format: "date-time" },
                    locale: { type: "string", maxLength: 35 },
                    userAgent: { type: "string", maxLength: 500 },
                    recentErrors: { type: "array", maxItems: 5, items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Report accepted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["reportId", "submittedAt"],
                properties: {
                  reportId: { type: "string", format: "uuid" },
                  submittedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid or oversized report" },
        "401": { description: "Sign-in required" },
        "403": { description: "CSRF failure or invalid contact consent" },
        "429": { description: "Submission rate limit reached" },
        "502": { description: "Relay delivery failed" },
        "503": { description: "Bug reporting is not configured" },
      },
    },
  },
  "/bug-reports/relay": {
    get: {
      tags: ["Security"],
      operationId: "getBugReportRelay",
      summary: "Read the configured bug-report relay destination",
      description: "Owner and Admin accounts see the relay URL and where it came from. The shared relay token is never returned.",
      security: [{ localSession: [] }],
      responses: {
        "200": {
          description: "Relay configuration",
          content: { "application/json": { schema: { $ref: "#/components/schemas/BugReportRelaySettings" } } },
        },
        "401": { description: "Sign-in required" },
        "403": { description: "Workspace administration required" },
      },
    },
    put: {
      tags: ["Security"],
      operationId: "configureBugReportRelay",
      summary: "Configure the bug-report relay destination",
      description: "Stores the HTTPS relay URL and shared token in the protected integration secrets file and enables reporting without a restart.",
      security: [{ localSession: [], csrfToken: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["url", "token"],
              properties: {
                url: { type: "string", format: "uri", maxLength: 500 },
                token: { type: "string", minLength: 32, maxLength: 512 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Relay configured",
          content: { "application/json": { schema: { $ref: "#/components/schemas/BugReportRelaySettings" } } },
        },
        "400": { description: "Invalid relay URL or token" },
        "401": { description: "Sign-in required" },
        "403": { description: "Workspace administration or CSRF failure" },
        "409": { description: "Deployment environment variables own the relay" },
      },
    },
    delete: {
      tags: ["Security"],
      operationId: "clearBugReportRelay",
      summary: "Remove the stored bug-report relay destination",
      security: [{ localSession: [], csrfToken: [] }],
      responses: {
        "200": {
          description: "Relay removed",
          content: { "application/json": { schema: { $ref: "#/components/schemas/BugReportRelaySettings" } } },
        },
        "401": { description: "Sign-in required" },
        "403": { description: "Workspace administration or CSRF failure" },
        "409": { description: "Deployment environment variables own the relay" },
      },
    },
  },
} as const;
