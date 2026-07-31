import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("background integration discovery routes", () => {
  let runtime: ApiRuntime | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("accepts discovery immediately and exposes the completed owner-scoped snapshot", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-discovery-jobs-"));
    let finish!: (result: {
      homeAssistant: [];
      tpLink: [];
      tuya: Array<{
        host: string;
        deviceId: string;
        protocolVersion: string;
        productKey: null;
        mac: null;
      }>;
      warnings: string[];
    }) => void;
    const discover = vi.fn((_houseId?: string, _credentials?: { username: string; password: string }) => (
      new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; })
    ));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        INTEGRATION_SECRETS_FILE: join(directory, "integrations.json"),
      }),
      startBackground: false,
      integrationDiscoverer: discover,
    });

    const started = await request(runtime.app)
      .post("/api/v1/integrations/discovery-jobs")
      .send({
        houseId: "house-main",
        tpLinkUsername: "person@example.com",
        tpLinkPassword: "draft-secret",
      })
      .expect(202);

    expect(started.body.job).toMatchObject({
      houseId: "house-main",
      status: "running",
      result: null,
      error: null,
    });
    expect(discover).toHaveBeenCalledWith("house-main", {
      username: "person@example.com",
      password: "draft-secret",
    });
    expect(JSON.stringify(started.body)).not.toContain("draft-secret");

    const server = createServer(runtime.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Discovery test server did not bind");
    const controller = new AbortController();
    const eventsResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/integrations/discovery-jobs/events?jobId=${started.body.job.id}`,
      { signal: controller.signal },
    );
    expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = eventsResponse.body!.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);
    expect(events).toContain("event: integration-discovery");
    expect(events).toContain('"status":"running"');

    finish({
      homeAssistant: [],
      tpLink: [],
      tuya: [{
        host: "192.168.1.60",
        deviceId: "must-not-be-enumerated",
        protocolVersion: "3.5",
        productKey: null,
        mac: null,
      }],
      warnings: ["No devices replied."],
    });
    for (let index = 0; index < 3 && !events.includes('"status":"completed"'); index += 1) {
      events += new TextDecoder().decode((await reader.read()).value);
    }
    expect(events).toContain('"status":"completed"');
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await vi.waitFor(async () => {
      const snapshot = await request(runtime!.app)
        .get(`/api/v1/integrations/discovery-jobs/${started.body.job.id}`)
        .expect(200);
      expect(snapshot.body.job.status).toBe("completed");
    });

    const latest = await request(runtime.app)
      .get("/api/v1/integrations/discovery-jobs/latest?houseId=house-main")
      .expect(200);
    expect(latest.body.job).toMatchObject({
      id: started.body.job.id,
      status: "completed",
      result: { tuya: [], warnings: ["No devices replied."] },
    });
    expect(JSON.stringify(latest.body)).not.toContain("must-not-be-enumerated");
  });
});
