export const testProfiles = [
  {
    id: "browser-auth", appliesTo: "Local browser-session routes; apply public/setup exceptions from middleware",
    factors: {
      account: ["anonymous", "owner", "admin", "member", "guest with grant", "guest without grant", "disabled/removed account"],
      session: ["valid", "absent", "malformed", "expired", "revoked", "cookie from another installation"],
      setup: ["first Owner absent", "initialized"],
    },
    oracle: "Public routes remain available as implemented; protected routes deny unauthorized requests; ungranted resource identifiers are concealed. Read the role guards; OpenAPI security alone does not describe role access.",
  },
  {
    id: "browser-write", appliesTo: "Unsafe browser-session methods, with documented middleware exceptions",
    factors: {
      csrf: ["valid", "absent", "incorrect", "token from another session"],
      origin: ["allowed", "absent", "untrusted", "spoofed forwarded origin"],
      contentType: ["documented type", "missing", "text/plain", "unsupported type"],
    },
    oracle: "Check CSRF and origin rejection before mutation. POST /api/v2/analytics/query and /analytics/coverage are read operations exempted by middleware; do not assume all POSTs share a policy.",
  },
  {
    id: "machine-auth", appliesTo: "Routes with machine credentials or Stuguby signatures",
    factors: {
      credential: ["valid for this route", "absent", "malformed", "incorrect", "revoked", "valid token for another service", "valid token for another Home/observer"],
      credentialSource: ["documented header", "supported alternative header", "unsupported query parameter"],
    },
    oracle: "Exercise each OR alternative separately and each AND requirement together. Machine credentials do not grant general browser access. Only test alternative headers actually implemented.",
  },
  {
    id: "resource-scope", appliesTo: "Scoped operations; identifiers in path, query, body, arrays and nested references",
    factors: {
      resource: ["existing and visible", "nonexistent", "hidden Home", "deleted", "different Property", "ungranted Home", "wrong parent-child relationship"],
      property: ["no Homes", "one Home", "multiple Homes", "remote shared projection"],
    },
    oracle: "Prevent cross-scope reads and writes. Hiding a Home removes Home-owned data from active access; Property-owned notes, equipment and maintenance survive. Detaching a remote projection uses its separate purge semantics.",
  },
  {
    id: "pagination-and-time", appliesTo: "Collection/history routes with relevant parameters",
    factors: {
      page: ["default", "first", "middle", "last", "beyond end", "empty collection", "cursor reused", "cursor mismatched to query"],
      range: ["omitted", "from only", "to only", "from before to", "equal bounds", "reversed bounds", "no data", "DST transition", "UTC versus equivalent offset"],
      filter: ["one match", "multiple matches", "no matches", "duplicate IDs", "unknown ID", "mixed visible and hidden IDs"],
    },
    oracle: "Verify ordering, limits, end semantics, stable pagination and scope filtering against each route. Include repeated/comma-separated query values where the parameter supports them.",
  },
  {
    id: "revision-and-repeat", appliesTo: "Mutations, especially baseRevision/expectedRevision/operationId routes",
    factors: {
      order: ["normal lifecycle", "reversed prerequisite", "repeat same request", "same identifier with changed payload", "concurrent requests"],
      revision: ["current", "stale", "future", "missing"],
    },
    oracle: "Check documented idempotency, conflict status, atomicity and server-owned fields. Repeat does not imply success or idempotency; assert the actual endpoint contract.",
  },
  {
    id: "telemetry-and-mode", appliesTo: "Telemetry, weather, monitoring, analytics, forecasts and tracking",
    factors: {
      mode: ["live", "demo", "replay where supported"],
      evidence: ["empty", "fresh", "stale", "partial", "gapped", "estimated", "out of order", "duplicate", "mixed sources"],
    },
    oracle: "Maintain mode/source isolation and explicit uncertainty. Never turn absent/stale/partial evidence into a healthy state. Use only modes accepted by the route; query dataMode supports its documented enum.",
  },
  {
    id: "dependency-state", appliesTo: "External integrations, workers, archive storage, host agents and inference engines",
    factors: {
      dependency: ["disabled", "not configured", "healthy", "authentication failure", "timeout", "unreachable", "malformed response", "partial response", "recovering"],
      cache: ["cold", "fresh", "stale", "invalidated after mutation"],
    },
    oracle: "Assert documented degraded responses, bounded retries, provenance and recovery. Use fake transports and temporary databases/secrets files.",
  },
  {
    id: "event-stream", appliesTo: "Routes whose successful content type is text/event-stream",
    factors: {
      connection: ["initial", "reconnect", "heartbeat only", "disconnect", "shutdown", "slow consumer", "stream limit exceeded"],
      access: ["authorized", "grant revoked while connected", "account disabled while connected"],
    },
    oracle: "Check documented event names, ordering, scope, backpressure and cleanup. Open the stream before the triggering operation and close it during teardown; a stream cannot be treated as a terminating first HTTP call.",
  },
  {
    id: "transport", appliesTo: "Every applicable route",
    factors: {
      method: ["documented", "unsupported method", "HEAD for GET", "OPTIONS with allowed origin", "OPTIONS with rejected origin"],
      payload: ["well formed", "malformed JSON", "parser limit boundary", "over parser limit", "duplicate query keys", "unknown query field"],
    },
    oracle: "Check actual middleware behavior. General unsupported API methods can return 404; MCP and the relay explicitly return 405. Express HEAD and middleware OPTIONS are transport checks, not additional documented operations.",
  },
  {
    id: "privacy-and-side-effects", appliesTo: "Every response and mutation",
    factors: { result: ["success", "validation failure", "authorization failure", "dependency failure"] },
    oracle: "Validate response schemas/media types and error shape; no secret/private repository URL leaks; no partial unauthorized mutation. Check invalidation and mutation events where applicable. Keep real household data out of artifacts.",
  },
];
