import { withSignal } from "@climate-twin/contracts";
import type {
  MeasurementSample,
  Reading,
} from "@climate-twin/contracts";
import { outdoorLocationKey } from "../db.js";
import {
  mcpBoundedInteger,
  mcpIsoDate,
  mcpOptionalFiniteNumber,
  mcpThermalDateRange,
  requireMcpHouse,
  requireMcpHouseSensor,
  requireMcpMeasurementTarget,
  requireMcpSensor,
  validateMcpDateRange,
} from "../mcp-validation.js";
import { runThermalSimulationAsync } from "../thermal-simulation.js";
import { config, database, optionalString, requiredString, telemetryReader } from "./01-config-to-get-house-weather.js";
import { runMcpThermalWork } from "./thermal-work.js";
import {
  configuredHeatPumpConnectionIds,
  filterHeatPumpAffectedSamples,
  loadHeatPumpExclusionWindow,
} from "../analytics/heat-pump-evidence.js";
import { HEAT_PUMP_SENSOR_TAG } from "../heat-pump-measurements.js";

export async function thermalSimulation(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const houseId = requiredString(args, "houseId");
  const house = requireMcpHouse(database, houseId);
  const sensor = requireMcpHouseSensor(database, houseId, requiredString(args, "sensorId"));
  if (sensor.tags.includes(HEAT_PUMP_SENSOR_TAG)) {
    throw new Error("Heat-pump equipment telemetry is not an ambient temperature sensor");
  }
  const { from, to } = mcpThermalDateRange(optionalString(args, "from"), optionalString(args, "to"));
  const horizonHours = mcpBoundedInteger(args.horizonHours, "horizonHours", 12, 0, 72);
  const scenarioOutdoorTemperatureC = mcpOptionalFiniteNumber(
    args.scenarioOutdoorTemperatureC,
    "scenarioOutdoorTemperatureC",
  );
  const boundaryPaddingMs = 2 * 3_600_000;
  return runMcpThermalWork({
    subjects: [sensor],
    ...withSignal(signal),
    readIndoor: (subject, readSignal) => telemetryReader.thermalMeasurementHistory({
      sensorId: subject.id,
      metrics: ["temperature"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
      ...withSignal(readSignal),
    }),
    readOutdoor: (readSignal) => telemetryReader.outdoorTemperatureHistory({
      houseId,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
      ...withSignal(readSignal),
    }),
    complete: ({ indoor, outdoor }, completionSignal) => {
      const heatPumpWindow = loadHeatPumpExclusionWindow(
        database,
        house.id,
        from,
        to,
        configuredHeatPumpConnectionIds(config.greeConnections, house.id),
      );
      const filtered = filterHeatPumpAffectedSamples(indoor[0]!.records, heatPumpWindow, 5 * 60_000);
      return runThermalSimulationAsync({
        houseId,
        sensorId: sensor.id,
        roomLabel: sensor.room,
        from,
        to,
        indoorSamples: filtered.samples,
        outdoorSamples: outdoor.records,
        horizonHours,
        scenarioOutdoorTemperatureC,
        hvacExclusion: filtered.summary,
        ...(heatPumpWindow.summary.evidenceState === "not-present" ? {} : { passiveIntervals: heatPumpWindow.passiveIntervals }),
      }, undefined, withSignal(completionSignal));
    },
  });
}

export async function queryMeasurementHistory(args: Record<string, unknown>): Promise<MeasurementSample[]> {
  const sensorId = requiredString(args, "sensorId");
  const metric = requiredString(args, "metric");
  requireMcpMeasurementTarget(database, sensorId, metric);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.measurementHistory({
    sensorId,
    metric,
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}

export async function querySensorHistory(args: Record<string, unknown>): Promise<Reading[]> {
  const sensorId = requiredString(args, "sensorId");
  requireMcpSensor(database, sensorId);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.legacyReadingHistory({
    sensorIds: [sensorId],
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}
