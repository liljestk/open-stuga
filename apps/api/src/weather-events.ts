import { createHash } from "node:crypto";
import type {
  HouseWeather,
  WeatherUpdateEvent,
  WeatherUpdateTrigger,
} from "@climate-twin/contracts";

const DEFAULT_RECENT_EVENT_LIMIT = 256;

export type WeatherEventProjector = (event: WeatherUpdateEvent) => void | Promise<void>;
export type WeatherEventListener = (event: WeatherUpdateEvent) => void | Promise<void>;

export class WeatherEventSupersededError extends Error {
  constructor() {
    super("House metadata changed while the weather event was being projected");
  }
}

/**
 * Provider-independent weather event port. A scheduled pull, an on-demand
 * request, or a future upstream push adapter can all publish the same snapshot.
 */
export interface WeatherEventBroker {
  addProjector(projector: WeatherEventProjector): () => void;
  subscribe(listener: WeatherEventListener): () => void;
  publish(weather: HouseWeather, trigger: WeatherUpdateTrigger): Promise<WeatherUpdateEvent | null>;
  latest(houseId: string): WeatherUpdateEvent | null;
  invalidate(houseId: string): void;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = canonicalValue(item);
  }
  return result;
}

function eventId(weather: HouseWeather): string {
  return `weather-${createHash("sha256").update(JSON.stringify(canonicalValue(weather))).digest("hex")}`;
}

/**
 * Single-process broker used by the local runtime.
 *
 * Projectors are awaited before an event becomes visible to subscribers. They
 * must be idempotent because a failed projection is retried with the same
 * stable event ID. Subscribers are best-effort observers and cannot interrupt
 * ingestion. Identical cached snapshots and concurrent publishers coalesce;
 * different snapshots retain publication order independently for each house.
 */
export class InMemoryWeatherEventBroker implements WeatherEventBroker {
  readonly #projectors = new Set<WeatherEventProjector>();
  readonly #listeners = new Set<WeatherEventListener>();
  readonly #recent = new Map<string, string>();
  readonly #latest = new Map<string, WeatherUpdateEvent>();
  readonly #inFlight = new Map<string, Promise<WeatherUpdateEvent | null>>();
  readonly #generations = new Map<string, number>();
  readonly #houseQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly recentEventLimit = DEFAULT_RECENT_EVENT_LIMIT) {
    if (!Number.isInteger(recentEventLimit) || recentEventLimit < 1) {
      throw new RangeError("recentEventLimit must be a positive integer");
    }
  }

  addProjector(projector: WeatherEventProjector): () => void {
    this.#projectors.add(projector);
    return () => this.#projectors.delete(projector);
  }

  subscribe(listener: WeatherEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(weather: HouseWeather, trigger: WeatherUpdateTrigger): Promise<WeatherUpdateEvent | null> {
    const id = eventId(weather);
    if (this.#recent.has(id)) return Promise.resolve(null);
    const generation = this.#generation(weather.houseId);
    const inFlightKey = `${weather.houseId}\u0000${generation}\u0000${id}`;
    const pending = this.#inFlight.get(inFlightKey);
    if (pending) return pending;

    const event: WeatherUpdateEvent = {
      id,
      type: "weather.snapshot",
      houseId: weather.houseId,
      publishedAt: new Date().toISOString(),
      trigger,
      weather: structuredClone(weather),
    };
    const previous = this.#houseQueues.get(weather.houseId) ?? Promise.resolve();
    const dispatch = previous
      .catch(() => undefined)
      .then(() => this.#dispatch(event, generation));
    this.#inFlight.set(inFlightKey, dispatch);
    this.#houseQueues.set(weather.houseId, dispatch);
    const cleanup = (): void => {
      this.#inFlight.delete(inFlightKey);
      if (this.#houseQueues.get(weather.houseId) === dispatch) this.#houseQueues.delete(weather.houseId);
    };
    void dispatch.then(cleanup, cleanup);
    return dispatch;
  }

  latest(houseId: string): WeatherUpdateEvent | null {
    const event = this.#latest.get(houseId);
    return event ? structuredClone(event) : null;
  }

  invalidate(houseId: string): void {
    this.#generations.set(houseId, this.#generation(houseId) + 1);
    this.#latest.delete(houseId);
    for (const [id, eventHouseId] of this.#recent) {
      if (eventHouseId === houseId) this.#recent.delete(id);
    }
  }

  async #dispatch(event: WeatherUpdateEvent, generation: number): Promise<WeatherUpdateEvent> {
    for (const projector of this.#projectors) {
      this.#assertCurrent(event.houseId, generation);
      await projector(structuredClone(event));
    }
    this.#assertCurrent(event.houseId, generation);

    this.#remember(event);
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(structuredClone(event))).catch(() => undefined);
      } catch {
        // A disconnected or faulty live consumer must not block ingestion.
      }
    }
    return structuredClone(event);
  }

  #generation(houseId: string): number {
    return this.#generations.get(houseId) ?? 0;
  }

  #assertCurrent(houseId: string, generation: number): void {
    if (this.#generation(houseId) !== generation) throw new WeatherEventSupersededError();
  }

  #remember(event: WeatherUpdateEvent): void {
    this.#recent.set(event.id, event.houseId);
    while (this.#recent.size > this.recentEventLimit) {
      const oldest = this.#recent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#recent.delete(oldest);
    }
    this.#latest.set(event.houseId, structuredClone(event));
  }
}
