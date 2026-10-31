import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { SECURITY_AUDIT_EVENT_TYPES, SECURITY_AUDIT_SUBJECT_TYPES } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openApiV1Document, openApiV2Document } from "../src/openapi.js";

type Document = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
const documents = { v1: openApiV1Document as unknown as Document, v2: openApiV2Document as unknown as Document };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const reference = (schema: unknown, version: string) => JSON.parse(JSON.stringify(schema)
  .replaceAll("#/components/schemas/", `urn:stugu:${version}#/$defs/`));
for (const [version, doc] of Object.entries(documents)) ajv.addSchema({
  $id: `urn:stugu:${version}`, $defs: reference(doc.components.schemas, version),
});
function validate(schema: unknown, body: unknown, version = "v1") {
  const check = ajv.compile(reference(schema, version));
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
  return check;
}
function validateResponse(path: string, body: unknown, version: "v1" | "v2" = "v1") {
  return validate(documents[version].paths[path]!.get.responses["200"].content["application/json"].schema, body, version);
}

describe("served response contracts", () => {
  let runtime: ApiRuntime | undefined;
  afterEach(async () => { await runtime?.close(); });
  function boot(env: Record<string, string> = {}) {
    return runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false", ...env }),
      startBackground: false });
  }

  it("documents optional Access synchronization after owner setup and invitation creation", async () => {
    const api = boot({ LOCAL_AUTH_TEST_BYPASS: "false" });
    const owner = request.agent(api.app);
    const setup = await owner.post("/api/v1/auth/setup")
      .send({ email: "owner@example.test", password: "Synthetic-password-2026" }).expect(201);
    const setupSchema = documents.v1.paths["/auth/setup"]!.post.responses["201"].content["application/json"].schema;
    const check = validate(setupSchema, setup.body);
    expect(setup.body.cloudflareAccess).toEqual({ status: "disabled", lastSyncedAt: null });
    expect(check({ ...setup.body, cloudflareAccess: { status: "unrecognized", lastSyncedAt: null } })).toBe(false);
    const invitation = await owner.post("/api/v1/tenant/members").set("x-csrf-token", setup.body.csrfToken)
      .send({ email: "member@example.test", role: "member" }).expect(201);
    validate(documents.v1.paths["/tenant/members"]!.post.responses["201"].content["application/json"].schema, invitation.body);
  });

  it("keeps the MCP start response closed while allowing its one-time token", () => {
    const schema = documents.v1.paths["/system/mcp-runtime/start"]!.post.responses["200"].content["application/json"].schema;
    const body = { state: "running", endpointPath: "/api/v1/mcp", pid: 123,
      startedAt: "2026-10-04T12:00:00Z", toolCount: 40, serverVersion: "0.41.15", errorCode: null, accessTokenIssued: true,
      accessToken: "synthetic-one-time-token" };
    const check = validate(schema, body);
    expect(check({ ...body, accessToken: null })).toBe(true);
    expect(check({ ...body, unintended: true })).toBe(false);
  });

  it("returns the public backup projection and retains the worker's persisted version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-backup-contract-"));
    try {
      const api = boot({ BACKUP_OPERATIONS_DIRECTORY: directory });
      const response = await request(api.app).post("/api/v1/backups").expect(202);
      validate(documents.v1.paths["/backups"]!.post.responses["202"].content["application/json"].schema, response.body);
      expect(response.body.backup).not.toHaveProperty("version");
      expect(JSON.parse(readFileSync(join(directory, "status.json"), "utf8")).version).toBe(1);
      const status = await request(api.app).get("/api/v1/backups/status").expect(200);
      expect(status.body).toEqual(response.body);
    } finally {
      await runtime?.close(); runtime = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("documents all appended security event and subject kinds", async () => {
    const api = boot();
    for (const [index, eventType] of SECURITY_AUDIT_EVENT_TYPES.entries()) api.database.recordSecurityAuditEvent({
      eventType, actorUserId: null, actorRole: "owner",
      subjectType: SECURITY_AUDIT_SUBJECT_TYPES[index % SECURITY_AUDIT_SUBJECT_TYPES.length]!, subjectId: "synthetic-subject",
    });
    const result = await request(api.app).get("/api/v1/security/audit-events").expect(200);
    validateResponse("/security/audit-events", result.body);
  });

  it("accepts dimensionless built-in units from the registry", async () => {
    const api = boot();
    const result = await request(api.app).get("/api/v2/measurement-definitions").expect(200);
    expect(result.body.definitions.some((definition: { unit: string }) => definition.unit === "")).toBe(true);
    validateResponse("/measurement-definitions", result.body, "v2");
  });

  it("documents a Property sharing projection in list and detail responses while remaining closed", async () => {
    const api = boot();
    const properties = (await request(api.app).get("/api/v1/properties").expect(200)).body.properties;
    const property = { ...properties[0], stuguby: {
      stugubyId: "synthetic-group", authorityNodeId: "synthetic-node", isAuthority: true,
      editPolicy: "collaborative", syncState: "current", authorityEpoch: 1,
      lastSyncedRevision: 2, pendingChangeCount: 0, conflictCount: 0,
    } };
    validateResponse("/properties", { properties: [property] });
    const check = validateResponse("/properties/{id}", { property });
    expect(check({ property: { ...property, unintended: true } })).toBe(false);
  });

  it("accepts the monitoring envelopes and their optional archive evidence without opening the response", async () => {
    const api = boot();
    const houses = api.database.listHouses();
    for (const [route, path] of [
      ["/api/v2/monitoring/houses?dataMode=demo", "/monitoring/houses"],
      [`/api/v2/monitoring/houses/${houses[0]!.id}?dataMode=demo`, "/monitoring/houses/{houseId}"],
    ]) {
      const result = await request(api.app).get(route!).expect(200);
      const check = validateResponse(path!, result.body, "v2");
      expect(check({ ...result.body, unintended: true })).toBe(false);
    }
    validate({ $ref: "#/components/schemas/DerivedAnalyticsProvenance" }, {
      algorithmKey: "home-performance", algorithmVersion: "synthetic-v1", evaluatedAt: "2026-10-04T12:00:00Z",
      sourceIds: [], archiveState: "merged", truthClass: "derived", archiveStates: ["merged", "not-ready"],
    }, "v2");
  });

  it("serves every documented GET body that the seeded workspace can answer in its documented shape", async () => {
    const api = boot({ MOCK_ENABLED: "true" });
    const sensorId = api.database.listSensors()[0]!.id;
    // Path parameters filled from the seeded workspace, by the collection segment before them.
    const seeded: Record<string, string> = {
      "houses": "house-main", "publications": "house-main", "properties": "property-main", "sensors": sensorId,
    };
    // Event streams never end, and these return files rather than JSON.
    const skipped = new Set(["/events", "/stream", "/measurements/events", "/system/updates/events",
      "/properties/{propertyId}/tracking-stream", "/openapi.json"]);
    const served: string[] = [];
    for (const [version, doc] of Object.entries(documents) as Array<["v1" | "v2", Document]>) {
      for (const [path, operations] of Object.entries(doc.paths)) {
        const success = operations.get?.responses?.["200"]?.content?.["application/json"]?.schema;
        if (!success || skipped.has(path)) continue;
        const parts = path.split("/");
        const filled = parts.map((part, index) => (part.startsWith("{") ? seeded[parts[index - 1]!] : part));
        if (filled.some((part) => part === undefined)) continue;
        const response = await request(api.app).get(`/api/${version}${filled.join("/")}`);
        if (response.status !== 200 || !response.type.includes("json")) continue;
        const check = ajv.compile(reference(success, version));
        expect(check(response.body), `${version} GET ${path}: ${JSON.stringify(check.errors)}`).toBe(true);
        served.push(`${version} ${path}`);
      }
    }
    // A floor, so a refactor that stops most routes answering cannot pass quietly.
    expect(served.length).toBeGreaterThanOrEqual(70);
  });
});
