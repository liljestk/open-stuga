import type { MeasurementSample } from "@climate-twin/contracts";
import { HttpError, parseMeasurementSample } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type MeasurementIngestRouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "v2Prefix"
  | "requireIngestKey"
  | "database"
  | "stuguby"
  | "measurements"
  | "telemetryArchive"
  | "visibility"
  | "cachedLatestMeasurements"
>;

/** Generic measurement ingest, bulk import, and the latest-value snapshot. */
export function registerMeasurementIngestRoutes(context: MeasurementIngestRouteContext): void {
  context.app.post(`${context.v2Prefix}/measurements`, context.requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    let input: unknown[];
    if (Array.isArray(candidate)) input = candidate;
    else if (candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)) {
      input = (candidate as { samples: unknown[] }).samples;
    } else if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).sample !== undefined) {
      input = [(candidate as Record<string, unknown>).sample];
    } else input = [candidate];
    if (input.length === 0 || input.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 measurement samples");
    const submitted = input.map((item) => parseMeasurementSample(item, context.database));
    for (const sample of submitted) {
      const sensor = context.database.getSensor(sample.sensorId);
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
    }
    const samples = context.measurements.ingestBatch(submitted);
    response.status(201).json({ accepted: samples.length, samples });
  });
  context.app.post(`${context.v2Prefix}/measurements/import`, context.requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    const input = candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)
      ? (candidate as { samples: unknown[] }).samples
      : [];
    if (input.length === 0 || input.length > 10_000) {
      throw new HttpError(400, "INVALID_BATCH", "Import between 1 and 10000 measurement samples at a time");
    }
    const submitted = input.map((item) => ({ ...parseMeasurementSample(item, context.database), source: "import" as const }));
    for (const sample of submitted) {
      const sensor = context.database.getSensor(sample.sensorId);
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
    }
    const samples = context.measurements.ingestBatch(submitted, {
      allowDisabledSensors: true,
      publish: false,
      evaluateAlerts: false,
      deduplicateAcrossSources: true,
    });
    if (samples.length > 0) void context.telemetryArchive?.reconcileNow().catch(() => undefined);
    response.status(201).json({ accepted: samples.length, ignoredDuplicates: submitted.length - samples.length });
  });
  context.app.get(`${context.v2Prefix}/measurements/snapshot`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    const access = context.visibility(response);
    if (houseId && (!context.database.getHouse(houseId) || !access.house(houseId))) {
      response.json({ snapshot: [] });
      return;
    }
    const latest = context.cachedLatestMeasurements(houseId);
    const bySensor = new Map<string, Record<string, MeasurementSample>>();
    for (const sample of latest) {
      const map = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
      map[sample.metric] = sample;
      bySensor.set(sample.sensorId, map);
    }
    const snapshot = context.database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)).map((sensor) => ({
      sensorId: sensor.id,
      measurements: bySensor.get(sensor.id) ?? {},
    }));
    response.json({ snapshot });
  });
}
