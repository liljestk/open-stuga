import { withResponseSignal } from "../app/response-signal.js";
import type express from "express";
import type { House, MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import { outdoorLocationKey, type ClimateDatabase } from "../db.js";
import { HEAT_PUMP_SENSOR_TAG } from "../heat-pump-measurements.js";
import { isMoistureResponseSensor } from "./thermal/moisture-response.js";
import { isThermalIsolationTemperatureSensor } from "./thermal/isolation.js";
import { runThermalSimulationAsync } from "./thermal/simulation.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { mapWithConcurrency } from "../timeseries/read-support.js";
import { HttpError } from "../http-error.js";
import { dateValue, optionalQueryNumber, safeInteger } from "../app/support/query-fields.js";
import { requireVisibleHouse } from "../app/support/house-access.js";
import {
  runMoistureResponseIsolated,
  runThermalIsolationIsolated,
} from "./derived-artifacts/fit-isolate.js";
import {
  configuredHeatPumpConnectionIds,
  filterHeatPumpAffectedSampleMap,
  filterHeatPumpAffectedSamples,
  loadHeatPumpExclusionWindow,
  type HeatPumpExclusionWindow,
} from "./heat-pump-evidence.js";
import type { AnalyticsWorkLimiter } from "./work-limiter.js";

export interface ThermalAnalyticsRouteContext {
  app: express.Express;
  prefix: string;
  config: Pick<AppConfig, "greeConnections">;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  analyticsWorkLimiter: AnalyticsWorkLimiter;
  visibility(response: express.Response): {
    house(houseId: string): boolean;
    sensor(sensorId: string): boolean;
  };
}

const DEFAULT_RANGE_MS = 7 * 24 * 3_600_000;
const MAX_RANGE_MS = 14 * 24 * 3_600_000;
const OUTDOOR_BOUNDARY_PADDING_MS = 2 * 3_600_000;
const HEAT_PUMP_SETTLE_MS = 5 * 60_000;

/** Passive-response fits default to the last week and never exceed two weeks. */
function calibrationRange(request: express.Request, label: string): { from: string; to: string } {
  const to = dateValue(request.query.to, new Date(), "to");
  const from = dateValue(request.query.from, new Date(Date.parse(to) - DEFAULT_RANGE_MS), "from");
  if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_MS) {
    throw new HttpError(400, "RANGE_TOO_LARGE", `${label} range cannot exceed 14 days`);
  }
  return { from, to };
}

function outdoorTemperatures(
  context: ThermalAnalyticsRouteContext,
  house: House,
  from: string,
  to: string,
  signal: AbortSignal,
) {
  return context.telemetryReader.outdoorTemperatureHistory({
    houseId: house.id,
    locationKey: outdoorLocationKey(house.location),
    from: new Date(Date.parse(from) - OUTDOOR_BOUNDARY_PADDING_MS).toISOString(),
    to: new Date(Date.parse(to) + OUTDOOR_BOUNDARY_PADDING_MS).toISOString(),
    limit: 50_000,
    signal,
  });
}

function heatPumpWindow(
  context: ThermalAnalyticsRouteContext,
  house: House,
  from: string,
  to: string,
): HeatPumpExclusionWindow {
  return loadHeatPumpExclusionWindow(
    context.database,
    house.id,
    from,
    to,
    configuredHeatPumpConnectionIds(context.config.greeConnections, house.id),
  );
}

function passiveIntervals(window: HeatPumpExclusionWindow) {
  return window.summary.evidenceState === "not-present" ? {} : { passiveIntervals: window.passiveIntervals };
}

