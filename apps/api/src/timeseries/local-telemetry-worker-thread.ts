import { parentPort, workerData } from "node:worker_threads";
import { ClimateDatabase } from "../db.js";
import type { EnergyCostAggregateQuery, MeasurementCoverageQuery, MeasurementHistoryBucketedQuery, MeasurementWindowQuery, ThermalMeasurementHistoryQuery } from "./types.js";
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
  | { metric: "coverage"; query: Omit<MeasurementCoverageQuery, "signal"> }
  | { metric: "thermal"; query: Omit<ThermalMeasurementHistoryQuery, "signal"> }
  | { metric: "power-profile"; query: Omit<LocalPowerProfileQuery, "signal"> }
  | { metric: "export-counts"; query: { tables: readonly ExportTable[] } }
  | { metric: "integrity"; query: Record<string, never> };
export type LocalTelemetryWorkerRequest = LocalTelemetryWorkerOperation & { id: number };

function readTelemetry(database: ClimateDatabase, request: LocalTelemetryWorkerOperation) {
  switch (request.metric) {
    case "power-profile": return localPowerProfile(database, request.query);
    case "window": return database.measurementWindow(request.query);
    case "coverage": return database.measurementCoverage(request.query.sensorIds, request.query.metrics, request.query.dataMode);
    case "thermal":
      return request.query.metrics.length === 1 && request.query.metrics[0] === "temperature"
        ? database.thermalTemperatureHistory(request.query)
        : database.thermalClimateHistory(request.query).filter((sample) => request.query.metrics.includes(sample.metric));
    case "sensor-page": return database.sensorMeasurementPage(request.query.sensorId, request.query.before, request.query.limit);
    case "export-counts": return exportTableCounts(database, request.query.tables);
    case "integrity": return databaseIntegrity(database);
    case "buckets": return database.measurementHistoryBucketed(request.query);
    case "energy": return database.energyCostAggregate(request.query);
    case "power": return database.powerCostAggregate(request.query);
  }
}

if (!parentPort) throw new Error("Local cost worker requires a parent port");
const port = parentPort;
port.on("message", (request: LocalTelemetryWorkerRequest) => {
  let database: ClimateDatabase | undefined;
  try {
    // A separate WAL reader sees committed data without running migrations or
    // seeding. Close it before replying, so an idle worker holds no read lock.
    database = new ClimateDatabase(workerData.databasePath as string, false, { readOnly: true });
    const result = readTelemetry(database, request);
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
