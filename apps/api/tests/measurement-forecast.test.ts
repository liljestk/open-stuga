import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { backtestForecaster, pooledCoverage } from "../src/analytics/forecast/backtest.js";
import {
  fitProfileForecaster,
  fitThermalForecaster,
  lookup,
  type HourlyValue,
} from "../src/analytics/forecast/models.js";
import { MeasurementForecastService } from "../src/analytics/forecast/service.js";
import { ClimateDatabase } from "../src/db.js";

const HOUR = 3_600_000;
const START = Date.parse("2025-11-01T00:00:00.000Z");
const DAYS = 14;

/** Seeded normal noise (Box–Muller over a linear congruential generator). */
function gaussian(seed: number): () => number {
  let state = seed;
  const uniform = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (state + 1) / 2_147_483_649;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

interface Replay {
  indoor: HourlyValue[];
  outdoor: HourlyValue[];
}

/**
 * Two weeks of a heated house: weather fronts and a daily outdoor swing drive
 * the indoor temperature through a 40-hour time constant, the sun adds an
 * afternoon bump, and the heating varies slowly (an AR(1) disturbance).
 */
function temperatureReplay(seed: number): Replay {
  const noise = gaussian(seed);
  const indoor: HourlyValue[] = [];
  const outdoor: HourlyValue[] = [];
  let state = 20;
  let heatingDrift = 0;
  for (let hour = 0; hour < DAYS * 24; hour += 1) {
    const time = START + hour * HOUR;
    const outside = -4 + 5 * Math.sin(2 * Math.PI * hour / 24 - 2) + 6 * Math.sin(2 * Math.PI * hour / 130) + noise() * 0.4;
    const solar = 2.5 * Math.max(0, Math.sin(2 * Math.PI * (hour % 24 - 8) / 16));
    heatingDrift = 0.9 * heatingDrift + noise() * 0.6;
    const memory = Math.exp(-1 / 40);
    state = memory * state + (1 - memory) * (outside + 24 + solar + heatingDrift);
    indoor.push({ time, value: state + noise() * 0.05 });
    outdoor.push({ time, value: outside });
  }
  return { indoor, outdoor };
}

/**
 * Bathroom humidity: a morning and an evening shower whose time and length
 * vary from day to day (the evening one is sometimes skipped), a slow weekly
 * drift, and a background that wanders by about ±1 %RH between showers.
 *
 * Drift without an observable cause caps 24-hour skill: with a ±4 %RH weekly
 * swing no model of the series alone beats "same time yesterday" at exactly
 * 24 hours. The service then withholds or flags the forecast; this replay keeps
 * the swing at ±1.5 %RH.
 */
function humidityReplay(seed: number): HourlyValue[] {
  const noise = gaussian(seed);
  const days = Array.from({ length: DAYS }, () => ({
    morning: 7 + noise() * 0.7,
    evening: 21 + noise() * 0.9,
    morningSize: 14 * (1 + noise() * 0.2),
    eveningSize: noise() > -0.85 ? 9 * (1 + noise() * 0.25) : 0,
  }));
  let disturbance = 0;
  return Array.from({ length: DAYS * 24 }, (_, hour) => {
    const day = days[Math.floor(hour / 24)]!;
    const hourOfDay = hour % 24;
    const showers = day.morningSize * Math.exp(-((hourOfDay - day.morning) ** 2) / 2)
      + day.eveningSize * Math.exp(-((hourOfDay - day.evening) ** 2) / 3);
    disturbance = 0.85 * disturbance + noise() * 0.5;
    return { time: START + hour * HOUR, value: 42 + 1.5 * Math.sin(2 * Math.PI * hour / 170) + showers + disturbance };
  });
}

/** Bedroom CO₂: high at night with the door closed, low while the room is empty. */
function co2Replay(seed: number): HourlyValue[] {
  const noise = gaussian(seed);
  let disturbance = 0;
  return Array.from({ length: DAYS * 24 }, (_, hour) => {
    const hourOfDay = hour % 24;
    const occupied = hourOfDay >= 22 || hourOfDay < 7;
    disturbance = 0.8 * disturbance + noise() * 40;
    return { time: START + hour * HOUR, value: (occupied ? 1_150 : 520) + disturbance };
  });
}

function expectGate(result: ReturnType<typeof backtestForecaster>) {
  expect(result).not.toBeNull();
  const at = (hours: number) => result!.horizons.find((horizon) => horizon.hours === hours)!;
  // Gate for W3: positive skill against "no change" at 6 h and 24 h …
  expect(at(6).skillVsPersistence).toBeGreaterThan(0);
  expect(at(24).skillVsPersistence).toBeGreaterThan(0);
  // … and 90% intervals that contain the outcome 85–95% of the time on held-out origins.
  const coverage = pooledCoverage(result!.horizons)!;
  expect(coverage).toBeGreaterThanOrEqual(0.85);
  expect(coverage).toBeLessThanOrEqual(0.95);
  // Intervals never narrow with a longer horizon.
  for (let index = 1; index < result!.horizons.length; index += 1) {
    expect(result!.horizons[index]!.intervalHalfWidth).toBeGreaterThanOrEqual(result!.horizons[index - 1]!.intervalHalfWidth);
  }
}

describe("backtested forecasting", () => {
  it.each([1, 2, 3])("forecasts a heated house's temperature from the weather (replay %i)", (seed) => {
    const replay = temperatureReplay(seed);
    const outdoor = lookup(replay.outdoor);
    expectGate(backtestForecaster(replay.indoor, (until) => fitThermalForecaster(replay.indoor, outdoor, until)));
  });

  it.each([4, 5, 6])("forecasts bathroom humidity from its daily profile (replay %i)", (seed) => {
    const series = humidityReplay(seed);
    expectGate(backtestForecaster(series, (until) => fitProfileForecaster(series, until)));
  });

  it.each([7, 8, 9])("forecasts bedroom CO₂ from its daily profile (replay %i)", (seed) => {
    const series = co2Replay(seed);
    expectGate(backtestForecaster(series, (until) => fitProfileForecaster(series, until)));
  });

  it("starts every forecast from the latest reading", () => {
    const replay = temperatureReplay(1);
    const forecaster = fitThermalForecaster(replay.indoor, lookup(replay.outdoor), replay.indoor.at(-1)!.time)!;
    const from = replay.indoor.at(-1)!;
    const shifted = forecaster.forecast(from.time, from.value + 3, 1)![0]!;
    const plain = forecaster.forecast(from.time, from.value, 1)![0]!;
    // A 3 °C higher start stays almost 3 °C higher after one hour of a 40-hour response.
    expect(shifted - plain).toBeGreaterThan(2.8);
    expect(Math.abs(plain - from.value)).toBeLessThan(1);
  });

  it("refuses to forecast without three days of history", () => {
    const series = humidityReplay(1).slice(0, 60);
    expect(fitProfileForecaster(series, series.at(-1)!.time)).toBeNull();
    expect(backtestForecaster(series, (until) => fitProfileForecaster(series, until))).toBeNull();
  });
});

describe("measurement forecast service", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  function ingest(database: ClimateDatabase, metric: "humidity" | "co2", values: HourlyValue[], offsetMs: number) {
    database.insertMeasurementSamples(values.map((point) => ({
      sensorId: "sensor-01", metric, value: point.value, canonicalUnit: metric === "co2" ? "ppm" : "%",
      timestamp: new Date(point.time + offsetMs).toISOString(), source: "api", quality: "good",
    })));
  }

  it("serves a backtested forecast with its evaluation and stores one evaluation per day", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const series = humidityReplay(4);
    // Shift the replay so it ends at the current hour.
    const offset = Math.floor(Date.now() / HOUR) * HOUR - series.at(-1)!.time;
    ingest(runtime.database, "humidity", series, offset);
    const response = await request(runtime.app).get("/api/v2/measurements/forecast")
      .query({ sensorId: "sensor-01", metric: "humidity", hours: 30 }).expect(200);
    expect(response.body.evaluation).toMatchObject({
      algorithmVersion: "measurement-forecast/v2", status: "ready", model: "daily-profile", sensorId: "sensor-01",
    });
    expect(response.body.evaluation.skill6h).toBeGreaterThan(0);
    expect(response.body.forecast).toHaveLength(30);
    const first = response.body.forecast[0];
    expect(first.low).toBeLessThanOrEqual(first.value);
    expect(first.high).toBeGreaterThanOrEqual(first.value);
    // Past the 24-hour backtest the interval keeps widening.
    const width = (point: { low: number; high: number }) => point.high - point.low;
    expect(width(response.body.forecast[29])).toBeGreaterThan(width(response.body.forecast[23]));
    expect(runtime.database.latestForecastEvaluation("sensor-01", "humidity")?.status).toBe("ready");
    expect(runtime.database.listForecastEvaluations("2000-01-01", "sensor-01")).toHaveLength(1);
  });

  it("withholds a forecast that does not beat no change", async () => {
    const database = new ClimateDatabase(":memory:");
    try {
      // A random walk: nothing beats the last value.
      const noise = gaussian(11);
      let value = 600;
      const end = Math.floor(Date.now() / HOUR) * HOUR;
      const walk = Array.from({ length: DAYS * 24 }, (_, hour) => {
        value += noise() * 30;
        return { time: end - (DAYS * 24 - 1 - hour) * HOUR, value };
      });
      ingest(database, "co2", walk, 0);
      const result = await new MeasurementForecastService(database).forecast({ sensorId: "sensor-01", metric: "co2", hours: 12 });
      expect(result.evaluation.status).toBe("no-skill");
      expect(result.points).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reports insufficient history instead of guessing", async () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const series = humidityReplay(2).slice(-40);
      ingest(database, "humidity", series, Math.floor(Date.now() / HOUR) * HOUR - series.at(-1)!.time);
      const result = await new MeasurementForecastService(database).forecast({ sensorId: "sensor-01", metric: "humidity", hours: 12 });
      expect(result.evaluation.status).toBe("insufficient-history");
      expect(result.points).toEqual([]);
    } finally {
      database.close();
    }
  });
});
