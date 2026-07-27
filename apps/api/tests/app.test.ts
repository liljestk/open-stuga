import { createServer, type Server } from "node:http";

import { generateKeyPairSync } from "node:crypto";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import type { TelemetryEvent } from "@climate-twin/contracts";

import { loadConfig, type AppConfig } from "../src/config.js";

import { createApi, type ApiRuntime } from "../src/app.js";

import { config } from "./appTestSupport.js";

describe("Climate Twin API v1", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("binds to loopback by default and honors an explicit API host", () => {
    const defaults = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    expect(defaults.apiHost).toBe("127.0.0.1");
    expect(defaults.tpLinkPollIntervalMs).toBe(2_000);
    expect(loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", API_HOST: "0.0.0.0" }).apiHost).toBe("0.0.0.0");
    expect(loadConfig({ NODE_ENV: "production", DATABASE_PATH: ":memory:" }).mockEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: "production", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }).mockEnabled).toBe(false);
  });

  it("keeps Stuguby inert but available and validates its node configuration", async () => {
    const defaults = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    expect(defaults).toMatchObject({
      stugubyIdentityFile: null,
      stugubyNodeName: "Stugu",
      stugubySyncIntervalMs: 15_000,
      stugubyPublicOrigin: null,
    });
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: "./data/test.sqlite",
      STUGBY_IDENTITY_FILE: "./data/test-stuguby.json", STUGBY_NODE_NAME: "Shore household",
      STUGBY_SYNC_INTERVAL_MS: "2000", STUGBY_PUBLIC_ORIGIN: "https://stuguby.example.test",
    })).toMatchObject({
      stugubyNodeName: "Shore household",
      stugubySyncIntervalMs: 2_000,
      stugubyPublicOrigin: "https://stuguby.example.test",
    });
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", CORS_ORIGIN: "https://stugu.example.test",
    })).toMatchObject({
      stugubyPublicOrigin: null,
      stugubySuggestedPublicOrigin: "https://stugu.example.test",
      stugubyCoordinatorProvisioningRequired: false,
    });
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:",
      CORS_ORIGIN: "https://browser.example.test",
      STUGBY_PUBLIC_ORIGIN: "https://coordinator.example.test",
    }).stugubyPublicOrigin).toBe("https://coordinator.example.test");
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", CORS_ORIGIN: "http://lan.example.test",
    }).stugubySuggestedPublicOrigin).toBeNull();
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", STUGBY_SYNC_INTERVAL_MS: "1999" })).toThrow(/STUGBY_SYNC_INTERVAL_MS/);
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", STUGBY_NODE_NAME: "x".repeat(201) })).toThrow(/STUGBY_NODE_NAME/);
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", STUGBY_PUBLIC_ORIGIN: "http://stuguby.example.test",
    })).toThrow(/must use HTTPS/);
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", STUGBY_PUBLIC_ORIGIN: "https://stuguby.example.test/path",
    })).toThrow(/must be an origin/);
    const available = await request(runtime.app).get("/api/v1/stugbys").expect(200);
    expect(available.body.stugubys).toEqual([]);
    expect(available.body.identity.nodeId).toBeTruthy();
  });

  it("rejects a required time-series archive that is disabled", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      TIMESERIES_ENABLED: "false",
      TIMESERIES_REQUIRED: "true",
    })).toThrow("TIMESERIES_REQUIRED=true requires TIMESERIES_ENABLED=true");

    const disabled = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    expect(() => createApi({
      config: { ...disabled, timeseriesEnabled: false, timeseriesRequired: true },
      startBackground: false,
    })).toThrow("timeseriesRequired=true requires timeseriesEnabled=true");
  });

  it("enables bounded SQLite hot retention only with a durable archive", () => {
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", RETENTION_DAYS: "30",
    })).toThrow("RETENTION_DAYS requires TIMESERIES_ENABLED=true");
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", RETENTION_DAYS: "7", TIMESERIES_ENABLED: "true",
    })).toThrow("RETENTION_DAYS must be 0 or at least 30");
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", RETENTION_DAYS: "30", TIMESERIES_ENABLED: "true",
    }).retentionDays).toBe(30);
  });

  it("loads database credentials from a file and validates TLS modes", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-timeseries-config-"));
    const passwordPath = join(directory, "password");
    const caPath = join(directory, "ca.pem");
    try {
      writeFileSync(passwordPath, "database-secret\n");
      writeFileSync(caPath, "test-ca-pem\n");
      expect(loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:",
        TIMESERIES_PASSWORD_FILE: passwordPath,
        TIMESERIES_SSL_MODE: "verify-full",
        TIMESERIES_SSL_CA_FILE: caPath,
      })).toMatchObject({
        timeseriesPassword: "database-secret",
        timeseriesSslMode: "verify-full",
        timeseriesSslCa: "test-ca-pem\n",
      });
      expect(() => loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:",
        TIMESERIES_PASSWORD: "inline", TIMESERIES_PASSWORD_FILE: passwordPath,
      })).toThrow("Configure only one");
      expect(() => loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", TIMESERIES_SSL_MODE: "insecure",
      })).toThrow("TIMESERIES_SSL_MODE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads only a complete, valid APNs provider credential tuple", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-apns-config-"));
    const keyPath = join(directory, "AuthKey_TEST.p8");
    try {
      const { privateKey } = generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      writeFileSync(
        keyPath,
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      expect(loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        APNS_TEAM_ID: "ABCDEFGHIJ",
        APNS_KEY_ID: "K123456789",
        APNS_BUNDLE_ID: "net.nysta.stuga",
        APNS_PRIVATE_KEY_FILE: keyPath,
      })).toMatchObject({
        apnsTeamId: "ABCDEFGHIJ",
        apnsKeyId: "K123456789",
        apnsBundleId: "net.nysta.stuga",
        apnsPrivateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
      });
      expect(() => loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        APNS_TEAM_ID: "ABCDEFGHIJ",
      })).toThrow(/requires APNS_TEAM_ID/u);
      writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n");
      expect(() => loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        APNS_TEAM_ID: "ABCDEFGHIJ",
        APNS_KEY_ID: "K123456789",
        APNS_BUNDLE_ID: "net.nysta.stuga",
        APNS_PRIVATE_KEY_FILE: keyPath,
      })).toThrow(/valid P-256 Apple \.p8/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates and reuses a high-entropy proxy credential file", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-proxy-secret-"));
    const path = join(directory, "proxy-secret");
    try {
      const first = loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", LOCAL_AUTH_PROXY_SECRET_FILE: path,
      });
      expect(first.localAuthProxySecret).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(path, "utf8").trim()).toBe(first.localAuthProxySecret);
      expect(loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", LOCAL_AUTH_PROXY_SECRET_FILE: path,
      }).localAuthProxySecret).toBe(first.localAuthProxySecret);
      expect(() => loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", LOCAL_AUTH_PROXY_SECRET: "too-short",
      })).toThrow(/at least 32/);
      expect(() => loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:",
        LOCAL_AUTH_PROXY_SECRET: "x".repeat(32), LOCAL_AUTH_PROXY_SECRET_FILE: path,
      })).toThrow(/only one/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads only complete, least-privilege Cloudflare Access synchronization settings", () => {
    const identity = {
      CLOUDFLARE_ACCESS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_ACCESS_GROUP_ID: "123e4567-e89b-42d3-a456-426614174000",
    };
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", ...identity }))
      .toThrow("Cloudflare Access synchronization requires");
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ...identity,
      CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
    })).toThrow("CLOUDFLARE_ACCESS_STATIC_EMAILS");
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ...identity,
      CLOUDFLARE_ACCESS_STATIC_EMAILS: "operator@example.test,bad,address@example.test",
      CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
    })).toThrow("valid comma-separated email addresses");
    expect(loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ...identity,
      CLOUDFLARE_ACCESS_GROUP_NAME: "Stugu test members",
      CLOUDFLARE_ACCESS_STATIC_EMAILS: " Owner@Example.test,owner@example.test ",
      CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
      CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS: "60000",
      CLOUDFLARE_ACCESS_PUBLIC_ORIGIN: "https://stugu.example.test",
    })).toMatchObject({
      cloudflareAccessAccountId: identity.CLOUDFLARE_ACCESS_ACCOUNT_ID,
      cloudflareAccessGroupId: identity.CLOUDFLARE_ACCESS_GROUP_ID,
      cloudflareAccessGroupName: "Stugu test members",
      cloudflareAccessStaticEmails: ["owner@example.test"],
      cloudflareAccessSyncIntervalMs: 60_000,
      corsOrigin: "https://stugu.example.test",
    });
    expect(loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      STUGA_CLOUDFLARE_OAUTH_CLIENT_ID: "stugu-private-client",
      STUGA_LOCAL_UI_PORT: "9090",
    })).toMatchObject({
      cloudflareSetupOAuthClientId: "stugu-private-client",
      cloudflareSetupLocalUiPort: 9_090,
    });
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      STUGA_CLOUDFLARE_OAUTH_CLIENT_ID: "bad id",
    })).toThrow("STUGA_CLOUDFLARE_OAUTH_CLIENT_ID");
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ...identity,
      CLOUDFLARE_ACCESS_STATIC_EMAILS: "owner@example.test",
      CLOUDFLARE_ACCESS_API_TOKEN: "runtime-token-that-is-long-enough-for-tests",
      CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS: "1000",
    })).toThrow("CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS");
  });

  it("exposes only redacted Cloudflare setup status and rejects setup without the host agent", async () => {
    const status = await request(runtime.app)
      .get("/api/v1/cloudflare/setup")
      .set("Host", "127.0.0.1:8080")
      .expect(200);
    expect(status.body).toMatchObject({
      canConfigure: true,
      localConfigureUrl: "http://127.0.0.1:8080/stugbys",
      capability: { available: false, reason: "not-configured" },
    });
    expect(JSON.stringify(status.body)).not.toContain("test-ingest-key");

    const start = await request(runtime.app)
      .post("/api/v1/cloudflare/setup/start")
      .set("Host", "127.0.0.1:8080")
      .send({
        mode: "stuguby-coordinator",
        hostname: "stugu.example.test",
        zone: "example.test",
        ownerEmail: "owner@example.test",
        accountId: "0123456789abcdef0123456789abcdef",
        zoneId: "abcdef0123456789abcdef0123456789",
        oauthClientToken: "oauth-client-write-token-that-is-long-enough",
        runtimeToken: "runtime-access-group-token-that-is-long-enough",
      })
      .expect(503);
    expect(start.body.error.code).toBe("CLOUDFLARE_SETUP_AGENT_UNAVAILABLE");
    expect(JSON.stringify(start.body)).not.toContain("oauth-client-write-token");
    expect(JSON.stringify(start.body)).not.toContain("runtime-access-group-token");
  });

  it("returns an accepted Cloudflare approval after the external operation starts even if local auditing fails", async () => {
    const operation = {
      id: "2fc58aab-24fb-4aa3-894a-2a0811497d76",
      mode: "stuguby-coordinator" as const,
      hostname: "stugu.example.test",
      phase: "awaiting-approval" as const,
      requestedAt: "2026-07-24T08:00:00.000Z",
      completedAt: null,
      detail: "Waiting for approval in Cloudflare",
    };
    vi.spyOn(runtime.cloudflareSetup, "start").mockResolvedValue({
      operation,
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=stugu-client",
    });
    vi.spyOn(runtime.database, "recordSecurityAuditEvent").mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const start = await request(runtime.app)
      .post("/api/v1/cloudflare/setup/start")
      .set("Host", "127.0.0.1:8080")
      .send({
        mode: "stuguby-coordinator",
        hostname: "stugu.example.test",
        zone: "example.test",
        ownerEmail: "owner@example.test",
      })
      .expect(202);

    expect(start.body).toEqual({
      operation,
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=stugu-client",
    });
  });

  it("keeps the starter inventory independent from mock telemetry", async () => {
    const cleanRuntime = createApi({
      config: { ...config, mockEnabled: false },
      startBackground: false,
    });
    try {
      expect(cleanRuntime.database.listHouses()).toMatchObject([{ id: "house-main", propertyId: "property-main" }]);
      expect(cleanRuntime.database.listProperties()).toMatchObject([{ name: "My property" }]);
    } finally {
      await cleanRuntime.close();
    }
  });

  it("does not cascade-delete real telemetry without immutable ownership lineage", async () => {
    const sensor = runtime.database.listSensors()[0]!;
    runtime.database.insertReadings([{
      sensorId: sensor.id,
      timestamp: "2026-07-18T09:00:00.000Z",
      temperature: 21,
      humidity: 45,
      battery: 90,
      source: "api",
      quality: "good",
    }]);

    await request(runtime.app).delete(`/api/v1/sensors/${sensor.id}`).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("TELEMETRY_LINEAGE_REQUIRED"));
    expect(runtime.database.getSensor(sensor.id)).not.toBeNull();
    expect(runtime.database.history([sensor.id], "2026-07-18T09:00:00.000Z", "2026-07-18T09:00:00.000Z"))
      .toHaveLength(1);
  });

  it("keeps the optional spatial engine local and separately configurable", () => {
    const testConfig = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    expect(testConfig).toMatchObject({
      spatialLayersEnabled: false,
      spatialLayersDatabasePath: ":memory:",
      spatialLayersIntervalMs: 60_000,
      spatialLayersRetentionDays: 30,
    });
    expect(loadConfig({
      NODE_ENV: "production",
      DATABASE_PATH: ":memory:",
      SPATIAL_LAYERS_ENABLED: "false",
      SPATIAL_LAYERS_INTERVAL_MS: "30000",
      SPATIAL_LAYERS_RETENTION_DAYS: "7",
    })).toMatchObject({
      spatialLayersEnabled: false,
      spatialLayersDatabasePath: ":memory:",
      spatialLayersIntervalMs: 30_000,
      spatialLayersRetentionDays: 7,
    });
  });

  it("treats Compose-style empty integration tuples as absent but rejects partial tuples", () => {
    const empty = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      HA_URL: " ",
      HA_TOKEN: "",
      TP_LINK_HOST: "",
      TP_LINK_USERNAME: " ",
      TP_LINK_PASSWORD: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
    });
    expect(empty).toMatchObject({
      haUrl: null,
      haToken: null,
      tpLinkHost: null,
      tpLinkUsername: null,
      tpLinkPassword: null,
      telegramBotToken: null,
      telegramChatId: null,
    });
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      TELEGRAM_BOT_TOKEN: "configured",
      TELEGRAM_CHAT_ID: "",
    })).toThrow(/requires TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
  });

  it("validates outbound webhook URLs and does not accept orphan credentials", () => {
    expect(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", ALERT_WEBHOOK_URL: "http://127.0.0.1:9000/hooks/",
    }).alertWebhookUrl).toBe("http://127.0.0.1:9000/hooks");
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", ALERT_WEBHOOK_URL: "file:///tmp/hook",
    })).toThrow(/valid HTTP\(S\) URL|must be an HTTP\(S\) URL/);
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", ALERT_WEBHOOK_URL: "https://user:secret@example.test/hook",
    })).toThrow(/without embedded credentials/);
    expect(() => loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", ALERT_WEBHOOK_BEARER_TOKEN: "secret",
    })).toThrow(/requires ALERT_WEBHOOK_URL/);
  });

  it("loads bounded multi-destination webhooks with an exact host allowlist", () => {
    const destinations = [
      {
        id: "operations",
        url: "https://ops.example.test/hooks/",
        bearerToken: "ops-bearer",
        signingSecret: "o".repeat(32),
      },
      {
        id: "archive.eu",
        url: "https://archive.example.test/events",
        bearerToken: "archive-bearer",
        signingSecret: "a".repeat(32),
      },
    ];
    const loaded = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify(destinations),
      ALERT_WEBHOOK_ALLOWED_HOSTS: "ops.example.test, archive.example.test",
    });

    expect(loaded.alertWebhookDestinations).toEqual([
      { ...destinations[0], url: "https://ops.example.test/hooks" },
      destinations[1],
    ]);
    expect(loaded.alertWebhookAllowedHosts).toEqual(["ops.example.test", "archive.example.test"]);
    expect(loaded.alertWebhookUrl).toBe("https://ops.example.test/hooks");
    expect(loaded.alertWebhookBearerToken).toBe("ops-bearer");

    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify([destinations[0], { ...destinations[1], id: "operations" }]),
    })).toThrow(/invalid or duplicate destination id/);
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify([{ ...destinations[0], id: "Not Stable" }]),
    })).toThrow(/invalid or duplicate destination id/);
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify(destinations),
      ALERT_WEBHOOK_URL: "https://legacy.example.test/hook",
    })).toThrow(/cannot be combined/);
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify(destinations),
      ALERT_WEBHOOK_ALLOWED_HOSTS: "ops.example.test",
    })).toThrow(/must include every configured webhook destination host \(archive.eu\)/);
  });

  it("rejects untrusted browser origins without blocking trusted or native clients", async () => {
    const before = runtime.database.latestReadings().map((reading) => reading.timestamp);
    const rejected = await request(runtime.app).post("/api/v1/mock/tick")
      .set("Origin", "https://evil.example")
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send({ trigger: "cross-site" })
      .expect(403);
    expect(rejected.body.error.code).toBe("CROSS_SITE_REQUEST_REJECTED");
    expect(runtime.database.latestReadings().map((reading) => reading.timestamp)).toEqual(before);

    const preflight = await request(runtime.app).options("/api/v1/mock/tick")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST")
      .expect(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    await request(runtime.app).post("/api/v1/mock/tick")
      .set("Host", "rebind.example:8787")
      .set("Origin", "http://rebind.example:8787")
      .set("Sec-Fetch-Site", "same-origin")
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("CROSS_SITE_REQUEST_REJECTED"));

    await request(runtime.app).post("/api/v1/mock/tick")
      .set("Host", "rebind.example:8787")
      .set("Origin", "http://rebind.example:8787")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/json")
      .send('{"large-or-invalid"')
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("CROSS_SITE_REQUEST_REJECTED"));

    await request(runtime.app).post("/api/v1/mock/tick")
      .set("Host", "localhost:8787")
      .set("Origin", "http://localhost:8787")
      .set("Sec-Fetch-Site", "same-origin")
      .expect(201);

    const trusted = await request(runtime.app).post("/api/v1/mock/tick")
      .set("Origin", config.corsOrigin!)
      .set("Sec-Fetch-Site", "same-site")
      .expect(201);
    expect(trusted.headers["access-control-allow-origin"]).toBe(config.corsOrigin);

    await request(runtime.app).options("/api/v1/mock/tick")
      .set("Origin", config.corsOrigin!)
      .set("Access-Control-Request-Method", "POST")
      .expect(204)
      .expect("Access-Control-Allow-Origin", config.corsOrigin!);
    await request(runtime.app).post("/api/v1/mock/tick").expect(201);
  });

  it("boots with one digital twin, ten positioned sensors, and durable seed history", async () => {
    const houses = await request(runtime.app).get("/api/v1/houses").expect(200);
    expect(houses.body.houses).toHaveLength(1);
    expect(houses.body.houses[0].floors).toHaveLength(2);

    const snapshots = await request(runtime.app).get("/api/v1/sensors/snapshots").expect(200);
    expect(snapshots.body.sensors).toHaveLength(10);
    expect(snapshots.body.sensors.every((sensor: { reading: unknown }) => sensor.reading !== null)).toBe(true);

    const history = await request(runtime.app)
      .get("/api/v1/history")
      .query({ sensorId: "sensor-01", limit: 500 })
      .expect(200);
    expect(history.body.series[0].readings.length).toBeGreaterThan(250);
  });
});
