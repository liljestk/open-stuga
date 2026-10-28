import type { AlertRule, AlertDeliveryPolicy } from "@climate-twin/contracts";
import { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, optionalBoolean, requiredNumber, requiredString } from "../../request-fields.js";
import { normalizeAlertDeliveryPolicy } from "../../notification-policy.js";
import { measurementId } from "./measurement-fields.js";

export function alertDurationSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 31_536_000) {
    throw new HttpError(400, "INVALID_FIELD", "durationSeconds must be an integer from 1 to 31536000");
  }
  return value;
}

export function parseAlertRule(value: unknown, database: ClimateDatabase): Omit<AlertRule, "id"> & { id?: string } {
  const body = bodyObject(value);
  const sensorId = body.sensorId;
  if (sensorId !== null && sensorId !== undefined && typeof sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId must be a string or null");
  const sensor = typeof sensorId === "string" ? database.getSensor(sensorId) : null;
  const fallbackTimeZone = sensor ? database.getHouse(sensor.houseId)?.timezone ?? "UTC" : "UTC";
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    name: requiredString(body, "name"),
    sensorId: typeof sensorId === "string" ? sensorId : null,
    metric: (() => {
      const metric = measurementId(body.metric);
      if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
      return metric;
    })(),
    operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator"),
    threshold: requiredNumber(body, "threshold"),
    durationSeconds: alertDurationSeconds(body.durationSeconds),
    severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity"),
    enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
    webhookEnabled: body.webhookEnabled === undefined ? false : optionalBoolean(body, "webhookEnabled") as boolean,
    telegramEnabled: body.telegramEnabled === undefined ? false : optionalBoolean(body, "telegramEnabled") as boolean,
    deliveryPolicy: parseAlertDeliveryPolicy(body.deliveryPolicy, fallbackTimeZone),
  };
}

export function parseAlertDeliveryPolicy(value: unknown, fallbackTimeZone = "UTC"): AlertDeliveryPolicy {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new HttpError(400, "INVALID_FIELD", "deliveryPolicy must be an object");
  }
  try {
    return normalizeAlertDeliveryPolicy(value as Partial<AlertDeliveryPolicy> | undefined, fallbackTimeZone);
  } catch (error) {
    throw new HttpError(400, "INVALID_FIELD", error instanceof Error ? error.message : "deliveryPolicy is invalid");
  }
}
