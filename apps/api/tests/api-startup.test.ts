import { createServer } from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { ApiStartupError, startApiServer, startupErrorCode, type ApiStartupRecord } from "../src/api-startup.js";
import { loadConfig } from "../src/config.js";

function fixture() {
  const app = express();
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  const runtime = { app, ready: vi.fn<() => Promise<void>>(async () => {}), close: vi.fn<() => Promise<void>>(async () => {}),
    beginShutdown: vi.fn<() => Promise<void>>(async () => {}) };
  const records: ApiStartupRecord[] = [];
  const config = { ...loadConfig({ MOCK_ENABLED: "false" }), apiHost: "127.0.0.1", port: 0 };
  const dependencies = { loadConfiguration: () => config, createRuntime: () => runtime,
    write: (record: ApiStartupRecord) => records.push(record) };
  return { runtime, records, config, dependencies };
}

describe("API startup", () => {
  it("captures configuration and database initialization failures without exposing private details", async () => {
    for (const phase of ["configuration", "runtime"] as const) {
      const test = fixture();
      const error = new Error("database or disk is full: /private/operator.sqlite SQL token=private-secret");
      if (phase === "configuration") test.dependencies.loadConfiguration = () => { throw error; };
      else test.dependencies.createRuntime = () => { throw error; };
      await expect(startApiServer(test.dependencies)).rejects.toMatchObject({ name: "ApiStartupError", phase, code: "STORAGE_FULL" });
      expect(test.records.at(-1)).toMatchObject({ phase, event: "failed", errorCode: "STORAGE_FULL" });
      expect(JSON.stringify(test.records)).not.toMatch(/operator|private|token=|SELECT/);
      expect(test.runtime.close).not.toHaveBeenCalled();
    }
  });

  it("closes a created runtime when required archive readiness fails", async () => {
    const test = fixture();
    test.runtime.ready.mockRejectedValue(Object.assign(new Error("private-host credential=private-secret"), { code: "ECONNREFUSED" }));
    await expect(startApiServer(test.dependencies)).rejects.toMatchObject({ phase: "archive", code: "CONNECTION_FAILED" });
    expect(test.runtime.close).toHaveBeenCalledTimes(1);
    expect(test.records.at(-1)).toMatchObject({ phase: "archive", event: "failed" });
    expect(JSON.stringify(test.records)).not.toMatch(/private-host|credential/);
  });

  it("captures an asynchronous listen failure and closes the runtime", async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const test = fixture();
      test.config.port = (occupied.address() as { port: number }).port;
      await expect(startApiServer(test.dependencies)).rejects.toMatchObject({ phase: "listener", code: "HTTP_ADDRESS_IN_USE" });
      expect(test.runtime.close).toHaveBeenCalledTimes(1);
      expect(test.records.at(-1)).toMatchObject({ phase: "listener", event: "failed", errorCode: "HTTP_ADDRESS_IN_USE" });
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });

  it("reports ready only after required startup work and the listener complete", async () => {
    const test = fixture();
    let release!: () => void;
    test.runtime.ready.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = startApiServer(test.dependencies);
    expect(test.records.at(-1)).toMatchObject({ phase: "archive", event: "started" });
    expect(test.records.some(record => record.phase === "listener")).toBe(false);
    release();
    const { server } = await pending;
    try {
      const port = (server.address() as { port: number }).port;
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      expect(test.records.at(-1)).toMatchObject({ phase: "listener", event: "ready" });
      expect(test.records.every(record => record.elapsedMs >= 0)).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("never propagates unclassified exceptions into the startup error", () => {
    expect(startupErrorCode(new Error("private secret"))).toBe("STARTUP_FAILED");
    expect(startupErrorCode("private secret")).toBe("STARTUP_FAILED");
    expect(new ApiStartupError("runtime", "STARTUP_FAILED").message).not.toContain("private");
  });
});
