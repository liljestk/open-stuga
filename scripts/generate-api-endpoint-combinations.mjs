// Run from the repository root with: node --import tsx scripts/generate-api-endpoint-combinations.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openApiV1Document, openApiV2Document } from "../apps/api/src/openapi.ts";
import { choicesFor, collectSchemaCases, combinationCount, combinations, resolveReference, topLevelBodyFactors } from "./api-test-matrix/input-cases.mjs";
import { testProfiles } from "./api-test-matrix/profiles.mjs";

const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const root = new URL("../", import.meta.url);
const output = new URL("docs/testing/", root);
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) throw new Error("Only --check is supported");
const packageInfo = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflows = JSON.parse(await readFile(new URL("api-workflows.json", output), "utf8"));
const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function assertReferences(document, value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref) resolveReference(document, value);
  Object.values(value).forEach((child) => assertReferences(document, child));
}

function listOperations(document, version) {
  assertReferences(document, document);
  return Object.entries(document.paths).flatMap(([path, item]) => methods.flatMap((method) => {
    const operation = item[method];
    if (!operation) return [];
    if (!operation.operationId) throw new Error(`Missing operationId: ${version} ${method} ${path}`);
    const parameters = new Map();
    for (const raw of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
      const parameter = resolveReference(document, raw);
      parameters.set(`${parameter.in}:${parameter.name}`, parameter);
    }
    const requestBody = resolveReference(document, operation.requestBody);
    const bodies = Object.entries(requestBody?.content ?? {}).map(([mediaType, content]) => {
      const factors = topLevelBodyFactors(document, content.schema);
      const schema = resolveReference(document, content.schema) ?? {};
      return {
        mediaType, schema: content.schema,
        required: requestBody.required === true,
        topLevelFactors: factors,
        topLevelCandidateCount: factors.length ? combinationCount(factors) : null,
        constraints: {
          required: schema.required ?? [],
          minProperties: schema.minProperties,
          maxProperties: schema.maxProperties,
          additionalProperties: schema.additionalProperties,
          oneOf: schema.oneOf, anyOf: schema.anyOf, allOf: schema.allOf,
          description: schema.description,
        },
        expansion: "Cartesian product of the factors, with representative complex values. Validate against the full schema and runtime rules. Branch-only fields are enumerated in input-cases; topLevelCandidateCount is not a count of accepted requests.",
      };
    });
    const security = operation.security ?? document.security ?? [];
    const queryFactors = [...parameters.values()].filter((parameter) => parameter.in === "query").map((parameter) => ({
      field: parameter.name, required: parameter.required === true,
      choices: choicesFor(document, parameter.schema, parameter.required === true),
    }));
    return [{
      key: `${version}:${operation.operationId}`,
      service: "local", version, operationId: operation.operationId,
      method: method.toUpperCase(), path: `${document.servers[0].url}${path}`,
      tags: operation.tags ?? ["General"], summary: operation.summary ?? operation.operationId,
      description: operation.description,
      securityAlternatives: security,
      parameters: [...parameters.values()], requestBodies: bodies,
      queryFactors, queryCombinationCount: combinationCount(queryFactors),
      responses: operation.responses,
      successCodes: Object.keys(operation.responses ?? {}).filter((code) => /^2\d\d$/.test(code)),
      documentedErrorCodes: Object.keys(operation.responses ?? {}).filter((code) => /^[45]\d\d$/.test(code)),
    }];
  }));
}

const documents = { v1: openApiV1Document, v2: openApiV2Document };
const operations = Object.entries(documents).flatMap(([version, document]) => listOperations(document, version));
if (sha256(openApiV1Document.components) !== sha256(openApiV2Document.components)) {
  throw new Error("Versioned components differ; preserve them separately before generating this matrix");
}

