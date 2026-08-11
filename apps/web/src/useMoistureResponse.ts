import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DurableDerivedAnalyticsResponse,
  MoistureResponseResult,
} from "@climate-twin/contracts";
import { api } from "./api";

export interface MoistureResponseOptions {
  windowDays: 1 | 7 | 14;
}

export function useMoistureResponse(houseId: string, dataMode: "live" | "demo") {
  const [result, setResult] = useState<MoistureResponseResult | null>(null);
  const [status, setStatus] = useState<DurableDerivedAnalyticsResponse<MoistureResponseResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setStatus(null);
    setLoading(false);
    setError(false);
    setErrorCode(null);
  }, []);

  useEffect(() => {
    reset();
    return () => controller.current?.abort();
  }, [houseId, dataMode, reset]);

  const run = useCallback(async (options: MoistureResponseOptions, refresh = false) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(false);
    setErrorCode(null);
    try {
      const request = refresh ? api.refreshCachedMoistureResponse : api.cachedMoistureResponse;
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
  }, [dataMode, houseId]);

  useEffect(() => {
    if (!status || (status.state !== "queued" && status.state !== "refreshing"
      && !(status.state === "failed" && status.job?.nextAttemptAt))) return;
    const timer = setTimeout(() => {
      void run({ windowDays: status.windowDays as 1 | 7 | 14 });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [run, status]);

  return { result, status, loading, error, errorCode, run, reset };
}
