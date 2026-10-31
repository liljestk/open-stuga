import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DurableDerivedAnalyticsResponse,
  ThermalIsolationResult,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { derivedPollDelayMs, useRecalculationFollow } from "./derivedPolling";

export interface ThermalIsolationOptions {
  windowDays: 1 | 7 | 14;
}

export function useThermalIsolation(houseId: string, dataMode: "live" | "demo") {
  const [result, setResult] = useState<ThermalIsolationResult | null>(null);
  const [status, setStatus] = useState<DurableDerivedAnalyticsResponse<ThermalIsolationResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const follow = useRecalculationFollow(status, loading);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setStatus(null);
    setLoading(false);
    follow.stop();
    setError(false);
    setErrorCode(null);
    setErrorStatus(null);
    setErrorDetail(null);
  }, []);

  useEffect(() => {
    reset();
    return () => controller.current?.abort();
  }, [houseId, dataMode, reset]);

  const request = useCallback(async (options: ThermalIsolationOptions, refresh = false) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(false);
    setErrorCode(null);
    setErrorStatus(null);
    setErrorDetail(null);
    try {
      const request = refresh ? api.refreshCachedThermalIsolation : api.cachedThermalIsolation;
      const next = await request(
        houseId,
        { windowDays: options.windowDays, dataMode },
        nextController.signal,
      );
      if (nextController.signal.aborted) return null;
      setStatus(next);
      setResult(next.result);
      return next.result;
    } catch (caught) {
      if (!nextController.signal.aborted) {
        const details = caught && typeof caught === "object"
          ? caught as { code?: unknown; status?: unknown; message?: unknown }
          : null;
        setError(true);
        setErrorCode(typeof details?.code === "string" ? details.code : null);
        setErrorStatus(typeof details?.status === "number" ? details.status : null);
        setErrorDetail(typeof details?.message === "string" ? details.message : null);
      }
      return null;
    } finally {
      if (!nextController.signal.aborted) setLoading(false);
    }
  }, [dataMode, houseId]);
  const run = useCallback((options: ThermalIsolationOptions, refresh = false) => {
    if (refresh) follow.start();
    return request(options, refresh);
  }, [follow.start, request]);

  useEffect(() => {
    const delay = derivedPollDelayMs(status, follow.following);
    if (!status || delay === null) return;
    const timer = setTimeout(() => {
      void run({ windowDays: status.windowDays as 1 | 7 | 14 });
    }, delay);
    return () => clearTimeout(timer);
  }, [follow.following, run, status]);

  const recalculating = follow.recalculating;
  return { result, status, loading, recalculating, error, errorCode, errorStatus, errorDetail, run, reset };
}