// The optional Worker is outside the local OpenAPI documents. Its contract is
// mapped explicitly from its source and the shared validator, with source hashes.
const bugReportSchema = openApiV1Document.paths["/bug-reports"].post.requestBody.content["application/json"].schema;
const relayDiagnosticSchema = {
  ...bugReportSchema.properties.diagnostics,
  properties: Object.fromEntries(Object.entries(bugReportSchema.properties.diagnostics.properties).map(([name, schema]) => [name, name === "recentErrors" ? {
    type: "array", maxItems: 5,
    items: {
      type: "object", additionalProperties: false, required: ["source", "occurredAt", "message"],
      properties: {
        source: { enum: ["browser", "promise", "api"] },
        occurredAt: { type: "string", minLength: 1, maxLength: 100, format: "date-time" },
        message: { type: "string", minLength: 1, maxLength: 500 },
        status: { type: "integer", minimum: 100, maximum: 599 },
        code: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
  } : { ...schema, minLength: 1, ...(name === "occurredAt" ? { maxLength: 100 } : {}) }])),
};
const relaySchema = {
  ...bugReportSchema,
  required: [...bugReportSchema.required, "reportId", "submittedAt", "serverVersion"],
  properties: {
    ...bugReportSchema.properties,
    contactEmail: { ...bugReportSchema.properties.contactEmail, minLength: 1, pattern: "^[^\\s@<>]+@[^\\s@<>]+$" },
    diagnostics: relayDiagnosticSchema,
    reportId: { type: "string", format: "uuid" },
    submittedAt: { type: "string", format: "date-time", description: "Within ten minutes of the relay clock, including future skew." },
    serverVersion: { type: "string", minLength: 1, maxLength: 100 },
  },
};
const relayFactors = topLevelBodyFactors(openApiV1Document, relaySchema);
operations.push({
  key: "relay:submitReport", service: "bug-report-relay", version: "relay", operationId: "submitReport",
  method: "POST", path: "/reports", tags: ["Bug report relay"], summary: "Accept an authenticated report and forward it to GitHub",
  contractOrigin: "Hand-mapped supplement from apps/bug-report-relay/src/index.ts and packages/contracts/src/bug-reports.ts; not an OpenAPI operation",
  securityAlternatives: [{ relayBearer: [] }], parameters: [],
  requestBodies: [{ mediaType: "application/json", schema: relaySchema, required: true, topLevelFactors: relayFactors, topLevelCandidateCount: combinationCount(relayFactors) }],
  queryFactors: [], queryCombinationCount: "1",
  successCodes: ["201"], documentedErrorCodes: ["400", "401", "404", "405", "413", "415", "429", "500", "502"],
  responses: {
    "201": { description: "Accepted", content: { "application/json": { schema: { type: "object", required: ["reportId"], properties: { reportId: { type: "string", format: "uuid" } } } } } },
  },
  runtimeConstraints: ["Body limit 32 KiB", "submittedAt within +/-600000 ms", "Rate limit enforced before parsing the report", "Shared validator imposes additional trimming, nonempty diagnostics and nested error-field constraints; use its fixtures", "GitHub transport must be mocked for testing"],
});

const operationKeys = new Set(operations.map((operation) => operation.key));
const routeKeys = new Set(operations.map((operation) => `${operation.service} ${operation.method} ${operation.path}`));
if (operationKeys.size !== operations.length || routeKeys.size !== operations.length) throw new Error("Duplicate operation or route");
for (const workflow of workflows) {
  for (const key of [...(workflow.subscribeBeforeSteps ?? []), ...workflow.steps]) {
    if (!operationKeys.has(key)) throw new Error(`${workflow.id} refers to unknown operation ${key}`);
  }
}

const inputCases = [];
const queryCombinations = [];
function addInputCases(operation, records, mediaType) {
  for (const record of records) {
    inputCases.push({ id: `I${String(inputCases.length + 1).padStart(6, "0")}`, operation: operation.key, ...(mediaType ? { mediaType } : {}), ...record });
  }
}
for (const operation of operations) {
  const document = documents[operation.version] ?? openApiV1Document;
  addInputCases(operation, [{ field: "request", when: [], variant: "valid-baseline", expectedForNode: "fixture-required", description: "Use an authenticated, visible, schema-valid fixture with prerequisites satisfied; assert the documented success body." }]);
  for (const parameter of operation.parameters) {
    // Query/path values have wire encodings; a normal numeric/boolean query
    // string is not the same invalid type as that string in a JSON body.
    const records = collectSchemaCases(document, parameter.schema, `${parameter.in}.${parameter.name}`, parameter.required === true)
      .filter((record) => !["numeric-string", "boolean-as-string", "wrong-json-type", "non-finite-number-on-wire"].includes(record.variant));
    addInputCases(operation, records);
    if (parameter.in === "query") {
      addInputCases(operation, [{ field: `query.${parameter.name}`, when: [], variant: "duplicate-query-key", expectedForNode: "check-runtime" }]);
      const schema = resolveReference(document, parameter.schema) ?? {};
      if (["integer", "number", "boolean"].includes(schema.type)) {
        addInputCases(operation, [{ field: `query.${parameter.name}`, when: [], variant: "invalid-wire-lexeme", expectedForNode: "check-runtime", description: "Use a non-parsable value; do not label normal numeric/boolean query strings invalid." }]);
      }
      if (schema.type === "array") addInputCases(operation, [
        { field: `query.${parameter.name}`, when: [], variant: "repeated-key-encoding", expectedForNode: "check-runtime" },
        { field: `query.${parameter.name}`, when: [], variant: "comma-separated-encoding", expectedForNode: "check-runtime" },
      ]);
    }
  }
  for (const body of operation.requestBodies) {
    addInputCases(operation, collectSchemaCases(document, body.schema, "body", body.required), body.mediaType);
  }
  for (const selection of combinations(operation.queryFactors)) {
    queryCombinations.push({ id: `Q${String(queryCombinations.length + 1).padStart(5, "0")}`, operation: operation.key, query: selection });
  }
}

const pairs = [];
for (const first of operations) for (const second of operations) pairs.push([first.key, second.key]);
const counts = {
  localOperations: operations.filter((operation) => operation.service === "local").length,
  v1: operations.filter((operation) => operation.version === "v1").length,
  v2: operations.filter((operation) => operation.version === "v2").length,
  supplementalRelayOperations: 1, allOperations: operations.length,
  orderedPairsIncludingSelf: pairs.length,
  localOrderedPairsIncludingSelf: operations.filter((operation) => operation.service === "local").length ** 2,
  unorderedDistinctPairs: operations.length * (operations.length - 1) / 2,
  queryCombinations: queryCombinations.length, inputCases: inputCases.length, workflows: workflows.length,
};
const supplementalSourceHashes = {};
for (const path of ["apps/bug-report-relay/src/index.ts", "packages/contracts/src/bug-reports.ts", "docs/testing/api-workflows.json", "scripts/api-test-matrix/profiles.mjs"]) {
  supplementalSourceHashes[path] = sha256(await readFile(new URL(path, root), "utf8"));
}
const matrix = {
  schemaVersion: 1, projectVersion: packageInfo.version, executionStatus: "not-run",
  source: { documents: Object.fromEntries(Object.entries(documents).map(([version, document]) => [version, { path: "apps/api/src/openapi.ts", sha256: sha256(document) }])), supplementalSourceHashes },
  scope: "All local documented method/path operations plus the optional report-relay operation. Endpoint pairs are exhaustive only for sequences of length two. Values and longer sequences are unbounded.",
  counts,
  combinationRules: {
    query: "Enumerate the full Cartesian product of queryFactors. Omitted and explicit default values are separate. Literals are actual values; fixture choices need schema-valid synthetic values. Resolve required path values separately.",
    body: "Cross topLevelFactors plus every conditional nested schema branch and its input cases. Validate full request schemas, mutual exclusions, required parent objects and domain constraints before classifying a request. Complex values are representative, not exhaustively enumerated.",
    common: "For each operation cross applicable testProfiles with its relevant input cases. Remove impossible fixture combinations and set the oracle from the route/middleware. Profile factors are test proposals, not accepted enum values.",
    pairs: "Each NDJSON row is [firstOperationKey, secondOperationKey]. Includes repeated endpoints, reverse order and cross-version/service pairs. Reset fixtures between pairs; distinguish success paths, missing prerequisites and expected denial. Open concurrent streams before triggering writes.",
    fieldOracles: "expectedForNode evaluates a field's schema node after parsing, under its when conditions. accept does not imply the whole request succeeds. check-schema/runtime and fixture-required need an oracle before execution; formats, trimming, ownership and transport policies are not fully expressed in OpenAPI.",
  },
  fixtures: ["property-a/property-b", "house-a/house-b plus a hidden Home and Property with no Homes", "floor-a/room-a/sensor-a plus cross-parent alternatives", "owner/admin/member/granted-guest/ungranted-guest accounts", "fixed clock and fresh/stale/partial synthetic samples", "temporary databases and protected secrets files", "fake external providers, host/update/storage agents, actuators and GitHub relay"],
  components: { ...openApiV1Document.components, securitySchemes: { ...openApiV1Document.components.securitySchemes, relayBearer: { type: "http", scheme: "bearer", description: "Optional relay shared bearer; accepted only by its /reports operation" } } },
  testProfiles, operations,
};

const mdCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const securityLabel = (operation) => operation.securityAlternatives.length
  ? operation.securityAlternatives.map((alternative) => Object.keys(alternative).join(" + ") || "public").join(" OR ") : "public";
const parameterLabel = (operation) => operation.parameters.map((parameter) => {
  const document = documents[operation.version] ?? openApiV1Document;
  const schema = resolveReference(document, parameter.schema) ?? {};
  const values = schema.enum ? `=${schema.enum.map((value) => JSON.stringify(value)).join("/")}` : "";
  return `${parameter.in}:${parameter.name}${parameter.required ? "*" : "?"}${values}`;
}).join(", ") || "—";
const bodyLabel = (operation) => operation.requestBodies.map((body) => {
  const schema = body.schema;
  return schema.$ref ? schema.$ref.split("/").at(-1) : (schema.oneOf ? `${schema.oneOf.length} oneOf shapes` : "inline schema");
}).join(", ") || "—";
const operationRows = operations.map((operation) => (
  `| \`${operation.key}\` | ${operation.method} \`${operation.path}\` | ${mdCell(parameterLabel(operation))} | ${mdCell(bodyLabel(operation))} | ${mdCell(securityLabel(operation))} | ${[...operation.successCodes, ...operation.documentedErrorCodes].join(", ")} |`
));
const workflowRows = workflows.map((workflow) => `| ${workflow.id} | ${workflow.name} | ${workflow.steps.length} | ${(workflow.subscribeBeforeSteps ?? []).length} |`);
const profileRows = testProfiles.map((profile) => `| ${profile.id} | ${profile.appliesTo} | ${Object.keys(profile.factors).join(", ")} |`);
const markdown = `# API endpoint combinations for testing

This is a testing list for Stugu ${packageInfo.version}: **${counts.localOperations} local API operations** (${counts.v1} v1 and ${counts.v2} v2), plus **one optional bug-report relay operation**. Each operation is a method and path, so GET and POST on the same path are separate entries.

The files cover endpoint inputs, applicable account/resource/runtime states, and multi-endpoint workflows. **All ${counts.orderedPairsIncludingSelf.toLocaleString("en-US")} ordered two-operation pairs are listed**, including repeats, reverse order, both versions and the relay. Arbitrary payload values, subsets of all endpoints and sequences of unrestricted length cannot be fully listed. These are proposed tests, not executed results.

## Testing files

| File | Contents |
| --- | --- |
| [api-endpoint-matrix.json](api-endpoint-matrix.json) | Every operation, resolved parameters, body schemas, response contracts, security alternatives, compact input factors and common profiles |
| [api-input-cases.ndjson](api-input-cases.ndjson) | ${counts.inputCases.toLocaleString("en-US")} individual schema, boundary, omission, null, enum, nested branch and invalid-input cases |
| [api-query-combinations.ndjson](api-query-combinations.ndjson) | ${counts.queryCombinations.toLocaleString("en-US")} combinations of query presence, enums and booleans; other values use synthetic fixtures |
| [api-endpoint-pairs.ndjson](api-endpoint-pairs.ndjson) | ${counts.orderedPairsIncludingSelf.toLocaleString("en-US")} rows of [first operation key, second operation key] |
| [api-workflows.json](api-workflows.json) | ${counts.workflows} ordered workflows with prerequisites, assertions and negative cases |

Operation keys include the version because operationId alone is not unique across documents. Look up each key in the matrix to find its method, path and contract. Relay paths use their separate configured service origin. Local-only pair coverage is ${counts.localOrderedPairsIncludingSelf.toLocaleString("en-US")}; filtering pairs to first key less than second key gives ${counts.unorderedDistinctPairs.toLocaleString("en-US")} distinct unordered pairs across all services.

## How to use the combinations

1. Seed synthetic accounts and resources in an isolated test installation. Give successful requests valid ownership, related IDs and credentials. Capture returned IDs and revisions for subsequent requests. Use temporary databases/secrets files and fake providers, actuators, host/update agents and GitHub transport.
2. Run a valid baseline for each operation and verify its documented success status, media type and response body. An empty result, stale cache or missing prerequisite is a different scenario with its own oracle.
3. Run each applicable input case by changing its named field while keeping the fixture otherwise valid. A field-level accept means only that schema node accepts the value. It does not promise whole-request success. Conditions in when identify required parent objects, array items or union branches. Query/path values require their documented wire encoding; ordinary numeric query strings are valid encodings.
4. Enumerate the query combinations, replacing fixture choices with valid synthetic values. Omitted values and explicit defaults are separate cases. Check from/to relationships, scope and other domain constraints before declaring a combination valid.
5. For bodies, cross all listed topLevelFactors and conditional nested branch choices from the original schemas and input cases. Enum values, booleans, null and omission are explicit; strings, numbers, arrays and objects use representative values plus boundary cases. topLevelCandidateCount is a candidate count before validation. Branch-only fields and complex-value products are not included in that count. Apply required fields, oneOf/anyOf/allOf, minProperties and runtime rules to the complete candidate.
6. Cross the applicable common profiles with each endpoint's inputs. Set expected status and state from the route/middleware, not from HTTP method alone. Keep incompatible fixture states separate. Record unsupported combinations as inapplicable, with a reason.
7. Run the selected workflows, then the exhaustive endpoint pairs. For each pair, supply prerequisites, capture the first result, and assert the second result and state. Reversed order and repeating a mutation can intentionally fail. Reset state between cases. For streams, subscribe before the triggering call and close during teardown.

The matrix preserves OpenAPI constraints and response schemas. Formats, trimming, ownership, lifecycle prerequisites, idempotency and middleware policies also need the implementation and existing tests. The relay supplement is explicitly hand-mapped from its source and shared validator; it is not part of the local OpenAPI counts.

## Shared test dimensions

Cross only factors applicable to the chosen route. The JSON contains every factor's case list and its oracle.

| Profile | Applies to | Dimensions |
| --- | --- | --- |
${profileRows.join("\n")}

Important policy cases include Owner/Admin/Member/Guest access; ungranted resources concealed as not found; immediate grant/account revocation; a Property without Homes; hidden Home write denial with retained Property records; route-scoped machine credentials; current/stale revisions; live/demo separation; stale/partial evidence; failed integrations; stream cleanup; secret redaction and no unauthorized mutation.

POST /api/v2/analytics/query and /analytics/coverage have explicit read-only middleware exceptions. Guest notification registration and bug reporting also have self-service exceptions. Documented security alternatives use OR between objects and AND within each object. Check actual session/ingest alternatives in middleware where documentation is incomplete. General unsupported API methods may return 404; MCP and the relay explicitly implement 405. HEAD and OPTIONS are transport cases rather than separate documented operations.

## Workflow list

The full operation sequence, subscriptions, fixture requirements and assertions are in api-workflows.json. Each step has to be evaluated under its intended fixture state; negative steps are not all expected to return success.

| ID | Workflow | Calls | Stream subscriptions |
| --- | --- | ---: | ---: |
${workflowRows.join("\n")}

## Complete endpoint inventory

Parameter markers: * required, ? optional. The JSON expands references and lists query literals; body constraints and nested inputs are available through requestBodies and components.schemas. Status values below are documented codes, not a claim that all middleware failures are documented. Administration roles still require their runtime guards.

| Operation key | Method and endpoint | Parameters | Body schema | Documented security | Documented statuses |
| --- | --- | --- | --- | --- | --- |
${operationRows.join("\n")}

## Regeneration and verification

Run from the repository root after installing its dependencies:

\`\`\`sh
npm run build:packages
node --import tsx scripts/generate-api-endpoint-combinations.mjs
node --import tsx scripts/generate-api-endpoint-combinations.mjs --check
npm test -w @climate-twin/api -- tests/openapi-parity.test.ts
\`\`\`

Generation imports the source OpenAPI documents and reads repository source files. It performs no HTTP requests and does not start the API, update an appliance or contact integrations. --check compares generated files with current contracts and workflow/profile definitions. The existing parity test checks the local contract against actual Express route registration. Add reviewed workflows when introducing new feature behavior; generated pairs/input cases do not establish domain oracles automatically.

For a test execution report, record case ID, operation/pair/workflow, synthetic fixture state, request variant, expected and actual status/body/state, and pass/fail/blocked/inapplicable. This document records a generated test catalogue; its execution status is **not run**.

Sources: [versioned OpenAPI](../../apps/api/src/openapi.ts), [route registration](../../apps/api/src/app/main.ts), [authorization middleware](../../apps/api/src/app/part-06.ts), [OpenAPI parity test](../../apps/api/tests/openapi-parity.test.ts), [optional relay](../../apps/bug-report-relay/src/index.ts), and [shared report validator](../../packages/contracts/src/bug-reports.ts). Exact source-document and supplemental-source hashes are in the JSON matrix.
`;

const ndjson = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const files = new Map([
  ["api-endpoint-combinations.md", markdown],
  ["api-endpoint-matrix.json", `${JSON.stringify(matrix, null, 2)}\n`],
  ["api-input-cases.ndjson", ndjson(inputCases)],
  ["api-query-combinations.ndjson", ndjson(queryCombinations)],
  ["api-endpoint-pairs.ndjson", ndjson(pairs)],
]);
if (!checkOnly) await mkdir(output, { recursive: true });
for (const [name, contents] of files) {
  const destination = new URL(name, output);
  if (checkOnly) {
    const actual = await readFile(destination, "utf8").catch(() => null);
    if (actual !== contents) throw new Error(`Outdated or missing matrix file: ${name}`);
  } else await writeFile(destination, contents, "utf8");
}
console.log(JSON.stringify({ mode: checkOnly ? "checked" : "generated", directory: fileURLToPath(output), counts }, null, 2));
