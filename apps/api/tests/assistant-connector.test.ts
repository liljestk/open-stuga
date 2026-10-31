import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRuntime } from "../src/app.js";
import { AssistantAuthorizationServer } from "../src/assistant-connector/authorization-server.js";
import { assistantForRedirectUri, redirectUriRegistered } from "../src/assistant-connector/redirect-policy.js";
import { AssistantConnectorStore } from "../src/assistant-connector/store.js";
import { ClimateDatabase } from "../src/db.js";
import { LocalAuthStore } from "../src/local-auth.js";
import { registerLocalMcpTransportRoute, type LocalMcpRuntimeController } from "../src/app/local-mcp-runtime-routes.js";
import { OWNER, authRuntime, setupOwner } from "./local-authTestSupport.js";

const HOST = "stugu.example.test";
const ORIGIN = `http://${HOST}`;
const RESOURCE = `${ORIGIN}/api/v1/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(32) + "-._~" + "b".repeat(20);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function authorizationQuery(clientId: string, overrides: Record<string, string | null> = {}): string {
  const values: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "stugu.read",
    resource: RESOURCE,
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== null) query.set(name, value);
  return query.toString();
}

describe("assistant redirect policy", () => {
  it("accepts only the assistants' own callbacks and this computer's loopback addresses", () => {
    expect(assistantForRedirectUri(CLAUDE_CALLBACK)).toBe("claude");
    expect(assistantForRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe("claude");
    expect(assistantForRedirectUri("https://chatgpt.com/connector/oauth/abc_123")).toBe("chatgpt");
    expect(assistantForRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe("chatgpt");
    expect(assistantForRedirectUri("http://localhost:33418/callback")).toBe("local");
    expect(assistantForRedirectUri("http://127.0.0.1:9000/oauth/callback")).toBe("local");
    for (const refused of [
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.attacker.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback?next=https://attacker.example",
      "https://chatgpt.com/connector/oauth/../../evil",
      "https://attacker.example/callback",
      "https://localhost/callback",
      "https://user:pass@claude.ai/api/mcp/auth_callback",
      "not a url",
    ]) expect(assistantForRedirectUri(refused), refused).toBeNull();
  });

  it("lets loopback clients choose their port at authorization time", () => {
    expect(redirectUriRegistered("http://127.0.0.1:51000/callback", ["http://127.0.0.1:3118/callback"])).toBe(true);
    expect(redirectUriRegistered("http://127.0.0.1:51000/other", ["http://127.0.0.1:3118/callback"])).toBe(false);
    expect(redirectUriRegistered("http://localhost:51000/callback", ["http://127.0.0.1:3118/callback"])).toBe(false);
    expect(redirectUriRegistered("https://claude.com/api/mcp/auth_callback", [CLAUDE_CALLBACK])).toBe(false);
  });
});

describe("assistant connector OAuth flow", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  async function connectedOwner() {
    runtime = authRuntime();
    const owner = await setupOwner(runtime);
    const registered = await request(runtime.app).post("/api/v1/oauth/register").set("host", HOST)
      .send({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude" })
      .expect(201);
    return { ...owner, clientId: registered.body.client_id as string, registration: registered.body as Record<string, unknown> };
  }

  async function approvedCode(owner: Awaited<ReturnType<typeof connectedOwner>>): Promise<string> {
    const decided = await owner.agent.post("/api/v1/assistant-connector/authorization").set("host", HOST)
      .set("x-csrf-token", owner.csrf)
      .send({ query: authorizationQuery(owner.clientId), decision: "approve" })
      .expect(200);
    const redirect = new URL(decided.body.redirectUrl as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    return redirect.searchParams.get("code")!;
  }

  function exchange(clientId: string, code: string) {
    return request(runtime!.app).post("/api/v1/oauth/token").set("host", HOST).type("form").send({
      grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK, resource: RESOURCE,
    });
  }

  it("publishes discovery metadata and challenges unauthenticated MCP requests", async () => {
    runtime = authRuntime();
    await setupOwner(runtime);
    const metadata = await request(runtime.app).get("/.well-known/oauth-authorization-server").set("host", HOST).expect(200);
    expect(metadata.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/connect/assistant`,
      token_endpoint: `${ORIGIN}/api/v1/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/v1/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["stugu.read"],
    });
    const resource = await request(runtime.app).get("/.well-known/oauth-protected-resource/api/v1/mcp").set("host", HOST).expect(200);
    expect(resource.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });

    const challenge = await request(runtime.app).post("/api/v1/mcp").set("host", HOST)
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 }).expect(401);
    expect(challenge.headers["www-authenticate"]).toBe(
      `Bearer realm="Stugu MCP", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp", scope="stugu.read"`,
    );
  });

  it("refuses registrations whose callbacks are not an assistant's own", async () => {
    runtime = authRuntime();
    const refused = await request(runtime.app).post("/api/v1/oauth/register").set("host", HOST)
      .send({ redirect_uris: ["https://attacker.example/callback"], client_name: "Claude" })
      .expect(400);
    expect(refused.body).toMatchObject({ error: "invalid_redirect_uri" });
    const mixed = await request(runtime.app).post("/api/v1/oauth/register").set("host", HOST)
      .send({ redirect_uris: [CLAUDE_CALLBACK, "https://chatgpt.com/connector_platform_oauth_redirect"] })
      .expect(400);
    expect(mixed.body).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("connects an approved assistant, rotates its refresh token, and disconnects it on reuse", async () => {
    const owner = await connectedOwner();
    expect(owner.registration).not.toHaveProperty("client_secret");

    const preview = await owner.agent.get(`/api/v1/assistant-connector/authorization?${authorizationQuery(owner.clientId)}`)
      .set("host", HOST).expect(200);
    expect(preview.body).toEqual({ assistant: "claude", clientName: "Claude", redirectOrigin: "https://claude.ai", scope: "stugu.read" });

    const code = await approvedCode(owner);
    const tokens = await exchange(owner.clientId, code).expect(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "stugu.read" });
    expect(tokens.body.access_token).toMatch(/^stugu_at_[A-Za-z0-9_-]{43}$/u);
    expect(tokens.headers["cache-control"]).toBe("no-store");
    expect((await exchange(owner.clientId, code).expect(400)).body).toMatchObject({ error: "invalid_grant" });

    const listed = await owner.agent.get("/api/v1/assistant-connector/connections").set("host", HOST).expect(200);
    expect(listed.body.connections).toEqual([expect.objectContaining({
      assistant: "claude", clientName: "Claude", approvedBy: OWNER.email, lastUsedAt: null,
    })]);

    const refresh = (refreshToken: string) => request(runtime!.app).post("/api/v1/oauth/token").set("host", HOST).type("form")
      .send({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: owner.clientId });
    const rotated = await refresh(tokens.body.refresh_token).expect(200);
    expect(rotated.body.refresh_token).not.toBe(tokens.body.refresh_token);
    expect((await refresh(tokens.body.refresh_token).expect(400)).body).toMatchObject({ error: "invalid_grant" });
    // Reuse of a spent refresh token disconnects the whole grant, including the newest tokens.
    expect((await refresh(rotated.body.refresh_token).expect(400)).body).toMatchObject({ error: "invalid_grant" });
    const after = await owner.agent.get("/api/v1/assistant-connector/connections").set("host", HOST).expect(200);
    expect(after.body.connections).toEqual([]);
  });

  it("binds codes to the PKCE verifier and the approving client", async () => {
    const owner = await connectedOwner();
    const code = await approvedCode(owner);
    const wrongVerifier = await request(runtime!.app).post("/api/v1/oauth/token").set("host", HOST).type("form").send({
      grant_type: "authorization_code", code, code_verifier: "c".repeat(43), client_id: owner.clientId,
    }).expect(400);
    expect(wrongVerifier.body).toMatchObject({ error: "invalid_grant" });
    const unknownClient = await request(runtime!.app).post("/api/v1/oauth/token").set("host", HOST).type("form").send({
      grant_type: "authorization_code", code: await approvedCode(owner), code_verifier: VERIFIER, client_id: "someone-else",
    }).expect(401);
    expect(unknownClient.body).toMatchObject({ error: "invalid_client" });
  });

  it("returns declined and invalid requests to the assistant, but never to an unregistered address", async () => {
    const owner = await connectedOwner();
    const declined = await owner.agent.post("/api/v1/assistant-connector/authorization").set("host", HOST)
      .set("x-csrf-token", owner.csrf)
      .send({ query: authorizationQuery(owner.clientId), decision: "deny" })
      .expect(200);
    const redirect = new URL(declined.body.redirectUrl as string);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.has("code")).toBe(false);

    const noPkce = authorizationQuery(owner.clientId, { code_challenge: null });
    const invalid = await owner.agent.get(`/api/v1/assistant-connector/authorization?${noPkce}`).set("host", HOST).expect(400);
    expect(invalid.body.error.code).toBe("ASSISTANT_AUTHORIZATION_INVALID");
    const returned = await owner.agent.post("/api/v1/assistant-connector/authorization").set("host", HOST)
      .set("x-csrf-token", owner.csrf)
      .send({ query: noPkce, decision: "approve" })
      .expect(200);
    expect(new URL(returned.body.redirectUrl as string).searchParams.get("error")).toBe("invalid_request");

    const elsewhere = authorizationQuery(owner.clientId, { redirect_uri: "https://claude.com/api/mcp/auth_callback" });
    const refused = await owner.agent.post("/api/v1/assistant-connector/authorization").set("host", HOST)
      .set("x-csrf-token", owner.csrf)
      .send({ query: elsewhere, decision: "approve" })
      .expect(400);
    expect(refused.body.error.code).toBe("ASSISTANT_CLIENT_UNKNOWN");
  });

  it("lets an Owner revoke a connection", async () => {
    const owner = await connectedOwner();
    await exchange(owner.clientId, await approvedCode(owner)).expect(200);
    const [connection] = (await owner.agent.get("/api/v1/assistant-connector/connections").set("host", HOST).expect(200)).body.connections;
    await owner.agent.delete(`/api/v1/assistant-connector/connections/${connection.id}`).set("host", HOST)
      .set("x-csrf-token", owner.csrf).expect(200, { connections: [] });
    await owner.agent.delete(`/api/v1/assistant-connector/connections/${connection.id}`).set("host", HOST)
      .set("x-csrf-token", owner.csrf).expect(404);
  });
});

