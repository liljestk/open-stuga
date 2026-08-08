import { outdoorLocationKey } from "../db.js";
import { mcpThermalDateRange, requireMcpHouse } from "../mcp-validation.js";
import {
  isMoistureResponseSensor,
  runMoistureResponseAsync,
} from "../moisture-response.js";
import {
  database,
  optionalString,
  requiredString,
  telemetryReader,
} from "./01-config-to-get-house-weather.js";
import {
  filterHeatPumpAffectedSampleMap,
  loadHeatPumpExclusionWindow,
} from "../analytics/heat-pump-evidence.js";

export async function homeMoistureResponse(
  args: Record<string, unknown>,
): Promise<unknown> {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const { from, to } = mcpThermalDateRange(
    optionalString(args, "from"),
    optionalString(args, "to"),
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
  const [outdoorRead, ...indoorReads] = await Promise.all([
    telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
    }),
    ...sensors.map((sensor) => telemetryReader.thermalMeasurementHistory({
      sensorId: sensor.id,
      metrics: ["temperature", "humidity"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
    })),
  ]);

  const heatPumpWindow = loadHeatPumpExclusionWindow(database, house.id, from, to);
  const filtered = filterHeatPumpAffectedSampleMap(new Map(sensors.map((sensor, index) => [
    sensor.id,
    indoorReads[index]!.records,
  ])), heatPumpWindow);
  return runMoistureResponseAsync({
    house,
    sensors,
    indoorSamplesBySensor: filtered.samplesBySensor,
    outdoorSamples: outdoorRead.records,
    from,
    to,
    hvacExclusion: filtered.summary,
  });
}
