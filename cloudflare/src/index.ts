import type {
  AlertRule,
  AssetRecord,
  House,
  IntegrationStatus,
  MeasurementDefinition,
  MeasurementSample,
  MockScenario,
} from "../../packages/contracts/src/index.js";
import { authenticate, randomApiToken, requireApiScope, sha256Hex } from "./auth.js";
import {
  acknowledgeAlert,
  createHouse,
  createObservation,
  createSensor,
  deleteHouse,
  deleteSensor,
  getHouse,
  getSensor,
  getStoredAsset,
  insertTelemetry,
  latestTelemetryRows,
  legacyForecast,
  listAlertEvents,
  listAlertRules,
  listAssets,
  listHouses,
  listJsonEntities,
  listMeasurementDefinitions,
  listSensors,
  measurementForecast,
  measurementHistory,
  measurementSnapshot,
  parseFloorInput,
  readingHistory,
  saveAlertRule,
  saveMeasurementDefinition,
  saveStaticParameter,
  snapshots,
  updateHouse,
  updateSensor,
} from "./data.js";
import {
  HttpError,
  boundedInteger,
  empty,
  errorResponse,
  finiteNumber,
  isObject,
  json,
  objectBody,
  readJson,
  requiredString,
  routeId,
} from "./http.js";
import { HOSTED_ROUTES, matchHostedRoute, openApiDocument, type HostedRoute } from "./routes.js";
import { requireTenantAdmin, requireTenantOwner, resolveTenant, type TenantContext } from "./tenant.js";
import {
  configuredBucketSeconds,
  groupMeasurements,
  parseMeasurementInput,
  parseReadingInput,
  readingsToMeasurements,
} from "./telemetry.js";
import { coordinateDefaults, fetchHouseWeather, searchLocations } from "./weather.js";

const MOCK_SCENARIOS: MockScenario[] = [
  { id: "normal", label: "Normal", description: "Stable indoor conditions." },
  { id: "shower", label: "Shower", description: "A short bathroom humidity rise." },
  { id: "leak", label: "Leak", description: "A sustained moisture anomaly." },
  { id: "cold-front", label: "Cold front", description: "A falling outdoor boundary." },
  { id: "heating-failure", label: "Heating failure", description: "A sustained indoor temperature fall." },
];

function decodedMatch(pathname: string, expression: RegExp): string[] | null {
  const match = expression.exec(pathname);
  if (!match) return null;
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Path contains an invalid encoded identifier");
  }
}

function dateRange(url: URL, defaultHours = 24): { from: string; to: string } {
  const toEpoch = url.searchParams.has("to") ? Date.parse(url.searchParams.get("to")!) : Date.now();
  const fromEpoch = url.searchParams.has("from") ? Date.parse(url.searchParams.get("from")!) : toEpoch - defaultHours * 3_600_000;
  if (!Number.isFinite(fromEpoch) || !Number.isFinite(toEpoch) || fromEpoch > toEpoch) {
    throw new HttpError(400, "INVALID_RANGE", "from and to must be valid instants with from before to");
  }
  return { from: new Date(fromEpoch).toISOString(), to: new Date(toEpoch).toISOString() };
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_EMAIL", "email is required");
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new HttpError(400, "INVALID_EMAIL", "email must be a valid address");
  }
  return email;
}

function enforceRouteAuthorization(route: HostedRoute, tenant: TenantContext): void {
  if (tenant.principal.kind === "api-token") {
    if (route.auth === "tenant-admin" || route.auth === "tenant-owner") {
      throw new HttpError(403, "INTERACTIVE_IDENTITY_REQUIRED", "Tenant administration requires a verified interactive identity");
    }
    if (route.apiTokenScope) requireApiScope(tenant.principal, route.apiTokenScope);
  }
  if (route.auth === "tenant-admin") requireTenantAdmin(tenant);
  if (route.auth === "tenant-owner") requireTenantOwner(tenant);
}

