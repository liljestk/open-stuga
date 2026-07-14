import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { House, HouseWeather } from "@climate-twin/contracts";
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
  const mounted = useRef(true);

  useEffect(() => {
    // React Strict Mode replays effects in development; restore the live flag
    // when the effect is mounted again after its simulated cleanup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current = null;
    };
  }, []);

  const load = useCallback(async (request: ActiveHouseRequest): Promise<void> => {
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
      const weather = await api.houseWeather(request.houseId, 48);
      if (!mounted.current
        || active.current?.key !== request.key
        || latestRequest.current.get(request.key) !== requestId) return;
      cache.current.set(request.key, weather);
      setState({ key: request.key, weather, loading: false, error: null });
    } catch (error) {
      if (!mounted.current
        || active.current?.key !== request.key
        || latestRequest.current.get(request.key) !== requestId) return;
      setState((current) => ({
        key: request.key,
        weather: current.key === request.key ? current.weather : (cache.current.get(request.key) ?? null),
        loading: false,
        error: asError(error),
      }));
    }
  }, []);

  useEffect(() => {
    if (!key || !house) {
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
    return () => window.clearInterval(timer);
  }, [house?.id, key, load]);

  const refresh = useCallback(async () => {
    const request = active.current;
    if (request) await load(request);
  }, [load]);

  return { weather: state.weather, loading: state.loading, error: state.error, refresh };
}
