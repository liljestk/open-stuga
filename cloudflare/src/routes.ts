export type HostedAuth = "public" | "tenant" | "tenant-admin" | "tenant-owner";

export interface HostedQueryParameter {
  name: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

export interface HostedRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: HostedAuth;
  apiTokenScope?: "read" | "write" | "ingest";
  summary: string;
  localMcp: "equivalent" | "local-only" | "hosted-only" | "not-exposed";
  primaryStatus: 200 | 201 | 204 | 409 | 501;
  responseKind: "json" | "empty" | "binary" | "sse";
  acceptsJsonBody: boolean;
  queryParameters: readonly HostedQueryParameter[];
}

type HostedRouteBase = Omit<HostedRoute, "primaryStatus" | "responseKind" | "acceptsJsonBody" | "queryParameters">;

function routeKey(method: HostedRouteBase["method"], path: string): string {
  return `${method} ${path}`;
}

const CREATED_OPERATIONS = new Set([
  "POST /api/v1/tenant/members", "POST /api/v1/tenant/tokens", "POST /api/v1/houses",
  "POST /api/v1/sensors", "POST /api/v1/readings", "POST /api/v2/measurement-definitions",
  "POST /api/v2/measurements", "POST /api/v2/measurements/import", "POST /api/v1/alert-rules",
  "POST /api/v1/observations", "POST /api/v1/static-parameters", "POST /api/v1/parameters",
  "POST /api/v1/assets",
]);

const EMPTY_OPERATIONS = new Set([
  "DELETE /api/v1/tenant/members/{email}", "DELETE /api/v1/tenant/tokens/{id}",
  "DELETE /api/v1/houses/{id}", "DELETE /api/v1/sensors/{id}",
  "DELETE /api/v1/alert-rules/{id}", "DELETE /api/v1/observations/{id}",
  "DELETE /api/v1/parameters/{id}", "DELETE /api/v1/assets/{id}",
]);

const EXPECTED_BOUNDARY_RESPONSES = new Map<string, 409 | 501>([
  ["GET /api/v1/houses/{id}/thermal-simulation", 501],
  ["PUT /api/v1/integrations/home-assistant/config", 409],
  ["PUT /api/v1/integrations/tp-link/config", 409],
]);

const JSON_BODY_OPERATIONS = new Set([
  "PATCH /api/v1/tenant", "POST /api/v1/tenant/members", "POST /api/v1/tenant/tokens",
  "POST /api/v1/houses", "PATCH /api/v1/houses/{id}", "PUT /api/v1/houses/{id}/layout",
  "PUT /api/v1/houses/{id}/floors/{floorId}", "POST /api/v1/sensors", "PATCH /api/v1/sensors/{id}",
  "PUT /api/v1/sensors/{id}", "POST /api/v1/readings", "POST /api/v2/measurement-definitions",
  "PATCH /api/v2/measurement-definitions/{id}", "POST /api/v2/measurements",
  "POST /api/v2/measurements/import", "POST /api/v1/alert-rules", "PATCH /api/v1/alert-rules/{id}",
  "POST /api/v1/observations", "POST /api/v1/static-parameters", "POST /api/v1/parameters",
  "POST /api/v1/assets",
]);

const optionalHouseId = [{ name: "houseId", schema: { type: "string", minLength: 1 } }] as const;
const historyParameters = [
  { name: "sensorId", required: true, schema: { type: "string", minLength: 1 } },
  { name: "from", schema: { type: "string", format: "date-time" } },
  { name: "to", schema: { type: "string", format: "date-time" } },
  { name: "limit", schema: { type: "integer", minimum: 1, maximum: 5_000, default: 500 } },
] as const;

