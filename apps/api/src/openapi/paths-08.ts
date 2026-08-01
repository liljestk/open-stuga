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
} as const;
