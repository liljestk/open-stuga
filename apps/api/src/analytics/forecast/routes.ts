import { withResponseSignal } from "../../app/response-signal.js";
import type express from "express";
import type { ForecastSeriesResponse } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { forecast, forecastMeasurementWithEvaluation } from "../../services.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import {
  HttpError,
  measurementId,
  queryList,
  safeInteger,
} from "../../app/support/index.js";
import type { AnalyticsWorkLimiter } from "../work-limiter.js";

export interface ForecastRouteContext {
  app: express.Express;
  prefix: string;
  v2Prefix: string;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  analyticsWorkLimiter: AnalyticsWorkLimiter;
  visibility(response: express.Response): {
    sensor(sensorId: string): boolean;
  };
}

export function registerForecastRoutes(context: ForecastRouteContext): void {
  context.app.get(`${context.v2Prefix}/measurements/forecast`, async (request, response) => {
    if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    if (!context.database.getSensor(request.query.sensorId) || !context.visibility(response).sensor(request.query.sensorId)) {
      throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    }
    const metric = measurementId(request.query.metric);
    const hours = safeInteger(request.query.hours, 12, 1, 168);
    const measurementForecast = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run(
      "measurement-forecast",
      () => forecastMeasurementWithEvaluation(context.database, {
        sensorId: request.query.sensorId as string,
        metric,
        hours,
        telemetryReader: context.telemetryReader,
        signal,
      }),
      signal,
    ));
    response.json({ forecast: measurementForecast.points, evaluation: measurementForecast.evaluation });
  });
  context.app.get(`${context.prefix}/forecast`, async (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const access = context.visibility(response);
    // One explicitly requested sensor answers like v2: missing or hidden is 404,
    // never an empty body whose shape depends on visibility.
    if (sensorIds.length === 1 && (!context.database.getSensor(sensorIds[0]!) || !access.sensor(sensorIds[0]!))) {
      throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    }
    const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
      .filter((sensorId) => access.sensor(sensorId));
    const horizonMinutes = safeInteger(request.query.horizonMinutes, 0, 0, 10_080);
    const hours = horizonMinutes > 0 ? Math.max(1, Math.ceil(horizonMinutes / 60)) : safeInteger(request.query.hours, 12, 1, 168);
    const series = await Promise.all(selected.map(async (sensorId) => ({
      sensorId,
      forecast: await forecast(context.database, sensorId, hours, context.telemetryReader),
    })));
    const body: ForecastSeriesResponse = {
      generatedAt: new Date().toISOString(),
      model: "backtested-v2",
      series,
      ...(sensorIds.length === 1 ? { forecast: series[0]!.forecast } : {}),
    };
    response.json(body);
  });
}
