import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { OWNER, setupOwner } from "./local-authTestSupport.js";

const RELAY_TOKEN = "r".repeat(32);

function reportBody() {
  return {
    description: "The temperature card stays blank.",
    diagnostics: {
      appVersion: "0.27.1",
      page: "dashboard",
      route: "/properties/:propertyId/homes/:homeId",
      occurredAt: "2026-08-01T10:00:00.000Z",
      locale: "en",
      userAgent: "test browser",
      recentErrors: [],
    },
  };
}

describe("bug report routes", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("forwards a bounded report through the configured relay without exposing GitHub", async () => {
    const relay = vi.fn(async () => new Response(JSON.stringify({ reportId: "accepted" }), { status: 201 }));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BUG_REPORT_RELAY_URL: "https://reports.example.test/reports",
        BUG_REPORT_RELAY_TOKEN: RELAY_TOKEN,
      }),
      bugReportFetcher: relay,
      startBackground: false,
    });
    const owner = await setupOwner(runtime);

    const response = await owner.agent.post("/api/v1/bug-reports")
      .set("x-csrf-token", owner.csrf)
      .send({ ...reportBody(), contactEmail: OWNER.email })
      .expect(201);

    expect(response.body).toEqual({
      reportId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      submittedAt: expect.any(String),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(relay).toHaveBeenCalledOnce();
    const [url, init] = relay.mock.calls[0]!;
    expect(url).toBe("https://reports.example.test/reports");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${RELAY_TOKEN}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      description: reportBody().description,
      contactEmail: OWNER.email,
      serverVersion: "0.28.0",
    });
    expect(response.body).not.toHaveProperty("issueUrl");
  });

  it("allows the guest self-service report only with CSRF and keeps other guest writes read-only", async () => {
    const relay = vi.fn(async () => new Response(null, { status: 201 }));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BUG_REPORT_RELAY_URL: "https://reports.example.test/reports",
        BUG_REPORT_RELAY_TOKEN: RELAY_TOKEN,
      }),
      bugReportFetcher: relay,
      startBackground: false,
    });
    const owner = await setupOwner(runtime);
    const email = "guest@example.test";
    const invitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({
        email,
        role: "guest",
        grants: [{ scopeType: "property", scopeId: "property-main" }],
      })
      .expect(201);
    const guest = request.agent(runtime.app);
    const registration = await guest.post("/api/v1/auth/register")
      .send({
        token: invitation.body.registrationToken,
        password: "guest password long enough",
      })
      .expect(201);
    const csrf = registration.body.csrfToken as string;

    const missingCsrf = await guest.post("/api/v1/bug-reports")
      .send(reportBody())
      .expect(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");
    expect(relay).not.toHaveBeenCalled();

    await guest.post("/api/v1/bug-reports")
      .set("x-csrf-token", csrf)
      .send({ ...reportBody(), contactEmail: email })
      .expect(201);
    expect(JSON.parse(String(relay.mock.calls[0]![1]?.body))).toMatchObject({ contactEmail: email });

    const deniedMutation = await guest.post("/api/v1/properties")
      .set("x-csrf-token", csrf)
      .send({ name: "Still denied" })
      .expect(403);
    expect(deniedMutation.body.error.code).toBe("GUEST_READ_ONLY");

    await guest.post("/api/v1/bug-reports").set("x-csrf-token", csrf).send(reportBody()).expect(201);
    await guest.post("/api/v1/bug-reports").set("x-csrf-token", csrf).send(reportBody()).expect(201);
    const rateLimited = await guest.post("/api/v1/bug-reports")
      .set("x-csrf-token", csrf)
      .send(reportBody())
      .expect(429);
    expect(rateLimited.body.error.code).toBe("BUG_REPORT_RATE_LIMITED");
    expect(rateLimited.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(relay).toHaveBeenCalledTimes(3);
  });

  it("only permits contact consent for the signed-in account", async () => {
    const relay = vi.fn(async () => new Response(null, { status: 201 }));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BUG_REPORT_RELAY_URL: "https://reports.example.test/reports",
        BUG_REPORT_RELAY_TOKEN: RELAY_TOKEN,
      }),
      bugReportFetcher: relay,
      startBackground: false,
    });
    const owner = await setupOwner(runtime);

    await owner.agent.post("/api/v1/bug-reports")
      .set("x-csrf-token", owner.csrf)
      .send({ ...reportBody(), contactEmail: "someone-else@example.test" })
      .expect(403);
    expect(relay).not.toHaveBeenCalled();
  });

  it("fails closed when the relay is not configured", async () => {
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
      }),
      startBackground: false,
    });
    const owner = await setupOwner(runtime);

    const response = await owner.agent.post("/api/v1/bug-reports")
      .set("x-csrf-token", owner.csrf)
      .send(reportBody())
      .expect(503);
    expect(response.body.error.code).toBe("BUG_REPORTING_UNAVAILABLE");
  });
});