async function handleTenantRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "GET" && (path === "/api/v1/session" || path === "/api/v1/tenant")) {
    return json({
      authenticated: true,
      principal: { type: tenant.principal.kind, email: tenant.email },
      tenant: { id: tenant.id, name: tenant.name, role: tenant.role },
    });
  }
  if (request.method === "PATCH" && path === "/api/v1/tenant") {
    const name = requiredString(objectBody(await readJson(request)), "name", 200);
    await env.DB.prepare("UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, new Date().toISOString(), tenant.id).run();
    return json({ tenant: { id: tenant.id, name, role: tenant.role } });
  }
  if (request.method === "GET" && path === "/api/v1/tenant/members") {
    const members = await env.DB.prepare(`SELECT u.email, m.role, m.created_at FROM tenant_members m
      JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.created_at, u.email`)
      .bind(tenant.id).all<{ email: string; role: string; created_at: string }>();
    const invitations = await env.DB.prepare(`SELECT email, role, created_at FROM tenant_invitations
      WHERE tenant_id = ? ORDER BY created_at, email`).bind(tenant.id).all<{ email: string; role: string; created_at: string }>();
    return json({
      members: members.results.map((member) => ({ email: member.email, role: member.role, joinedAt: member.created_at })),
      invitations: invitations.results.map((invitation) => ({ email: invitation.email, role: invitation.role, invitedAt: invitation.created_at })),
    });
  }
  if (request.method === "POST" && path === "/api/v1/tenant/members") {
    if (!tenant.userId) throw new HttpError(403, "INTERACTIVE_IDENTITY_REQUIRED", "An interactive owner or admin is required");
    const body = objectBody(await readJson(request));
    const email = normalizeEmail(body.email);
    const role = body.role === "admin" ? "admin" : "member";
    if (email === tenant.email) throw new HttpError(409, "ALREADY_MEMBER", "The current user is already a tenant member");
    const timestamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO tenant_invitations(tenant_id, email, role, invited_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, email) DO UPDATE SET role = excluded.role,
      invited_by_user_id = excluded.invited_by_user_id, created_at = excluded.created_at`)
      .bind(tenant.id, email, role, tenant.userId, timestamp).run();
    return json({ invitation: { email, role, invitedAt: timestamp } }, 201);
  }
  const memberEmail = routeId(path, /^\/api\/v1\/tenant\/members\/([^/]+)$/);
  if (request.method === "DELETE" && memberEmail !== null) {
    const email = normalizeEmail(memberEmail);
    if (email === tenant.email) throw new HttpError(409, "OWNER_SELF_REMOVAL", "The active tenant owner cannot remove their own membership");
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM tenant_members WHERE tenant_id = ? AND user_id IN
        (SELECT id FROM users WHERE email = ?)`).bind(tenant.id, email),
      env.DB.prepare("DELETE FROM tenant_invitations WHERE tenant_id = ? AND email = ?").bind(tenant.id, email),
    ]);
    if (!results.some((result) => Number(result.meta.changes) > 0)) throw new HttpError(404, "NOT_FOUND", "Member or invitation not found");
    return empty();
  }
  if (request.method === "GET" && path === "/api/v1/tenant/tokens") {
    const rows = await env.DB.prepare(`SELECT id, label, scopes_json, created_by, created_at, expires_at, revoked_at
      FROM api_tokens WHERE tenant_id = ? ORDER BY created_at DESC`).bind(tenant.id).all<{
        id: string; label: string; scopes_json: string; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null;
      }>();
    return json({ tokens: rows.results.map((row) => ({
      id: row.id, label: row.label, scopes: JSON.parse(row.scopes_json) as unknown,
      createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
    })) });
  }
  if (request.method === "POST" && path === "/api/v1/tenant/tokens") {
    if (!tenant.email) throw new HttpError(403, "INTERACTIVE_IDENTITY_REQUIRED", "An interactive owner or admin is required");
    const body = objectBody(await readJson(request));
    const label = requiredString(body, "label", 100);
    const allowedScopes = new Set(["read", "write", "ingest"]);
    const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes.filter((scope): scope is string => typeof scope === "string"))] : ["read", "ingest"];
    if (!scopes.length || scopes.some((scope) => !allowedScopes.has(scope))) {
      throw new HttpError(400, "INVALID_SCOPES", "scopes must contain read, write, and/or ingest");
    }
    const expiryEpoch = body.expiresAt === null || body.expiresAt === undefined ? null : Date.parse(String(body.expiresAt));
    if (expiryEpoch !== null && (!Number.isFinite(expiryEpoch) || expiryEpoch <= Date.now())) {
      throw new HttpError(400, "INVALID_EXPIRY", "expiresAt must be a valid future instant");
    }
    const expiresAt = expiryEpoch === null ? null : new Date(expiryEpoch).toISOString();
    const token = randomApiToken();
    const tokenId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO api_tokens
      (token_hash, id, tenant_id, label, scopes_json, created_by, created_at, expires_at, revoked_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .bind(await sha256Hex(token), tokenId, tenant.id, label, JSON.stringify(scopes), tenant.email, timestamp, expiresAt).run();
    return json({ token: { id: tokenId, label, scopes, expiresAt, value: token }, warning: "The token value is shown once and is never stored in plaintext." }, 201);
  }
  const tokenId = routeId(path, /^\/api\/v1\/tenant\/tokens\/([^/]+)$/);
  if (request.method === "DELETE" && tokenId !== null) {
    const result = await env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`)
      .bind(new Date().toISOString(), tenant.id, tokenId).run();
    if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "Active API token not found");
    return empty();
  }
  return null;
}

async function handleHouseRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/v1/houses" && request.method === "GET") return json({ houses: await listHouses(env.DB, tenant.id) });
  if (path === "/api/v1/houses" && request.method === "POST") return json({ house: await createHouse(env.DB, tenant.id, await readJson(request)) }, 201);

  const weatherMatch = decodedMatch(path, /^\/api\/v1\/houses\/([^/]+)\/weather$/);
  if (request.method === "GET" && weatherMatch) {
    const house = await getHouse(env.DB, tenant.id, weatherMatch[0]!);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    return json({ weather: await fetchHouseWeather(house, boundedInteger(url.searchParams.get("hours"), 48, 1, 240)) });
  }
  const thermalMatch = decodedMatch(path, /^\/api\/v1\/houses\/([^/]+)\/thermal-simulation$/);
  if (request.method === "GET" && thermalMatch) {
    if (!await getHouse(env.DB, tenant.id, thermalMatch[0]!)) throw new HttpError(404, "NOT_FOUND", "House not found");
    throw new HttpError(501, "LOCAL_COMPUTE_REQUIRED", "Thermal calibration remains in the local runtime because the Free Worker CPU limit is not suitable for it");
  }
  const layoutMatch = decodedMatch(path, /^\/api\/v1\/houses\/([^/]+)\/layout$/);
  if (request.method === "PUT" && layoutMatch) {
    const body = objectBody(await readJson(request));
    if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
    return json({ house: await updateHouse(env.DB, tenant.id, layoutMatch[0]!, { floors: body.floors }) });
  }
  const floorMatch = decodedMatch(path, /^\/api\/v1\/houses\/([^/]+)\/floors\/([^/]+)$/);
  if (request.method === "PUT" && floorMatch) {
    const house = await getHouse(env.DB, tenant.id, floorMatch[0]!);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    const floor = parseFloorInput(await readJson(request));
    if (floor.id !== floorMatch[1]) throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
    const index = house.floors.findIndex((candidate) => candidate.id === floor.id);
    if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
    const floors = [...house.floors];
    floors[index] = floor;
    await updateHouse(env.DB, tenant.id, house.id, { floors });
    return json(floor);
  }
  const id = routeId(path, /^\/api\/v1\/houses\/([^/]+)$/);
  if (id === null) return null;
  if (request.method === "GET") {
    const house = await getHouse(env.DB, tenant.id, id);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    return json({ house });
  }
  if (request.method === "PATCH") return json({ house: await updateHouse(env.DB, tenant.id, id, await readJson(request)) });
  if (request.method === "DELETE") {
    const objectKeys = await env.DB.prepare("SELECT object_key FROM assets WHERE tenant_id = ? AND house_id = ?")
      .bind(tenant.id, id).all<{ object_key: string }>();
    const keys = objectKeys.results.map((row) => row.object_key);
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      await env.ASSET_BUCKET.delete(keys.slice(offset, offset + 1_000));
    }
    await deleteHouse(env.DB, tenant.id, id);
    return empty();
  }
  return null;
}

async function handleSensorRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const houseId = url.searchParams.get("houseId") ?? undefined;
  if ((path === "/api/v1/snapshot" || path === "/api/v1/sensors/snapshots") && request.method === "GET") {
    const values = await snapshots(env.DB, tenant.id, houseId);
    return json(path.endsWith("snapshots") ? { sensors: values } : { snapshot: values });
  }
  if (path === "/api/v1/sensors" && request.method === "GET") return json({ sensors: await listSensors(env.DB, tenant.id, houseId) });
  if (path === "/api/v1/sensors" && request.method === "POST") return json({ sensor: await createSensor(env.DB, tenant.id, await readJson(request)) }, 201);
  const id = routeId(path, /^\/api\/v1\/sensors\/([^/]+)$/);
  if (id === null) return null;
  if (request.method === "GET") {
    const sensor = await getSensor(env.DB, tenant.id, id);
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    const snapshot = (await snapshots(env.DB, tenant.id, sensor.houseId)).find((entry) => entry.id === sensor.id);
    return json({ sensor, reading: snapshot?.reading ?? null });
  }
  if (request.method === "PATCH" || request.method === "PUT") return json({ sensor: await updateSensor(env.DB, tenant.id, id, await readJson(request)) });
  if (request.method === "DELETE") { await deleteSensor(env.DB, tenant.id, id); return empty(); }
  return null;
}

function measurementInputs(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isObject(body) && Array.isArray(body.samples)) return body.samples;
  if (isObject(body) && body.sample !== undefined) return [body.sample];
  return [body];
}

function legacyReadingInputs(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isObject(body) && Array.isArray(body.readings)) return body.readings;
  if (isObject(body) && body.reading !== undefined) return [body.reading];
  return [body];
}

async function ingestMeasurements(request: Request, env: Env, tenant: TenantContext, legacy: boolean): Promise<Response> {
  const body = await readJson(request, 2_000_000);
  const inputs = legacy ? legacyReadingInputs(body) : measurementInputs(body);
  if (inputs.length < 1 || inputs.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1,000 samples");
  const raw = legacy ? inputs.map(parseReadingInput) : inputs.map(parseMeasurementInput);
  const measurements = legacy ? readingsToMeasurements(raw as ReturnType<typeof parseReadingInput>[]) : raw as MeasurementSample[];
  const groups = groupMeasurements(measurements, configuredBucketSeconds(env.INGEST_MIN_INTERVAL_SECONDS));
  await insertTelemetry(env.DB, tenant.id, groups);
  return json({ accepted: measurements.length, persistedBuckets: groups.length, ignoredDuplicates: 0, ...(legacy ? { readings: raw } : { samples: measurements }) }, 201);
}

async function handleTelemetryRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "POST" && path === "/api/v1/readings") return ingestMeasurements(request, env, tenant, true);
  if (request.method === "POST" && (path === "/api/v2/measurements" || path === "/api/v2/measurements/import")) {
    return ingestMeasurements(request, env, tenant, false);
  }
  if (request.method === "GET" && path === "/api/v1/readings/latest") {
    const result = (await snapshots(env.DB, tenant.id)).flatMap((entry) => entry.reading ? [entry.reading] : []);
    return json({ readings: result });
  }
  if (request.method === "GET" && (path === "/api/v1/readings" || path === "/api/v1/history")) {
    const sensorId = url.searchParams.get("sensorId");
    if (!sensorId) throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    const { from, to } = dateRange(url);
    return json({ readings: await readingHistory(env.DB, tenant.id, sensorId, from, to, boundedInteger(url.searchParams.get("limit"), 500, 1, 5_000)) });
  }
  if (request.method === "GET" && path === "/api/v2/measurements/snapshot") {
    return json({ snapshot: await measurementSnapshot(env.DB, tenant.id, url.searchParams.get("houseId") ?? undefined) });
  }
  if (request.method === "GET" && path === "/api/v2/measurements/history") {
    const sensorId = url.searchParams.get("sensorId");
    const metric = url.searchParams.get("metric");
    if (!sensorId || !metric) throw new HttpError(400, "INVALID_FIELD", "sensorId and metric are required");
    const { from, to } = dateRange(url);
    return json({ samples: await measurementHistory(env.DB, tenant.id, sensorId, metric, from, to, boundedInteger(url.searchParams.get("limit"), 500, 1, 5_000)) });
  }
  if (request.method === "GET" && path === "/api/v2/measurements/forecast") {
    const sensorId = url.searchParams.get("sensorId");
    const metric = url.searchParams.get("metric");
    if (!sensorId || !metric) throw new HttpError(400, "INVALID_FIELD", "sensorId and metric are required");
    const hours = boundedInteger(url.searchParams.get("hours"), 12, 1, 72);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const samples = await measurementHistory(env.DB, tenant.id, sensorId, metric, from, to, 100);
    return json({ forecast: measurementForecast(samples, hours) });
  }
  if (request.method === "GET" && path === "/api/v1/forecast") {
    const sensorId = url.searchParams.get("sensorId");
    if (!sensorId) throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    const horizonMinutes = boundedInteger(url.searchParams.get("horizonMinutes"), 360, 10, 4_320);
    const hours = Math.ceil(horizonMinutes / 60);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [temperature, humidity] = await Promise.all([
      measurementHistory(env.DB, tenant.id, sensorId, "temperature", from, to, 100),
      measurementHistory(env.DB, tenant.id, sensorId, "humidity", from, to, 100),
    ]);
    return json({ forecast: legacyForecast(measurementForecast(temperature, hours), measurementForecast(humidity, hours)) });
  }
  if (request.method === "GET" && ["/api/v1/events", "/api/v1/stream", "/api/v2/measurements/events"].includes(path)) {
    const payload = `retry: 60000\nevent: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString(), tenantId: tenant.id })}\n\n`;
    return new Response(payload, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
  }
  return null;
}

async function handleDefinitionRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/v2/measurement-definitions" && request.method === "GET") {
    return json({ definitions: await listMeasurementDefinitions(env.DB, tenant.id, url.searchParams.get("includeDisabled") !== "false") });
  }
  if (path === "/api/v2/measurement-definitions" && request.method === "POST") {
    const body = objectBody(await readJson(request));
    const id = requiredString(body, "id", 64).toLowerCase();
    return json({ definition: await saveMeasurementDefinition(env.DB, tenant.id, id, body) }, 201);
  }
  const id = routeId(path, /^\/api\/v2\/measurement-definitions\/([^/]+)$/);
  if (id === null) return null;
  if (request.method === "PATCH") return json({ definition: await saveMeasurementDefinition(env.DB, tenant.id, id, await readJson(request)) });
  if (request.method === "DELETE") return json({ definition: await saveMeasurementDefinition(env.DB, tenant.id, id, { enabled: false }) });
  return null;
}

async function handleDomainRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/v1/alert-rules" && request.method === "GET") return json({ rules: await listAlertRules(env.DB, tenant.id) });
  if (path === "/api/v1/alert-rules" && request.method === "POST") return json(await saveAlertRule(env.DB, tenant.id, await readJson(request)), 201);
  const ruleId = routeId(path, /^\/api\/v1\/alert-rules\/([^/]+)$/);
  if (ruleId !== null && request.method === "PATCH") return json(await saveAlertRule(env.DB, tenant.id, await readJson(request), ruleId));
  if (ruleId !== null && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM alert_rules WHERE tenant_id = ? AND id = ?").bind(tenant.id, ruleId).run();
    if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
    return empty();
  }
  if (["/api/v1/alerts", "/api/v1/alert-events"].includes(path) && request.method === "GET") {
    return json({ alerts: await listAlertEvents(env.DB, tenant.id, boundedInteger(url.searchParams.get("limit"), 200, 1, 1_000)) });
  }
  const alertMatch = decodedMatch(path, /^\/api\/v1\/(?:alerts|alert-events)\/([^/]+)\/acknowledge$/);
  if (alertMatch && request.method === "POST") return json(await acknowledgeAlert(env.DB, tenant.id, alertMatch[0]!));
  if (path === "/api/v1/observations" && request.method === "GET") {
    const houseId = url.searchParams.get("houseId");
    return json({ observations: await listJsonEntities(env.DB, "observations", tenant.id, houseId ? "AND house_id = ? ORDER BY occurred_at DESC" : "ORDER BY occurred_at DESC", houseId ? [houseId] : []) });
  }
  if (path === "/api/v1/observations" && request.method === "POST") return json(await createObservation(env.DB, tenant.id, await readJson(request)), 201);
  const observationId = routeId(path, /^\/api\/v1\/observations\/([^/]+)$/);
  if (observationId !== null && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM observations WHERE tenant_id = ? AND id = ?").bind(tenant.id, observationId).run();
    if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "Observation not found");
    return empty();
  }
  if (["/api/v1/parameters", "/api/v1/static-parameters"].includes(path) && request.method === "GET") {
    const houseId = url.searchParams.get("houseId");
    return json({ parameters: await listJsonEntities(env.DB, "static_parameters", tenant.id, houseId ? "AND house_id = ? ORDER BY id" : "ORDER BY id", houseId ? [houseId] : []) });
  }
  if (["/api/v1/parameters", "/api/v1/static-parameters"].includes(path) && request.method === "POST") {
    return json(await saveStaticParameter(env.DB, tenant.id, await readJson(request)), 201);
  }
  const parameterId = routeId(path, /^\/api\/v1\/parameters\/([^/]+)$/);
  if (parameterId !== null && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM static_parameters WHERE tenant_id = ? AND id = ?").bind(tenant.id, parameterId).run();
    if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
    return empty();
  }
  return null;
}

function decodeBase64Asset(data: unknown): Uint8Array {
  if (typeof data !== "string") throw new HttpError(400, "INVALID_ASSET", "data must be a base64 string");
  const encoded = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const maxBytes = 256 * 1024;
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (encoded.length > maxEncodedLength) {
    throw new HttpError(413, "ASSET_TOO_LARGE", "Asset exceeds the 256 KiB Free-tier inline upload limit");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new HttpError(400, "INVALID_ASSET", "data is not valid base64");
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength > maxBytes) throw new HttpError(413, "ASSET_TOO_LARGE", "Asset exceeds the 256 KiB Free-tier inline upload limit");
    return bytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_ASSET", "data is not valid base64");
  }
}

async function handleAssetRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/v1/assets" && request.method === "GET") return json({ assets: await listAssets(env.DB, tenant.id, url.searchParams.get("houseId") ?? undefined) });
  if (path === "/api/v1/assets" && request.method === "POST") {
    const body = objectBody(await readJson(request, 400_000));
    const houseId = requiredString(body, "houseId", 200);
    if (!await getHouse(env.DB, tenant.id, houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "House not found");
    const mimeType = requiredString(body, "mimeType", 100);
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"]);
    if (!allowedTypes.has(mimeType)) throw new HttpError(400, "INVALID_MIME_TYPE", "Unsupported hosted asset type");
    const kind = requiredString(body, "kind", 20) as AssetRecord["kind"];
    if (!["floor-plan", "model-3d", "other"].includes(kind)) throw new HttpError(400, "INVALID_ASSET_KIND", "Unsupported asset kind");
    const bytes = decodeBase64Asset(body.data);
    const name = requiredString(body, "name", 300);
    const id = crypto.randomUUID();
    const objectKey = `tenants/${tenant.id}/assets/${id}`;
    const createdAt = new Date().toISOString();
    await env.ASSET_BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: mimeType } });
    try {
      await env.DB.prepare(`INSERT INTO assets(tenant_id, id, house_id, object_key, name, mime_type, kind, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(tenant.id, id, houseId, objectKey, name, mimeType, kind, bytes.byteLength, createdAt).run();
    } catch (error) {
      await env.ASSET_BUCKET.delete(objectKey);
      throw error;
    }
    return json({ id, houseId, name, mimeType, kind, size: bytes.byteLength, createdAt }, 201);
  }
  const id = routeId(path, /^\/api\/v1\/assets\/([^/]+)$/);
  if (id === null) return null;
  const metadata = await getStoredAsset(env.DB, tenant.id, id);
  if (!metadata) throw new HttpError(404, "NOT_FOUND", "Asset not found");
  if (request.method === "GET") {
    const object = await env.ASSET_BUCKET.get(metadata.objectKey);
    if (!object) throw new HttpError(404, "NOT_FOUND", "Asset object not found");
    const headers = new Headers({
      "content-type": metadata.mimeType,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag,
    });
    const disposition = metadata.mimeType.startsWith("image/") ? "inline" : "attachment";
    headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
    return new Response(object.body, { headers });
  }
  if (request.method === "DELETE") {
    await env.ASSET_BUCKET.delete(metadata.objectKey);
    await env.DB.prepare("DELETE FROM assets WHERE tenant_id = ? AND id = ?").bind(tenant.id, id).run();
    return empty();
  }
  return null;
}

