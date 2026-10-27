import { withResponseSignal } from "./response-signal.js";
import type {
  MeasurementSample,
  Property,
} from "@climate-twin/contracts";
import { HttpError, boundedQueryInteger, boundedSseWriter, collectionPage, dateValue, localAuthorizationFingerprint, measurementId, parsePropertyInput, parsePropertyPatch, queryList, requestPrincipal, safeInteger, visibleCollectionPage } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";


export function configureApiPart11(context: ApiRouteRegistrationContext) {
  context.app.get(`${context.v2Prefix}/measurements/history`, async (request, response) => {
      if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
      if (!context.database.getSensor(request.query.sensorId) || !context.visibility(response).sensor(request.query.sensorId)) {
        throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      }
      const metric = measurementId(request.query.metric);
      if (!context.database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
      let before: { timestamp: string; source: string } | undefined;
      if (typeof request.query.cursor === "string" && request.query.cursor) {
        if (bucketSeconds !== null) {
          throw new HttpError(400, "INVALID_CURSOR", "cursor is supported only for raw history");
        }
        try {
          const decoded = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as unknown;
          if (!Array.isArray(decoded) || decoded.length !== 2
            || typeof decoded[0] !== "string" || !Number.isFinite(Date.parse(decoded[0]))
            || typeof decoded[1] !== "string" || decoded[1].length === 0 || decoded[1].length > 200) {
            throw new Error();
          }
          before = { timestamp: new Date(decoded[0]).toISOString(), source: decoded[1] };
        } catch {
          throw new HttpError(400, "INVALID_CURSOR", "cursor is invalid");
        }
      }
      // Bucketed reads cover the whole requested window regardless of length:
      // the hybrid reader tiles local SQLite work into day-scale statements and
      // lets the archive aggregate long histories, so the response is bounded
      // by buckets rather than by a raw-row cap that silently drops coverage.
      const abortController = new AbortController();
      const abortOnClose = () => abortController.abort(new DOMException("Client disconnected", "AbortError"));
      response.once("close", abortOnClose);
      if (response.destroyed) abortOnClose();
      const readSamples = (await context.analyticsWorkLimiter.run(
        "measurement-history",
        () => bucketSeconds === null
          ? context.telemetryReader.measurementHistory({
              sensorId: request.query.sensorId as string,
              metric,
              from,
              to,
              limit: limit + 1,
              signal: abortController.signal,
              ...(before ? { before } : {}),
            })
          : context.telemetryReader.measurementHistoryBucketed({
              sensorId: request.query.sensorId as string,
              metric,
              from,
              to,
              bucketSeconds,
              limit: limit + 1,
              signal: abortController.signal,
            }),
        abortController.signal,
      ).finally(() => response.off("close", abortOnClose))).records;
      const truncated = readSamples.length > limit;
      const samples = truncated ? readSamples.slice(-limit) : readSamples;
      const nextCursor = bucketSeconds === null && truncated && samples[0]
        ? Buffer.from(JSON.stringify([samples[0].timestamp, samples[0].source]), "utf8").toString("base64url")
        : null;
      response.json({ samples, from, to, bucketSeconds, truncated, nextCursor });
    });
  context.app.get(`${context.v2Prefix}/sensors/:id/measurements`, async (request, response) => {
      if (!context.database.getSensor(request.params.id) || !context.visibility(response).sensor(request.params.id)) {
        throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      }
      const limit = safeInteger(request.query.limit, 100, 1, 500);
      let before: { timestamp: string; id: number } | null = null;
      if (typeof request.query.cursor === "string" && request.query.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as unknown;
          if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string"
            || !Number.isSafeInteger(decoded[1]) || !Number.isFinite(Date.parse(decoded[0]))) throw new Error();
          before = { timestamp: new Date(decoded[0]).toISOString(), id: decoded[1] as number };
        } catch {
          throw new HttpError(400, "INVALID_CURSOR", "cursor is invalid");
        }
      }
      const page = await withResponseSignal(response, signal => context.database.sensorMeasurementPageAsync({
        sensorId: request.params.id, before, limit, signal,
      }));
      response.json(page);
    });
  context.app.get(`${context.v2Prefix}/measurements/events`, (request, response) => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const sensorFilter = new Set(queryList(request.query.sensorId));
      const metricFilter = new Set(queryList(request.query.metric));
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
      writer.send(": connected\n\n");
      const write = (sample: MeasurementSample): void => {
        if (response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access) return;
        if (!access.sensor(sample.sensorId)) return;
        if (sensorFilter.size > 0 && !sensorFilter.has(sample.sensorId)) return;
        if (metricFilter.size > 0 && !metricFilter.has(sample.metric)) return;
        writer.send(`event: measurement\ndata: ${JSON.stringify(sample)}\n\n`);
      };
      const unsubscribe = context.bus.subscribeMeasurements(write);
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) {
          if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
          writer.send(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
        }
      }, 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    });
  context.app.get(`${context.prefix}/properties`, (request, response) => {
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      const properties = visibleCollectionPage(
        (limit, offset) => context.database.listProperties(limit, offset),
        (property) => access.property(property) !== null,
        page,
      ).map((property) => access.property(property) as Property);
      response.json({ properties });
    });
  context.app.post(`${context.prefix}/properties`, (request, response) => {
      const property = context.database.createProperty(parsePropertyInput(request.body));
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ property });
    });
  context.app.get(`${context.prefix}/properties/:id`, (request, response) => {
      const candidate = context.database.getProperty(request.params.id as string);
      const property = candidate ? context.visibility(response).property(candidate) : null;
      if (!property) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.json({ property });
    });
  context.app.patch(`${context.prefix}/properties/:id`, (request, response) => {
      const propertyId = request.params.id as string;
      context.stuguby.assertPropertyWriteAllowed(propertyId);
      const patch = parsePropertyPatch(request.body);
      const property = context.database.transaction(() => {
        const updated = context.database.updateProperty(propertyId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property not found");
        const sharedFields = Object.keys(patch).filter((field) => field !== "defaultHouseId");
        if (sharedFields.length > 0) {
          context.stuguby.captureCurrentPropertyEntity(updated.id, "property", updated.id, "upsert", sharedFields);
        }
        return updated;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.json({ property });
    });
  context.app.delete(`${context.prefix}/properties/:id`, async (request, response) => {
      const propertyId = request.params.id as string;
      const property = context.database.getProperty(propertyId);
      if (property?.stuguby && property.stuguby.syncState !== "detached") {
        throw new HttpError(409, "STUGBY_DISCONNECT_REQUIRED", "Disconnect the Stuguby Property explicitly before deleting it");
      }
      context.requireImmutableTelemetryLineage("property", propertyId);
      if (!context.database.deleteProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.status(204).end();
    });
  const extended = Object.assign(context, {  });
  return extended;
}
