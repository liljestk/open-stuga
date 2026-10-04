import { parentPort, workerData } from "node:worker_threads";
import { ClimateDatabase } from "../db.js";
import type { EnergyCostAggregateQuery, MeasurementHistoryBucketedQuery } from "./types.js";

export type LocalBucketQuery = MeasurementHistoryBucketedQuery & { toExclusive?: boolean };
export type LocalCostWorkerOperation =
  | { metric: "energy" | "power"; query: Omit<EnergyCostAggregateQuery, "signal"> }
  | { metric: "buckets"; query: Omit<LocalBucketQuery, "signal"> };
export type LocalCostWorkerRequest = LocalCostWorkerOperation & { id: number };

if (!parentPort) throw new Error("Local cost worker requires a parent port");
const port = parentPort;
port.on("message", (request: LocalCostWorkerRequest) => {
  let database: ClimateDatabase | undefined;
  try {
    // A separate WAL reader sees committed data without running migrations or
    // seeding. Close it before replying, so an idle worker holds no read lock.
    database = new ClimateDatabase(workerData.databasePath as string, false, { readOnly: true });
    const result = request.metric === "buckets"
      ? database.measurementHistoryBucketed(request.query.sensorId, request.query.metric,
        request.query.from, request.query.to, request.query.bucketSeconds, request.query.limit,
        request.query.excludeSynthetic, request.query.toExclusive)
      : request.metric === "energy" ? database.energyCostAggregate(request.query)
        : database.powerCostAggregate(request.query);
    database.close();
    database = undefined;
    port.postMessage({ id: request.id, ok: true, result });
  } catch {
    // Paths, SQL and source identifiers must not cross the response boundary.
    port.postMessage({ id: request.id, ok: false });
  } finally {
    database?.close();
  }
});
