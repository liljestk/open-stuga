import { withSignal } from "@climate-twin/contracts";
import { outdoorLocationKey } from "../db.js";
import { mcpBoundedInteger, mcpOptionalFiniteNumber, mcpThermalDateRange, requireMcpHouse, requireMcpHouseSensor } from "../mcp-validation.js";
import { runThermalSimulationAsync } from "../thermal-simulation.js";
import { runMcpThermalWork } from "./thermal-work.js";
import { configuredHeatPumpConnectionIds, filterHeatPumpAffectedSamples, loadHeatPumpExclusionWindow, filterHeatPumpAffectedSampleMap } from "../analytics/heat-pump-evidence.js";
import { HEAT_PUMP_SENSOR_TAG } from "../heat-pump-measurements.js";
import type { McpRuntime } from "./runtime.js";
import { isThermalIsolationTemperatureSensor, runThermalIsolationAsync } from "../thermal-isolation.js";
import { optionalToolString, requiredToolString } from "./arguments.js";

export async function thermalSimulation(
  runtime: McpRuntime,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { config, database, telemetryReader } = runtime;
  const houseId = requiredToolString(args, "houseId");
  const house = requireMcpHouse(database, houseId);
  const sensor = requireMcpHouseSensor(database, houseId, requiredToolString(args, "sensorId"));
  if (sensor.tags.includes(HEAT_PUMP_SENSOR_TAG)) {
    throw new Error("Heat-pump equipment telemetry is not an ambient temperature sensor");
  }
  const { from, to } = mcpThermalDateRange(optionalToolString(args, "from"), optionalToolString(args, "to"));
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

export async function thermalIsolation(
  runtime: McpRuntime,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { config, database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const { from, to } = mcpThermalDateRange(optionalToolString(args, "from"), optionalToolString(args, "to"));
  const sensorCandidates = database.listSensors(house.id).filter((sensor) => sensor.enabled);
  const sensorsWithTemperatureHistory = new Set(
    (await telemetryReader.measurementCoverage({
      sensorIds: sensorCandidates.map((sensor) => sensor.id),
      metrics: ["temperature"],
      ...withSignal(signal),
    })).records.map((coverage) => coverage.sensorId),
  );
  signal?.throwIfAborted();
  const sensors = sensorCandidates.filter((sensor) =>
    isThermalIsolationTemperatureSensor(sensor, sensorsWithTemperatureHistory.has(sensor.id)));
  if (sensors.length > 64) throw new Error("Thermal isolation comparison supports at most 64 temperature sensors");
  const boundaryPaddingMs = 2 * 3_600_000;
  return runMcpThermalWork({
    subjects: sensors,
    ...withSignal(signal),
    readOutdoor: (readSignal) => telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
      ...withSignal(readSignal),
    }),
    readIndoor: (subject, readSignal) => telemetryReader.thermalMeasurementHistory({
      sensorId: subject.id,
      metrics: ["temperature"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
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
      const filtered = filterHeatPumpAffectedSampleMap(new Map(sensors.map((sensor, index) => [
        sensor.id,
        indoor[index]!.records,
      ])), heatPumpWindow, 5 * 60_000);
      return runThermalIsolationAsync({
        house,
        sensors,
        indoorSamplesBySensor: filtered.samplesBySensor,
        outdoorSamples: outdoor.records,
        from,
        to,
        hvacExclusion: filtered.summary,
        ...(heatPumpWindow.summary.evidenceState === "not-present" ? {} : { passiveIntervals: heatPumpWindow.passiveIntervals }),
      }, withSignal(completionSignal));
    },
  });
}
