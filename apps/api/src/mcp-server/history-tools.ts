import type { MeasurementSample, MeasurementSnapshotEntry, Reading } from "@climate-twin/contracts";
import { requireMcpHouse, mcpBoundedInteger, mcpIsoDate, requireMcpMeasurementTarget, requireMcpSensor, validateMcpDateRange } from "./validation.js";
import type { McpRuntime } from "./runtime.js";
import { optionalToolString, requiredToolString } from "./arguments.js";

export function measurementSnapshot(runtime: McpRuntime, houseId?: string): MeasurementSnapshotEntry[] {
  const { database } = runtime;
  if (houseId) requireMcpHouse(database, houseId);
  const bySensor = new Map<string, Record<string, MeasurementSample>>();
  for (const sample of database.latestMeasurementSamples(houseId)) {
    const measurements = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
    measurements[sample.metric] = sample;
    bySensor.set(sample.sensorId, measurements);
  }
  return database.listSensors(houseId).map((sensor) => ({
    sensorId: sensor.id,
    measurements: bySensor.get(sensor.id) ?? {},
  }));
}

export async function queryMeasurementHistory(runtime: McpRuntime, args: Record<string, unknown>): Promise<MeasurementSample[]> {
  const { database, telemetryReader } = runtime;
  const sensorId = requiredToolString(args, "sensorId");
  const metric = requiredToolString(args, "metric");
  requireMcpMeasurementTarget(database, sensorId, metric);
  const from = mcpIsoDate(requiredToolString(args, "from"), "from");
  const to = mcpIsoDate(requiredToolString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.measurementHistory({
    sensorId,
    metric,
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}

export async function querySensorHistory(runtime: McpRuntime, args: Record<string, unknown>): Promise<Reading[]> {
  const { database, telemetryReader } = runtime;
  const sensorId = requiredToolString(args, "sensorId");
  requireMcpSensor(database, sensorId);
  const from = mcpIsoDate(requiredToolString(args, "from"), "from");
  const to = mcpIsoDate(requiredToolString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.legacyReadingHistory({
    sensorIds: [sensorId],
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}

export function sensorDataGaps(runtime: McpRuntime, args: Record<string, unknown>): unknown {
  const { database } = runtime;
  const houseId = optionalToolString(args, "houseId");
  if (houseId) requireMcpHouse(database, houseId);
  const sensorId = optionalToolString(args, "sensorId");
  if (sensorId) requireMcpSensor(database, sensorId);
  return database.listSensorDataGaps(
    sensorId,
    mcpBoundedInteger(args.limit, "limit", 100, 1, 1_000),
  ).filter((gap) => !houseId || database.getSensor(gap.sensorId)?.houseId === houseId);
}
