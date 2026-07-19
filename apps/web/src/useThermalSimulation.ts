import { useCallback, useEffect, useRef, useState } from "react";
import type { ThermalSimulationResult } from "@climate-twin/contracts";
import { api } from "./api";

export interface ThermalSimulationOptions {
  from: string;
  to: string;
  horizonHours: number;
  scenarioOutdoorTemperatureC?: number;
}

export function useThermalSimulation(houseId: string, sensorId: string | null) {
  const [result, setResult] = useState<ThermalSimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const requestSequence = useRef(0);

  const reset = useCallback(() => {
    requestSequence.current += 1;
    setResult(null);
    setLoading(false);
    setError(false);
    setElapsedSeconds(0);
  }, []);

  useEffect(() => {
    reset();
  }, [houseId, sensorId, reset]);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [loading]);

  const run = useCallback(async (options: ThermalSimulationOptions) => {
    if (!sensorId) return null;
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(false);
    try {
      const next = await api.thermalSimulation(houseId, { sensorId, ...options });
      if (requestId !== requestSequence.current) return null;
      setResult(next);
      return next;
    } catch {
      if (requestId === requestSequence.current) setError(true);
      return null;
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [houseId, sensorId]);

  return { result, loading, error, elapsedSeconds, run, reset };
}
