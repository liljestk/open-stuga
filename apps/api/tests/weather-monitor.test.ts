import type { House, HouseLocation, HouseWeather } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WeatherMonitor,
  type WeatherMonitorHouseRepository,
  type WeatherMonitorRefreshService,
} from "../src/weather-monitor.js";

const baseTime = Date.parse("2026-07-14T10:00:00.000Z");

function house(id: string, location?: HouseLocation): House {
  return {
    id,
    name: id,
    timezone: "UTC",
    ...(location ? { location } : {}),
    floors: [],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function weatherFor(target: House, overrides: Partial<HouseWeather> = {}): HouseWeather {
  if (!target.location) throw new Error("Test weather requires a location");
  return {
    houseId: target.id,
    location: target.location,
    provider: "fmi",
    attribution: "Test provider",
    fetchedAt: "2026-07-14T10:00:00.000Z",
    forecastIssuedAt: null,
    stale: false,
    current: { timestamp: "2026-07-14T10:00:00.000Z", temperatureC: 20 },
    observationStation: null,
    forecast: [],
    warnings: [],
    unavailable: [],
    ...overrides,
  };
}

function repository(initial: House[]): WeatherMonitorHouseRepository & { values: Map<string, House> } {
  const values = new Map(initial.map((item) => [item.id, item]));
  return {
    values,
    listHouses: () => [...values.values()],
    getHouse: (id) => values.get(id) ?? null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WeatherMonitor", () => {
  it("uses a bounded worker pool, ignores unlocated houses, and coalesces overlapping cycles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const located = Array.from({ length: 5 }, (_, index) => house(
      `house-${index + 1}`,
      { latitude: 60 + index / 100, longitude: 24 + index / 100 },
    ));
    const houses = repository([...located, house("unlocated")]);
    let active = 0;
    let maximumActive = 0;
    const weather: WeatherMonitorRefreshService = {
      get: vi.fn(async (target) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        active -= 1;
        return weatherFor(target);
      }),
    };
    const persist = vi.fn();
    const monitor = new WeatherMonitor({ houses, weather, persist, concurrency: 2, now: Date.now });

    const first = monitor.runOnce();
    expect(monitor.runOnce()).toBe(first);
    await vi.runAllTimersAsync();
    const summary = await first;

    expect(maximumActive).toBe(2);
    expect(weather.get).toHaveBeenCalledTimes(5);
    expect(persist).toHaveBeenCalledTimes(5);
    expect(summary).toMatchObject({
      locatedHouses: 5,
      attempted: 5,
      succeeded: 5,
      failed: 0,
      superseded: 0,
      backedOff: 0,
    });
    expect(monitor.status).toMatchObject({ started: false, running: false, lastRun: summary });
  });

  it("re-reads each house and fences both location-key and revision changes before persistence", async () => {
    const first = house("location-change", { latitude: 60, longitude: 24 });
    const second = house("revision-change", { latitude: 35, longitude: 139 });
    const houses = repository([first, second]);
    const releases = new Map<string, (value: HouseWeather) => void>();
    let startedCount = 0;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let hold = true;
    const weather: WeatherMonitorRefreshService = {
      get: vi.fn((target) => {
        if (!hold) return Promise.resolve(weatherFor(target));
        startedCount += 1;
        if (startedCount === 2) signalStarted?.();
        return new Promise<HouseWeather>((resolve) => releases.set(target.id, resolve));
      }),
    };
    const persist = vi.fn();
    const monitor = new WeatherMonitor({ houses, weather, persist, concurrency: 2 });

    const pending = monitor.runOnce();
    await started;
    houses.values.set(first.id, {
      ...first,
      location: { latitude: 61, longitude: 25 },
      // Same revision proves that the opaque location key is an independent fence.
      updatedAt: first.updatedAt,
    });
    houses.values.set(second.id, {
      ...second,
      // Same location proves that revision changes are independently fenced.
      updatedAt: "2026-07-14T00:01:00.000Z",
    });
    releases.get(first.id)?.(weatherFor(first));
    releases.get(second.id)?.(weatherFor(second));

    await expect(pending).resolves.toMatchObject({ attempted: 2, succeeded: 0, failed: 0, superseded: 2 });
    expect(persist).not.toHaveBeenCalled();

    hold = false;
    const replacement = await monitor.runOnce();
    expect(replacement).toMatchObject({ attempted: 2, succeeded: 2, backedOff: 0 });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("backs off stale and failed refreshes exponentially, caps the delay, and resets on house changes", async () => {
    let now = 0;
    const original = house("backoff", { latitude: 60, longitude: 24 });
    const houses = repository([original]);
    const outcomes: Array<"stale" | "error" | "success"> = [
      "stale", "error", "error", "success", "error", "success",
    ];
    const weather: WeatherMonitorRefreshService = {
      get: vi.fn(async (target) => {
        const outcome = outcomes.shift() ?? "success";
        if (outcome === "error") throw new Error("provider offline");
        return weatherFor(target, { stale: outcome === "stale" });
      }),
    };
    const persist = vi.fn();
    const monitor = new WeatherMonitor({
      houses,
      weather,
      persist,
      now: () => now,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
    });

    await expect(monitor.runOnce()).resolves.toMatchObject({ failed: 1, lastError: "Weather refresh returned a stale result" });
    now = 999;
    await expect(monitor.runOnce()).resolves.toMatchObject({ attempted: 0, backedOff: 1 });
    now = 1_000;
    await expect(monitor.runOnce()).resolves.toMatchObject({ failed: 1, lastError: "provider offline" });
    now = 2_999;
    await expect(monitor.runOnce()).resolves.toMatchObject({ attempted: 0, backedOff: 1 });
    now = 3_000;
    await expect(monitor.runOnce()).resolves.toMatchObject({ failed: 1 });
    now = 6_999;
    await expect(monitor.runOnce()).resolves.toMatchObject({ attempted: 0, backedOff: 1 });
    now = 7_000;
    await expect(monitor.runOnce()).resolves.toMatchObject({ succeeded: 1 });

    // Success reset the exponent, so this new failure receives the base delay.
    await expect(monitor.runOnce()).resolves.toMatchObject({ failed: 1 });
    now = 7_001;
    houses.values.set(original.id, {
      ...original,
      location: { latitude: 61, longitude: 25 },
      updatedAt: "2026-07-14T00:01:00.000Z",
    });
    // A changed revision/location bypasses the obsolete house's backoff immediately.
    await expect(monitor.runOnce()).resolves.toMatchObject({ attempted: 1, succeeded: 1, backedOff: 0 });
    expect(weather.get).toHaveBeenCalledTimes(6);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("applies startup and positive interval jitter, schedules after completion, and stops idempotently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const target = house("scheduled", { latitude: 60, longitude: 24 });
    const houses = repository([target]);
    const weather: WeatherMonitorRefreshService = { get: vi.fn(async (item) => weatherFor(item)) };
    const random = vi.fn().mockReturnValueOnce(0.5).mockReturnValueOnce(0.25).mockReturnValue(0);
    const statusChanges = vi.fn();
    const monitor = new WeatherMonitor({
      houses,
      weather,
      persist: vi.fn(),
      now: Date.now,
      random,
      startupJitterMs: 1_000,
      intervalMs: 10_000,
      intervalJitterMs: 2_000,
      onStatusChange: statusChanges,
    });

    monitor.start();
    monitor.start();
    expect(monitor.status).toMatchObject({
      started: true,
      running: false,
      nextRunAt: new Date(baseTime + 500).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(weather.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(weather.get).toHaveBeenCalledTimes(1);
    expect(monitor.status.nextRunAt).toBe(new Date(baseTime + 11_000).toISOString());

    await vi.advanceTimersByTimeAsync(10_499);
    expect(weather.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(weather.get).toHaveBeenCalledTimes(2);

    monitor.stop();
    monitor.stop();
    expect(monitor.status).toMatchObject({ started: false, running: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(weather.get).toHaveBeenCalledTimes(2);
    expect(statusChanges).toHaveBeenCalled();
  });

  it("does not access the repository or persist after an active refresh is stopped", async () => {
    const target = house("shutdown", { latitude: 60, longitude: 24 });
    const houses = repository([target]);
    const originalGetHouse = houses.getHouse;
    const getHouse = vi.fn(originalGetHouse);
    houses.getHouse = getHouse;
    let release!: (value: HouseWeather) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const weather: WeatherMonitorRefreshService = {
      get: vi.fn(() => {
        signalStarted();
        return new Promise<HouseWeather>((resolve) => { release = resolve; });
      }),
    };
    const persist = vi.fn();
    const monitor = new WeatherMonitor({ houses, weather, persist });

    const pending = monitor.runOnce();
    await started;
    monitor.stop();
    release(weatherFor(target));

    await expect(pending).resolves.toMatchObject({ succeeded: 0, failed: 0, superseded: 1 });
    expect(getHouse).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});
