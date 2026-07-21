import { describe, expect, it } from "vitest";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
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
  it("documents every runtime operation exactly once with resolvable schemas", async () => {
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

      expect(runtimeOperations).toHaveLength(193);
      expect(documentOperations(v1, "v1")).toHaveLength(179);
      expect(documentOperations(v2, "v2")).toHaveLength(14);
      expect(documentedOperations).toEqual(runtimeOperations);
      auditDocument(v1);
      auditDocument(v2);
    } finally {
      await runtime.close();
    }
  });

  it("documents the server-owned observation resolution lifecycle", () => {
    const schemas = (openApiV1Document.components as unknown as {
      schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    }).schemas;
    expect(schemas.ObservationPatch?.properties).toMatchObject({
      status: { enum: ["open", "resolved"] },
      resolutionNote: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
      },
    });
    expect(schemas.ObservationPatch?.properties).not.toHaveProperty("resolvedAt");
    expect(schemas.ManualObservation?.required).toEqual(expect.arrayContaining([
      "status", "resolutionNote", "resolvedAt",
    ]));
    expect(schemas.ManualObservation?.properties).toMatchObject({
      status: { enum: ["open", "resolved"], readOnly: true },
      resolutionNote: {
        type: ["string", "null"],
        maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
        readOnly: true,
      },
      resolvedAt: { type: ["string", "null"], format: "date-time", readOnly: true },
    });
  });

  it("documents revisioned maintenance planning through verification", () => {
    const schemas = (openApiV1Document.components as unknown as {
      schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    }).schemas;
    expect(schemas.MaintenanceTaskInput?.required).toEqual(["title", "basis"]);
    expect(schemas.MaintenanceTaskInput?.properties).toMatchObject({
      propertyId: { type: "string", minLength: 1, maxLength: 200 },
      houseId: { type: ["string", "null"], maxLength: 200 },
    });
    expect(schemas.MaintenanceTaskPatch?.properties).toMatchObject({
      baseRevision: { type: "integer", minimum: 1 },
      houseId: { type: ["string", "null"], maxLength: 200 },
      status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
      completionNote: { type: ["string", "null"], maxLength: 5_000 },
      verificationNote: { type: ["string", "null"], maxLength: 5_000 },
    });
    expect(schemas.MaintenanceTaskPatch?.properties).not.toHaveProperty("completedAt");
    expect(schemas.MaintenanceTaskPatch?.properties).not.toHaveProperty("verifiedAt");
    expect(schemas.MaintenanceTask?.required).toEqual(expect.arrayContaining([
      "propertyId", "houseId", "basis", "priority", "plannedFor", "dueBy", "observationIds", "status",
      "completionNote", "completedAt", "verificationNote", "verifiedAt", "revision",
    ]));
  });

  it("documents non-blank ownership identifiers for property aggregates", () => {
    const schemas = (openApiV1Document.components as unknown as {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    }).schemas;
    expect(schemas.PropertyAreaInput?.properties).toMatchObject({
      propertyId: { type: "string", minLength: 1, maxLength: 200 },
    });
    expect(schemas.AreaEquipmentInput?.properties).toMatchObject({
      propertyId: { type: "string", minLength: 1, maxLength: 200 },
      areaId: { type: "string", minLength: 1, maxLength: 200 },
    });
    expect(schemas.AreaEquipmentPatch?.properties).toMatchObject({
      areaId: { type: "string", minLength: 1, maxLength: 200 },
    });
    expect(schemas.PropertyNoteInput?.properties).toMatchObject({
      propertyId: { type: "string", minLength: 1, maxLength: 200 },
    });
  });

  it("documents the nullable stable sensor-to-room relationship", () => {
    const schemas = (openApiV1Document.components as unknown as {
      schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    }).schemas;
    expect(schemas.Sensor?.required).toContain("roomId");
    expect(schemas.Sensor?.properties).toMatchObject({
      roomId: { type: ["string", "null"] },
      room: { type: "string" },
    });
    expect(schemas.SensorInput?.required).not.toContain("roomId");
    expect(schemas.SensorInput?.properties).toMatchObject({ roomId: { type: ["string", "null"] } });
    expect(schemas.SensorPatch?.properties).toMatchObject({ roomId: { type: ["string", "null"] } });
  });

  it("documents a Home-safe effective electricity-price projection", () => {
    const document = openApiV1Document as unknown as {
      paths: Record<string, { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } }>;
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: unknown }> };
    };
    expect(document.paths["/houses/{id}/electricity-price"]?.get?.responses?.["200"]
      ?.content?.["application/json"]?.schema).toMatchObject({
        additionalProperties: false,
        required: ["current"],
      });
    expect(document.components.schemas.HomeElectricityPricePoint).toMatchObject({
      additionalProperties: false,
      required: ["startAt", "endAt", "effectivePriceCentsPerKwh", "effectivePriceEurPerKwh", "fetchedAt"],
    });
    expect(document.components.schemas.HomeElectricityPricePoint?.properties).not.toHaveProperty("rawPriceCentsPerKwh");
    expect(document.components.schemas.HomeElectricityPricePoint?.properties).not.toHaveProperty("propertyId");
  });

  it("documents bounded spatial writes and the flattened persisted snapshot payload", () => {
    const document = openApiV1Document as unknown as {
      paths: Record<string, {
        post?: {
          requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
          responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
        };
      }>;
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: unknown }> };
    };
    const schemas = document.components.schemas;
    const requestSchema = (path: string): Record<string, unknown> | undefined => document.paths[path]?.post
      ?.requestBody?.content?.["application/json"]?.schema;
    const responseSchema = (path: string, status: string): Record<string, unknown> | undefined => document.paths[path]?.post
      ?.responses?.[status]?.content?.["application/json"]?.schema;

    expect(requestSchema("/houses/{id}/layers/bindings")).toEqual({ $ref: "#/components/schemas/SpatialSensorBindingInput" });
    expect(requestSchema("/houses/{id}/layers/calibrations")).toEqual({ $ref: "#/components/schemas/SpatialSensorCalibrationInput" });
    expect(requestSchema("/houses/{id}/layers/calibration-sessions")).toEqual({ $ref: "#/components/schemas/SpatialCalibrationSessionInput" });
    expect(requestSchema("/houses/{id}/layers/context-events")).toEqual({ $ref: "#/components/schemas/SpatialContextEventInput" });
    expect(responseSchema("/houses/{id}/layers/infer", "200")).toEqual({ $ref: "#/components/schemas/SpatialLayerInferenceResult" });

    expect(schemas.SpatialSensorBindingInput?.additionalProperties).toBe(false);
    expect(schemas.SpatialSensorCalibrationInput?.additionalProperties).toBe(false);
    expect(schemas.SpatialCalibrationSessionInput?.additionalProperties).toBe(false);
    expect(schemas.SpatialContextEventInput?.additionalProperties).toBe(false);

    expect(schemas.SpatialLayerSnapshot?.required).toEqual(expect.arrayContaining([
      "id", "partition", "scope", "coordinateFrames", "configVersion", "qualityScore", "reasonCodes",
      "zones", "connections", "points", "revision", "supersedesSnapshotId", "createdAt",
    ]));
    expect(schemas.SpatialLayerSnapshot?.properties).not.toHaveProperty("payload");
    expect(schemas.SpatialLayerSnapshot?.properties).toMatchObject({
      partition: { $ref: "#/components/schemas/SpatialPartition" },
      zones: { type: "array", items: { $ref: "#/components/schemas/SpatialZoneLayerValue" } },
      connections: { type: "array", items: { $ref: "#/components/schemas/SpatialConnectionLayerValue" } },
      points: { type: "array", items: { $ref: "#/components/schemas/SpatialPointLayerValue" } },
      revision: { type: "integer", minimum: 1 },
    });
  });
});
