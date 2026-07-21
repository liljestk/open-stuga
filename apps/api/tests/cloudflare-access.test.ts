import { describe, expect, it, vi } from "vitest";
import {
  CloudflareAccessGroupSynchronizer,
  CloudflareAccessSyncError,
  type CloudflareAccessGroupConfig,
} from "../src/cloudflare-access.js";

const config: CloudflareAccessGroupConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  groupId: "123e4567-e89b-42d3-a456-426614174000",
  groupName: "Stuga (stuga.example.test) members",
  apiToken: "runtime-token-that-is-long-enough-for-tests",
  syncIntervalMs: 60_000,
};

function cloudflareResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Cloudflare Access group synchronization", () => {
  it("replaces only the managed exact-email rules and skips unchanged writes", async () => {
    let group = {
      id: config.groupId,
      name: config.groupName,
      include: [{ email: { email: "owner@example.test" } }],
      exclude: [],
      require: [],
    };
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.apiToken}`);
      if (init?.method === "PUT") {
        const update = JSON.parse(String(init.body)) as typeof group;
        group = { ...group, ...update };
      }
      return cloudflareResponse(group);
    }) as unknown as typeof fetch;
    const emails = ["Guest@Example.test", "owner@example.test", "guest@example.test"];
    const synchronizer = new CloudflareAccessGroupSynchronizer(config, () => emails, fetchImpl);

    await expect(synchronizer.synchronize()).resolves.toMatchObject({ status: "synced" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(group.include).toEqual([
      { email: { email: "guest@example.test" } },
      { email: { email: "owner@example.test" } },
    ]);

    await synchronizer.synchronize();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not erase the bootstrap allowlist before the first local owner exists", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const synchronizer = new CloudflareAccessGroupSynchronizer(config, () => null, fetchImpl);

    await expect(synchronizer.synchronize()).resolves.toEqual({
      status: "pending",
      lastSyncedAt: null,
      lastFailureAt: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed instead of overwriting a group that contains unmanaged rules", async () => {
    const fetchImpl = vi.fn(async () => cloudflareResponse({
      id: config.groupId,
      name: config.groupName,
      include: [{ email_domain: { domain: "example.test" } }],
      exclude: [],
      require: [],
    })) as unknown as typeof fetch;
    const synchronizer = new CloudflareAccessGroupSynchronizer(
      config,
      () => ["owner@example.test"],
      fetchImpl,
    );

    await expect(synchronizer.synchronize()).rejects.toMatchObject<Partial<CloudflareAccessSyncError>>({
      code: "UNMANAGED_GROUP_RULES",
    });
    expect(synchronizer.status()).toMatchObject({ status: "pending", lastSyncedAt: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
