import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const OWNER = { email: "owner@example.test", password: "correct horse battery staple" };

function privateIpv4Address(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("10.") || entry.address.startsWith("192.168.")) return entry.address;
      const match = entry.address.match(/^172\.(\d{1,3})\./);
      if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return entry.address;
    }
  }
  return null;
}

function authRuntime(spatialLayers = false): ApiRuntime {
  return createApi({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      MOCK_ENABLED: "false",
      LOCAL_AUTH_TEST_BYPASS: "false",
      ...(spatialLayers ? {
        SPATIAL_LAYERS_ENABLED: "true",
        SPATIAL_LAYERS_DATABASE_PATH: ":memory:",
      } : {}),
    }),
    startBackground: false,
  });
}

async function streamTextToEnd(response: globalThis.Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not expose a body");
  const chunks: Uint8Array[] = [];
  await Promise.race([
    (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        chunks.push(result.value);
      }
    })(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE did not close")), 2_000)),
  ]);
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

function sessionCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = cookies?.find((value) => value.startsWith("stuga_session="));
  if (!cookie) throw new Error("Session cookie missing");
  return cookie.split(";", 1)[0]!;
}

async function setupOwner(runtime: ApiRuntime): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrf: string;
}> {
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/v1/auth/setup").send(OWNER).expect(201);
  return { agent, csrf: response.body.csrfToken as string };
}

