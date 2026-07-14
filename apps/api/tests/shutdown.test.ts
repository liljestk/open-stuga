import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { shutdownHttpServer } from "../src/http-shutdown.js";

describe("API shutdown", () => {
  let runtime: ApiRuntime | null = null;
  let server: Server | null = null;

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    runtime?.close();
  });

  it("drains every SSE endpoint before closing the database and HTTP server", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
    server = createServer(runtime.app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

    const [telemetry, measurements] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/api/v1/events`),
      fetch(`http://127.0.0.1:${address.port}/api/v2/measurements/events`),
    ]);
    expect(telemetry.headers.get("content-type")).toContain("text/event-stream");
    expect(measurements.headers.get("content-type")).toContain("text/event-stream");

    const shutdown = shutdownHttpServer(server, runtime, 1_000);
    const [result, telemetryBody, measurementBody] = await Promise.all([
      shutdown,
      telemetry.text(),
      measurements.text(),
    ]);

    expect(result).toEqual({ forced: false });
    expect(telemetryBody).toContain("event: integration");
    expect(telemetryBody).toContain(": server shutting down");
    expect(measurementBody).toContain(": server shutting down");
    expect(server.listening).toBe(false);
  });

  it("immediately ends an SSE handler that was accepted as shutdown began", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
    runtime.beginShutdown();
    server = createServer(runtime.app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/measurements/events`);
    await expect(response.text()).resolves.toContain(": server shutting down");
  });
});
