import type { TelemetryEvent } from "@climate-twin/contracts";
import { HttpError, parseReading, queryList, boundedQueryInteger, boundedSseWriter, dateValue, localAuthorizationFingerprint, requestPrincipal, safeInteger } from "./support/index.js";
import { type Request, type Response } from "express";
import { forecast } from "../services.js";
import { bucketLegacyReadings } from "../timeseries/read-facade.js";
import { visibleStreamEvent } from "./live-stream-visibility.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** v1 readings, reading history and the live telemetry event stream. */
export function registerTelemetryRoutes(context: ApiRouteRegistrationContext): void {
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
        const visible = visibleStreamEvent(event, access);
        if (!visible) return;
        if (filter.size > 0 && (visible.type === "reading" || visible.type === "alert")
          && !filter.has(visible.data.sensorId)) return;
        const id = visible.type === "weather" ? `id: ${visible.data.id}\n` : "";
        writer.send(`${id}event: ${visible.type}\ndata: ${JSON.stringify(visible.data)}\n\n`);
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
  context.app.post(`${context.prefix}/readings`, context.requireIngestKey, (request, response) => {
      const candidate = request.body as unknown;
      const readingsInput = Array.isArray(candidate) ? candidate : (
        candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).readings)
          ? (candidate as { readings: unknown[] }).readings : [candidate]
      );
      if (readingsInput.length === 0 || readingsInput.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 readings");
      const submitted = readingsInput.map(parseReading);
      for (const reading of submitted) {
        const sensor = context.database.getSensor(reading.sensorId);
        if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const readings = context.telemetry.ingestBatch(submitted);
      response.status(201).json({ readings, ignoredDuplicates: submitted.length - readings.length });
    });
  context.app.get(`${context.prefix}/readings/latest`, (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const selectedIds = new Set(selected);
      response.json({ readings: selected.length > 0
        ? context.cachedLatestReadings().filter((reading) => selectedIds.has(reading.sensorId))
        : [] });
    });
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
  context.app.get(`${context.prefix}/stream`, streamTelemetry);
  context.app.get(`${context.prefix}/events`, streamTelemetry);
}