const QUERY_PARAMETERS = new Map<string, readonly HostedQueryParameter[]>([
  ["GET /api/v1/locations/search", [
    { name: "q", required: true, schema: { type: "string", minLength: 2, maxLength: 120 } },
    { name: "language", schema: { type: "string", minLength: 2, maxLength: 8, default: "en" } },
  ]],
  ["GET /api/v1/locations/defaults", [
    { name: "latitude", required: true, schema: { type: "number", minimum: -90, maximum: 90 } },
    { name: "longitude", required: true, schema: { type: "number", minimum: -180, maximum: 180 } },
  ]],
  ["GET /api/v1/houses/{id}/weather", [
    { name: "hours", schema: { type: "integer", minimum: 1, maximum: 240, default: 48 } },
  ]],
  ["GET /api/v1/sensors", optionalHouseId],
  ["GET /api/v1/snapshot", optionalHouseId],
  ["GET /api/v1/sensors/snapshots", optionalHouseId],
  ["GET /api/v1/readings", historyParameters],
  ["GET /api/v1/history", historyParameters],
  ["GET /api/v1/forecast", [
    { name: "sensorId", required: true, schema: { type: "string", minLength: 1 } },
    { name: "horizonMinutes", schema: { type: "integer", minimum: 10, maximum: 4_320, default: 360 } },
  ]],
  ["GET /api/v2/measurement-definitions", [
    { name: "includeDisabled", schema: { type: "boolean", default: true } },
  ]],
  ["GET /api/v2/measurements/snapshot", optionalHouseId],
  ["GET /api/v2/measurements/history", [
    { name: "sensorId", required: true, schema: { type: "string", minLength: 1 } },
    { name: "metric", required: true, schema: { type: "string", minLength: 1 } },
    { name: "from", schema: { type: "string", format: "date-time" } },
    { name: "to", schema: { type: "string", format: "date-time" } },
    { name: "limit", schema: { type: "integer", minimum: 1, maximum: 5_000, default: 500 } },
  ]],
  ["GET /api/v2/measurements/forecast", [
    { name: "sensorId", required: true, schema: { type: "string", minLength: 1 } },
    { name: "metric", required: true, schema: { type: "string", minLength: 1 } },
    { name: "hours", schema: { type: "integer", minimum: 1, maximum: 72, default: 12 } },
  ]],
  ["GET /api/v1/alerts", [{ name: "limit", schema: { type: "integer", minimum: 1, maximum: 1_000, default: 200 } }]],
  ["GET /api/v1/alert-events", [{ name: "limit", schema: { type: "integer", minimum: 1, maximum: 1_000, default: 200 } }]],
  ["GET /api/v1/observations", optionalHouseId],
  ["GET /api/v1/static-parameters", optionalHouseId],
  ["GET /api/v1/parameters", optionalHouseId],
  ["GET /api/v1/assets", optionalHouseId],
]);

/**
 * Auditable hosted surface. The Worker router and generated OpenAPI document
 * intentionally use this inventory as their public contract.
 */
