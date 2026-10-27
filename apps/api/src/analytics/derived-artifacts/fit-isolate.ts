import { withSignal } from "@climate-twin/contracts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { MoistureResponseResult, ThermalIsolationResult } from "@climate-twin/contracts";
import {
  runMoistureResponseAsync,
  type MoistureResponseInput,
} from "../../moisture-response.js";
import {
  runThermalIsolationAsync,
  type ThermalIsolationInput,
} from "../../thermal-isolation.js";
import type { DerivedFitWorkerRequest } from "./fit-worker.js";

type DerivedFitResult = ThermalIsolationResult | MoistureResponseResult;
type WorkerReply =
  | { ok: true; result: DerivedFitResult }
  | { ok: false; error: { name: string; message: string; code?: string } };

const FIT_WORKER_URL = new URL("./fit-worker.js", import.meta.url);
const FIT_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 384,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 4,
} as const;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Derived analytics fit was cancelled", "AbortError");
}

async function sourceRuntimeFallback(
  request: DerivedFitWorkerRequest,
  signal?: AbortSignal,
): Promise<DerivedFitResult> {
  // Vitest and `tsx` execute the TypeScript source tree, where the compiled
  // worker entry point does not exist. Production starts dist/index.js and
  // must use the sibling compiled worker rather than falling back in-process.
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
  if (!sourceRuntime) {
    throw Object.assign(new Error("The compiled derived-fit worker is missing"), {
      code: "DERIVED_FIT_WORKER_MISSING",
    });
  }
  if (request.kind === "thermal-isolation") {
    return runThermalIsolationAsync(request.input, {
      ...withSignal(signal),
      yieldEvery: 1,
    });
  }
  return runMoistureResponseAsync(request.input, withSignal(signal));
}

function runWorker(
  request: DerivedFitWorkerRequest,
  signal?: AbortSignal,
): Promise<DerivedFitResult> {
  signal?.throwIfAborted();
  if (!existsSync(fileURLToPath(FIT_WORKER_URL))) {
    return sourceRuntimeFallback(request, signal);
  }
  return new Promise<DerivedFitResult>((resolve, reject) => {
    const worker = new Worker(FIT_WORKER_URL, {
      workerData: request,
      resourceLimits: FIT_WORKER_RESOURCE_LIMITS,
      // `node --input-type=module --eval` is used by built-artifact smoke
      // checks, but that flag is invalid when the child has a file entrypoint.
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const fail = (error: unknown) => {
      void worker.terminate();
      finish(() => reject(error));
    };
    const onAbort = () => fail(abortReason(signal!));

    worker.once("message", (reply: WorkerReply) => {
      if (reply.ok) {
        void worker.terminate();
        finish(() => resolve(reply.result));
        return;
      }
      const error = Object.assign(new Error(reply.error.message), {
        name: reply.error.name,
        ...(reply.error.code ? { code: reply.error.code } : {}),
      });
      fail(error);
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (!settled) {
        fail(Object.assign(new Error(`Derived fit worker exited before returning a result (${code})`), {
          code: "DERIVED_FIT_WORKER_EXITED",
        }));
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function runThermalIsolationIsolated(
  input: ThermalIsolationInput,
  signal?: AbortSignal,
): Promise<ThermalIsolationResult> {
  return runWorker({ kind: "thermal-isolation", input }, signal) as Promise<ThermalIsolationResult>;
}

export function runMoistureResponseIsolated(
  input: MoistureResponseInput,
  signal?: AbortSignal,
): Promise<MoistureResponseResult> {
  return runWorker({ kind: "moisture-response", input }, signal) as Promise<MoistureResponseResult>;
}
