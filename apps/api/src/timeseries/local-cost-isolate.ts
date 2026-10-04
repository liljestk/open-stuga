import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import { AnalyticsWorkLimiter } from "../analytics/work-limiter.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementWindowQuery, ThermalMeasurementHistoryQuery } from "./types.js";
import type { LocalBucketQuery, LocalSensorPageQuery, LocalCostWorkerOperation, LocalCostWorkerRequest } from "./local-cost-worker.js";
import type { ExportTable, DatabaseIntegrityResult } from "../db/inspection.js";
import type { LocalPowerProfileQuery, PowerProfile } from "./read-power-profile.js";

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false };
const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
const workerUrl = new URL(sourceRuntime ? "./local-cost-worker.ts" : "./local-cost-worker.js", import.meta.url);

export class LocalTelemetryTimeoutError extends Error {
  readonly code: "LOCAL_HISTORY_TIMEOUT" | "LOCAL_COST_TIMEOUT";
  constructor(history: boolean) {
    super(history ? "Local history read timed out" : "Local cost calculation timed out");
    this.name = "LocalTelemetryTimeoutError";
    this.code = history ? "LOCAL_HISTORY_TIMEOUT" : "LOCAL_COST_TIMEOUT";
  }
}

/** Cost and history scans share one bounded read-only worker per database. */
export class LocalCostIsolate {
  readonly #limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 8 });
  readonly #shutdown = new AbortController();
  #worker: Worker | null = null;
  #nextId = 0;

  constructor(readonly databasePath: string, readonly timeoutMs = 15_000) {}

  read(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
    const { signal, ...serializableQuery } = query;
    return this.#run<EnergyCostAggregateRecord>({ metric, query: serializableQuery }, signal);
  }

  readBuckets(query: LocalBucketQuery): Promise<MeasurementSample[]> {
    const { signal, ...serializableQuery } = query;
    return this.#run<MeasurementSample[]>({ metric: "buckets", query: serializableQuery }, signal);
  }

  readSensorPage(query: LocalSensorPageQuery): Promise<{ samples: MeasurementSample[]; nextCursor: string | null }> {
    const { signal, ...serializableQuery } = query;
    return this.#run({ metric: "sensor-page", query: serializableQuery }, signal);
  }

  readExportCounts(tables: readonly ExportTable[], signal?: AbortSignal): Promise<Record<string, number>> {
    return this.#run({ metric: "export-counts", query: { tables } }, signal);
  }

  readIntegrity(signal?: AbortSignal): Promise<DatabaseIntegrityResult> {
    return this.#run({ metric: "integrity", query: {} }, signal);
  }

  readWindow(query: MeasurementWindowQuery): Promise<MeasurementSample[]> {
    const { signal, ...serializableQuery } = query;
    return this.#run({ metric: "window", query: serializableQuery }, signal);
  }
  readPowerProfile(query: LocalPowerProfileQuery): Promise<PowerProfile> {
    const { signal, ...serializableQuery } = query;
    return this.#run({ metric: "power-profile", query: serializableQuery }, signal);
  }

  readThermal(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSample[]> {
    const { signal, ...serializableQuery } = query;
    return this.#run({ metric: "thermal", query: serializableQuery }, signal);
  }

  #run<Result>(operation: LocalCostWorkerOperation, callerSignal?: AbortSignal): Promise<Result> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.#shutdown.signal]) : this.#shutdown.signal;
    return this.#limiter.run(`sqlite-${operation.metric}`,
      () => this.#read<Result>(operation, signal), signal);
  }

  close(): void {
    this.#shutdown.abort(new DOMException("Local cost reader closed", "AbortError"));
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate();
  }

  #read<Result>(operation: LocalCostWorkerOperation, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    const worker = this.#worker ??= this.#createWorker();
    worker.ref();
    const request: LocalCostWorkerRequest = { ...operation, id: ++this.#nextId };
    const history = operation.metric !== "energy" && operation.metric !== "power";
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
      const onAbort = () => fail(signal.reason ?? new DOMException("Local query cancelled", "AbortError"));
      const onError = () => fail(Object.assign(new Error(history ? "Local history read failed" : "Local cost calculation failed"),
        { code: history ? "LOCAL_HISTORY_FAILED" : "LOCAL_COST_FAILED" }));
      const onExit = () => onError();
      const onMessage = (reply: Reply) => {
        if (reply.id !== request.id || settled) return;
        if (!reply.ok) { onError(); return; }
        settled = true;
        cleanup();
        worker.unref();
        resolve(reply.result as Result);
      };
      const timer = setTimeout(() => fail(new LocalTelemetryTimeoutError(history)), this.timeoutMs);
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