export function registerThermalAnalyticsRoutes(context: ThermalAnalyticsRouteContext): void {
  context.app.get(`${context.prefix}/houses/:id/thermal-simulation`, async (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.id as string);
    if (typeof request.query.sensorId !== "string" || !request.query.sensorId) {
      throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    }
    const sensor = context.database.getSensor(request.query.sensorId);
    if (!sensor) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    if (sensor.houseId !== house.id) {
      throw new HttpError(409, "SENSOR_HOUSE_MISMATCH", "Sensor does not belong to the selected house");
    }
    if (sensor.tags.includes(HEAT_PUMP_SENSOR_TAG)) {
      throw new HttpError(422, "SENSOR_NOT_AMBIENT", "Heat-pump equipment telemetry is not an ambient temperature sensor");
    }
    const { from, to } = calibrationRange(request, "thermal calibration");
    const horizonHours = safeInteger(request.query.horizonHours, 12, 0, 72);
    const scenarioOutdoorTemperatureC = optionalQueryNumber(request.query.scenarioOutdoorTemperatureC, "scenarioOutdoorTemperatureC");
    const startedAt = performance.now();
    const result = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run("thermal-simulation", async () => {
      const [indoorRead, outdoorRead] = await Promise.all([
        context.telemetryReader.thermalMeasurementHistory({
          sensorId: sensor.id,
          metrics: ["temperature"],
          from,
          to,
          bucketMinutes: 5,
          limitPerMetric: 5_000,
          signal,
        }),
        outdoorTemperatures(context, house, from, to, signal),
      ]);
      const window = heatPumpWindow(context, house, from, to);
      const filtered = filterHeatPumpAffectedSamples(indoorRead.records, window, HEAT_PUMP_SETTLE_MS);
      return runThermalSimulationAsync({
        houseId: house.id,
        sensorId: sensor.id,
        roomLabel: sensor.room,
        from,
        to,
        indoorSamples: filtered.samples,
        outdoorSamples: outdoorRead.records,
        horizonHours,
        scenarioOutdoorTemperatureC,
        hvacExclusion: filtered.summary,
        ...passiveIntervals(window),
      }, undefined, { signal });
    }, signal));
    response.setHeader(
      "server-timing",
      `thermal-simulation;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json({ simulation: result });
  });
  context.app.get(`${context.prefix}/houses/:id/thermal-isolation`, async (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.id as string);
    const { from, to } = calibrationRange(request, "thermal isolation");
    const sensorCandidates = context.database.listSensors(house.id)
      .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
    const sensorsWithTemperatureHistory = new Set(
      (await context.telemetryReader.measurementCoverage({
        sensorIds: sensorCandidates.map((sensor) => sensor.id),
        metrics: ["temperature"],
      })).records
        .map((coverage) => coverage.sensorId),
    );
    const sensors = sensorCandidates.filter((sensor) =>
      isThermalIsolationTemperatureSensor(sensor, sensorsWithTemperatureHistory.has(sensor.id)));
    if (sensors.length > 64) {
      throw new HttpError(422, "THERMAL_SCOPE_TOO_LARGE", "thermal isolation comparison supports at most 64 temperature sensors per request");
    }
    const startedAt = performance.now();
    const result = await withResponseSignal(response, (signal) => sensors.length === 0
      ? runThermalIsolationIsolated({
        house,
        sensors,
        indoorSamplesBySensor: new Map<string, MeasurementSample[]>(),
        outdoorSamples: [],
        from,
        to,
      }, signal)
      : context.analyticsWorkLimiter.run("thermal-isolation", async () => {
        const [outdoorRead, indoorReads] = await Promise.all([
          outdoorTemperatures(context, house, from, to, signal),
          mapWithConcurrency(sensors, 2, (sensor) => (
            context.telemetryReader.thermalMeasurementHistory({
              sensorId: sensor.id,
              metrics: ["temperature"],
              from,
              to,
              bucketMinutes: 5,
              limitPerMetric: 5_000,
              signal,
            })
          )),
        ]);
        const indoorSamplesBySensor = new Map(sensors.map((sensor, index) => [
          sensor.id,
          indoorReads[index]!.records,
        ]));
        const window = heatPumpWindow(context, house, from, to);
        const filtered = filterHeatPumpAffectedSampleMap(indoorSamplesBySensor, window, HEAT_PUMP_SETTLE_MS);
        return runThermalIsolationIsolated({
          house,
          sensors,
          indoorSamplesBySensor: filtered.samplesBySensor,
          outdoorSamples: outdoorRead.records,
          from,
          to,
          hvacExclusion: filtered.summary,
          ...passiveIntervals(window),
        }, signal);
      }, signal));
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "server-timing",
      `thermal-isolation;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json({ isolation: result });
  });
  context.app.get(`${context.prefix}/houses/:id/moisture-response`, async (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.id as string);
    const { from, to } = calibrationRange(request, "moisture response");
    const sensorCandidates = context.database.listSensors(house.id)
      .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
    const coverage = (await context.telemetryReader.measurementCoverage({
      sensorIds: sensorCandidates.map((sensor) => sensor.id),
      metrics: ["temperature", "humidity"],
    })).records;
    const sensorsWithTemperature = new Set(
      coverage.filter((item) => item.metric === "temperature").map((item) => item.sensorId),
    );
    const sensorsWithHumidity = new Set(
      coverage.filter((item) => item.metric === "humidity").map((item) => item.sensorId),
    );
    const sensors = sensorCandidates.filter((sensor) => isMoistureResponseSensor(
      sensor,
      sensorsWithTemperature.has(sensor.id),
      sensorsWithHumidity.has(sensor.id),
    ));
    if (sensors.length > 64) {
      throw new HttpError(422, "MOISTURE_SCOPE_TOO_LARGE", "moisture response comparison supports at most 64 paired climate sensors per request");
    }
    const startedAt = performance.now();
    const result = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run("moisture-response", async () => {
      const [outdoorRead, indoorReads] = await Promise.all([
        outdoorTemperatures(context, house, from, to, signal),
        mapWithConcurrency(sensors, 2, (sensor) => (
          context.telemetryReader.thermalMeasurementHistory({
            sensorId: sensor.id,
            metrics: ["temperature", "humidity"],
            from,
            to,
            bucketMinutes: 5,
            limitPerMetric: 5_000,
            signal,
          })
        )),
      ]);
      const indoorSamplesBySensor = new Map(sensors.map((sensor, index) => [
        sensor.id,
        indoorReads[index]!.records,
      ]));
      const window = heatPumpWindow(context, house, from, to);
      const filtered = filterHeatPumpAffectedSampleMap(indoorSamplesBySensor, window, HEAT_PUMP_SETTLE_MS);
      return runMoistureResponseIsolated({
        house,
        sensors,
        indoorSamplesBySensor: filtered.samplesBySensor,
        outdoorSamples: outdoorRead.records,
        from,
        to,
        hvacExclusion: filtered.summary,
        ...passiveIntervals(window),
      }, signal);
    }, signal));
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "server-timing",
      `moisture-response;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json({ moistureResponse: result });
  });
}
