import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

function environment(rateLimitSuccess = true): Env {
  return {
    BUG_REPORT_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: rateLimitSuccess })),
    },
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_OWNER: "replace-with-owner",
    GITHUB_REPOSITORY: "replace-with-private-repository",
    GITHUB_LABEL: "bug",
    RELAY_AUTH_TOKEN: "r".repeat(32),
    GITHUB_APP_ID: "123456",
    GITHUB_INSTALLATION_ID: "654321",
    GITHUB_PRIVATE_KEY: PRIVATE_KEY,
  };
}

function report() {
  const now = new Date().toISOString();
  return {
    description: "The card is blank @octocat <script>alert(1)</script>",
    reportId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    submittedAt: now,
    serverVersion: "0.27.1",
    diagnostics: {
      appVersion: "0.27.1",
      page: "dashboard",
      route: "/properties/:propertyId/homes/:homeId",
      occurredAt: now,
      locale: "en",
      userAgent: "test browser",
      recentErrors: [],
    },
  };
}

function request(body: string, token = "r".repeat(32), headers: HeadersInit = {}): Request {
  return new Request("https://relay.example.test/reports", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("bug report relay", () => {
  it("rejects unauthenticated requests before calling GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await handleRequest(request(JSON.stringify(report()), "wrong-token"), environment(), fetcher);
    expect(result.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized requests before reading their body", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await handleRequest(
      request("{}", "r".repeat(32), { "content-length": String(33 * 1_024) }),
      environment(),
      fetcher,
    );
    expect(result.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies the native rate limiter before creating a GitHub token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await handleRequest(request(JSON.stringify(report())), environment(false), fetcher);
    expect(result.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("mints a repository-scoped token and creates a safely formatted private issue", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      if (String(input).includes("/access_tokens")) {
        return Response.json({ token: "installation-token-value-long-enough" }, { status: 201 });
      }
      return Response.json({ number: 42 }, { status: 201 });
    });

    const result = await handleRequest(request(JSON.stringify(report())), environment(), fetcher);

    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ reportId: report().reportId });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain("/app/installations/654321/access_tokens");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      repositories: ["replace-with-private-repository"],
      permissions: { issues: "write" },
    });
    const issue = JSON.parse(requests[1]!.body) as { title: string; body: string; labels: string[] };
    expect(requests[1]!.url).toContain("/repos/replace-with-owner/replace-with-private-repository/issues");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.title).not.toContain("@octocat");
    expect(issue.body).not.toContain("<script>");
    expect(issue.body).not.toContain("@octocat");
    expect(issue.body).toContain(report().reportId);
  });
});
