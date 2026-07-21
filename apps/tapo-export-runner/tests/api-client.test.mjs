import assert from "node:assert/strict";
import test from "node:test";
import { JobApiClient, MAX_JOB_API_RESPONSE_BYTES } from "../dist/api-client.js";

test("uses the authenticated internal worker contract and propagates the lease token", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const claimed = {
    id: "job-1",
    sensorId: "sensor-1",
    deviceId: "device-1",
    deviceName: "Living room",
    metric: "temperature",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-02T00:00:00.000Z",
    timeZone: "Europe/Helsinki",
    intervalMinutes: 15,
    expectedRecipient: "history+tapo-job-1@example.com",
    status: "claimed",
    attemptCount: 1,
    leaseExpiresAt: "2026-07-19T20:10:00.000Z",
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        job: claimed,
        leaseToken: "lease-1",
        serverNow: "2026-07-19T20:05:00.000Z",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (calls.length === 2) {
      return Response.json({
        job: { leaseExpiresAt: "2026-07-19T20:15:00.000Z" },
        serverNow: "2026-07-19T20:10:00.000Z",
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const client = new JobApiClient({
      baseUrl: "http://api:8787",
      apiPrefix: "/api/v1/internal/tapo-history",
      token: "worker-secret",
      workerId: "android worker/1",
      deploymentFingerprint: "a".repeat(64),
      requestTimeoutMs: 5_000,
    });
    const job = await client.claim();
    assert.equal(job.leaseToken, "lease-1");
    assert.equal(job.leaseTtlMs, 300_000);
    assert.equal(job.serverNow, "2026-07-19T20:05:00.000Z");
    const renewedLease = await client.heartbeat(job);
    assert.deepEqual(renewedLease, { leaseExpiresAt: "2026-07-19T20:15:00.000Z", leaseTtlMs: 300_000 });
    await client.updateStatus(job, { status: "waiting-email", detail: "accepted" });

    assert.equal(
      calls[0].url,
      `http://api:8787/api/v1/internal/tapo-history/jobs/claim?workerId=android%20worker%2F1&deploymentFingerprint=${"a".repeat(64)}`,
    );
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.authorization, "Bearer worker-secret");
    assert.equal(calls[0].init.headers["x-tapo-deployment-fingerprint"], "a".repeat(64));
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      workerId: "android worker/1",
      leaseToken: "lease-1",
    });
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      workerId: "android worker/1",
      leaseToken: "lease-1",
      status: "waiting-email",
      detail: "accepted",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a streamed job API body above the bounded JSON limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(MAX_JOB_API_RESPONSE_BYTES + 1), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const client = new JobApiClient({
      baseUrl: "http://api:8787",
      apiPrefix: "/api/v1/internal/tapo-history",
      token: "worker-secret",
      workerId: "android-worker-1",
      deploymentFingerprint: "b".repeat(64),
      requestTimeoutMs: 5_000,
    });
    await assert.rejects(client.claim(), /exceeded 262144 bytes/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