describe("assistant bearer tokens on the MCP endpoint", () => {
  async function issuedAccessToken() {
    const database = new ClimateDatabase(":memory:", false);
    const owner = await new LocalAuthStore(database).createFirstOwner(OWNER.email, OWNER.password);
    const server = new AssistantAuthorizationServer(new AssistantConnectorStore(database));
    const client = server.register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_post" });
    const { redirectUrl } = server.decide({ query: authorizationQuery(client.client_id), decision: "approve", userId: owner.userId, origin: ORIGIN });
    const tokens = server.token({
      grant_type: "authorization_code",
      code: new URL(redirectUrl).searchParams.get("code")!,
      code_verifier: VERIFIER,
      client_id: client.client_id,
      client_secret: client.client_secret!,
    }, undefined);
    return { database, server, accessToken: tokens.access_token };
  }

  it("serves verified assistant tokens from the assistant profile and starts the server on demand", async () => {
    const { database, server, accessToken } = await issuedAccessToken();
    const runtime = {
      authorize: vi.fn(() => false),
      ensureRunning: vi.fn(async () => undefined),
      proxy: vi.fn(async (_request, response) => { response.json({ jsonrpc: "2.0", result: {}, id: 1 }); }),
    } as unknown as LocalMcpRuntimeController;
    const app = express();
    registerLocalMcpTransportRoute({ app, prefix: "/api/v1" }, runtime, {
      origin: () => ORIGIN,
      verifyAccessToken: (token, origin) => server.verifyAccessToken(token, origin),
    });
    try {
      await request(app).post("/api/v1/mcp").set("authorization", `Bearer ${accessToken}`).set("origin", "https://claude.ai")
        .send({ jsonrpc: "2.0", method: "initialize", id: 1 }).expect(200);
      expect(runtime.ensureRunning).toHaveBeenCalledOnce();
      expect(runtime.proxy).toHaveBeenCalledWith(expect.anything(), expect.anything(), "assistant");

      await request(app).post("/api/v1/mcp").set("authorization", `Bearer ${accessToken}`).set("origin", "https://attacker.example")
        .send({}).expect(403);
      const rejected = await request(app).post("/api/v1/mcp").set("authorization", "Bearer stugu_at_".padEnd(52, "x")).send({}).expect(401);
      expect(rejected.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(server.verifyAccessToken(accessToken, "https://other.example.test")).toBeNull();
      expect(server.connections()[0]?.lastUsedAt).not.toBeNull();
    } finally {
      database.close();
    }
  });
});