describe("local account authentication and authorization", () => {
  const runtimes: ApiRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("accepts accounts on a private local domain", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const localOwner = { email: "owner@stuga", password: OWNER.password };
    const agent = request.agent(runtime.app);

    const setup = await agent.post("/api/v1/auth/setup").send(localOwner).expect(201);
    expect(setup.body.principal.email).toBe(localOwner.email);
    await agent.post("/api/v1/auth/logout")
      .set("x-csrf-token", setup.body.csrfToken)
      .expect(204);
    await agent.post("/api/v1/auth/login").send(localOwner).expect(200)
      .expect(({ body }) => expect(body.principal.email).toBe(localOwner.email));
  });

  it("fails closed before setup, creates the first owner, enforces CSRF, and revokes logout", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);

    const initial = await request(runtime.app).get("/api/v1/session").expect(200);
    expect(initial.body).toMatchObject({ authenticated: false, setupRequired: true, readOnly: true });
    expect(initial.headers["cache-control"]).toBe("private, no-store");
    await request(runtime.app).get("/api/v1/houses").expect(401, {
      error: { code: "SETUP_REQUIRED", message: "Create the first local Owner before using the API" },
    });
    await request(runtime.app).post("/api/v1/auth/setup").send({
      email: OWNER.email,
      password: "x".repeat(9 * 1024),
    }).expect(413, {
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the 8 KiB limit" },
    });

    const agent = request.agent(runtime.app);
    const setup = await agent.post("/api/v1/auth/setup").send(OWNER).expect(201);
    expect(setup.body).toMatchObject({ authenticated: true, readOnly: false, principal: { email: OWNER.email } });
    expect(setup.headers["cache-control"]).toBe("private, no-store");
    const setCookies = setup.headers["set-cookie"] as unknown as string[];
    expect(setCookies.some((cookie) => /stuga_session=.*HttpOnly.*SameSite=Strict/i.test(cookie))).toBe(true);
    expect(setCookies.some((cookie) => /stuga_csrf=.*SameSite=Strict/i.test(cookie) && !/HttpOnly/i.test(cookie))).toBe(true);

    await request(runtime.app).post("/api/v1/tenant/members")
      .send({ padding: "x".repeat(40 * 1024) })
      .expect(401);

    const largeGrant = { scopeType: "property", scopeId: "x".repeat(200) };
    await agent.post("/api/v1/tenant/members").set("x-csrf-token", setup.body.csrfToken).send({
      email: "large-grants@example.test",
      role: "guest",
      grants: Array.from({ length: 100 }, () => largeGrant),
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_GRANT_SCOPE"));
    await agent.post("/api/v1/tenant/members").set("x-csrf-token", setup.body.csrfToken).send({
      email: "too-many-grants@example.test",
      role: "guest",
      grants: Array.from({ length: 101 }, () => ({ scopeType: "property", scopeId: "property-main" })),
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_GRANTS"));

    const stored = runtime.database.db.prepare(
      "SELECT email, password_hash, password_salt FROM local_auth_users WHERE email = ?",
    ).get(OWNER.email) as { email: string; password_hash: string; password_salt: string };
    expect(stored.password_hash).not.toContain(OWNER.password);
    expect(stored.password_hash.length).toBeGreaterThan(40);
    expect(stored.password_salt.length).toBeGreaterThan(10);

    await agent.post("/api/v1/properties").send({ name: "Missing CSRF" }).expect(403);
    await agent.post("/api/v1/properties").set("x-csrf-token", setup.body.csrfToken).send({ name: "Allowed" }).expect(201);
    await request(runtime.app).post("/api/v1/auth/setup").send(OWNER).expect(409);

    await agent.post("/api/v1/auth/logout").set("x-csrf-token", setup.body.csrfToken).expect(204);
    await agent.get("/api/v1/session").expect(401);
    await agent.get("/api/v1/houses").expect(401);
  });

  it("authenticates forwarded proxy metadata and rate-limits subjects independently of x-real-ip", async () => {
    const address = privateIpv4Address();
    expect(address, "A private IPv4 interface is required for the proxy-boundary test").not.toBeNull();
    const proxySecret = "proxy-secret-".padEnd(48, "x");
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        LOCAL_AUTH_PROXY_BIND_ADDRESS: "127.0.0.1",
        LOCAL_AUTH_PROXY_SECRET: proxySecret,
      }),
      startBackground: false,
    });
    runtimes.push(runtime);
    const server = runtime.app.listen(0, "0.0.0.0");
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const setupUrl = `http://${address}:${port}/api/v1/auth/setup`;
      const rejected = await fetch(setupUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-stuga-local-proxy": "compose-v1" },
        body: JSON.stringify(OWNER),
      });
      expect(rejected.status).toBe(403);

      const setup = await fetch(setupUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          "x-real-ip": "192.0.2.1",
          "x-stuga-local-proxy": proxySecret,
        },
        body: JSON.stringify(OWNER),
      });
      expect(setup.status).toBe(201);
      expect(setup.headers.getSetCookie().some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie))).toBe(true);

      const loginUrl = `http://${address}:${port}/api/v1/auth/login`;
      for (let index = 0; index < 8; index += 1) {
        const response = await fetch(loginUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `192.0.2.${index + 10}`,
            "x-stuga-local-proxy": proxySecret,
          },
          body: JSON.stringify({ email: OWNER.email, password: "incorrect password" }),
        });
        expect(response.status).toBe(401);
      }
      const limited = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "192.0.2.99",
          "x-stuga-local-proxy": proxySecret,
        },
        body: JSON.stringify({ email: OWNER.email, password: "incorrect password" }),
      });
      expect(limited.status).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses shown-once expiring invitation tokens and enforces live Guest scopes/read-only access", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    await owner.agent.post("/api/v1/properties").set("x-csrf-token", owner.csrf).send({
      id: "property-hidden", name: "Hidden property", description: "secret", location: { latitude: 61, longitude: 25 },
    }).expect(201);
    await owner.agent.post("/api/v1/houses").set("x-csrf-token", owner.csrf).send({
      id: "house-hidden", propertyId: "property-hidden", name: "Hidden house", timezone: "Europe/Helsinki",
      floors: [{ id: "ground", name: "Ground", width: 4, height: 4, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    await owner.agent.post("/api/v1/property-areas").set("x-csrf-token", owner.csrf).send({
      id: "area-hidden", propertyId: "property-hidden", name: "Hidden well", kind: "well",
      polygon: [
        { latitude: 61, longitude: 25 }, { latitude: 61.001, longitude: 25 }, { latitude: 61, longitude: 25.001 },
      ],
    }).expect(201);
    await owner.agent.post("/api/v1/maintenance-tasks").set("x-csrf-token", owner.csrf).send({
      id: "task-compound", propertyId: "property-hidden", houseId: "house-hidden", areaId: "area-hidden",
      title: "Compound task", basis: "required",
    }).expect(201);
    await owner.agent.put("/api/v1/properties/property-hidden/electricity/config")
      .set("x-csrf-token", owner.csrf)
      .send({
        provider: "custom",
        endpointUrl: "https://prices.example.test/feed.json?apiKey=owner-only-secret&site=hidden",
        enabled: true,
        marginCentsPerKwh: 0.5,
        contractType: "spot",
        contractName: null,
        retailer: null,
        monthlyFeeEur: null,
      })
      .expect(200);
    const priceNow = Date.now();
    const priceStartAt = new Date(priceNow - 60_000).toISOString();
    const priceEndAt = new Date(priceNow + 15 * 60_000).toISOString();
    const priceFetchedAt = new Date(priceNow - 30_000).toISOString();
    runtime.database.storePropertyElectricityPrices("property-hidden", [{
      startAt: priceStartAt,
      endAt: priceEndAt,
      rawPriceCentsPerKwh: 5,
    }], priceFetchedAt);
    await owner.agent.get("/api/v1/properties/property-hidden/electricity").expect(200)
      .expect(({ body }) => expect(body.config.endpointUrl).toContain("owner-only-secret"));
    const expectedHomePrice = {
      startAt: priceStartAt,
      endAt: priceEndAt,
      effectivePriceCentsPerKwh: 5.5,
      effectivePriceEurPerKwh: 0.055,
      fetchedAt: priceFetchedAt,
    };
    await owner.agent.get("/api/v1/houses/house-hidden/electricity-price").expect(200, {
      current: expectedHomePrice,
    });

    const invitation = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "guest@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: "house-hidden" }],
    }).expect(201);
    const token = invitation.body.registrationToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.body.activationPath).toBe(`/#invite=${encodeURIComponent(token)}`);
    expect(JSON.stringify(runtime.database.db.prepare(
      "SELECT token_hash FROM local_workspace_invitations WHERE email = ?",
    ).get("guest@example.test"))).not.toContain(token);

    const guestAgent = request.agent(runtime.app);
    const registration = await guestAgent.post("/api/v1/auth/register").send({
      token, password: "guest password long enough",
    }).expect(201);
    expect(registration.body).toMatchObject({ readOnly: true, tenant: { role: "guest" } });
    await request(runtime.app).post("/api/v1/auth/register").send({ token, password: "another password long enough" }).expect(404);

    const houses = await guestAgent.get("/api/v1/houses").expect(200);
    expect(houses.body.houses.map((house: { id: string }) => house.id)).toEqual(["house-hidden"]);
    await guestAgent.get("/api/v1/houses/house-main").expect(404);
    await guestAgent.get("/api/v1/houses/house-main/electricity-price").expect(404);
    await guestAgent.get("/api/v1/houses/house-hidden/electricity-price").expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ current: expectedHomePrice });
        expect(JSON.stringify(body)).not.toMatch(/endpoint|contract|provider|rawPrice|propertyId|owner-only-secret/i);
      });
    const properties = await guestAgent.get("/api/v1/properties").expect(200);
    expect(properties.headers["cache-control"]).toBe("private, no-store");
    expect(properties.body.properties).toEqual([
      expect.objectContaining({ id: "property-hidden", description: null, location: null }),
    ]);
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound").expect(404);
    await guestAgent.post("/api/v1/properties").set("x-csrf-token", registration.body.csrfToken).send({ name: "Denied" }).expect(403);
    await guestAgent.get("/api/v1/tenant/members").expect(403);

    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [{ scopeType: "area", scopeId: "area-hidden" }],
    }).expect(200);
    await guestAgent.get("/api/v1/houses/house-hidden/electricity-price").expect(404);
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [
        { scopeType: "house", scopeId: "house-hidden" },
        { scopeType: "area", scopeId: "area-hidden" },
      ],
    }).expect(200);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound").expect(200);
    await guestAgent.get("/api/v1/houses/house-hidden/electricity-price").expect(200, { current: expectedHomePrice });
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound/revisions").expect(403);

    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [{ scopeType: "property", scopeId: "property-hidden" }],
    }).expect(200);
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(200)
      .expect(({ body }) => {
        expect(body.config.endpointUrl).toBe("https://prices.example.test/feed.json");
        expect(JSON.stringify(body)).not.toContain("owner-only-secret");
      });
    await owner.agent.get("/api/v1/properties/property-hidden/electricity").expect(200)
      .expect(({ body }) => expect(body.config.endpointUrl).toContain("owner-only-secret"));
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound").expect(200);

    await guestAgent.post("/api/v1/auth/logout").set("x-csrf-token", registration.body.csrfToken).expect(204);
    await guestAgent.get("/api/v1/session").expect(401);
  });

  it("limits Admin account management to Guest accounts and invitations", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    const adminInvitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "admin@example.test", role: "admin", grants: [] })
      .expect(201);
    const adminAgent = request.agent(runtime.app);
    const adminRegistration = await adminAgent.post("/api/v1/auth/register").send({
      token: adminInvitation.body.registrationToken,
      password: "admin password long enough",
    }).expect(201);
    const adminCsrf = adminRegistration.body.csrfToken as string;
    await adminAgent.get("/api/v1/properties/property-main/electricity").expect(200);

    const memberInvitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "member@example.test", role: "member", grants: [] })
      .expect(201);
    await adminAgent.post("/api/v1/tenant/members").set("x-csrf-token", adminCsrf).send({
      email: "member@example.test",
      role: "guest",
      grants: [{ scopeType: "property", scopeId: "property-main" }],
    }).expect(403, {
      error: { code: "FORBIDDEN", message: "Admins can invite and manage Guest accounts only" },
    });
    await request(runtime.app).post("/api/v1/auth/register").send({
      token: memberInvitation.body.registrationToken,
      password: "member password long enough",
    }).expect(201).expect(({ body }) => expect(body.tenant.role).toBe("member"));

    await adminAgent.post("/api/v1/tenant/members").set("x-csrf-token", adminCsrf).send({
      email: "peer-admin@example.test", role: "admin", grants: [],
    }).expect(403, {
      error: { code: "FORBIDDEN", message: "Admins can invite and manage Guest accounts only" },
    });
    await adminAgent.delete("/api/v1/tenant/members/member%40example.test")
      .set("x-csrf-token", adminCsrf)
      .expect(403, {
        error: { code: "FORBIDDEN", message: "Admins can remove Guest accounts and invitations only" },
      });

    await adminAgent.post("/api/v1/tenant/members").set("x-csrf-token", adminCsrf).send({
      email: "managed-guest@example.test",
      role: "guest",
      grants: [{ scopeType: "property", scopeId: "property-main" }],
    }).expect(201);
    await adminAgent.delete("/api/v1/tenant/members/managed-guest%40example.test")
      .set("x-csrf-token", adminCsrf)
      .expect(204);
  });

  it("cleans expired invitations and deleted grants, scans beyond 500 hidden rows, and limits subject churn", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    for (let index = 0; index < 501; index += 1) {
      runtime.database.createProperty({ id: `hidden-${String(index).padStart(3, "0")}`, name: `A hidden ${String(index).padStart(3, "0")}` });
    }
    runtime.database.createProperty({ id: "visible-after-500", name: "Z visible" });
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "paged@example.test", role: "guest", grants: [{ scopeType: "property", scopeId: "visible-after-500" }],
    }).expect(201);
    const pagedAgent = request.agent(runtime.app);
    await pagedAgent.post("/api/v1/auth/register").send({
      token: invite.body.registrationToken, password: "paged guest password long",
    }).expect(201);
    const page = await pagedAgent.get("/api/v1/properties?limit=1").expect(200);
    expect(page.body.properties.map((property: { id: string }) => property.id)).toEqual(["visible-after-500"]);

    const expired = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "expired@example.test", role: "guest", grants: [{ scopeType: "property", scopeId: "property-main" }],
    }).expect(201);
    runtime.database.db.prepare("UPDATE local_workspace_invitations SET expires_at = ? WHERE email = ?")
      .run("2000-01-01T00:00:00.000Z", "expired@example.test");
    await request(runtime.app).post("/api/v1/auth/register").send({
      token: expired.body.registrationToken, password: "expired password long enough",
    }).expect(404);
    expect(runtime.database.db.prepare("SELECT 1 FROM local_workspace_invitations WHERE email = ?").get("expired@example.test")).toBeUndefined();
    expect(runtime.database.db.prepare("SELECT 1 FROM local_guest_access_grants WHERE subject_key = ?").get("expired@example.test")).toBeUndefined();

    const areaInvite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "area@example.test", role: "guest", grants: [{ scopeType: "area", scopeId: "area-delete-me" }],
    });
    expect(areaInvite.status).toBe(422);
    runtime.database.createPropertyArea({
      id: "area-delete-me", propertyId: "property-main", name: "Delete me", kind: "other",
      polygon: [{ latitude: 60, longitude: 24 }, { latitude: 60.001, longitude: 24 }, { latitude: 60, longitude: 24.001 }],
    });
    await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "area@example.test", role: "guest", grants: [{ scopeType: "area", scopeId: "area-delete-me" }],
    }).expect(201);
    expect(runtime.database.deletePropertyArea("area-delete-me")).toBe(true);
    expect(runtime.database.db.prepare("SELECT 1 FROM local_guest_access_grants WHERE scope_id = ?").get("area-delete-me")).toBeUndefined();

    // Setup, successful registration, and the expired-token attempt consumed
    // three of this client's 60 aggregate authentication attempts.
    for (let index = 0; index < 57; index += 1) {
      await request(runtime.app).post("/api/v1/auth/login").send({
        email: `rotated-${index}@example.test`, password: "short",
      }).expect(400);
    }
    const limited = await request(runtime.app).post("/api/v1/auth/login").send({
      email: "yet-another@example.test", password: "short",
    }).expect(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
  });

  it("signals authorization changes across core, v2, and spatial SSE before clearing cached Guest data", async () => {
    const runtime = authRuntime(true);
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const ownerRow = runtime.database.db.prepare("SELECT id FROM local_auth_users WHERE email = ?")
      .get(OWNER.email) as { id: string };
    const groundTruth = await owner.agent.post("/api/v1/houses/house-main/layers/ground-truth")
      .set("x-csrf-token", owner.csrf)
      .set("x-user", "spoofed-client-actor")
      .send({ label: "Owner observation" })
      .expect(201);
    expect(groundTruth.body.groundTruth.createdBy).toBe(ownerRow.id);

    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "stream@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: "house-main" }],
    }).expect(201);
    const registration = await request(runtime.app).post("/api/v1/auth/register").send({
      token: invite.body.registrationToken, password: "stream guest password long",
    }).expect(201);
    const cookie = sessionCookie(registration);

    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const [coreStream, measurementStream, spatialStream] = await Promise.all([
        fetch(`${base}/api/v1/events`, { headers: { cookie } }),
        fetch(`${base}/api/v2/measurements/events`, { headers: { cookie } }),
        fetch(`${base}/api/v1/layers/events?scopeKind=house&scopeId=house-main`, { headers: { cookie } }),
      ]);
      expect([coreStream.status, measurementStream.status, spatialStream.status]).toEqual([200, 200, 200]);

      await owner.agent.put("/api/v1/tenant/members/stream%40example.test/access")
        .set("x-csrf-token", owner.csrf).send({ grants: [] }).expect(200);
      const now = new Date().toISOString();
      runtime.bus.publish({
        type: "reading",
        data: {
          sensorId: "sensor-01", timestamp: now, temperature: 20, humidity: 40,
          battery: null, source: "api", quality: "good",
        },
      });
      runtime.bus.publishMeasurement({
        sensorId: "sensor-01", metric: "temperature", timestamp: now, value: 20,
        canonicalUnit: "°C", source: "api", quality: "good",
      });
      runtime.spatialLayers!.notifier.publish({
        partition: runtime.spatialLayers!.host.partition,
        scope: { kind: "house", id: "house-main" }, snapshotIds: [], bucketAt: now, emittedAt: now,
      });
      for (const text of await Promise.all([
        streamTextToEnd(coreStream),
        streamTextToEnd(measurementStream),
        streamTextToEnd(spatialStream),
      ])) {
        expect(text).toContain("event: authorization");
        expect(text).toContain('"status":"changed"');
      }

      await owner.agent.put("/api/v1/tenant/members/stream%40example.test/access")
        .set("x-csrf-token", owner.csrf)
        .send({ grants: [{ scopeType: "house", scopeId: "house-main" }] }).expect(200);
      const expiredStream = await fetch(`${base}/api/v1/events`, { headers: { cookie } });
      expect(expiredStream.status).toBe(200);

      await owner.agent.delete("/api/v1/tenant/members/stream%40example.test")
        .set("x-csrf-token", owner.csrf).expect(204);
      runtime.bus.publish({
        type: "reading",
        data: {
          sensorId: "sensor-01", timestamp: new Date().toISOString(), temperature: 20, humidity: 40,
          battery: null, source: "api", quality: "good",
        },
      });
      const expiredText = await streamTextToEnd(expiredStream);
      expect(expiredText).toContain("event: authorization");
      expect(expiredText).toContain('"status":"expired"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds concurrent SSE connections per authenticated account", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const setup = await request(runtime.app).post("/api/v1/auth/setup").send(OWNER).expect(201);
    const cookie = sessionCookie(setup);
    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controllers: AbortController[] = [];
    const streams: globalThis.Response[] = [];
    try {
      const port = (server.address() as AddressInfo).port;
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const stream = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
          headers: { cookie }, signal: controller.signal,
        });
        expect(stream.status).toBe(200);
        streams.push(stream);
      }
      const limited = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { cookie } });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("5");
      expect(await limited.json()).toMatchObject({ error: { code: "EVENT_STREAM_LIMIT" } });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.allSettled(streams.map((stream) => stream.body?.cancel()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
