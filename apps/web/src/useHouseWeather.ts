import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { House, HouseWeather, WeatherUpdateEvent } from "@climate-twin/contracts";
import { api } from "./api";

export const HOUSE_WEATHER_REFRESH_MS = 10 * 60 * 1000;

export interface UseHouseWeatherResult {
  weather: HouseWeather | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

interface WeatherState extends Omit<UseHouseWeatherResult, "refresh"> {
  key: string | null;
}

interface ActiveHouseRequest {
  key: string;
  houseId: string;
}

const weatherSubscribers = new Set<(event: WeatherUpdateEvent) => void>();
const deliveredWeatherEventIds = new Set<string>();
const WEATHER_EVENT_DEDUPE_LIMIT = 256;

/** Fan out provider-neutral live snapshots to every mounted house-weather view. */
export function publishHouseWeatherUpdate(event: WeatherUpdateEvent): void {
  if (event.type !== "weather.snapshot" || deliveredWeatherEventIds.has(event.id)) return;
  deliveredWeatherEventIds.add(event.id);
  while (deliveredWeatherEventIds.size > WEATHER_EVENT_DEDUPE_LIMIT) {
    const oldest = deliveredWeatherEventIds.values().next().value as string | undefined;
    if (!oldest) break;
    deliveredWeatherEventIds.delete(oldest);
  }
  for (const subscriber of weatherSubscribers) subscriber(event);
}

function locationKey(house: House | null | undefined, enabled: boolean): string | null {
  if (!enabled || !house?.location) return null;
  return `${house.id}:${house.location.latitude}:${house.location.longitude}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Load house-scoped FMI weather and refresh it every ten minutes.
 *
 * Results are cached by house and coordinates inside the hook instance. This
 * makes switching houses responsive without ever displaying another house's
 * result, and prevents old coordinates from being reused after a move.
 */
export function useHouseWeather(
  house: House | null | undefined,
  enabled = true,
): UseHouseWeatherResult {
  const key = useMemo(
    () => locationKey(house, enabled),
    [enabled, house?.id, house?.location?.latitude, house?.location?.longitude],
  );
  const [state, setState] = useState<WeatherState>({ key: null, weather: null, loading: false, error: null });
  const cache = useRef(new Map<string, HouseWeather>());
  const active = useRef<ActiveHouseRequest | null>(null);
  const latestRequest = useRef(new Map<string, number>());
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    // React Strict Mode replays effects in development; restore the live flag
    // when the effect is mounted again after its simulated cleanup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current = null;
      requestController.current?.abort();
      requestController.current = null;
    };
  }, []);

  const load = useCallback(async (request: ActiveHouseRequest): Promise<void> => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const requestId = ++requestSequence.current;
    latestRequest.current.set(request.key, requestId);
    if (mounted.current && active.current?.key === request.key) {
      setState((current) => ({
        key: request.key,
        weather: current.key === request.key ? current.weather : (cache.current.get(request.key) ?? null),
        loading: true,
        error: null,
      }));
    }

    try {
      const weather = await api.houseWeather(request.houseId, 48, controller.signal);
      if (controller.signal.aborted
        || !mounted.current
        || active.current?.key !== request.key
        || latestRequest.current.get(request.key) !== requestId) return;
      cache.current.set(request.key, weather);
      setState({ key: request.key, weather, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!mounted.current
        || active.current?.key !== request.key
        || latestRequest.current.get(request.key) !== requestId) return;
      setState((current) => ({
        key: request.key,
        weather: current.key === request.key ? current.weather : (cache.current.get(request.key) ?? null),
        loading: false,
        error: asError(error),
      }));
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }, []);

  useEffect(() => {
    if (!key || !house) {
      requestController.current?.abort();
      requestController.current = null;
      active.current = null;
      setState({ key: null, weather: null, loading: false, error: null });
      return;
    }

    const request = { key, houseId: house.id };
    active.current = request;
    setState({ key, weather: cache.current.get(key) ?? null, loading: true, error: null });
    load(request);
    const timer = window.setInterval(() => {
      load(request);
    }, HOUSE_WEATHER_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      if (active.current?.key === request.key) {
        requestController.current?.abort();
        requestController.current = null;
      }
    };
  }, [house?.id, key, load]);

  useEffect(() => {
    if (!key || !house?.location) return;
    const consume = (event: WeatherUpdateEvent) => {
      if (event.houseId !== house.id
        || event.weather.location.latitude !== house.location?.latitude
        || event.weather.location.longitude !== house.location?.longitude) return;
      // A pushed snapshot is authoritative for this refresh cycle. Invalidate
      // any older HTTP response that was already in flight so it cannot replace
      // the live value after arriving late.
      requestController.current?.abort();
      requestController.current = null;
      latestRequest.current.set(key, ++requestSequence.current);
      cache.current.set(key, event.weather);
      if (mounted.current && active.current?.key === key) {
        setState({ key, weather: event.weather, loading: false, error: null });
      }
    };
    weatherSubscribers.add(consume);
    return () => { weatherSubscribers.delete(consume); };
  }, [house?.id, house?.location?.latitude, house?.location?.longitude, key]);

  const refresh = useCallback(async () => {
    const request = active.current;
    if (request) await load(request);
  }, [load]);

  return { weather: state.weather, loading: state.loading, error: state.error, refresh };
}