const HOSTED_ROUTE_BASES: readonly HostedRouteBase[] = [
  { method: "GET", path: "/api/openapi.json", auth: "public", summary: "Hosted OpenAPI document", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v1/openapi.json", auth: "public", summary: "Hosted v1 OpenAPI compatibility document", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v2/openapi.json", auth: "public", summary: "Hosted v2 OpenAPI compatibility document", localMcp: "not-exposed" },
  { method: "GET", path: "/api/hosted-routes.json", auth: "public", summary: "Hosted route and authorization manifest", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v1/health", auth: "public", summary: "Worker and binding health", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v1/session", auth: "tenant", apiTokenScope: "read", summary: "Resolved principal, tenant, and role", localMcp: "hosted-only" },
  { method: "GET", path: "/api/v1/tenant", auth: "tenant", apiTokenScope: "read", summary: "Current tenant", localMcp: "hosted-only" },
  { method: "PATCH", path: "/api/v1/tenant", auth: "tenant-admin", summary: "Rename current tenant", localMcp: "hosted-only" },
  { method: "GET", path: "/api/v1/tenant/members", auth: "tenant", apiTokenScope: "read", summary: "List tenant members and invitations", localMcp: "hosted-only" },
  { method: "POST", path: "/api/v1/tenant/members", auth: "tenant-admin", summary: "Invite a member by email", localMcp: "hosted-only" },
  { method: "DELETE", path: "/api/v1/tenant/members/{email}", auth: "tenant-owner", summary: "Remove a member or invitation", localMcp: "hosted-only" },
  { method: "GET", path: "/api/v1/tenant/tokens", auth: "tenant-admin", summary: "List scoped API token metadata", localMcp: "hosted-only" },
  { method: "POST", path: "/api/v1/tenant/tokens", auth: "tenant-admin", summary: "Create a write-only scoped API token", localMcp: "hosted-only" },
  { method: "DELETE", path: "/api/v1/tenant/tokens/{id}", auth: "tenant-admin", summary: "Revoke an API token", localMcp: "hosted-only" },
  { method: "GET", path: "/api/v1/locations/search", auth: "tenant", apiTokenScope: "read", summary: "Search locations", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/locations/defaults", auth: "tenant", apiTokenScope: "read", summary: "Resolve timezone for coordinates", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/houses", auth: "tenant", apiTokenScope: "read", summary: "List tenant houses", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/houses", auth: "tenant", apiTokenScope: "write", summary: "Create a tenant house", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/houses/{id}", auth: "tenant", apiTokenScope: "read", summary: "Get a tenant house", localMcp: "equivalent" },
  { method: "PATCH", path: "/api/v1/houses/{id}", auth: "tenant", apiTokenScope: "write", summary: "Update a tenant house", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v1/houses/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete a tenant house", localMcp: "equivalent" },
  { method: "PUT", path: "/api/v1/houses/{id}/layout", auth: "tenant", apiTokenScope: "write", summary: "Replace a house layout", localMcp: "equivalent" },
  { method: "PUT", path: "/api/v1/houses/{id}/floors/{floorId}", auth: "tenant", apiTokenScope: "write", summary: "Replace one floor", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/houses/{id}/weather", auth: "tenant", apiTokenScope: "read", summary: "Get Open-Meteo hosted weather", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/houses/{id}/thermal-simulation", auth: "tenant", apiTokenScope: "read", summary: "Report hosted thermal-model boundary", localMcp: "local-only" },
  { method: "GET", path: "/api/v1/sensors", auth: "tenant", apiTokenScope: "read", summary: "List tenant sensors", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/sensors", auth: "tenant", apiTokenScope: "write", summary: "Create a tenant sensor", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/sensors/{id}", auth: "tenant", apiTokenScope: "read", summary: "Get a tenant sensor and latest reading", localMcp: "equivalent" },
  { method: "PATCH", path: "/api/v1/sensors/{id}", auth: "tenant", apiTokenScope: "write", summary: "Update a tenant sensor", localMcp: "equivalent" },
  { method: "PUT", path: "/api/v1/sensors/{id}", auth: "tenant", apiTokenScope: "write", summary: "Replace a tenant sensor", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v1/sensors/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete a tenant sensor", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/snapshot", auth: "tenant", apiTokenScope: "read", summary: "Latest tenant sensor readings", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/sensors/snapshots", auth: "tenant", apiTokenScope: "read", summary: "Latest tenant sensor readings alias", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/readings", auth: "tenant", apiTokenScope: "ingest", summary: "Ingest compacted legacy readings", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/readings", auth: "tenant", apiTokenScope: "read", summary: "Read tenant sensor history", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/readings/latest", auth: "tenant", apiTokenScope: "read", summary: "Read latest tenant readings", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/history", auth: "tenant", apiTokenScope: "read", summary: "Read tenant sensor history alias", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/forecast", auth: "tenant", apiTokenScope: "read", summary: "Lightweight tenant forecast", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/events", auth: "tenant", apiTokenScope: "read", summary: "SSE heartbeat compatibility stream", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v1/stream", auth: "tenant", apiTokenScope: "read", summary: "SSE heartbeat compatibility alias", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v2/measurement-definitions", auth: "tenant", apiTokenScope: "read", summary: "List tenant measurement registry", localMcp: "equivalent" },
  { method: "POST", path: "/api/v2/measurement-definitions", auth: "tenant", apiTokenScope: "write", summary: "Create tenant measurement definition", localMcp: "equivalent" },
  { method: "PATCH", path: "/api/v2/measurement-definitions/{id}", auth: "tenant", apiTokenScope: "write", summary: "Update tenant measurement definition", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v2/measurement-definitions/{id}", auth: "tenant", apiTokenScope: "write", summary: "Disable tenant measurement definition", localMcp: "equivalent" },
  { method: "POST", path: "/api/v2/measurements", auth: "tenant", apiTokenScope: "ingest", summary: "Ingest compacted measurements", localMcp: "equivalent" },
  { method: "POST", path: "/api/v2/measurements/import", auth: "tenant", apiTokenScope: "ingest", summary: "Import compacted historical measurements", localMcp: "equivalent" },
  { method: "GET", path: "/api/v2/measurements/snapshot", auth: "tenant", apiTokenScope: "read", summary: "Latest tenant measurements", localMcp: "equivalent" },
  { method: "GET", path: "/api/v2/measurements/history", auth: "tenant", apiTokenScope: "read", summary: "Tenant measurement history", localMcp: "equivalent" },
  { method: "GET", path: "/api/v2/measurements/forecast", auth: "tenant", apiTokenScope: "read", summary: "Tenant measurement forecast", localMcp: "equivalent" },
  { method: "GET", path: "/api/v2/measurements/events", auth: "tenant", apiTokenScope: "read", summary: "Measurement SSE heartbeat compatibility", localMcp: "not-exposed" },
  { method: "GET", path: "/api/v1/alert-rules", auth: "tenant", apiTokenScope: "read", summary: "List tenant alert rules", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/alert-rules", auth: "tenant", apiTokenScope: "write", summary: "Create tenant alert rule", localMcp: "equivalent" },
  { method: "PATCH", path: "/api/v1/alert-rules/{id}", auth: "tenant", apiTokenScope: "write", summary: "Update tenant alert rule", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v1/alert-rules/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete tenant alert rule", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/alerts", auth: "tenant", apiTokenScope: "read", summary: "List tenant alert events", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/alert-events", auth: "tenant", apiTokenScope: "read", summary: "List tenant alert events alias", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/alerts/{id}/acknowledge", auth: "tenant", apiTokenScope: "write", summary: "Acknowledge tenant alert", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/alert-events/{id}/acknowledge", auth: "tenant", apiTokenScope: "write", summary: "Acknowledge tenant alert alias", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/observations", auth: "tenant", apiTokenScope: "read", summary: "List tenant observations", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/observations", auth: "tenant", apiTokenScope: "write", summary: "Create tenant observation", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v1/observations/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete tenant observation", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/static-parameters", auth: "tenant", apiTokenScope: "read", summary: "List tenant static parameters", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/static-parameters", auth: "tenant", apiTokenScope: "write", summary: "Upsert tenant static parameter", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/parameters", auth: "tenant", apiTokenScope: "read", summary: "List tenant static parameters alias", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/parameters", auth: "tenant", apiTokenScope: "write", summary: "Upsert tenant static parameter alias", localMcp: "equivalent" },
  { method: "DELETE", path: "/api/v1/parameters/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete tenant static parameter", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/assets", auth: "tenant", apiTokenScope: "read", summary: "List tenant R2 asset metadata", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/assets", auth: "tenant", apiTokenScope: "write", summary: "Upload a tenant asset to R2", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/assets/{id}", auth: "tenant", apiTokenScope: "read", summary: "Stream an authorized tenant R2 asset", localMcp: "not-exposed" },
  { method: "DELETE", path: "/api/v1/assets/{id}", auth: "tenant", apiTokenScope: "write", summary: "Delete a tenant R2 asset", localMcp: "equivalent" },
  { method: "GET", path: "/api/v1/integrations/status", auth: "tenant", apiTokenScope: "read", summary: "Tenant-scoped hosted integration boundary", localMcp: "local-only" },
  { method: "POST", path: "/api/v1/integrations/discover", auth: "tenant", apiTokenScope: "read", summary: "Explain LAN discovery boundary", localMcp: "local-only" },
  { method: "PUT", path: "/api/v1/integrations/home-assistant/config", auth: "tenant", apiTokenScope: "write", summary: "Reject cloud storage of Home Assistant credentials", localMcp: "not-exposed" },
  { method: "PUT", path: "/api/v1/integrations/tp-link/config", auth: "tenant", apiTokenScope: "write", summary: "Reject cloud storage of TP-Link credentials", localMcp: "not-exposed" },
  { method: "POST", path: "/api/v1/integrations/home-assistant/test", auth: "tenant", apiTokenScope: "read", summary: "Explain local Home Assistant test boundary", localMcp: "local-only" },
  { method: "POST", path: "/api/v1/integrations/tp-link/test", auth: "tenant", apiTokenScope: "read", summary: "Explain local TP-Link test boundary", localMcp: "local-only" },
  { method: "GET", path: "/api/v1/integrations/home-assistant/setup", auth: "tenant", apiTokenScope: "read", summary: "Describe hosted Home Assistant connector setup", localMcp: "local-only" },
  { method: "GET", path: "/api/v1/integrations/tp-link/setup", auth: "tenant", apiTokenScope: "read", summary: "Describe hosted TP-Link connector setup", localMcp: "local-only" },
  { method: "GET", path: "/api/v1/integrations/tp-link/devices", auth: "tenant", apiTokenScope: "read", summary: "Return no cloud-discoverable LAN devices", localMcp: "local-only" },
  { method: "GET", path: "/api/v1/mock/scenarios", auth: "tenant", apiTokenScope: "read", summary: "List UI demo scenarios", localMcp: "equivalent" },
  { method: "POST", path: "/api/v1/mock/scenario", auth: "tenant", apiTokenScope: "write", summary: "Acknowledge browser-local scenario", localMcp: "local-only" },
] as const;

const baseKeys = new Set(HOSTED_ROUTE_BASES.map((route) => routeKey(route.method, route.path)));
for (const contractKey of [
  ...CREATED_OPERATIONS, ...EMPTY_OPERATIONS, ...EXPECTED_BOUNDARY_RESPONSES.keys(),
  ...JSON_BODY_OPERATIONS, ...QUERY_PARAMETERS.keys(),
]) {
  if (!baseKeys.has(contractKey)) throw new Error(`Hosted route contract references an unknown operation: ${contractKey}`);
}

function primaryStatusFor(key: string, expectedBoundaryStatus: 409 | 501 | undefined): HostedRoute["primaryStatus"] {
  if (expectedBoundaryStatus !== undefined) return expectedBoundaryStatus;
  if (CREATED_OPERATIONS.has(key)) return 201;
  if (EMPTY_OPERATIONS.has(key)) return 204;
  return 200;
}

function responseKindFor(key: string): HostedRoute["responseKind"] {
  if (EMPTY_OPERATIONS.has(key)) return "empty";
  if (key === "GET /api/v1/assets/{id}") return "binary";
  if (["GET /api/v1/events", "GET /api/v1/stream", "GET /api/v2/measurements/events"].includes(key)) return "sse";
  return "json";
}

/**
 * Relationship values describe execution, not shared state: `equivalent` means
 * a logically matching local MCP tool exists; `local-only` means the Worker
 * returns a boundary/status response while execution remains on the home LAN;
 * `hosted-only` is tenant administration; and `not-exposed` covers protocol
 * documents, SSE/binary transfer, and raw credential writes intentionally kept
 * out of model arguments.
 */
export const HOSTED_ROUTES: readonly HostedRoute[] = HOSTED_ROUTE_BASES.map((route) => {
  const key = routeKey(route.method, route.path);
  const expectedBoundaryStatus = EXPECTED_BOUNDARY_RESPONSES.get(key);
  const primaryStatus = primaryStatusFor(key, expectedBoundaryStatus);
  const responseKind = responseKindFor(key);
  return {
    ...route,
    primaryStatus,
    responseKind,
    acceptsJsonBody: JSON_BODY_OPERATIONS.has(key),
    queryParameters: QUERY_PARAMETERS.get(key) ?? [],
  };
});

/**
 * Resolve an incoming request against the same route inventory that produces
 * the hosted OpenAPI document. Template parameters match exactly one non-empty
 * path segment; authorization never relies on values extracted here.
 */
export function matchHostedRoute(method: string, pathname: string): HostedRoute | null {
  const incoming = pathname.split("/");
  const candidates = HOSTED_ROUTES.filter((route) => route.method === method);
  const exact = candidates.find((route) => route.path === pathname);
  if (exact) return exact;
  return candidates.find((route) => {
    const template = route.path.split("/");
    return template.length === incoming.length && template.every((segment, index) => (
      /^\{[^/{}]+\}$/.test(segment) ? Boolean(incoming[index]) : segment === incoming[index]
    ));
  }) ?? null;
}

function routeSecurity(route: HostedRoute): Array<Record<string, unknown[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "tenant") return [{ cloudflareAccess: [] }, { bearerToken: [] }];
  return [{ cloudflareAccess: [] }];
}

const errorContent = {
  "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
} as const;

function primaryResponse(route: HostedRoute): Record<string, unknown> {
  const description = route.primaryStatus >= 400 ? "Expected hosted boundary response" : "Success";
  if (route.responseKind === "empty") return { description };
  if (route.responseKind === "binary") {
    return { description, content: { "*/*": { schema: { type: "string", format: "binary" } } } };
  }
  if (route.responseKind === "sse") return { description, content: { "text/event-stream": {} } };
  return {
    description,
    content: route.primaryStatus >= 400
      ? errorContent
      : { "application/json": { schema: { type: "object" } } },
  };
}

function errorResponse(description: string): Record<string, unknown> {
  return { description, content: errorContent };
}

export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of HOSTED_ROUTES) {
    const pathParameters = [...route.path.matchAll(/\{([^/{}]+)\}/g)].map((match) => ({
      name: match[1]!,
      in: "path",
      required: true,
      description: "Opaque tenant-scoped resource identifier.",
      schema: { type: "string", minLength: 1 },
    }));
    const queryParameters = route.queryParameters.map((parameter) => ({
      name: parameter.name,
      in: "query",
      required: parameter.required ?? false,
      schema: parameter.schema,
    }));
    const operation: Record<string, unknown> = {
      summary: route.summary,
      operationId: `${route.method.toLowerCase()}_${route.path.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_|_$/g, "")}`,
      security: routeSecurity(route),
      "x-open-stuga-auth": route.auth,
      "x-open-stuga-api-token-scope": route.apiTokenScope ?? null,
      "x-open-stuga-local-mcp": route.localMcp,
      "x-open-stuga-primary-status": route.primaryStatus,
      ...((pathParameters.length || queryParameters.length) ? { parameters: [...pathParameters, ...queryParameters] } : {}),
      ...(route.acceptsJsonBody ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: {} } },
        },
      } : {}),
      responses: {
        [String(route.primaryStatus)]: primaryResponse(route),
        "400": errorResponse("Invalid request"),
        ...(route.auth === "public" ? {} : {
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant authorization denied"),
        }),
        ...(pathParameters.length ? { "404": errorResponse("Tenant-scoped resource not found") } : {}),
      },
    };
    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Open Stuga Hosted API",
      version: "0.2.0",
      description: "Cloudflare-hosted, tenant-isolated compatibility API. Local stdio MCP operates on one local database and keeps LAN credentials, continuous pollers, replay, and bounded thermal compute outside the hosted tenant runtime.",
    },
    "x-open-stuga-surface-boundary": {
      hostedState: "Every authenticated hosted operation is scoped to the resolved tenant in D1/R2; tenant administration has no local MCP equivalent.",
      localStdioMcp: "The local stdio MCP operates directly on its configured local SQLite database and cannot inspect a separately running API process's in-memory connections or event bus.",
      localExecutionOnly: ["LAN discovery and connection tests", "thermal simulation", "mock tick generation", "historical replay"],
      intentionallyNotExposedToMcp: ["raw integration credential writes", "SSE streams", "binary asset downloads", "hosted tenant/member/token administration"],
    },
    paths,
    components: {
      securitySchemes: {
        cloudflareAccess: { type: "apiKey", in: "header", name: "Cf-Access-Jwt-Assertion", description: "Verified by the Worker against the configured Access issuer and audience." },
        bearerToken: { type: "http", scheme: "bearer", bearerFormat: "stuga_<secret>", description: "Tenant-scoped hashed API token. The plaintext is returned once." },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
  };
}
