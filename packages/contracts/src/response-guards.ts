import type { AnalyticsDiagnostics } from "./analytics-diagnostics.js";
import type { ElectricityInvoice, ElectricityInvoiceReconciliation, PropertyElectricityTariff } from "./electricity-tariffs.js";
import type { HomeEnergyProjection } from "./energy-projection.js";
import type { MeasurementForecastEvaluation, MeasurementForecastPoint } from "./measurement-analytics.js";
import type { ForecastPoint, ForecastSeriesResponse, NotificationDeliveryStatus } from "./sensors-alerts.js";

/** A response body did not have the shape its endpoint documents. */
export class ResponseShapeError extends Error {
  constructor(readonly endpoint: string, detail?: string) {
    super(`Unexpected response shape from ${endpoint}${detail ? ` (${detail})` : ""}`);
    this.name = "ResponseShapeError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNullableNumber = (value: unknown) => value === null || isNumber(value);
const isString = (value: unknown): value is string => typeof value === "string";
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => (
  typeof value === "string" && (options as readonly string[]).includes(value)
);

/** Returns the value typed when the guard accepts it; throws `ResponseShapeError` otherwise. */
export function expectShape<T>(value: unknown, guard: (candidate: unknown) => candidate is T, endpoint: string): T {
  if (!guard(value)) throw new ResponseShapeError(endpoint);
  return value;
}

export function isHomeEnergyProjection(value: unknown): value is HomeEnergyProjection {
  return isRecord(value) && isString(value.houseId) && oneOf(value.method, ["weather-regression", "recent-average"])
    && isNumber(value.next30DaysKwh) && isNumber(value.lowKwh) && isNumber(value.highKwh) && isNumber(value.dailyKwh)
    && isNullableNumber(value.estimatedCostEur) && oneOf(value.confidence, ["low", "medium", "high"])
    && isRecord(value.backtest) && isNumber(value.backtest.origins);
}

export function isAnalyticsDiagnostics(value: unknown): value is AnalyticsDiagnostics {
  return isRecord(value) && isString(value.houseId) && isNumber(value.windowDays)
    && Array.isArray(value.latency) && value.latency.every((item) => isRecord(item) && isString(item.operation) && isNumber(item.requests))
    && Array.isArray(value.forecasts) && value.forecasts.every((item) => isRecord(item) && isString(item.metric))
    && isRecord(value.bills) && isNumber(value.bills.invoices)
    && (value.projection === null || isRecord(value.projection)) && (value.findings === null || isRecord(value.findings));
}

export function isMeasurementForecastEvaluation(value: unknown): value is MeasurementForecastEvaluation {
  return isRecord(value) && isString(value.sensorId) && isString(value.metric)
    && oneOf(value.status, ["ready", "no-skill", "insufficient-history"]) && Array.isArray(value.horizons)
    && isNullableNumber(value.skill6h) && isNullableNumber(value.skill24h) && isNullableNumber(value.coverage90);
}

export function isMeasurementForecastPoints(value: unknown): value is MeasurementForecastPoint[] {
  return Array.isArray(value) && value.every((point) => isRecord(point) && isString(point.timestamp) && isNumber(point.value));
}

export function isForecastPoints(value: unknown): value is ForecastPoint[] {
  return Array.isArray(value) && value.every((point) => isRecord(point) && isString(point.sensorId) && isString(point.timestamp)
    && isNumber(point.temperature) && isNumber(point.humidity));
}

export function isForecastSeriesResponse(value: unknown): value is ForecastSeriesResponse {
  return isRecord(value) && isString(value.generatedAt) && Array.isArray(value.series)
    && value.series.every((item) => isRecord(item) && isString(item.sensorId) && isForecastPoints(item.forecast));
}

export function isNotificationDeliveryStatus(value: unknown): value is NotificationDeliveryStatus {
  return isRecord(value) && isString(value.id) && isString(value.subjectKind) && isString(value.subjectId)
    && isString(value.channel) && isNumber(value.attempts) && isString(value.createdAt);
}

export function isNotificationDeliveryList(value: unknown): value is NotificationDeliveryStatus[] {
  return Array.isArray(value) && value.every(isNotificationDeliveryStatus);
}

export function isPropertyElectricityTariff(value: unknown): value is PropertyElectricityTariff {
  return isRecord(value) && isString(value.propertyId) && isNumber(value.revision) && Array.isArray(value.versions);
}

export function isElectricityInvoice(value: unknown): value is ElectricityInvoice {
  return isRecord(value) && isString(value.id) && isString(value.houseId) && isString(value.periodStart)
    && isString(value.periodEnd) && isNumber(value.totalEur);
}

export function isElectricityInvoiceReconciliation(value: unknown): value is ElectricityInvoiceReconciliation {
  return isRecord(value) && isString(value.invoiceId) && oneOf(value.status, ["reconciled", "outside_tolerance", "incomplete"])
    && isRecord(value.total) && isNumber(value.total.invoicedEur);
}
