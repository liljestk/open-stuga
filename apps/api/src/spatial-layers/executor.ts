import { Worker } from "node:worker_threads";
import type { SpatialLayerEngineInput, SpatialLayerSnapshot } from "@climate-twin/spatial-layers";
import type { SpatialEngineRegistryPort } from "./types.js";

export interface SpatialEngineExecutionRequest {
  engineId: string;
  input: SpatialLayerEngineInput;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface SpatialEngineExecutor {
  execute(request: SpatialEngineExecutionRequest): Promise<SpatialLayerSnapshot[]>;
  close(): void;
}

export class SpatialExecutionTimeoutError extends Error {}
export class SpatialExecutionAbortedError extends Error {}

const BUILTIN_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
parentPort.once("message", async ({ engineId, input }) => {
  try {
    const { createBuiltinSpatialLayerRegistry } = await import("@climate-twin/spatial-layers");
    const registry = createBuiltinSpatialLayerRegistry();
    const snapshots = await registry.infer(engineId, input);
    parentPort.postMessage({ ok: true, snapshots });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Unknown worker failure",
      },
    });
  }
});
`;

/**
 * Production executor. Every inference gets a disposable worker so a research
 * model can be hard-terminated without blocking the API event loop.
 */
export class WorkerThreadSpatialEngineExecutor implements SpatialEngineExecutor {
  readonly #workers = new Set<Worker>();

  constructor(readonly options: {
    workerSource?: string;
    maximumHeapMb?: number;
  } = {}) {}

  execute(request: SpatialEngineExecutionRequest): Promise<SpatialLayerSnapshot[]> {
    if (request.signal.aborted) return Promise.reject(new SpatialExecutionAbortedError("Spatial inference was cancelled"));
    const maximumHeapMb = Math.max(32, Math.min(512, Math.round(this.options.maximumHeapMb ?? 128)));
    const worker = new Worker(this.options.workerSource ?? BUILTIN_WORKER_SOURCE, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: maximumHeapMb,
        maxYoungGenerationSizeMb: Math.max(8, Math.round(maximumHeapMb / 4)),
        stackSizeMb: 4,
      },
    });
    this.#workers.add(worker);
    return new Promise<SpatialLayerSnapshot[]>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.#workers.delete(worker);
        void worker.terminate();
        operation();
      };
      const abort = (): void => finish(() => reject(new SpatialExecutionAbortedError("Spatial inference was cancelled")));
      const timer = setTimeout(() => finish(() => reject(new SpatialExecutionTimeoutError(
        `Engine ${request.engineId} exceeded ${request.timeoutMs} ms`,
      ))), request.timeoutMs);
      timer.unref();
      request.signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: unknown) => {
        const result = message as { ok?: unknown; snapshots?: unknown; error?: { message?: unknown } };
        if (result.ok === true && Array.isArray(result.snapshots)) {
          finish(() => resolve(result.snapshots as SpatialLayerSnapshot[]));
          return;
        }
        const messageText = typeof result.error?.message === "string" ? result.error.message : "Spatial worker failed";
        finish(() => reject(new Error(messageText)));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`Spatial worker exited with code ${code}`)));
      });
      worker.postMessage({ engineId: request.engineId, input: request.input });
    });
  }

  close(): void {
    for (const worker of this.#workers) void worker.terminate();
    this.#workers.clear();
  }
}

/** Test-only/custom-engine executor. It cannot hard-stop synchronous code. */
export class DirectSpatialEngineExecutor implements SpatialEngineExecutor {
  constructor(readonly registry: SpatialEngineRegistryPort) {}

  execute(request: SpatialEngineExecutionRequest): Promise<SpatialLayerSnapshot[]> {
    if (request.signal.aborted) return Promise.reject(new SpatialExecutionAbortedError("Spatial inference was cancelled"));
    const engine = this.registry.resolve(request.engineId);
    return new Promise<SpatialLayerSnapshot[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => reject(new SpatialExecutionAbortedError("Spatial inference was cancelled"));
      request.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new SpatialExecutionTimeoutError(
        `Engine ${request.engineId} exceeded ${request.timeoutMs} ms`,
      )), request.timeoutMs);
      timer.unref();
      Promise.resolve().then(() => engine.infer(request.input)).then(resolve, reject).finally(() => {
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      });
    });
  }

  close(): void {}
}
