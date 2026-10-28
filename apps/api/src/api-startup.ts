import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import type { AppConfig } from "./config.js";
import type { ApiRuntime } from "./app/support/api-runtime.js";
import { SYSTEM_VERSION } from "./version.js";

export type ApiStartupPhase = "configuration" | "runtime" | "archive" | "listener";
type StartupRuntime = Pick<ApiRuntime, "app" | "ready" | "close" | "beginShutdown">;
export interface ApiStartupRecord {
  schema: "stugu-api-startup/v1";
  systemVersion: string;
  phase: ApiStartupPhase;
  event: "started" | "ready" | "failed";
  elapsedMs: number;
  errorCode?: string;
}

/** Return a fixed classification; never return paths, SQL, URLs or credentials. */
export function startupErrorCode(error: unknown): string {
  const value = error instanceof Error ? error as Error & { code?: unknown } : null;
  const code = typeof value?.code === "string" ? value.code : "";
  if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code)
    || /database (?:is |table is )?locked/i.test(value?.message ?? "")) return "SQLITE_LOCKED";
  if (["SQLITE_FULL", "ENOSPC"].includes(code)
    || /database or disk is full|no space left/i.test(value?.message ?? "")) return "STORAGE_FULL";
  if (["SQLITE_IOERR", "EROFS"].includes(code)
    || /disk I\/O error|read-only file system/i.test(value?.message ?? "")) return "STORAGE_IO";
  if (code === "EADDRINUSE") return "HTTP_ADDRESS_IN_USE";
  if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "CONNECTION_FAILED";
  if (["ETIMEDOUT", "ETIME"].includes(code) || value?.name === "TimeoutError") return "STARTUP_TIMEOUT";
  if (code === "ENOMEM" || /heap out of memory|allocation failed/i.test(value?.message ?? "")) return "MEMORY_EXHAUSTED";
  return "STARTUP_FAILED";
}

export class ApiStartupError extends Error {
  constructor(readonly phase: ApiStartupPhase, readonly code: string) {
    super(`Stugu API startup failed during ${phase} (${code})`);
    this.name = "ApiStartupError";
  }
}

/** Startup failures are captured before the failed container is replaced. */
export async function startApiServer(dependencies: {
  loadConfiguration: () => AppConfig;
  createRuntime: (config: AppConfig) => StartupRuntime;
  write: (record: ApiStartupRecord) => void;
}): Promise<{ runtime: StartupRuntime; server: Server }> {
  const startedAt = performance.now();
  let phase: ApiStartupPhase = "configuration";
  let runtime: StartupRuntime | undefined;
  let server: Server | undefined;
  const record = (event: ApiStartupRecord["event"], errorCode?: string) => dependencies.write({
    schema: "stugu-api-startup/v1", systemVersion: SYSTEM_VERSION, phase, event,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(errorCode ? { errorCode } : {}),
  });
  try {
    record("started");
    const config = dependencies.loadConfiguration();
    record("ready");
    phase = "runtime";
    record("started");
    runtime = dependencies.createRuntime(config);
    record("ready");
    phase = "archive";
    record("started");
    await runtime.ready();
    record("ready");
    phase = "listener";
    record("started");
    server = createServer(runtime.app);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(config.port, config.apiHost, () => {
        server!.off("error", reject);
        resolve();
      });
    });
    record("ready");
    return { runtime, server };
  } catch (error) {
    const code = startupErrorCode(error);
    record("failed", code);
    if (server?.listening) server.close();
    if (runtime) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve().then(() => runtime!.close()).catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); }),
      ]).finally(() => clearTimeout(timer));
    }
    throw new ApiStartupError(phase, code);
  }
}
