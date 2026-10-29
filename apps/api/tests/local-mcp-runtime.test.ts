import type { LocalMcpRuntimeStatus } from "@climate-twin/contracts";
import { EventEmitter, once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { LocalMcpRuntimeError, LocalMcpRuntimeService } from "../src/local-mcp-runtime.js";
import {
  registerLocalMcpRuntimeRoutes,
  registerLocalMcpTransportRoute,
  type LocalMcpRuntimeController,
} from "../src/app/local-mcp-runtime-routes.js";

class FakeChild extends EventEmitter {
  readonly pid = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    if ((message as { type?: unknown }).type === "shutdown") queueMicrotask(() => this.exit(0));
    return true;
  }

  kill(): boolean {
    queueMicrotask(() => this.exit(null, "SIGTERM"));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const stoppedStatus = (): LocalMcpRuntimeStatus => ({
  state: "stopped",
  endpointPath: "/api/v1/mcp",
  pid: null,
  startedAt: null,
  toolCount: null,
  serverVersion: null,
  errorCode: null,
  accessTokenIssued: false,
});

describe("network MCP runtime", () => {
  it("starts one child, returns the bearer token once, and invalidates it when stopped", async () => {
    const child = new FakeChild();
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit("message", {
        type: "ready", port: 40123, toolCount: 61, serverVersion: "0.30.0",
      }));
      return child as unknown as ChildProcess;
    });
    const runtime = new LocalMcpRuntimeService({
      serverPath: "mcp-http-server.js",
      workingDirectory: "C:\\stugu",
      pathExists: () => true,
      launch,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      shutdownTimeoutMs: 100,
    });

    const started = await runtime.start();
    expect(started).toMatchObject({
      state: "running", endpointPath: "/api/v1/mcp", pid: 4321,
      toolCount: 61, serverVersion: "0.30.0", startedAt: "2026-08-02T12:00:00.000Z",
    });
    expect(started.accessToken).toMatch(/^stugu_mcp_[A-Za-z0-9_-]{43}$/u);
    expect(started.accessTokenIssued).toBe(true);
    expect(runtime.authorize(`Bearer ${started.accessToken}`)).toBe(true);
    expect(runtime.authorize("Bearer stugu_mcp_invalid")).toBe(false);

    expect((await runtime.start()).accessToken).toBeNull();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(
      "mcp-http-server.js",
      "C:\\stugu",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );

    expect(await runtime.stop()).toEqual(stoppedStatus());
    expect(runtime.authorize(`Bearer ${started.accessToken}`)).toBe(false);
    expect(child.sent).toContainEqual({ type: "shutdown" });
  });

  it("starts for an assistant connection without issuing a manual token, and issues one later on request", async () => {
    const child = new FakeChild();
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit("message", {
        type: "ready", port: 40123, toolCount: 61, serverVersion: "0.30.0",
      }));
      return child as unknown as ChildProcess;
    });
    const runtime = new LocalMcpRuntimeService({ serverPath: "mcp-http-server.js", pathExists: () => true, launch, shutdownTimeoutMs: 100 });

    await runtime.ensureRunning();
    await runtime.ensureRunning();
    expect(launch).toHaveBeenCalledOnce();
    expect(runtime.status()).toMatchObject({ state: "running", accessTokenIssued: false });
    // The child's own bearer is internal; it never authorizes a client.
    const [, , internalTokenHash] = launch.mock.calls[0] as unknown as [string, string, string];
    expect(internalTokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtime.authorize(`Bearer ${internalTokenHash}`)).toBe(false);

    const issued = await runtime.start();
    expect(issued.accessToken).toMatch(/^stugu_mcp_/u);
    expect(issued.accessTokenIssued).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("fails closed when the compiled HTTP entry point is missing", async () => {
    const runtime = new LocalMcpRuntimeService({ pathExists: () => false });
    await expect(runtime.start()).rejects.toMatchObject<Partial<LocalMcpRuntimeError>>({
      status: 409,
      code: "MCP_BUILD_MISSING",
    });
    expect(runtime.status()).toMatchObject({ state: "error", errorCode: "build_missing" });
  });

  it("marks an unexpected child exit and revokes access", async () => {
    const child = new FakeChild();
    const runtime = new LocalMcpRuntimeService({
      serverPath: "mcp-http-server.js",
      pathExists: () => true,
      launch: () => {
        queueMicrotask(() => child.emit("message", {
          type: "ready", port: 40123, toolCount: 61, serverVersion: "0.30.0",
        }));
        return child as unknown as ChildProcess;
      },
    });
    const started = await runtime.start();

    child.exit(1);

    expect(runtime.status()).toMatchObject({ state: "error", errorCode: "unexpected_exit" });
    expect(runtime.authorize(`Bearer ${started.accessToken}`)).toBe(false);
  });

  it("serves a complete MCP exchange through the Web-facing bearer endpoint", async () => {
    const workspaceRoot = process.cwd().replace(/[\\/]apps[\\/]api$/u, "");
    const directory = mkdtempSync(join(tmpdir(), "stugu-network-mcp-"));
    const databasePath = join(directory, "climate.db");
    new ClimateDatabase(databasePath, true).close();
    const runtime = new LocalMcpRuntimeService({
      serverPath: join(workspaceRoot, "apps", "api", "src", "mcp-http-server.ts"),
      workingDirectory: workspaceRoot,
      pathExists: () => true,
      launch: (serverPath, workingDirectory, accessTokenHash) => {
        const child = fork(serverPath, [], {
          cwd: workingDirectory,
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_PATH: databasePath,
            MOCK_ENABLED: "true",
            STUGU_MCP_ACCESS_TOKEN_SHA256: accessTokenHash,
          },
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        child.stderr?.on("data", () => undefined);
        return child;
      },
    });
    const assistantToken = `stugu_at_${"a".repeat(43)}`;
    const app = express();
    registerLocalMcpTransportRoute({ app, prefix: "/api/v1" }, runtime, {
      origin: () => "http://127.0.0.1",
      verifyAccessToken: (token) => token === assistantToken ? { grantId: "grant" } : null,
    });
    const listener = app.listen(0, "127.0.0.1");
    const client = new Client({ name: "stugu-network-test", version: "1.0.0" });
    const assistant = new Client({ name: "stugu-assistant-test", version: "1.0.0" });
    try {
      await once(listener, "listening");
      const started = await runtime.start();
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/v1/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${started.accessToken}` } } },
      );
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(61);
      expect((await client.callTool({ name: "list_properties", arguments: {} })).structuredContent)
        .toMatchObject({ result: expect.any(Array) });

      // An assistant connection reaches the focused conversation profile through the same child.
      await assistant.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/v1/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${assistantToken}` } } },
      ));
      const assistantTools = (await assistant.listTools()).tools.map((tool) => tool.name);
      expect(assistantTools).toHaveLength(20);
      expect(assistantTools).toContain("get_measurement_snapshot");
      expect(assistantTools).not.toContain("test_home_assistant_connection");
    } finally {
      await assistant.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("network MCP routes", () => {
  it("requires the dedicated bearer token and rejects browser-origin requests", async () => {
    const app = express();
    const runtime = {
      status: vi.fn(stoppedStatus),
      start: vi.fn(),
      stop: vi.fn(),
      authorize: vi.fn((authorization: string | undefined) => authorization === "Bearer allowed"),
      proxy: vi.fn(async (_request, response) => { response.json({ jsonrpc: "2.0", result: {}, id: 1 }); }),
    } as unknown as LocalMcpRuntimeController;
    registerLocalMcpTransportRoute({ app, prefix: "/api/v1" }, runtime);

    await request(app).post("/api/v1/mcp").send({}).expect(401);
    await request(app).post("/api/v1/mcp")
      .set("authorization", "Bearer allowed")
      .set("origin", "https://untrusted.example")
      .send({})
      .expect(403);
    await request(app).post("/api/v1/mcp")
      .set("authorization", "Bearer allowed")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 })
      .expect(200, { jsonrpc: "2.0", result: {}, id: 1 });
    expect(runtime.proxy).toHaveBeenCalledOnce();
  });

  it("keeps start and stop controls Owner/Admin-only and audits the bearer", async () => {
    const app = express();
    const recordSecurityAudit = vi.fn();
    const runtime = {
      status: vi.fn(stoppedStatus),
      start: vi.fn(async () => ({ ...stoppedStatus(), accessToken: "stugu_mcp_test" })),
      stop: vi.fn(async () => stoppedStatus()),
      authorize: vi.fn(),
      proxy: vi.fn(),
    } as unknown as LocalMcpRuntimeController;
    app.use((request, response, next) => {
      response.locals.localPrincipal = {
        userId: "member", email: "member@example.test", role: request.header("x-role") ?? "member",
        grants: [], bootstrap: false,
      };
      next();
    });
    registerLocalMcpRuntimeRoutes({ app, prefix: "/api/v1", recordSecurityAudit }, runtime);
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status((error as { status?: number }).status ?? 500).json({});
    });

    await request(app).post("/api/v1/system/mcp-runtime/start").expect(403);
    await request(app).post("/api/v1/system/mcp-runtime/start").set("x-role", "owner").expect(200);
    expect(runtime.start).toHaveBeenCalledOnce();
    await request(app).post("/api/v1/system/mcp-runtime/stop").set("x-role", "owner").expect(200);
    expect(recordSecurityAudit.mock.calls.map(([, event]) => [event.eventType, event.subjectId])).toEqual([
      ["integration.grant.issued", "mcp-http"],
      ["integration.grant.revoked", "mcp-http"],
    ]);
  });
});
