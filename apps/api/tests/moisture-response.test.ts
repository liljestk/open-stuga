import type { House, MeasurementSample, OutdoorTemperatureSample, Sensor } from "@climate-twin/contracts";
import { calculatePsychrometrics, saturationVaporPressureOverWaterHpa } from "@climate-twin/spatial-layers";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import { outdoorLocationKey } from "../src/db.js";
import { calibrateMoistureResponse } from "../src/analytics/thermal/moisture-response-model.js";
import {
  isMoistureResponseSensor,
  runMoistureResponse,
  runMoistureResponseAsync,
} from "../src/analytics/thermal/moisture-response.js";
import { config as appTestConfig } from "./appTestSupport.js";

const house: Pick<House, "id" | "name" | "floors"> = {
  id: "moisture-house",
  name: "Moisture test home",
  floors: [
    {
      id: "ground",
      name: "Ground floor",
      width: 10,
      height: 8,
      elevation: 0,
      walls: [],
      rooms: [
        { id: "living", name: "Living room", points: [] },
        { id: "empty", name: "Unmonitored room", points: [] },
      ],
    },
    {
      id: "upper",
      name: "Upper floor",
      width: 10,
      height: 8,
      elevation: 3,
      walls: [],
      rooms: [{ id: "bedroom", name: "Bedroom", points: [] }],
    },
  ],
};

function sensor(id: string, floorId: string, roomId: string, room: string): Sensor {
  return {
    id,
    houseId: house.id,
    floorId,
    roomId,
    room,
    name: id,
    model: "Synthetic climate sensor",
    x: 1,
    y: 1,
    z: 1.2,
    tags: [],
    enabled: true,
  };
}

function relativeHumidity(vaporPressureHpa: number, temperatureC: number): number {
  return vaporPressureHpa / saturationVaporPressureOverWaterHpa(temperatureC) * 100;
}

function syntheticSeries(
  sensorId: string,
  responseTimeHours: number,
  outdoorCoupling = 0.62,
  equilibriumOffsetHpa = 5.4,
  outdoorTemperatureC = 10,
  outdoorVaporScale = 1,
): { indoor: MeasurementSample[]; outdoor: OutdoorTemperatureSample[] } {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const stepHours = 0.25;
  const steps = 8 * 24 / stepHours;
  const indoorTemperatureC = 21;
  let indoorVaporPressureHpa = outdoorCoupling * 8.3 * outdoorVaporScale + equilibriumOffsetHpa;
  const indoor: MeasurementSample[] = [];
  const outdoor: OutdoorTemperatureSample[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const timestamp = new Date(start + step * stepHours * 3_600_000).toISOString();
    const outdoorVaporPressureHpa = (7.2
      + 1.35 * Math.sin(step / 13)
      + 0.7 * Math.cos(step / 41)
      + 0.35 * Math.sin(step / 5)) * outdoorVaporScale;
    indoor.push(
      {
        sensorId,
        metric: "temperature",
        value: indoorTemperatureC,
        canonicalUnit: "°C",
        timestamp,
        source: "api",
        quality: "good",
      },
      {
        sensorId,
        metric: "humidity",
        value: relativeHumidity(indoorVaporPressureHpa, indoorTemperatureC),
        canonicalUnit: "%",
        timestamp,
        source: "api",
        quality: "good",
      },
    );
    outdoor.push({
      houseId: house.id,
      locationKey: "test-location",
      timestamp,
      temperatureC: outdoorTemperatureC,
      source: "api",
      fetchedAt: timestamp,
      stationId: null,
      stationName: null,
      conditions: {
        timestamp,
        temperatureC: outdoorTemperatureC,
        relativeHumidityPercent: relativeHumidity(outdoorVaporPressureHpa, outdoorTemperatureC),
      },
    });
    const memory = Math.exp(-stepHours / responseTimeHours);
    indoorVaporPressureHpa = memory * indoorVaporPressureHpa
      + (1 - memory) * (outdoorCoupling * outdoorVaporPressureHpa + equilibriumOffsetHpa);
  }
  return { indoor, outdoor };
}

