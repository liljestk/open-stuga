import { outdoorLocationKey } from "../db.js";
import { mapWithConcurrency } from "../timeseries/read-support.js";
import { MCP_THERMAL_HISTORY_READ_CONCURRENCY } from "./thermal-work.js";
import { mcpThermalDateRange, requireMcpHouse } from "./validation.js";
import {
  isMoistureResponseSensor,
  runMoistureResponseAsync,
} from "../analytics/thermal/moisture-response.js";
import { optionalToolString, requiredToolString } from "./arguments.js";
import {
  configuredHeatPumpConnectionIds,
  filterHeatPumpAffectedSampleMap,
  loadHeatPumpExclusionWindow,
} from "../analytics/heat-pump-evidence.js";
import type { McpRuntime } from "./runtime.js";

export async function homeMoistureResponse(
  runtime: McpRuntime,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { config, database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const { from, to } = mcpThermalDateRange(
    optionalToolString(args, "from"),
    optionalToolString(args, "to"),
  );
  const candidates = database.listSensors(house.id).filter((sensor) => sensor.enabled);
  const coverage = (await telemetryReader.measurementCoverage({
    sensorIds: candidates.map((sensor) => sensor.id),
    metrics: ["temperature", "humidity"],
  })).records;
  const temperatureSensors = new Set(
    coverage.filter((item) => item.metric === "temperature").map((item) => item.sensorId),
  );
  const humiditySensors = new Set(
    coverage.filter((item) => item.metric === "humidity").map((item) => item.sensorId),
  );
  const sensors = candidates.filter((sensor) => isMoistureResponseSensor(
    sensor,
    temperatureSensors.has(sensor.id),
    humiditySensors.has(sensor.id),
  ));
  if (sensors.length > 64) {
    throw new Error("Moisture response comparison supports at most 64 paired climate sensors");
  }

  const boundaryPaddingMs = 2 * 3_600_000;
  const [outdoorRead, indoorReads] = await Promise.all([
    telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
    }),
    mapWithConcurrency(sensors, MCP_THERMAL_HISTORY_READ_CONCURRENCY, (sensor) => telemetryReader.thermalMeasurementHistory({
      sensorId: sensor.id,
      metrics: ["temperature", "humidity"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
    })),
  ]);

  const heatPumpWindow = loadHeatPumpExclusionWindow(
    database,
    house.id,
    from,
    to,
    configuredHeatPumpConnectionIds(config.greeConnections, house.id),
  );
  const filtered = filterHeatPumpAffectedSampleMap(new Map(sensors.map((sensor, index) => [
    sensor.id,
    indoorReads[index]!.records,
  ])), heatPumpWindow, 5 * 60_000);
  return runMoistureResponseAsync({
    house,
    sensors,
    indoorSamplesBySensor: filtered.samplesBySensor,
    outdoorSamples: outdoorRead.records,
    from,
    to,
    hvacExclusion: filtered.summary,
    ...(heatPumpWindow.summary.evidenceState === "not-present" ? {} : { passiveIntervals: heatPumpWindow.passiveIntervals }),
  });
}
