import type { HouseWeather, WeatherUpdateEvent } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
} from "../src/weather-events.js";

function weather(overrides: Partial<HouseWeather> = {}): HouseWeather {
  return {
    houseId: "house-main",
    location: { latitude: 60.1699, longitude: 24.9384 },
    provider: "fmi",
    attribution: "Test weather provider",
    fetchedAt: "2026-07-15T08:00:00.000Z",
    forecastIssuedAt: null,
    stale: false,
    current: { timestamp: "2026-07-15T07:50:00.000Z", temperatureC: 18.5 },
    observationStation: null,
    forecast: [],
    warnings: [],
    unavailable: [],
    ...overrides,
  };
}

describe("InMemoryWeatherEventBroker", () => {
  it("projects accepted snapshots before publishing an immutable provider-neutral event", async () => {
    const broker = new InMemoryWeatherEventBroker();
    const order: string[] = [];
    const projected: WeatherUpdateEvent[] = [];
    const observed: WeatherUpdateEvent[] = [];
    broker.addProjector((event) => {
      order.push("project");
      projected.push(event);
    });
    broker.subscribe((event) => {
      order.push("publish");
      observed.push(event);
    });

    const accepted = await broker.publish(weather(), "scheduled-refresh");

    expect(order).toEqual(["project", "publish"]);
    expect(accepted).toMatchObject({
      id: expect.stringMatching(/^weather-[a-f0-9]{64}$/),
      type: "weather.snapshot",
      houseId: "house-main",
      trigger: "scheduled-refresh",
      weather: { provider: "fmi", stale: false },
    });
    expect(projected[0]).not.toBe(observed[0]);
    projected[0]!.weather.houseId = "mutated-projector";
    observed[0]!.weather.houseId = "mutated-listener";
    expect(broker.latest("house-main")?.weather.houseId).toBe("house-main");
  });

  it("coalesces concurrent publication and suppresses cached snapshot replays", async () => {
    const broker = new InMemoryWeatherEventBroker();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const projector = vi.fn(async () => hold);
    const listener = vi.fn();
    broker.addProjector(projector);
    broker.subscribe(listener);

    const snapshot = weather();
    const first = broker.publish(snapshot, "on-demand");
    const concurrent = broker.publish(snapshot, "scheduled-refresh");
    expect(concurrent).toBe(first);
    release();
    const accepted = await first;

    expect(projector).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(broker.publish(snapshot, "on-demand")).resolves.toBeNull();
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as HouseWeather;
    await expect(broker.publish(reordered, "on-demand")).resolves.toBeNull();
    expect(broker.latest("house-main")?.id).toBe(accepted?.id);
  });

  it("serializes different snapshots per house so an older projection cannot finish last", async () => {
    const broker = new InMemoryWeatherEventBroker();
    let releaseOlder!: () => void;
    let signalOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => { signalOlderStarted = resolve; });
    const holdOlder = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const projected: number[] = [];
    const observed: number[] = [];
    broker.addProjector(async (event) => {
      const value = event.weather.current?.temperatureC ?? Number.NaN;
      projected.push(value);
      if (value === 18) {
        signalOlderStarted();
        await holdOlder;
      }
    });
    broker.subscribe((event) => observed.push(event.weather.current?.temperatureC ?? Number.NaN));

    const older = broker.publish(weather({
      fetchedAt: "2026-07-15T08:00:00.000Z",
      current: { timestamp: "2026-07-15T07:50:00.000Z", temperatureC: 18 },
    }), "scheduled-refresh");
    await olderStarted;
    const newer = broker.publish(weather({
      fetchedAt: "2026-07-15T08:01:00.000Z",
      current: { timestamp: "2026-07-15T07:51:00.000Z", temperatureC: 19 },
    }), "on-demand");
    await Promise.resolve();

    expect(projected).toEqual([18]);
    expect(observed).toEqual([]);
    releaseOlder();
    await Promise.all([older, newer]);

    expect(projected).toEqual([18, 19]);
    expect(observed).toEqual([18, 19]);
    expect(broker.latest("house-main")?.weather.current?.temperatureC).toBe(19);
  });

  it("does not expose a snapshot until every durable projector succeeds", async () => {
    const broker = new InMemoryWeatherEventBroker();
    let fail = true;
    const observer = vi.fn();
    broker.addProjector(() => {
      if (fail) throw new Error("projection unavailable");
    });
    broker.subscribe(observer);

    await expect(broker.publish(weather(), "scheduled-refresh")).rejects.toThrow("projection unavailable");
    expect(observer).not.toHaveBeenCalled();
    expect(broker.latest("house-main")).toBeNull();

    fail = false;
    await expect(broker.publish(weather(), "scheduled-refresh")).resolves.toMatchObject({ houseId: "house-main" });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("isolates faulty live subscribers from ingestion and other consumers", async () => {
    const broker = new InMemoryWeatherEventBroker();
    const healthy = vi.fn();
    broker.subscribe(() => { throw new Error("disconnected"); });
    broker.subscribe(async () => { throw new Error("async disconnect"); });
    broker.subscribe(healthy);

    await expect(broker.publish(weather(), "scheduled-refresh")).resolves.toMatchObject({ houseId: "house-main" });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("does not reinstate or publish an in-flight snapshot after house invalidation", async () => {
    const broker = new InMemoryWeatherEventBroker();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const observer = vi.fn();
    broker.addProjector(async () => hold);
    broker.subscribe(observer);

    const pending = broker.publish(weather(), "scheduled-refresh");
    broker.invalidate("house-main");
    release();

    await expect(pending).rejects.toBeInstanceOf(WeatherEventSupersededError);
    expect(observer).not.toHaveBeenCalled();
    expect(broker.latest("house-main")).toBeNull();
  });

  it("supports subscriber cleanup and house invalidation", async () => {
    const broker = new InMemoryWeatherEventBroker();
    const listener = vi.fn();
    const unsubscribe = broker.subscribe(listener);
    const snapshot = weather();

    await broker.publish(snapshot, "on-demand");
    unsubscribe();
    broker.invalidate(snapshot.houseId);
    expect(broker.latest(snapshot.houseId)).toBeNull();

    await broker.publish(snapshot, "on-demand");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(broker.latest(snapshot.houseId)).not.toBeNull();
  });
});
