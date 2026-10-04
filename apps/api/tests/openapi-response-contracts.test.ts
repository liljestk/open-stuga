import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
  function boot() {
    return runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false });
  }

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
});
