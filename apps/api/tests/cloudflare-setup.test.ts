import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareSetupError,
  CloudflareSetupService,
} from "../src/cloudflare-setup.js";

const accountId = "0123456789abcdef0123456789abcdef";
const zoneId = "abcdef0123456789abcdef0123456789";
const runtimeToken = "runtime-access-group-token-that-is-long-enough";
const registrationToken = "oauth-client-write-token-that-is-long-enough";
const provisionToken = "temporary-oauth-provision-token-that-is-long-enough";
const clientId = "stugu-private-oauth-client";

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("UI-managed Cloudflare setup", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(): { operations: string; deployment: string } {
    const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-setup-"));
    directories.push(directory);
    const operations = join(directory, "operations");
    const deployment = join(directory, "deployment.json");
    mkdirSync(operations);
    return { operations, deployment };
  }

  function heartbeat(operations: string): void {
    writeFileSync(join(operations, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "docker",
      agentVersion: "1.1.0",
      capabilities: ["system-update", "cloudflare-setup"],
      ready: true,
      updatedAt: "2026-07-24T08:00:00.000Z",
    }));
  }

  it("marks an approval interrupted by an API restart as failed", () => {
    const { operations, deployment } = fixture();
    writeFileSync(join(operations, "cloudflare-status.json"), JSON.stringify({
      id: "2fc58aab-24fb-4aa3-894a-2a0811497d76",
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      phase: "awaiting-approval",
      requestedAt: "2026-07-24T08:00:00.000Z",
      completedAt: null,
      detail: "Waiting for approval in Cloudflare",
    }));
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      now: () => new Date("2026-07-24T08:01:00.000Z"),
    });

    expect(service.status().operation).toMatchObject({
      phase: "failed",
      completedAt: "2026-07-24T08:01:00.000Z",
      detail: "Cloudflare approval was interrupted by a Stugu restart. Start again from Stugu.",
    });
  });

  it("registers a private client, queues no provider tokens, and exposes the grant once", async () => {
    const { operations, deployment } = fixture();
    writeFileSync(deployment, JSON.stringify({
      version: 2,
      mode: "remote-ui",
      hostname: "stugu.example.com",
      accountId,
      zoneId,
    }));
    const now = new Date("2026-07-24T08:00:00.000Z");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${accountId}/oauth_clients`)) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${registrationToken}`);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback"],
        });
        return response({ client_id: clientId });
      }
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        expect(String(init?.body)).not.toContain(registrationToken);
        expect(String(init?.body)).not.toContain(runtimeToken);
        return new Response(JSON.stringify({
          access_token: provisionToken,
          token_type: "bearer",
          scope: "access.write argotunnel.write dns.write",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      runtimeToken,
      ownerEmail: "owner@example.com",
      fetchImpl,
      now: () => now,
    });
    heartbeat(operations);

    const started = await service.start({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      oauthClientToken: registrationToken,
    }, "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback");
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe("https://dash.cloudflare.com");
    expect(authorization.searchParams.get("scope")).toBe("access.write argotunnel.write dns.write");
    expect(started.authorizationUrl).not.toContain(registrationToken);
    expect(started.authorizationUrl).not.toContain(runtimeToken);

    const completed = await service.completeOAuth(new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "cloudflare-authorization-code",
    }));
    expect(completed.phase).toBe("queued");
    const requestName = readdirSync(operations).find((name) => name.startsWith("cloudflare-request-"));
    expect(requestName).toBeTruthy();
    const requestText = readFileSync(join(operations, requestName!), "utf8");
    expect(requestText).not.toContain(registrationToken);
    expect(requestText).not.toContain(runtimeToken);
    expect(requestText).not.toContain(provisionToken);
    const request = JSON.parse(requestText) as { claimSecret: string };

    expect(service.claim(started.operation.id, request.claimSecret)).toEqual({
      schema: "stugu-cloudflare-setup-claim/v1",
      provisionToken,
      accessToken: runtimeToken,
      oauthClientId: clientId,
    });
    expect(service.claim(started.operation.id, request.claimSecret)).toBeNull();
    await service.stop();
  });

  it("requires the capable host agent before accepting any bootstrap credential", async () => {
    const { operations, deployment } = fixture();
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    await expect(service.start({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      accountId,
      zoneId,
      oauthClientToken: registrationToken,
      runtimeToken,
    }, "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback")).rejects.toMatchObject<CloudflareSetupError>({
      code: "CLOUDFLARE_SETUP_AGENT_UNAVAILABLE",
      status: 503,
    });
    expect(service.status().capability.reason).toBe("agent-not-connected");
  });

  it("serializes client registration so two starts cannot create competing operations", async () => {
    const { operations, deployment } = fixture();
    let finishRegistration!: (value: Response) => void;
    const registration = new Promise<Response>((resolve) => {
      finishRegistration = resolve;
    });
    const fetchImpl = vi.fn(() => registration) as unknown as typeof fetch;
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      fetchImpl,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });
    heartbeat(operations);
    const input = {
      mode: "stuguby-coordinator" as const,
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      accountId,
      zoneId,
      oauthClientToken: registrationToken,
      runtimeToken,
    };
    const redirect = "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback";

    const first = service.start(input, redirect);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await expect(service.start(input, redirect)).rejects.toMatchObject<CloudflareSetupError>({
      code: "CLOUDFLARE_SETUP_IN_PROGRESS",
      status: 409,
    });
    finishRegistration(response({ client_id: clientId }));
    await expect(first).resolves.toMatchObject({
      operation: { phase: "awaiting-approval" },
    });
    await service.stop();
  });

  it("reopens the same live approval instead of rejecting a repeated start", async () => {
    const { operations, deployment } = fixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${accountId}/oauth_clients`)) return response({ client_id: clientId });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      fetchImpl,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });
    heartbeat(operations);
    const input = {
      mode: "stuguby-coordinator" as const,
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      accountId,
      zoneId,
      oauthClientToken: registrationToken,
      runtimeToken,
    };
    const redirect = "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback";

    const first = await service.start(input, redirect);
    const repeated = await service.start(input, redirect);

    expect(repeated).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("adds Zone Read only when the zone ID must be discovered", async () => {
    const { operations, deployment } = fixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${accountId}/oauth_clients`)) return response({ client_id: clientId });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      fetchImpl,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });
    heartbeat(operations);

    const started = await service.start({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      accountId,
      oauthClientToken: registrationToken,
      runtimeToken,
    }, "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback");

    expect(new URL(started.authorizationUrl).searchParams.get("scope"))
      .toBe("access.write argotunnel.write dns.write zone.read");
    await service.stop();
  });

  it("fails closed and revokes an OAuth grant missing a required scope", async () => {
    const { operations, deployment } = fixture();
    writeFileSync(deployment, JSON.stringify({
      version: 2,
      mode: "remote-ui",
      hostname: "stugu.example.com",
      accountId,
      zoneId,
      oauthClientId: clientId,
    }));
    let revoked = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        return new Response(JSON.stringify({
          access_token: provisionToken,
          token_type: "bearer",
          scope: "access.write argotunnel.write",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://dash.cloudflare.com/oauth2/revoke") {
        revoked += 1;
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new CloudflareSetupService({
      operationsDirectory: operations,
      deploymentFile: deployment,
      runtimeToken,
      fetchImpl,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });
    heartbeat(operations);

    const started = await service.start({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
    }, "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback");
    const authorization = new URL(started.authorizationUrl);
    const completed = await service.completeOAuth(new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "cloudflare-authorization-code",
    }));

    expect(completed.phase).toBe("failed");
    expect(completed.detail).toContain("omitted a required permission");
    expect(revoked).toBe(1);
    expect(readdirSync(operations).some((name) => name.startsWith("cloudflare-request-"))).toBe(false);
    await service.stop();
  });
});
