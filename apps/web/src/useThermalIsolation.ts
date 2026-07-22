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
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setLoading(false);
    setError(false);
  }, []);

  useEffect(() => {
    reset();
    return () => controller.current?.abort();
  }, [houseId, reset]);

  const run = useCallback(async (options: ThermalIsolationOptions) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(false);
    try {
      const next = await api.thermalIsolation(houseId, options, nextController.signal);
      if (nextController.signal.aborted) return null;
      setResult(next);
      return next;
    } catch {
      if (!nextController.signal.aborted) setError(true);
      return null;
    } finally {
      if (!nextController.signal.aborted) setLoading(false);
    }
  }, [houseId]);

  return { result, loading, error, run, reset };
}
