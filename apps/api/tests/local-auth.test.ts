import { once } from "node:events";

import type { AddressInfo } from "node:net";

import { networkInterfaces } from "node:os";

import request from "supertest";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { OWNER, authRuntime, privateIpv4Address, sessionCookie, setupOwner, streamTextToEnd } from "./local-authTestSupport.js";

describe("local account authentication and authorization", () => {
  const runtimes: ApiRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("accepts accounts on a private local domain", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const localOwner = { email: "owner@stugu", password: OWNER.password };
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

  it("keeps a local invitation valid when Cloudflare synchronization is temporarily unavailable", async () => {
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        CLOUDFLARE_ACCESS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CLOUDFLARE_ACCESS_GROUP_ID: "123e4567-e89b-42d3-a456-426614174000",
        CLOUDFLARE_ACCESS_GROUP_NAME: "Stugu test members",
        CLOUDFLARE_ACCESS_STATIC_EMAILS: "cloudflare-owner@example.test",
        CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
      }),
      cloudflareAccessFetcher: vi.fn(async () => new Response(JSON.stringify({
        success: false,
        errors: [{ code: 10000 }],
      }), { status: 403 })) as unknown as typeof fetch,
      startBackground: false,
    });
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    const invitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "pending@example.test", role: "member", grants: [] })
      .expect(201);

    expect(invitation.body.cloudflareAccess).toMatchObject({ status: "pending" });
    expect(invitation.body.registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runtime.database.db.prepare(
      "SELECT email FROM local_workspace_invitations WHERE email = ?",
    ).get("pending@example.test")).toMatchObject({ email: "pending@example.test" });
  });

  it("keeps the Cloudflare operator identity while syncing invited accounts, not the local owner login", async () => {
    const group = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "Stugu test members",
      include: [{ email: { email: "cloudflare-owner@example.test" } }],
      exclude: [],
      require: [],
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const update = JSON.parse(String(init.body)) as Pick<typeof group, "include" | "exclude" | "require">;
        Object.assign(group, update);
      }
      return new Response(JSON.stringify({ success: true, result: group }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        CLOUDFLARE_ACCESS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CLOUDFLARE_ACCESS_GROUP_ID: group.id,
        CLOUDFLARE_ACCESS_GROUP_NAME: group.name,
        CLOUDFLARE_ACCESS_STATIC_EMAILS: "cloudflare-owner@example.test",
        CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
      }),
      cloudflareAccessFetcher: fetcher,
      startBackground: false,
    });
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "guest@example.test", role: "member", grants: [] })
      .expect(201)
      .expect(({ body }) => expect(body.cloudflareAccess).toMatchObject({ status: "synced" }));

    expect(group.include).toEqual([
      { email: { email: "cloudflare-owner@example.test" } },
      { email: { email: "guest@example.test" } },
    ]);
    expect(group.include).not.toContainEqual({ email: { email: OWNER.email } });
  });

  it("authenticates forwarded proxy metadata and rate-limits subjects independently of x-real-ip", async () => {
    const address = privateIpv4Address();
    expect(address, "A private IPv4 interface is required for the proxy-boundary test").not.toBeNull();
    const proxySecret = "proxy-secret-".padEnd(48, "x");
    const bootstrapSecret = "bootstrap-secret-".padEnd(48, "y");
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        LOCAL_AUTH_PROXY_BIND_ADDRESS: "0.0.0.0",
        LOCAL_AUTH_PROXY_SECRET: proxySecret,
        LOCAL_AUTH_BOOTSTRAP_SECRET: bootstrapSecret,
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
        headers: { "content-type": "application/json", "x-stugu-local-proxy": "compose-v1" },
        body: JSON.stringify(OWNER),
      });
      expect(rejected.status).toBe(403);

      const setup = await fetch(setupUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          "x-real-ip": "192.0.2.1",
          "x-stugu-local-proxy": proxySecret,
          "x-stugu-bootstrap-secret": bootstrapSecret,
          origin: `https://${address}:${port}`,
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
            "x-stugu-local-proxy": proxySecret,
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
          "x-stugu-local-proxy": proxySecret,
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
    await owner.agent.post("/api/v1/property-areas").set("x-csrf-token", owner.csrf).send({
      id: "area-owner-only", propertyId: "property-hidden", name: "Owner shed", kind: "building", polygon: [],
    }).expect(201);
    await owner.agent.post("/api/v1/area-equipment").set("x-csrf-token", owner.csrf).send({
      id: "equipment-visible", areaId: "area-hidden", name: "Well pump", kind: "pump",
    }).expect(201);
    await owner.agent.post("/api/v1/area-equipment").set("x-csrf-token", owner.csrf).send({
      id: "equipment-owner-only", areaId: "area-owner-only", name: "Private tool", kind: "tool",
    }).expect(201);
    const visibleAttachment = await owner.agent
      .post("/api/v1/area-equipment/equipment-visible/attachments")
      .set("x-csrf-token", owner.csrf)
      .send({
        kind: "photo",
        name: "Well pump.png",
        mimeType: "image/png",
        data: Buffer.from("visible-photo").toString("base64"),
      })
      .expect(201);
    const privateAttachment = await owner.agent
      .post("/api/v1/area-equipment/equipment-owner-only/attachments")
      .set("x-csrf-token", owner.csrf)
      .send({
        kind: "document",
        name: "Private manual.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("%PDF-private").toString("base64"),
      })
      .expect(201);
    const visibleLink = await owner.agent
      .post("/api/v1/area-equipment/equipment-visible/links")
      .set("x-csrf-token", owner.csrf)
      .send({ label: "Pump support", url: "https://example.test/pump" })
      .expect(201);
    await owner.agent
      .post("/api/v1/area-equipment/equipment-owner-only/links")
      .set("x-csrf-token", owner.csrf)
      .send({ label: "Private support", url: "https://example.test/private" })
      .expect(201);
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
    expect(invitation.body.activationPath).toBe(`/invite-bootstrap#invite=${encodeURIComponent(token)}`);
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
    await guestAgent.get(`/api/v1/houses/house-hidden/electricity-price?from=${encodeURIComponent(priceStartAt)}&to=${encodeURIComponent(priceEndAt)}`).expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ current: expectedHomePrice, prices: [expectedHomePrice] });
        expect(JSON.stringify(body)).not.toMatch(/endpoint|contract|provider|rawPrice|propertyId|owner-only-secret/i);
      });
    const properties = await guestAgent.get("/api/v1/properties").expect(200);
    expect(properties.headers["cache-control"]).toBe("private, no-store");
    expect(properties.body.properties).toEqual([
      expect.objectContaining({ id: "property-hidden", description: null, location: null }),
    ]);
    await guestAgent.get("/api/v1/properties/property-hidden/inventory").expect(200)
      .expect(({ body }) => {
        expect(body.inventory.areas).toEqual([]);
        expect(body.inventory.equipment).toEqual([]);
        expect(body.inventory.attachments).toEqual([]);
        expect(body.inventory.links).toEqual([]);
      });
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await guestAgent.get("/api/v1/properties/property-hidden/energy-optimization").expect(404);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound").expect(404);
    await guestAgent.post("/api/v1/properties").set("x-csrf-token", registration.body.csrfToken).send({ name: "Denied" }).expect(403);
    await guestAgent.get("/api/v1/tenant/members").expect(403);

    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [{ scopeType: "area", scopeId: "area-hidden" }],
    }).expect(200);
    await guestAgent.get("/api/v1/properties/property-hidden/inventory").expect(200)
      .expect(({ body }) => {
        expect(body.inventory.areas.map((area: { id: string }) => area.id)).toEqual(["area-hidden"]);
        expect(body.inventory.equipment.map((item: { id: string }) => item.id)).toEqual(["equipment-visible"]);
        expect(body.inventory.attachments.map((item: { id: string }) => item.id))
          .toEqual([visibleAttachment.body.attachment.id]);
        expect(body.inventory.links.map((item: { id: string }) => item.id))
          .toEqual([visibleLink.body.link.id]);
      });
    await guestAgent
      .get(`/api/v1/area-equipment/equipment-visible/attachments/${visibleAttachment.body.attachment.id}`)
      .expect(200);
    await guestAgent
      .get(`/api/v1/area-equipment/equipment-owner-only/attachments/${privateAttachment.body.attachment.id}`)
      .expect(404);
    await guestAgent
      .post("/api/v1/area-equipment/equipment-visible/links")
      .set("x-csrf-token", registration.body.csrfToken)
      .send({ label: "Denied", url: "https://example.test/denied" })
      .expect(403);
    await guestAgent.get("/api/v1/houses/house-hidden/electricity-price").expect(404);
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await guestAgent.get("/api/v1/properties/property-hidden/energy-optimization").expect(404);
    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [
        { scopeType: "house", scopeId: "house-hidden" },
        { scopeType: "area", scopeId: "area-hidden" },
      ],
    }).expect(200);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound").expect(200);
    await guestAgent.get("/api/v1/houses/house-hidden/electricity-price").expect(200, { current: expectedHomePrice });
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(404);
    await guestAgent.get("/api/v1/properties/property-hidden/energy-optimization").expect(404);
    await guestAgent.get("/api/v1/maintenance-tasks/task-compound/revisions").expect(403);

    await owner.agent.put("/api/v1/tenant/members/guest%40example.test/access").set("x-csrf-token", owner.csrf).send({
      grants: [{ scopeType: "property", scopeId: "property-hidden" }],
    }).expect(200);
    await guestAgent.get("/api/v1/properties/property-hidden/inventory").expect(200)
      .expect(({ body }) => {
        expect(body.inventory.areas).toHaveLength(2);
        expect(body.inventory.equipment).toHaveLength(2);
        expect(body.inventory.attachments).toHaveLength(2);
        expect(body.inventory.links).toHaveLength(2);
      });
    await guestAgent.get("/api/v1/properties/property-hidden/electricity").expect(200)
      .expect(({ body }) => {
        expect(body.config.endpointUrl).toBe("https://prices.example.test/feed.json");
        expect(JSON.stringify(body)).not.toContain("owner-only-secret");
      });
    await guestAgent.get("/api/v1/properties/property-hidden/energy-optimization").expect(200);
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

  it("restricts Tapo export canaries to Owner and Admin roles", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const payload = {
      sensorId: "sensor-living",
      metric: "temperature",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-01T01:00:00.000Z",
    };

    for (const role of ["member", "guest"] as const) {
      const email = `${role}-canary@example.test`;
      const invitation = await owner.agent.post("/api/v1/tenant/members")
        .set("x-csrf-token", owner.csrf)
        .send({
          email,
          role,
          grants: role === "guest" ? [{ scopeType: "property", scopeId: "property-main" }] : [],
        })
        .expect(201);
      const agent = request.agent(runtime.app);
      const registration = await agent.post("/api/v1/auth/register").send({
        token: invitation.body.registrationToken,
        password: `${role} canary password long enough`,
      }).expect(201);
      await agent.post("/api/v1/integrations/tp-link/history-export/canary")
        .set("x-csrf-token", registration.body.csrfToken)
        .send(payload)
        .expect(403);
    }
  });

  it("restricts connected-device placement and control to Owner and Admin roles", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const invitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "device-member@example.test", role: "member", grants: [] })
      .expect(201);
    const member = request.agent(runtime.app);
    const registration = await member.post("/api/v1/auth/register").send({
      token: invitation.body.registrationToken,
      password: "member password long enough",
    }).expect(201);
    const csrf = registration.body.csrfToken as string;

    await member.patch("/api/v1/connected-devices/missing/placement")
      .set("x-csrf-token", csrf)
      .send({ floorId: null, roomId: null, x: null, y: null, z: null })
      .expect(403);
    await member.post("/api/v1/connected-devices/missing/commands")
      .set("x-csrf-token", csrf)
      .send({ operationId: "11111111-1111-4111-8111-111111111111", power: false })
      .expect(403);
  });
});
