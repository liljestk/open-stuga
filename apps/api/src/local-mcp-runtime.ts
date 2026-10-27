import type { LocalMcpRuntimeErrorCode, LocalMcpRuntimeStartResult, LocalMcpRuntimeStatus } from "@climate-twin/contracts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";
import type { Request, Response } from "express";

interface ReadyMessage {
  type: "ready";
  port: number;
  toolCount: number;
  serverVersion: string;
}

export interface LocalMcpRuntimeOptions {
  serverPath?: string;
  workingDirectory?: string;
  pathExists?: (path: string) => boolean;
  launch?: (serverPath: string, workingDirectory: string, accessTokenHash: string) => ChildProcess;
  now?: () => Date;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class LocalMcpRuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: "MCP_BUILD_MISSING" | "MCP_START_FAILED" | "MCP_STOP_FAILED" | "MCP_NOT_RUNNING",
    message: string,
  ) {
    super(message);
    this.name = "LocalMcpRuntimeError";
  }
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const endpointPath = "/api/v1/mcp" as const;

function inheritedEnvironment(accessTokenHash: string): NodeJS.ProcessEnv {
  return { ...process.env, STUGU_MCP_ACCESS_TOKEN_SHA256: accessTokenHash };
}

function launchHttpMcp(serverPath: string, workingDirectory: string, accessTokenHash: string): ChildProcess {
  const child = fork(serverPath, [], {
    cwd: workingDirectory,
    env: inheritedEnvironment(accessTokenHash),
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.on("data", () => undefined);
  return child;
}

function readyMessage(value: unknown): ReadyMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ReadyMessage>;
  return candidate.type === "ready"
    && Number.isInteger(candidate.port) && (candidate.port ?? 0) > 0 && (candidate.port ?? 0) <= 65_535
    && Number.isInteger(candidate.toolCount) && (candidate.toolCount ?? -1) >= 0
    && typeof candidate.serverVersion === "string" && candidate.serverVersion.length > 0
    ? candidate as ReadyMessage
    : null;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class LocalMcpRuntimeService {
  readonly #serverPath: string;
  readonly #workingDirectory: string;
  readonly #pathExists: (path: string) => boolean;
  readonly #launch: (serverPath: string, workingDirectory: string, accessTokenHash: string) => ChildProcess;
  readonly #now: () => Date;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  #child: ChildProcess | null = null;
  #upstreamPort: number | null = null;
  #tokenHash: Buffer | null = null;
  #operations: Promise<void> = Promise.resolve();
  #status: LocalMcpRuntimeStatus = {
    state: "stopped",
    endpointPath,
    pid: null,
    startedAt: null,
    toolCount: null,
    serverVersion: null,
    errorCode: null,
  };

  constructor(options: LocalMcpRuntimeOptions = {}) {
    this.#workingDirectory = options.workingDirectory ?? projectRoot;
    this.#serverPath = options.serverPath ?? join(this.#workingDirectory, "apps", "api", "dist", "mcp-http-server.js");
    this.#pathExists = options.pathExists ?? existsSync;
    this.#launch = options.launch ?? launchHttpMcp;
    this.#now = options.now ?? (() => new Date());
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  }

  status(): LocalMcpRuntimeStatus {
    return { ...this.#status };
  }

  start(): Promise<LocalMcpRuntimeStartResult> {
    return this.#enqueue(async () => {
      if (this.#status.state === "running") return { ...this.status(), accessToken: null };
      if (!this.#pathExists(this.#serverPath)) {
        this.#setError("build_missing");
        throw new LocalMcpRuntimeError(
          409,
          "MCP_BUILD_MISSING",
          "The compiled network MCP server is unavailable. Build Stugu and try again.",
        );
      }

      this.#status = {
        state: "starting",
        endpointPath,
        pid: null,
        startedAt: null,
        toolCount: null,
        serverVersion: null,
        errorCode: null,
      };

      let child: ChildProcess | null = null;
      const accessToken = `stugu_mcp_${randomBytes(32).toString("base64url")}`;
      this.#tokenHash = tokenDigest(accessToken);
      try {
        child = this.#launch(this.#serverPath, this.#workingDirectory, this.#tokenHash.toString("hex"));
        this.#child = child;
        child.once("exit", () => this.#handleChildExit(child!));
        const ready = await this.#waitUntilReady(child);
        if (this.#child !== child) throw new Error("MCP process exited during startup");
        this.#upstreamPort = ready.port;
        this.#status = {
          state: "running",
          endpointPath,
          pid: child.pid ?? null,
          startedAt: this.#now().toISOString(),
          toolCount: ready.toolCount,
          serverVersion: ready.serverVersion,
          errorCode: null,
        };
        return { ...this.status(), accessToken };
      } catch {
        if (this.#child === child) this.#child = null;
        this.#upstreamPort = null;
        this.#tokenHash = null;
        child?.kill();
        this.#setError("start_failed");
        throw new LocalMcpRuntimeError(
          503,
          "MCP_START_FAILED",
          "The network MCP server could not start. Check the Stugu server logs and try again.",
        );
      }
    });
  }

  stop(): Promise<LocalMcpRuntimeStatus> {
    return this.#enqueue(async () => {
      const child = this.#child;
      if (!child) {
        this.#setStopped();
        return this.status();
      }

      this.#status = { ...this.#status, state: "stopping", errorCode: null };
      this.#upstreamPort = null;
      this.#tokenHash = null;
      try {
        await this.#requestChildShutdown(child);
        if (this.#child === child) this.#child = null;
        this.#setStopped();
        return this.status();
      } catch {
        this.#setError("stop_failed");
        throw new LocalMcpRuntimeError(
          503,
          "MCP_STOP_FAILED",
          "The network MCP server could not stop cleanly. Check the Stugu server logs and try again.",
        );
      }
    });
  }

  authorize(authorization: string | undefined): boolean {
    if (!this.#tokenHash || !authorization?.startsWith("Bearer ")) return false;
    const token = authorization.slice(7);
    if (!/^stugu_mcp_[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    return timingSafeEqual(this.#tokenHash, tokenDigest(token));
  }

  proxy(request: Request, response: Response): Promise<void> {
    const port = this.#upstreamPort;
    if (this.#status.state !== "running" || port === null) {
      return Promise.reject(new LocalMcpRuntimeError(503, "MCP_NOT_RUNNING", "The network MCP server is not running"));
    }

    const hasBody = !["GET", "HEAD"].includes(request.method);
    const body = hasBody ? Buffer.from(JSON.stringify(request.body ?? null), "utf8") : null;
    const authorization = request.header("authorization");
    const headers: OutgoingHttpHeaders = {
      accept: request.header("accept") ?? "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
      ...(body ? { "content-type": "application/json", "content-length": body.byteLength } : {}),
    };
    for (const name of ["mcp-protocol-version", "mcp-session-id", "last-event-id"] as const) {
      const value = request.header(name);
      if (value) headers[name] = value;
    }

    return new Promise<void>((resolve, reject) => {
      const upstream = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: request.method, headers }, (upstreamResponse) => {
        response.status(upstreamResponse.statusCode ?? 502);
        for (const name of ["content-type", "cache-control", "mcp-protocol-version", "mcp-session-id"] as const) {
          const value = upstreamResponse.headers[name];
          if (value !== undefined) response.setHeader(name, value);
        }
        upstreamResponse.once("error", reject);
        upstreamResponse.once("end", resolve);
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(120_000, () => upstream.destroy(new Error("MCP upstream request timed out")));
      upstream.once("error", reject);
      request.once("aborted", () => upstream.destroy());
      if (body) upstream.write(body);
      upstream.end();
    });
  }

  #waitUntilReady(child: ChildProcess): Promise<ReadyMessage> {
    return new Promise<ReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("MCP startup timed out")), this.#startupTimeoutMs);
      const onMessage = (message: unknown) => {
        const ready = readyMessage(message);
        if (ready) finish(null, ready);
      };
      const onError = () => finish(new Error("MCP process failed"));
      const onExit = () => finish(new Error("MCP process exited"));
      const finish = (error: Error | null, value?: ReadyMessage) => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve(value!);
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  #requestChildShutdown(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        if (child.kill()) resolve();
        else reject(new Error("MCP process did not stop"));
      }, this.#shutdownTimeoutMs);
      const onExit = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("exit", onExit);
      };
      child.once("exit", onExit);
      try {
        child.send({ type: "shutdown" }, (error) => {
          if (!error) return;
          cleanup();
          if (child.kill()) resolve();
          else reject(error);
        });
      } catch (error) {
        cleanup();
        if (child.kill()) resolve();
        else reject(error);
      }
    });
  }

  #handleChildExit(child: ChildProcess): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#upstreamPort = null;
    this.#tokenHash = null;
    if (this.#status.state === "stopping" || this.#status.state === "stopped") return;
    this.#setError("unexpected_exit");
  }

  #setStopped(): void {
    this.#status = {
      state: "stopped",
      endpointPath,
      pid: null,
      startedAt: null,
      toolCount: null,
      serverVersion: null,
      errorCode: null,
    };
  }

  #setError(errorCode: LocalMcpRuntimeErrorCode): void {
    this.#status = {
      state: "error",
      endpointPath,
      pid: null,
      startedAt: null,
      toolCount: null,
      serverVersion: null,
      errorCode,
    };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
