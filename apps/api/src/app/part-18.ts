import { type Request, type Response } from "express";
import type {
  Reading,
  TelemetryEvent,
} from "@climate-twin/contracts";
import {
  forecast,
} from "../services.js";
import {
  bucketLegacyReadings,
} from "../timeseries/read-facade.js";
import { HttpError, alertDurationSeconds, bodyObject, boundedQueryInteger, boundedSseWriter, dateValue, enumValue, localAuthorizationFingerprint, measurementId, optionalBoolean, parseAlertDeliveryPolicy, parseAlertRule, queryList, requestPrincipal, requiredNumber, requiredString, safeInteger, visibleCollectionPage } from "./support/index.js";
import { configureApiPart17 } from "./part-17.js";


export function configureApiPart18(context: ReturnType<typeof configureApiPart17>) {
  context.app.get(`${context.prefix}/readings`, async (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      const limit = safeInteger(request.query.limit, 2_000, 1, 50_000);
      const readings = (await context.telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit })).records;
      response.json({ readings });
    });
  context.app.get(`${context.prefix}/history`, async (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
      const rawLimit = bucketSeconds === null ? limit + 1 : 100_000;
      const archived = (await context.telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit: rawLimit })).records;
      const requestedReadings = bucketSeconds === null ? archived : bucketLegacyReadings(archived, bucketSeconds);
      const truncated = requestedReadings.length > limit || (bucketSeconds !== null && archived.length === rawLimit);
      const readings = truncated ? requestedReadings.slice(-limit) : requestedReadings;
      const forecastHours = safeInteger(request.query.forecastHours, 0, 0, 168);
      const series = await Promise.all(selected.map(async (sensorId) => ({
        sensorId,
        readings: readings.filter((reading) => reading.sensorId === sensorId),
        forecast: forecastHours
          ? await forecast(context.database, sensorId, forecastHours, context.telemetryReader)
          : [],
      })));
      response.json({ from, to, bucketSeconds, series, truncated });
    });
  const streamTelemetry = (request: Request, response: Response): void => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const filter = new Set(queryList(request.query.sensorId));
      const releaseStream = context.acquireEventStream(response);
      if (!releaseStream) {
        response.setHeader("retry-after", "5");
        throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
      }
      const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();
      const writer = boundedSseWriter(response);
      const write = (event: TelemetryEvent): void => {
        if (response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access) return;
        if (access.restricted && event.type === "integration") return;
        if ((event.type === "reading" || event.type === "measurement" || event.type === "alert")
          && !access.sensor(event.data.sensorId)) return;
        if (event.type === "weather" && !access.house(event.data.houseId)) return;
        if (event.type === "opening" && !access.house(event.data.houseId)) return;
        if (event.type === "heat-pump" && !access.house(event.data.houseId)) return;
        if (event.type === "connected-device" && !access.house(event.data.houseId)) return;
        if (filter.size > 0 && (event.type === "reading" || event.type === "alert")) {
          const data = event.data as Reading | { sensorId: string };
          if (!filter.has(data.sensorId)) return;
        }
        const id = event.type === "weather" ? `id: ${event.data.id}\n` : "";
        writer.send(`${id}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };
      if (!context.visibility(response).restricted) write({ type: "integration", data: structuredClone(context.status.value) });
      const unsubscribe = context.bus.subscribe(write);
      const heartbeat = setInterval(() => write({ type: "heartbeat", data: { timestamp: new Date().toISOString() } }), 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    };
  context.app.get(`${context.prefix}/stream`, streamTelemetry);
  context.app.get(`${context.prefix}/events`, streamTelemetry);
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
      response.status(201).json(context.database.saveAlertRule(input));
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
      const rule = context.database.updateAlertRule(current.id, {
        ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
        ...(body.sensorId !== undefined ? { sensorId: body.sensorId === null ? null : requiredString(body, "sensorId") } : {}),
        ...(body.metric !== undefined ? { metric: (() => {
          const metric = measurementId(body.metric);
          if (!context.database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
          return metric;
        })() } : {}),
        ...(body.operator !== undefined ? { operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator") } : {}),
        ...(body.threshold !== undefined ? { threshold: requiredNumber(body, "threshold") } : {}),
        ...(body.durationSeconds !== undefined ? { durationSeconds: alertDurationSeconds(body.durationSeconds) } : {}),
        ...(body.severity !== undefined ? { severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity") } : {}),
        ...(body.enabled !== undefined ? { enabled: optionalBoolean(body, "enabled") as boolean } : {}),
        ...(body.webhookEnabled !== undefined ? { webhookEnabled: optionalBoolean(body, "webhookEnabled") as boolean } : {}),
        ...(body.telegramEnabled !== undefined ? { telegramEnabled: optionalBoolean(body, "telegramEnabled") as boolean } : {}),
        ...(body.deliveryPolicy !== undefined ? { deliveryPolicy: parseAlertDeliveryPolicy(
          body.deliveryPolicy,
          current.sensorId ? context.database.getHouse(context.database.getSensor(current.sensorId)?.houseId ?? "")?.timezone ?? "UTC" : "UTC",
        ) } : {}),
      });
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
      const activeOnly = request.query.active === "true";
      const access = context.visibility(response);
      const limit = safeInteger(request.query.limit, 200, 1, 1_000);
      response.json({ events: visibleCollectionPage(
        (batchLimit, offset) => context.database.listAlertEvents(batchLimit, activeOnly, offset),
        (event) => access.sensor(event.sensorId),
        { limit, offset: 0 },
      ) });
    });
  context.app.get(`${context.prefix}/alerts`, (request, response) => {
      const activeOnly = request.query.active === "true";
      const access = context.visibility(response);
      const limit = safeInteger(request.query.limit, 200, 1, 1_000);
      response.json({ alerts: visibleCollectionPage(
        (batchLimit, offset) => context.database.listAlertEvents(batchLimit, activeOnly, offset),
        (event) => access.sensor(event.sensorId),
        { limit, offset: 0 },
      ) });
    });
  context.app.post(`${context.prefix}/alert-events/:id/acknowledge`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertEvent(id);
      if (!current || !context.visibility(response).sensor(current.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      const event = context.database.acknowledgeAlert(id, new Date().toISOString());
      if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      context.bus.publish({ type: "alert", data: event });
      response.json({ event });
    });
  context.app.post(`${context.prefix}/alerts/:id/acknowledge`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertEvent(id);
      if (!current || !context.visibility(response).sensor(current.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      const event = context.database.acknowledgeAlert(id, new Date().toISOString());
      if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      context.bus.publish({ type: "alert", data: event });
      response.json(event);
    });
  const extended = Object.assign(context, { streamTelemetry });
  return extended;
}
