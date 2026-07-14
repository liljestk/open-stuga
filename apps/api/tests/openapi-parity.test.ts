import { describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openApiV1Document, openApiV2Document } from "../src/openapi.js";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = typeof METHODS[number];

interface OpenApiOperation {
  operationId?: string;
  parameters?: unknown[];
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

interface OpenApiPathItem extends Partial<Record<Method, OpenApiOperation>> {
  parameters?: unknown[];
}

interface OpenApiDocument {
  paths: Record<string, OpenApiPathItem>;
  components?: Record<string, unknown>;
}

function documentOperations(document: OpenApiDocument, version: "v1" | "v2"): string[] {
  return Object.entries(document.paths).flatMap(([path, item]) => METHODS.flatMap((method) => (
    item[method] ? [`${method.toUpperCase()} /api/${version}${path}`] : []
  )));
}

function resolveReference(document: OpenApiDocument, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce<unknown>((value, encodedSegment) => {
    if (!value || typeof value !== "object") return undefined;
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    return (value as Record<string, unknown>)[segment];
  }, document);
}

function referencedParameter(document: OpenApiDocument, value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const parameter = value as Record<string, unknown>;
  if (typeof parameter.$ref !== "string") return parameter;
  const resolved = resolveReference(document, parameter.$ref);
  return resolved && typeof resolved === "object" ? resolved as Record<string, unknown> : null;
}

function auditDocument(document: OpenApiDocument): void {
  const operationIds: string[] = [];
  const unresolvedReferences: string[] = [];

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && resolveReference(document, object.$ref) === undefined) {
      unresolvedReferences.push(object.$ref);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(document);
  expect(unresolvedReferences).toEqual([]);

  for (const [path, item] of Object.entries(document.paths)) {
    const placeholders = [...path.matchAll(/\{([^/{}]+)\}/g)].map((match) => match[1]);
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      expect(operation.operationId, `${method.toUpperCase()} ${path} needs an operationId`).toBeTruthy();
      operationIds.push(operation.operationId!);

      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => referencedParameter(document, parameter))
        .filter((parameter): parameter is Record<string, unknown> => parameter !== null);
      for (const name of placeholders) {
        expect(parameters, `${method.toUpperCase()} ${path} must declare {${name}}`).toContainEqual(
          expect.objectContaining({ name, in: "path", required: true }),
        );
      }

      const successful = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
      expect(successful.length, `${method.toUpperCase()} ${path} needs a success response`).toBeGreaterThan(0);
      for (const [status, response] of successful) {
        if (status === "204") expect(response.content).toBeUndefined();
        else expect(Object.keys(response.content ?? {}).length, `${method.toUpperCase()} ${path} ${status} needs content`).toBeGreaterThan(0);
      }
    }
  }
  expect(new Set(operationIds).size).toBe(operationIds.length);
}

describe("local Express/OpenAPI parity", () => {
  it("documents every runtime operation exactly once with resolvable schemas", () => {
    const runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
    try {
      const router = (runtime.app as unknown as {
        router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      }).router;
      const runtimeOperations = router.stack.flatMap((layer) => {
        if (!layer.route) return [];
        const path = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        return METHODS.flatMap((method) => layer.route?.methods[method] ? [`${method.toUpperCase()} ${path}`] : []);
      }).sort();

      const v1 = openApiV1Document as unknown as OpenApiDocument;
      const v2 = openApiV2Document as unknown as OpenApiDocument;
      const documentedOperations = [
        ...documentOperations(v1, "v1"),
        ...documentOperations(v2, "v2"),
      ].sort();

      expect(runtimeOperations).toHaveLength(75);
      expect(documentOperations(v1, "v1")).toHaveLength(64);
      expect(documentOperations(v2, "v2")).toHaveLength(11);
      expect(documentedOperations).toEqual(runtimeOperations);
      auditDocument(v1);
      auditDocument(v2);
    } finally {
      runtime.close();
    }
  });
});
