import { parentPort, workerData } from "node:worker_threads";
import { ClimateDatabase } from "../db.js";
import type { EnergyCostAggregateQuery, MeasurementHistoryBucketedQuery, MeasurementWindowQuery, ThermalMeasurementHistoryQuery } from "./types.js";
import { databaseIntegrity, exportTableCounts, type ExportTable } from "../db/inspection.js";
import { localPowerProfile } from "../db/local-power-profile.js";
import type { LocalPowerProfileQuery } from "./read-power-profile.js";

export interface LocalSensorPageQuery {
  sensorId: string;
  before: { timestamp: string; id: number } | null;
  limit: number;
  signal?: AbortSignal;
}

export type LocalBucketQuery = MeasurementHistoryBucketedQuery & { toExclusive?: boolean };
export type LocalTelemetryWorkerOperation =
  | { metric: "energy" | "power"; query: Omit<EnergyCostAggregateQuery, "signal"> }
  | { metric: "buckets"; query: Omit<LocalBucketQuery, "signal"> }
  | { metric: "sensor-page"; query: Omit<LocalSensorPageQuery, "signal"> }
  | { metric: "window"; query: Omit<MeasurementWindowQuery, "signal"> }
  | { metric: "thermal"; query: Omit<ThermalMeasurementHistoryQuery, "signal"> }
  | { metric: "power-profile"; query: Omit<LocalPowerProfileQuery, "signal"> }
  | { metric: "export-counts"; query: { tables: readonly ExportTable[] } }
  | { metric: "integrity"; query: Record<string, never> };
export type LocalTelemetryWorkerRequest = LocalTelemetryWorkerOperation & { id: number };

if (!parentPort) throw new Error("Local cost worker requires a parent port");
const port = parentPort;
port.on("message", (request: LocalTelemetryWorkerRequest) => {
  let database: ClimateDatabase | undefined;
  try {
    // A separate WAL reader sees committed data without running migrations or
    // seeding. Close it before replying, so an idle worker holds no read lock.
    database = new ClimateDatabase(workerData.databasePath as string, false, { readOnly: true });
    const result = request.metric === "power-profile" ? localPowerProfile(database, request.query)
      : request.metric === "window"
      ? database.measurementWindow(request.query)
      : request.metric === "thermal"
        ? (request.query.metrics.length === 1 && request.query.metrics[0] === "temperature"
          ? database.thermalTemperatureHistory(request.query)
          : database.thermalClimateHistory(request.query)
            .filter(sample => request.query.metrics.includes(sample.metric)))
      : request.metric === "sensor-page"
      ? database.sensorMeasurementPage(request.query.sensorId, request.query.before, request.query.limit)
      : request.metric === "export-counts" ? exportTableCounts(database, request.query.tables)
      : request.metric === "integrity" ? databaseIntegrity(database)
      : request.metric === "buckets"
      ? database.measurementHistoryBucketed(request.query)
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
