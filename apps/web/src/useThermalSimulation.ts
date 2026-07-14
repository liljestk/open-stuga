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
  const requestSequence = useRef(0);

  const reset = useCallback(() => {
    requestSequence.current += 1;
    setResult(null);
    setLoading(false);
    setError(false);
  }, []);

  useEffect(() => {
    reset();
  }, [houseId, sensorId, reset]);

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

  return { result, loading, error, run, reset };
}