async function integrationStatus(env: Env, tenant: TenantContext): Promise<IntegrationStatus> {
  const houses = await listHouses(env.DB, tenant.id);
  return {
    homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: "Hosted deployments receive Home Assistant data from a tenant-scoped local connector." },
    tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: "Cloudflare cannot discover or poll private-LAN TP-Link hubs; use the local connector." },
    webhook: { configured: false, lastDeliveryAt: null, error: null },
    mock: { enabled: false, intervalMs: 0, mode: "real", activatedAt: null },
    weather: { policy: "open-meteo", availableProviders: ["open-meteo"], provider: "open-meteo", configuredHouses: houses.filter((house) => house.location).length, lastSuccessAt: null, error: null },
  };
}

async function handleIntegrationRoutes(request: Request, env: Env, tenant: TenantContext, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/v1/integrations/status") return json(await integrationStatus(env, tenant));
  if (request.method === "POST" && path === "/api/v1/integrations/discover") return json({
    homeAssistant: [], tpLink: [], warnings: ["LAN discovery runs only in the local connector. Cloudflare cannot reach private home networks."],
  });
  if (request.method === "GET" && path === "/api/v1/integrations/tp-link/devices") return json({ devices: [] });
  if (request.method === "PUT" && ["/api/v1/integrations/home-assistant/config", "/api/v1/integrations/tp-link/config"].includes(path)) {
    throw new HttpError(409, "LOCAL_CONNECTOR_REQUIRED", "Hosted Stuga never stores LAN integration credentials. Configure them in the local connector and use a scoped ingest token.");
  }
  if (request.method === "POST" && ["/api/v1/integrations/home-assistant/test", "/api/v1/integrations/tp-link/test"].includes(path)) {
    return json({ ok: false, message: "Connection tests run in the local connector on the same LAN as the integration." });
  }
  if (request.method === "GET" && ["/api/v1/integrations/home-assistant/setup", "/api/v1/integrations/tp-link/setup"].includes(path)) {
    return json({ hosted: true, credentialStorage: "local-only", steps: [
      "Run the Open Stuga local API/connector on the home LAN.",
      "Configure TP-Link or Home Assistant credentials only on that machine.",
      "Create a tenant token with the ingest scope and configure outbound 10-minute batches to the hosted API.",
    ] });
  }
  if (request.method === "GET" && path === "/api/v1/mock/scenarios") return json({ scenarios: MOCK_SCENARIOS, enabled: false });
  if (request.method === "POST" && path === "/api/v1/mock/scenario") return json({ ok: true, persisted: false, note: "Hosted scenarios remain browser-local." });
  return null;
}

