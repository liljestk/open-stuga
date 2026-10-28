import { HttpError, alertDurationSeconds, bodyObject, enumValue, measurementId, optionalBoolean, parseAlertDeliveryPolicy, parseAlertRule, requiredNumber, requiredString, safeInteger, visibleCollectionPage } from "./support/index.js";
import type { Request, Response } from "express";
import type { AlertEvent, AlertRulePatch } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Alert rules, alert events and acknowledgement. */
export function registerAlertRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/alert-rules`, (_request, response) => {
      const access = context.visibility(response);
      response.json({ rules: context.database.listAlertRules().filter((rule) => (
        !access.restricted || (rule.sensorId !== null && access.sensor(rule.sensorId))
      )) });
    });
  context.app.post(`${context.prefix}/alert-rules`, (request, response) => {
      const input = parseAlertRule(request.body, context.database);
      const sensor = input.sensorId ? context.database.getSensor(input.sensorId) : null;
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      response.status(201).json({ rule: context.database.saveAlertRule(input) });
    });
  context.app.patch(`${context.prefix}/alert-rules/:id`, (request, response) => {
      const current = context.database.getAlertRule(request.params.id as string);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
      const currentSensor = current.sensorId ? context.database.getSensor(current.sensorId) : null;
      if (currentSensor) context.stuguby.assertHouseLocalAuthority(currentSensor.houseId);
      const body = bodyObject(request.body);
      if (body.sensorId !== undefined && body.sensorId !== null) {
        const nextSensor = context.database.getSensor(requiredString(body, "sensorId"));
        if (nextSensor) context.stuguby.assertHouseLocalAuthority(nextSensor.houseId);
      }
      const rule = context.database.updateAlertRule(current.id, parseAlertRulePatch(context.database, body, current.sensorId));
      response.json({ rule });
    });
  context.app.delete(`${context.prefix}/alert-rules/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertRule(id);
      const sensor = current?.sensorId ? context.database.getSensor(current.sensorId) : null;
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      if (!context.database.deleteAlertRule(id)) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/alert-events`, (request, response) => {
      response.json({ events: visibleAlertEvents(context, request, response) });
    });
  // Compatibility path for the iOS companion: the same events under `alerts`.
  context.app.get(`${context.prefix}/alerts`, (request, response) => {
      response.json({ alerts: visibleAlertEvents(context, request, response) });
    });
  context.app.post(`${context.prefix}/alert-events/:id/acknowledge`, (request, response) => {
      response.json({ event: acknowledgeVisibleAlert(context, request.params.id as string, response) });
    });
  // Compatibility path for the iOS companion: the same acknowledgement, answered with the bare event.
  context.app.post(`${context.prefix}/alerts/:id/acknowledge`, (request, response) => {
      response.json(acknowledgeVisibleAlert(context, request.params.id as string, response));
    });
}

/** The newest alert events whose sensor the caller may see. */
function visibleAlertEvents(context: ApiRouteRegistrationContext, request: Request, response: Response): AlertEvent[] {
  const activeOnly = request.query.active === "true";
  const access = context.visibility(response);
  const limit = safeInteger(request.query.limit, 200, 1, 1_000);
  return visibleCollectionPage(
    (batchLimit, offset) => context.database.listAlertEvents(batchLimit, activeOnly, offset),
    (event) => access.sensor(event.sensorId),
    { limit, offset: 0 },
  );
}

/** Acknowledges a visible alert event and publishes the change; an event the caller cannot see is not found. */
function acknowledgeVisibleAlert(context: ApiRouteRegistrationContext, id: string, response: Response): AlertEvent {
  const current = context.database.getAlertEvent(id);
  if (!current || !context.visibility(response).sensor(current.sensorId)) {
    throw new HttpError(404, "NOT_FOUND", "Alert event not found");
  }
  const event = context.database.acknowledgeAlert(id, new Date().toISOString());
  if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
  context.bus.publish({ type: "alert", data: event });
  return event;
}

/** Validated alert-rule patch; only the fields present in the body change. */
function parseAlertRulePatch(database: ClimateDatabase, body: Record<string, unknown>, currentSensorId: string | null): AlertRulePatch {
  const present = (key: string) => body[key] !== undefined;
  const flag = (key: "enabled" | "webhookEnabled" | "telegramEnabled") => (
    present(key) ? { [key]: optionalBoolean(body, key) as boolean } : {}
  );
  return {
    ...(present("name") ? { name: requiredString(body, "name") } : {}),
    ...(present("sensorId") ? { sensorId: body.sensorId === null ? null : requiredString(body, "sensorId") } : {}),
    ...(present("metric") ? { metric: knownMetric(database, body.metric) } : {}),
    ...(present("operator") ? { operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator") } : {}),
    ...(present("threshold") ? { threshold: requiredNumber(body, "threshold") } : {}),
    ...(present("durationSeconds") ? { durationSeconds: alertDurationSeconds(body.durationSeconds) } : {}),
    ...(present("severity") ? { severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity") } : {}),
    ...flag("enabled"),
    ...flag("webhookEnabled"),
    ...flag("telegramEnabled"),
    ...(present("deliveryPolicy")
      ? { deliveryPolicy: parseAlertDeliveryPolicy(body.deliveryPolicy, sensorTimezone(database, currentSensorId)) }
      : {}),
  };
}

function knownMetric(database: ClimateDatabase, value: unknown): string {
  const metric = measurementId(value);
  if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
  return metric;
}

/** Quiet hours follow the rule's house; rules without a sensor use UTC. */
function sensorTimezone(database: ClimateDatabase, sensorId: string | null): string {
  const sensor = sensorId ? database.getSensor(sensorId) : null;
  return (sensor ? database.getHouse(sensor.houseId)?.timezone : undefined) ?? "UTC";
}
