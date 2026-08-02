import { useCallback, useEffect, useRef, useState } from "react";
import type { ThermalIsolationResult } from "@climate-twin/contracts";
import { api } from "./api";

export interface ThermalIsolationOptions {
  from: string;
  to: string;
}

export function useThermalIsolation(houseId: string) {
  const [result, setResult] = useState<ThermalIsolationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setLoading(false);
    setError(false);
    setErrorCode(null);
    setErrorStatus(null);
    setErrorDetail(null);
  }, []);

  useEffect(() => {
    reset();
    return () => controller.current?.abort();
  }, [houseId, reset]);

  const run = useCallback(async (options: ThermalIsolationOptions) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setResult(null);
    setLoading(true);
    setError(false);
    setErrorCode(null);
    setErrorStatus(null);
    setErrorDetail(null);
    try {
      const next = await api.thermalIsolation(houseId, options, nextController.signal);
      if (nextController.signal.aborted) return null;
      setResult(next);
      return next;
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
  }, [houseId]);

  return { result, loading, error, errorCode, errorStatus, errorDetail, run, reset };
}
