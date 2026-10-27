import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { outdoorLocationKey } from "../src/db.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("energy projection API", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => { await runtime?.close(); runtime = null; });

  it("projects a heated Home from its metered days and weather, with a backtest", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const location = { latitude: 60.17, longitude: 24.94 };
    const floor = {
      id: "main", name: "Main", type: "ground" as const, width: 10, height: 8, elevation: 0,
      walls: [], rooms: [{ id: "living", name: "Living", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }],
    };
    runtime.database.createHouse({ id: "projection-house", name: "Projection house", timezone: "UTC", floors: [floor], location });
    runtime.database.createSensor({
      id: "main-meter", houseId: "projection-house", floorId: "main", roomId: "living", room: "Living",
      name: "Main meter", model: "Test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    runtime.database.updateSensor("main-meter", { energyMeterRole: "whole_home" });

    // 120 days into the past: outdoor cooling 0.15 °C a day with fronts; 0.3 kWh base per hour plus heating.
    const end = Math.floor(Date.now() / DAY) * DAY;
    const start = end - 120 * DAY;
    const key = outdoorLocationKey(location);
    let counter = 1_000;
    let front = 0;
    const samples = [];
    for (let time = start; time <= end; time += HOUR) {
      const day = (time - start) / DAY;
      if ((time - start) % DAY === 0) front = 0.7 * front + Math.sin(day * 1.7) * 3;
      const outdoorC = 12 - 0.15 * day + front + 3 * Math.sin(2 * Math.PI * ((time / HOUR) % 24 - 9) / 24);
      counter += 0.3 + 0.006 * Math.max(0, 17 - outdoorC);
      const timestamp = new Date(time).toISOString();
      samples.push({ sensorId: "main-meter", metric: "energy", value: counter, canonicalUnit: "kWh", timestamp, source: "api" as const, quality: "good" as const });
      runtime.database.upsertOutdoorTemperatureSample({
        houseId: "projection-house", locationKey: key, timestamp, temperatureC: outdoorC,
        source: "api", fetchedAt: timestamp, stationId: "test", stationName: "Test",
      });
    }
    runtime.database.insertMeasurementSamples(samples);

    const response = await request(runtime.app).get("/api/v1/houses/projection-house/energy-projection").expect(200);
    const projection = response.body.projection;
    expect(projection).toMatchObject({
      houseId: "projection-house",
      algorithmVersion: "energy-projection/v1",
      method: "weather-regression",
      heatingBaseTemperatureC: 17,
      forecastDays: 0,
    });
    expect(projection.observedDays).toBeGreaterThanOrEqual(110);
    expect(projection.heatingSlopeKwhPerDegreeHour).toBeCloseTo(0.006, 3);
    expect(projection.baseLoadKwhPerDay).toBeCloseTo(7.2, 0);
    expect(projection.backtest.origins).toBeGreaterThan(10);
    expect(projection.backtest.skill).toBeGreaterThan(0);
    expect(projection.lowKwh).toBeLessThanOrEqual(projection.next30DaysKwh);
    expect(projection.highKwh).toBeGreaterThanOrEqual(projection.next30DaysKwh);
  });

  it("has no projection without a source standing for the whole Home", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const response = await request(runtime.app).get("/api/v1/houses/house-main/energy-projection").expect(200);
    expect(response.body.projection).toBeNull();
  });
});

describe("energy optimizer flexible loads", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => { await runtime?.close(); runtime = null; });

  it("prices a measured dishwasher's evening runs against the cheapest night window", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const weekStart = now - 7 * DAY;
    runtime.database.createSensor({
      id: "dishwasher", houseId: "house-main", floorId: runtime.database.listSensors("house-main")[0]!.floorId,
      room: "Kitchen", name: "Dishwasher", model: "P110", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    runtime.database.updateSensor("dishwasher", { energyMeterRole: "submeter" });
    const samples = [];
    for (let time = weekStart; time < now; time += 5 * 60_000) {
      const minute = (time % DAY) / 60_000;
      samples.push({
        sensorId: "dishwasher", metric: "power", value: minute >= 19 * 60 && minute < 20.5 * 60 ? 2_000 : 2,
        canonicalUnit: "W", timestamp: new Date(time).toISOString(), source: "api" as const, quality: "good" as const,
      });
    }
    runtime.database.insertMeasurementSamples(samples);
    // Evenings cost 20 c/kWh, nights 5, other hours 10.
    runtime.database.storePropertyElectricityPrices("property-main", Array.from({ length: 9 * 24 }, (_, hour) => {
      const start = weekStart + hour * HOUR;
      const hourOfDay = (start % DAY) / HOUR;
      return {
        startAt: new Date(start).toISOString(), endAt: new Date(start + HOUR).toISOString(),
        rawPriceCentsPerKwh: hourOfDay >= 17 && hourOfDay < 21 ? 20 : hourOfDay < 6 ? 5 : 10,
      };
    }), new Date(weekStart).toISOString());

    const report = await runtime.energyOptimizer.report("property-main", 2, new Date(now));
    const margin = report.currentPriceCentsPerKwh! - 10;
    const dishwasher = report.flexibleLoads?.find((load) => load.sensorId === "dishwasher");
    expect(dishwasher).toMatchObject({ runsPerDay: 1, typicalRunMinutes: 90 });
    expect(dishwasher!.dailyKwh).toBeCloseTo(3, 1);
    expect(dishwasher!.paidCentsPerKwh).toBeCloseTo(20 + margin, 3);
    expect(dishwasher!.cheapestWindow!.averagePriceCentsPerKwh).toBeCloseTo(5 + margin, 3);
    expect(dishwasher!.estimatedDailySavingsEur).toBeCloseTo(0.45, 2);
    expect(report.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "flexible-load:dishwasher", severity: "opportunity", estimatedSavingsEur: dishwasher!.estimatedDailySavingsEur }),
    ]));
  });
});
