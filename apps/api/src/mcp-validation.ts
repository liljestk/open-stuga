import type { ClimateDatabase } from "./db.js";

export function mcpIsoDate(value: string, field: string): string {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

export function validateMcpDateRange(from: string, to: string): void {
  if (Date.parse(from) > Date.parse(to)) throw new Error("from must be before or equal to to");
}

export function requireMcpSensor(database: ClimateDatabase, sensorId: string): void {
  if (!database.getSensor(sensorId)) throw new Error(`Unknown sensor: ${sensorId}`);
}

export function requireMcpMeasurementTarget(database: ClimateDatabase, sensorId: string, metric: string): void {
  requireMcpSensor(database, sensorId);
  if (!database.getMeasurementDefinition(metric)) throw new Error(`Unknown measurement metric: ${metric}`);
}
