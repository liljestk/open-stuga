import { useCallback, useEffect, useRef, useState } from "react";
import type { MoistureResponseResult } from "@climate-twin/contracts";
import { api } from "./api";

export interface MoistureResponseOptions {
  from: string;
  to: string;
}

export function useMoistureResponse(houseId: string) {
  const [result, setResult] = useState<MoistureResponseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setLoading(false);
    setError(false);
    setErrorCode(null);
  }, []);

  useEffect(() => {
    reset();
    return () => controller.current?.abort();
  }, [houseId, reset]);

  const run = useCallback(async (options: MoistureResponseOptions) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setResult(null);
    setLoading(true);
    setError(false);
    setErrorCode(null);
    try {
      const next = await api.moistureResponse(houseId, options, nextController.signal);
      if (nextController.signal.aborted) return null;
      setResult(next);
      return next;
    } catch (caught) {
      if (!nextController.signal.aborted) {
        setError(true);
        const code = caught && typeof caught === "object" && "code" in caught
          ? (caught as { code?: unknown }).code
          : null;
        setErrorCode(typeof code === "string" ? code : null);
      }
      return null;
    } finally {
      if (!nextController.signal.aborted) setLoading(false);
    }
  }, [houseId]);

  return { result, loading, error, errorCode, run, reset };
}
