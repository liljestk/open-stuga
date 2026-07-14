import { describe, expect, it } from "vitest";
import { HOSTED_ROUTES, matchHostedRoute, openApiDocument } from "../src/routes.js";

describe("hosted API route manifest", () => {
  it("has unique method/path pairs and explicit authorization", () => {
    const keys = HOSTED_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(HOSTED_ROUTES).toHaveLength(81);
    expect(new Set(keys).size).toBe(keys.length);
    expect(HOSTED_ROUTES.every((route) => Boolean(route.auth) && Boolean(route.localMcp))).toBe(true);
  });

  it("never grants an API-token scope to tenant administration", () => {
    expect(HOSTED_ROUTES.filter((route) => route.auth === "tenant-admin" || route.auth === "tenant-owner")
      .every((route) => route.apiTokenScope === undefined)).toBe(true);
  });

  it("generates an OpenAPI operation for every manifest entry", () => {
    const document = openApiDocument() as {
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
      "x-open-stuga-surface-boundary": Record<string, unknown>;
    };
    expect(document.info.version).toBe("0.2.0");
    expect(document["x-open-stuga-surface-boundary"]).toMatchObject({
      hostedState: expect.any(String),
      localStdioMcp: expect.any(String),
      intentionallyNotExposedToMcp: expect.arrayContaining(["raw integration credential writes", "binary asset downloads"]),
    });
    for (const route of HOSTED_ROUTES) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()] as {
        requestBody?: unknown;
        parameters?: Array<{ name?: string; in?: string }>;
        responses?: Record<string, { content?: Record<string, unknown> }>;
        "x-open-stuga-local-mcp"?: string;
        "x-open-stuga-primary-status"?: number;
      } | undefined;
      expect(operation).toBeDefined();
      expect(operation?.["x-open-stuga-local-mcp"]).toBe(route.localMcp);
      expect(operation?.["x-open-stuga-primary-status"]).toBe(route.primaryStatus);
      expect(Boolean(operation?.requestBody)).toBe(route.acceptsJsonBody);
      for (const query of route.queryParameters) {
        expect(operation?.parameters).toContainEqual(expect.objectContaining({ name: query.name, in: "query" }));
      }
      const primary = operation?.responses?.[String(route.primaryStatus)];
      expect(primary).toBeDefined();
      if (route.responseKind === "empty") expect(primary?.content).toBeUndefined();
      if (route.responseKind === "json") expect(primary?.content).toHaveProperty("application/json");
      if (route.responseKind === "binary") expect(primary?.content).toHaveProperty("*/*");
      if (route.responseKind === "sse") expect(primary?.content).toHaveProperty("text/event-stream");
      if (route.primaryStatus !== 200) expect(operation?.responses?.["200"]).toBeUndefined();
    }
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path)) as Array<{ operationId?: string }>;
    expect(operations).toHaveLength(HOSTED_ROUTES.length);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(operations.length);
    expect((document.paths["/api/v1/tenant/tokens"]?.post as { security?: unknown[] }).security)
      .toEqual([{ cloudflareAccess: [] }]);
    expect((document.paths["/api/v1/houses/{id}"]?.get as { parameters?: unknown[] }).parameters)
      .toEqual([expect.objectContaining({ name: "id", in: "path", required: true })]);
  });

  it("documents the intentional local MCP boundary per operation", () => {
    const relationship = (method: string, path: string) => HOSTED_ROUTES.find((route) => (
      route.method === method && route.path === path
    ))?.localMcp;
    expect(relationship("GET", "/api/v1/locations/search")).toBe("equivalent");
    expect(relationship("GET", "/api/v1/houses/{id}/thermal-simulation")).toBe("local-only");
    expect(relationship("GET", "/api/v1/assets/{id}")).toBe("not-exposed");
    expect(relationship("PUT", "/api/v1/integrations/home-assistant/config")).toBe("not-exposed");
    expect(relationship("GET", "/api/v1/tenant/members")).toBe("hosted-only");
  });

  it("matches static and parameterized routes without crossing segments or methods", () => {
    expect(matchHostedRoute("GET", "/api/v1/health")?.auth).toBe("public");
    expect(matchHostedRoute("GET", "/api/v1/sensors/snapshots")?.path).toBe("/api/v1/sensors/snapshots");
    expect(matchHostedRoute("GET", "/api/v1/houses/house%2Fopaque")?.path).toBe("/api/v1/houses/{id}");
    expect(matchHostedRoute("PUT", "/api/v1/houses/house-1/floors/floor-2")?.path)
      .toBe("/api/v1/houses/{id}/floors/{floorId}");
    expect(matchHostedRoute("POST", "/api/v1/houses/house-1")).toBeNull();
    expect(matchHostedRoute("GET", "/api/v1/houses/house-1/extra")).toBeNull();
    expect(matchHostedRoute("GET", "/api/v1/houses//weather")).toBeNull();
  });
});