async function handleLocations(request: Request, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/v1/locations/search") {
    return json({ results: await searchLocations(url.searchParams.get("q")?.trim() ?? "", url.searchParams.get("language") ?? "en") });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/locations/defaults") {
    const latitude = url.searchParams.get("latitude");
    const longitude = url.searchParams.get("longitude");
    if (latitude === null || latitude.trim() === "" || longitude === null || longitude.trim() === "") {
      throw new HttpError(400, "INVALID_FIELD", "latitude and longitude are required");
    }
    return json(await coordinateDefaults(finiteNumber(Number(latitude), "latitude"), finiteNumber(Number(longitude), "longitude")));
  }
  return null;
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return empty();
  if (request.method === "GET" && ["/api/openapi.json", "/api/v1/openapi.json", "/api/v2/openapi.json"].includes(url.pathname)) return json(openApiDocument());
  if (request.method === "GET" && url.pathname === "/api/hosted-routes.json") return json({ routes: HOSTED_ROUTES });
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    const database = await env.DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
    return json({ status: database?.ready === 1 ? "ok" : "degraded", runtime: "cloudflare-workers", database: "d1", assets: "r2", tenancy: "access-subject-and-membership" });
  }

  const route = matchHostedRoute(request.method, url.pathname);
  if (!route) throw new HttpError(404, "NOT_FOUND", "Hosted API endpoint not found");
  const principal = await authenticate(request, env);
  const tenant = await resolveTenant(request, principal, env);
  enforceRouteAuthorization(route, tenant);

  const handlers: Array<() => Promise<Response | null>> = [
    () => handleTenantRoutes(request, env, tenant, url),
    () => handleLocations(request, url),
    () => handleHouseRoutes(request, env, tenant, url),
    () => handleSensorRoutes(request, env, tenant, url),
    () => handleTelemetryRoutes(request, env, tenant, url),
    () => handleDefinitionRoutes(request, env, tenant, url),
    () => handleDomainRoutes(request, env, tenant, url),
    () => handleAssetRoutes(request, env, tenant, url),
    () => handleIntegrationRoutes(request, env, tenant, url),
  ];
  // Handlers are deliberately started sequentially: several inspect request.body,
  // which is a one-shot stream and must never be consumed speculatively.
  for (const candidate of handlers) {
    const response = await candidate();
    if (response) return response;
  }
  throw new HttpError(501, "HOSTED_OPERATION_NOT_IMPLEMENTED", "The route is declared but not implemented by this hosted adapter");
}

async function purgeExpiredTelemetry(env: Env): Promise<number> {
  const days = boundedInteger(env.RAW_RETENTION_DAYS ?? null, 30, 1, 365);
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  let deleted = 0;
  while (deleted < 20_000) {
    const result = await env.DB.prepare(`DELETE FROM telemetry_samples WHERE rowid IN (
      SELECT rowid FROM telemetry_samples WHERE timestamp < ? ORDER BY timestamp LIMIT 5000
    )`).bind(before).run();
    const changes = Number(result.meta.changes);
    deleted += changes;
    if (changes < 5_000) break;
  }
  console.log(JSON.stringify({ message: "hosted telemetry retention complete", before, deleted }));
  return deleted;
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return errorResponse(error, request);
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(purgeExpiredTelemetry(env));
  },
} satisfies ExportedHandler<Env>;