describe("moisture response comparison", () => {
  it("fits temperature-corrected vapor pressure rather than raw relative humidity", () => {
    const series = syntheticSeries("climate", 24, 0.62, 5.4);
    const calibration = calibrateMoistureResponse(series.indoor, series.outdoor);

    expect(calibration.parameters?.responseTimeHours).toBeCloseTo(24, 0);
    expect(calibration.parameters?.outdoorCoupling).toBeCloseTo(0.62, 1);
    expect(calibration.quality.modelSkillPct).toBeGreaterThan(50);
    expect(calibration.quality.medianOutdoorVaporPressureHpa).toBeGreaterThan(5);
    expect(calibration.quality.medianOutdoorVaporPressureHpa).toBeLessThan(9);
  });

  it("recovers the response time from many short heat-pump-off stretches and reports its interval", () => {
    const series = syntheticSeries("climate", 30, 0.62, 5.4);
    const start = Date.parse(series.indoor[0]!.timestamp);
    // A heat pump running 2 h of every 6 leaves only 4-hour passive stretches.
    const passiveIntervals = Array.from({ length: 32 }, (_, cycle) => ({
      fromMs: start + (cycle * 6 + 2) * 3_600_000,
      toMs: start + (cycle * 6 + 6) * 3_600_000,
    }));
    const calibration = calibrateMoistureResponse(series.indoor, series.outdoor, undefined, passiveIntervals);
    expect(calibration.quality.stretchesUsed).toBe(32);
    expect(Math.abs(calibration.parameters!.responseTimeHours / 30 - 1)).toBeLessThanOrEqual(0.1);
    expect(calibration.parameters!.outdoorCoupling).toBeCloseTo(0.62, 1);
    expect(calibration.quality.responseTimeLowHours).toBeLessThanOrEqual(calibration.parameters!.responseTimeHours);
    expect(calibration.quality.responseTimeHighHours).toBeGreaterThanOrEqual(calibration.parameters!.responseTimeHours);
  });

  it("aggregates room and floor medians while preserving missing room evidence", () => {
    const living = syntheticSeries("living", 36, 0.55);
    const bedroom = syntheticSeries("bedroom", 12, 0.8);
    const result = runMoistureResponse({
      house,
      sensors: [
        sensor("living", "ground", "living", "Living room"),
        sensor("bedroom", "upper", "bedroom", "Bedroom"),
      ],
      indoorSamplesBySensor: new Map([
        ["living", living.indoor],
        ["bedroom", bedroom.indoor],
      ]),
      outdoorSamples: living.outdoor,
      from: living.indoor[0]!.timestamp,
      to: living.indoor.at(-1)!.timestamp,
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    const livingRoom = result.entries.find((entry) => entry.scope.id === "room:ground:living")!;
    const bedroomRoom = result.entries.find((entry) => entry.scope.id === "room:upper:bedroom")!;
    const unmonitored = result.entries.find((entry) => entry.scope.id === "room:ground:empty")!;
    const home = result.entries.find((entry) => entry.scope.type === "house")!;

    expect(bedroomRoom.metrics.responseTimeHours).toBeLessThan(livingRoom.metrics.responseTimeHours!);
    expect(bedroomRoom.rank).toBe(1);
    expect(livingRoom.rank).toBe(2);
    expect(unmonitored.metrics.responseTimeHours).toBeNull();
    expect(unmonitored.warnings).toContain("NO_PAIRED_CLIMATE_SENSOR");
    expect(home.sensorCount).toBe(2);
    expect(home.eligibleSensorCount).toBe(2);
    expect(result.methodology.conversionMethod).toBe("buck-vapor-pressure-v1");
  });

  it("reports missing outdoor humidity as an explicit insufficient-data state", () => {
    const series = syntheticSeries("climate", 24);
    const withoutHumidity = series.outdoor.map(({ conditions: _conditions, ...sample }) => sample);
    const calibration = calibrateMoistureResponse(series.indoor, withoutHumidity);

    expect(calibration.parameters).toBeNull();
    expect(calibration.status).toBe("insufficient-data");
    expect(calibration.warnings).toContain("INSUFFICIENT_OUTDOOR_HUMIDITY");
  });

  it("uses an observed outdoor dew point when relative humidity is absent", () => {
    const series = syntheticSeries("climate", 24);
    const dewPointBoundary = series.outdoor.map((sample) => {
      const conditions = sample.conditions!;
      const psychrometrics = calculatePsychrometrics(
        conditions.temperatureC!,
        conditions.relativeHumidityPercent!,
      );
      return {
        ...sample,
        conditions: {
          timestamp: conditions.timestamp,
          temperatureC: conditions.temperatureC,
          dewPointC: psychrometrics.dewPointC!,
        },
      };
    });
    const calibration = calibrateMoistureResponse(series.indoor, dewPointBoundary);

    expect(calibration.parameters?.responseTimeHours).toBeCloseTo(24, 0);
    expect(calibration.parameters?.outdoorCoupling).toBeCloseTo(0.62, 1);
  });

  it("uses the meteorological over-water humidity convention below freezing", () => {
    const winter = syntheticSeries("winter", 24, 0.62, 5.4, -8, 0.3);
    const calibration = calibrateMoistureResponse(winter.indoor, winter.outdoor);

    expect(calibration.parameters?.responseTimeHours).toBeCloseTo(24, 0);
    expect(calibration.parameters?.outdoorCoupling).toBeCloseTo(0.62, 1);
  });

  it("requires both temperature and humidity evidence and excludes energy-only devices", () => {
    const energyPlug = { ...sensor("plug", "ground", "living", "Living room"), model: "Tapo P110" };
    expect(isMoistureResponseSensor(energyPlug)).toBe(false);
    expect(isMoistureResponseSensor(sensor("climate", "ground", "living", "Living room"), true, false)).toBe(false);
    expect(isMoistureResponseSensor(sensor("climate", "ground", "living", "Living room"), true, true)).toBe(true);
  });

  it("gives identical peers equal ranks and supports asynchronous cancellation", async () => {
    const first = syntheticSeries("first", 24);
    const second = syntheticSeries("second", 24);
    const tieHouse = {
      ...house,
      floors: [
        { ...house.floors[0]!, rooms: [house.floors[0]!.rooms[0]!] },
        house.floors[1]!,
      ],
    };
    const input = {
      house: tieHouse,
      sensors: [
        sensor("first", "ground", "living", "Living room"),
        sensor("second", "upper", "bedroom", "Bedroom"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", first.indoor],
        ["second", second.indoor],
      ]),
      outdoorSamples: first.outdoor,
      from: first.indoor[0]!.timestamp,
      to: first.indoor.at(-1)!.timestamp,
    };
    const result = runMoistureResponse(input);
    for (const scopeType of ["sensor", "room", "floor"] as const) {
      expect(result.entries.filter((entry) => entry.scope.type === scopeType).map((entry) => entry.rank))
        .toEqual([1, 1]);
    }
    expect(result.insights.map((insight) => insight.code)).not.toContain("FASTEST_MOISTURE_RESPONSE_ROOM");

    const controller = new AbortController();
    controller.abort();
    await expect(runMoistureResponseAsync(input, { signal: controller.signal })).rejects.toThrow();

    const midRunController = new AbortController();
    const midRun = runMoistureResponseAsync(input, { signal: midRunController.signal });
    setImmediate(() => midRunController.abort());
    await expect(midRun).rejects.toThrow();
  });

  it("serves bounded paired climate history through the house API", async () => {
    const runtime = createApi({
      config: { ...appTestConfig, mockEnabled: false, ingestApiKey: null },
      startBackground: false,
    });
    try {
      const apiHouse = runtime.database.getHouse("house-main")!;
      const floor = apiHouse.floors[0]!;
      const room = floor.rooms[0]!;
      runtime.database.createSensor({
        ...sensor("moisture-api", floor.id, room.id, room.name),
        houseId: apiHouse.id,
        humidityEntityId: "sensor.moisture_api_humidity",
        temperatureEntityId: "sensor.moisture_api_temperature",
      });
      const series = syntheticSeries("moisture-api", 24);
      runtime.database.insertMeasurementSamples(series.indoor);
      const location = { latitude: 60, longitude: 24 };
      runtime.database.updateHouse(apiHouse.id, { location });
      const locationKey = outdoorLocationKey(location);
      for (const sample of series.outdoor) {
        runtime.database.upsertOutdoorTemperatureSample({
          ...sample,
          houseId: apiHouse.id,
          locationKey,
        });
      }

      const climateHistory = runtime.database.thermalClimateHistory(
        {
          sensorId: "moisture-api",
          from: series.indoor[0]!.timestamp,
          to: series.indoor.at(-1)!.timestamp,
        },
      );
      expect(new Set(climateHistory.map((sample) => sample.metric))).toEqual(new Set(["temperature", "humidity"]));
      const boundedClimateHistory = runtime.database.thermalClimateHistory(
        {
          sensorId: "moisture-api",
          from: series.indoor[0]!.timestamp,
          to: series.indoor.at(-1)!.timestamp,
          bucketMinutes: 5,
          limitPerMetric: 10,
        },
      );
      expect(boundedClimateHistory.filter((sample) => sample.metric === "temperature")).toHaveLength(10);
      expect(boundedClimateHistory.filter((sample) => sample.metric === "humidity")).toHaveLength(10);

      const response = await request(runtime.app)
        .get(`/api/v1/houses/${apiHouse.id}/moisture-response`)
        .query({ from: series.indoor[0]!.timestamp, to: series.indoor.at(-1)!.timestamp })
        .expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body.moistureResponse).toMatchObject({
        houseId: apiHouse.id,
        methodology: {
          conversionMethod: "buck-vapor-pressure-v1",
          modelMethod: "first-order-moisture-response-v1",
        },
      });
      expect(response.body.moistureResponse.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: expect.objectContaining({ type: "sensor", sensorIds: ["moisture-api"] }),
          metrics: expect.objectContaining({ responseTimeHours: expect.any(Number) }),
        }),
      ]));

      await request(runtime.app)
        .get(`/api/v1/houses/${apiHouse.id}/moisture-response`)
        .query({ from: series.indoor[0]!.timestamp, to: series.indoor[0]!.timestamp })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe("INVALID_RANGE"));
      await request(runtime.app)
        .get(`/api/v1/houses/${apiHouse.id}/moisture-response`)
        .query({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-16T00:00:00.000Z" })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe("RANGE_TOO_LARGE"));

      for (let index = 0; index < 64; index += 1) {
        runtime.database.createSensor({
          ...sensor(`moisture-extra-${index}`, floor.id, room.id, room.name),
          houseId: apiHouse.id,
          temperatureEntityId: `sensor.moisture_extra_${index}_temperature`,
          humidityEntityId: `sensor.moisture_extra_${index}_humidity`,
        });
      }
      await request(runtime.app)
        .get(`/api/v1/houses/${apiHouse.id}/moisture-response`)
        .query({ from: series.indoor[0]!.timestamp, to: series.indoor.at(-1)!.timestamp })
        .expect(422)
        .expect(({ body }) => expect(body.error.code).toBe("MOISTURE_SCOPE_TOO_LARGE"));
    } finally {
      await runtime.close();
    }
  });
});
