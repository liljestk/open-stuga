import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, randomApiToken, requireApiScope, sha256Hex, stableTenantId } from "../src/auth.js";

afterEach(() => vi.unstubAllGlobals());

function accessEnvironment(teamDomain: string, audience: string): Env {
  return {
    ASSET_BUCKET: null as never,
    DB: null as never,
    ASSETS: null as never,
    AUTH_MODE: "access",
    DEV_USER_EMAIL: "",
    TEAM_DOMAIN: teamDomain,
    POLICY_AUD: audience,
    INGEST_MIN_INTERVAL_SECONDS: "600",
    RAW_RETENTION_DAYS: "30",
  } as unknown as Env;
}

describe("tenant identity", () => {
  it("normalizes email casing before deriving an opaque tenant id", async () => {
    await expect(stableTenantId("Owner@Example.com")).resolves.toBe(await stableTenantId("owner@example.com"));
  });

  it("hashes API credentials without retaining the bearer token", async () => {
    await expect(sha256Hex("stuga_test-secret")).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates high-entropy URL-safe tokens and enforces their declared scopes", () => {
    expect(randomApiToken()).toMatch(/^stuga_[A-Za-z0-9_-]{40,}$/);
    expect(() => requireApiScope({ kind: "api-token", tenantId: "tenant", label: "read", scopes: ["read"] }, "write"))
      .toThrow("write scope");
    expect(() => requireApiScope({ kind: "api-token", tenantId: "tenant", label: "all", scopes: ["*"] }, "write"))
      .not.toThrow();
  });

  it("rejects incomplete Access configuration before accepting identity headers", async () => {
    const request = new Request("https://worker.example/api/v1/session");
    await expect(authenticate(request, accessEnvironment("https://CHANGE-ME.cloudflareaccess.com", "CHANGE-ME")))
      .rejects.toMatchObject({ status: 503, code: "ACCESS_NOT_CONFIGURED" });

    await expect(authenticate(request, accessEnvironment("https://access.example.com", "policy-audience")))
      .rejects.toMatchObject({ status: 401, code: "ACCESS_REQUIRED" });
  });

  it("verifies an Access JWT against the configured issuer and audience", async () => {
    const issuer = "https://access-unit.example.com";
    const audience = "policy-audience";
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "unit-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ keys: [jwk] })));
    const token = await new SignJWT({ email: "Owner@Example.com" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("access-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const request = new Request("https://worker.example/api/v1/session", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });

    await expect(authenticate(request, accessEnvironment(issuer, audience)))
      .resolves.toEqual({ kind: "access", email: "owner@example.com", subject: "access-subject" });
  });
});
