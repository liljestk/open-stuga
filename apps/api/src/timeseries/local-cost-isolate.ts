import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { AnalyticsWorkLimiter } from "../analytics/work-limiter.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord } from "./types.js";
import type { LocalCostWorkerRequest } from "./local-cost-worker.js";

type Reply = { id: number; ok: true; result: EnergyCostAggregateRecord } | { id: number; ok: false };
const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
const workerUrl = new URL(sourceRuntime ? "./local-cost-worker.ts" : "./local-cost-worker.js", import.meta.url);

/** One bounded read-only SQLite worker per database; health and ingestion stay responsive. */
export class LocalCostIsolate {
  readonly #limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 8 });
  readonly #shutdown = new AbortController();
  #worker: Worker | null = null;
  #nextId = 0;

  constructor(readonly databasePath: string, readonly timeoutMs = 15_000) {}

  read(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    const signal = query.signal
      ? AbortSignal.any([query.signal, this.#shutdown.signal]) : this.#shutdown.signal;
    return this.#limiter.run("sqlite-cost", () => this.#read(metric, query, signal), signal);
  }

  close(): void {
    this.#shutdown.abort(new DOMException("Local cost reader closed", "AbortError"));
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate();
  }

  #read(metric: "energy" | "power", query: EnergyCostAggregateQuery, signal: AbortSignal): Promise<EnergyCostAggregateRecord> {
    signal.throwIfAborted();
    const worker = this.#worker ??= this.#createWorker();
    worker.ref();
    const { signal: _signal, ...serializableQuery } = query;
    const request: LocalCostWorkerRequest = { id: ++this.#nextId, metric, query: serializableQuery };
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.#worker === worker) this.#worker = null;
        // Do not start the next queued scan until this one has really stopped.
        void worker.terminate().then(() => reject(error), () => reject(error));
      };
      const onAbort = () => fail(signal.reason ?? new DOMException("Cost query cancelled", "AbortError"));
      const onError = () => fail(Object.assign(new Error("Local cost calculation failed"), { code: "LOCAL_COST_FAILED" }));
      const onExit = () => onError();
      const onMessage = (reply: Reply) => {
        if (reply.id !== request.id || settled) return;
        if (!reply.ok) { onError(); return; }
        settled = true;
        cleanup();
        worker.unref();
        resolve(reply.result);
      };
      const timer = setTimeout(() => fail(Object.assign(new Error("Local cost calculation timed out"), {
        code: "LOCAL_COST_TIMEOUT",
      })), this.timeoutMs);
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      worker.postMessage(request);
    });
  }

  #createWorker(): Worker {
    const worker = new Worker(workerUrl, {
      workerData: { databasePath: this.databasePath },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      execArgv: [
        ...process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
        ...(sourceRuntime ? ["--import", import.meta.resolve("tsx")] : []),
      ],
    });
    const retired = () => { if (this.#worker === worker) this.#worker = null; };
    // Keep a listener while idle too: an unexpected child failure must never
    // become an unhandled Worker error that brings down the API process.
    worker.on("error", retired);
    worker.on("exit", retired);
    return worker;
  }
}
