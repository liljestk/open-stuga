import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api, subscribeToSpatialLayerEvents } from "./api";
import {
  isSnapshotStale,
  latestSnapshotPerLayer,
  type SpatialLayerEngineHealth,
  type SpatialLayerEngineManifest,
  type SpatialLayerScope,
  type SpatialLayerSnapshot,
  type SpatialTopology,
} from "./spatialLayers";

export const SPATIAL_LAYER_POLL_MS = 60_000;
export const SPATIAL_LAYER_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1_000;
export const SPATIAL_LAYER_HISTORY_MIN_INTERVAL_MS = 5_000;

export interface UseSpatialLayersOptions {
  scope: SpatialLayerScope | null;
  enabled?: boolean;
  historyAt?: number | null;
  historyRange?: { from: number; to: number } | null;
}

export interface UseSpatialLayersResult {
  available: boolean;
  loading: boolean;
  refreshing: boolean;
  historyLoading: boolean;
  error: Error | null;
  streamState: "idle" | "live" | "reconnecting";
  engines: SpatialLayerEngineManifest[];
  health: SpatialLayerEngineHealth[];
  topology: SpatialTopology | null;
  snapshots: SpatialLayerSnapshot[];
  history: SpatialLayerSnapshot[];
  selectedLayerIds: string[];
  staleLayerIds: string[];
  setLayerSelected: (layerId: string, selected: boolean) => void;
  refresh: () => Promise<void>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function capabilityUnavailable(value: unknown): boolean {
  return value instanceof ApiRequestError && (value.status === 404 || value.status === 501 || value.status === 503);
}

function layerIds(engines: readonly SpatialLayerEngineManifest[]): string[] {
  return [...new Set(engines.flatMap((engine) => engine.layerIds))];
}

function initialSelection(engines: readonly SpatialLayerEngineManifest[], snapshots: readonly SpatialLayerSnapshot[]): string[] {
  const supported = layerIds(engines);
  const defaults = engines.filter((engine) => engine.defaultEnabled).flatMap((engine) => engine.layerIds);
  if (defaults.length) return [...new Set(defaults)].filter((id) => supported.includes(id));
  const available = snapshots.map((snapshot) => snapshot.layerId).filter((id) => supported.includes(id));
  const preferred = available.find((id) => id === "climate.propagation.experimental")
    ?? available.find((id) => id === "climate.scalar")
    ?? supported.find((id) => id === "climate.propagation.experimental")
    ?? supported[0];
  return preferred ? [preferred] : [];
}

async function loadCurrent(scope: SpatialLayerScope, selected: readonly string[], signal?: AbortSignal) {
  return scope.kind === "house"
    ? api.houseSpatialLayersCurrent(scope.id, selected, signal)
    : api.propertySpatialLayersCurrent(scope.id, selected, signal);
}

async function loadHistory(
  scope: SpatialLayerScope,
  selected: readonly string[],
  at: number,
  range: { from: number; to: number } | null,
  signal?: AbortSignal,
) {
  const options = {
    layerIds: selected,
    from: new Date(range?.from ?? at - SPATIAL_LAYER_HISTORY_WINDOW_MS).toISOString(),
    to: new Date(range?.to ?? at + 60_000).toISOString(),
    limit: range ? 20_000 : 1_000,
  };
  return scope.kind === "house"
    ? api.houseSpatialLayersHistory(scope.id, options, signal)
    : api.propertySpatialLayersHistory(scope.id, options, signal);
}

/**
 * Replay advances its visual cursor four times per second. Archive-backed
 * spatial snapshots do not change at that cadence, so keep only the latest
 * cursor and admit at most one history request per interval. A hidden tab does
 * no history work and catches up once when it becomes visible again.
 */
function useThrottledHistoryAt(value: number | null, scopeKey: string, enabled: boolean): number | null {
  const [throttled, setThrottled] = useState<number | null>(null);
  const latest = useRef<number | null>(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedAt = useRef(0);
  const activeScopeKey = useRef(scopeKey);
  const commit = useRef<() => void>(() => undefined);

  commit.current = () => {
    if (!enabled || latest.current === null
        || (typeof document !== "undefined" && document.hidden)) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    lastCommittedAt.current = Date.now();
    setThrottled(latest.current);
  };

  useEffect(() => {
    latest.current = value;
    if (activeScopeKey.current !== scopeKey) {
      activeScopeKey.current = scopeKey;
      lastCommittedAt.current = 0;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    }
    if (!enabled || value === null) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      lastCommittedAt.current = 0;
      setThrottled(null);
      return;
    }
    const remaining = SPATIAL_LAYER_HISTORY_MIN_INTERVAL_MS - (Date.now() - lastCommittedAt.current);
    if (lastCommittedAt.current === 0 || remaining <= 0) {
      commit.current();
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        commit.current();
      }, remaining);
    }
  }, [enabled, scopeKey, value]);

  useEffect(() => {
    const catchUp = () => {
      if (typeof document === "undefined" || !document.hidden) commit.current();
    };
    document.addEventListener("visibilitychange", catchUp);
    return () => document.removeEventListener("visibilitychange", catchUp);
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  if (!enabled || value === null || activeScopeKey.current !== scopeKey
      || (typeof document !== "undefined" && document.hidden)) return null;
  return throttled;
}

export function useSpatialLayers({ scope, enabled = true, historyAt = null, historyRange = null }: UseSpatialLayersOptions): UseSpatialLayersResult {
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : "";
  const boundedHistoryRange = historyAt !== null
      && historyRange
      && Number.isFinite(historyRange.from)
      && Number.isFinite(historyRange.to)
      && historyRange.to > historyRange.from
    ? historyRange
    : null;
  const historyRangeKey = boundedHistoryRange
    ? `${boundedHistoryRange.from}:${boundedHistoryRange.to}`
    : "cursor";
  // A replay range is prefetched once and filtered locally as the cursor moves.
  // Callers without a known range retain the bounded trailing-cursor fallback.
  const historyQueryAt = useThrottledHistoryAt(
    boundedHistoryRange?.to ?? historyAt,
    `${scopeKey}:${historyRangeKey}`,
    enabled,
  );
  const [engines, setEngines] = useState<SpatialLayerEngineManifest[]>([]);
  const [health, setHealth] = useState<SpatialLayerEngineHealth[]>([]);
  const [topology, setTopology] = useState<SpatialTopology | null>(null);
  const [current, setCurrent] = useState<SpatialLayerSnapshot[]>([]);
  const [history, setHistory] = useState<SpatialLayerSnapshot[]>([]);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "live" | "reconnecting">("idle");
  const [now, setNow] = useState(() => Date.now());
  const requestSequence = useRef(0);
  const activeScope = useRef(scopeKey);
  const activeRefreshController = useRef<AbortController | null>(null);

  const selectionKey = selectedLayerIds.join(",");

  useEffect(() => {
    activeRefreshController.current?.abort();
    activeRefreshController.current = null;
    activeScope.current = scopeKey;
    requestSequence.current += 1;
    setEngines([]);
    setHealth([]);
    setTopology(null);
    setCurrent([]);
    setHistory([]);
    setSelectedLayerIds([]);
    setAvailable(false);
    setError(null);
    setRefreshing(false);
    setHistoryLoading(false);
    setStreamState("idle");
    if (!enabled || !scope) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    setLoading(true);
    void Promise.all([
      api.spatialLayerEngines(controller.signal),
      loadCurrent(scope, [], controller.signal),
    ]).then(([catalog, overview]) => {
      if (controller.signal.aborted || requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      const supported = catalog.filter((engine) => engine.enabled !== false && engine.supportedScopes.includes(scope.kind));
      setEngines(supported);
      setCurrent(overview.snapshots);
      setHealth(overview.health);
      setTopology(overview.topology);
      setAvailable(supported.length > 0);
      setSelectedLayerIds(initialSelection(supported, overview.snapshots));
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setAvailable(false);
      if (!capabilityUnavailable(reason)) setError(asError(reason));
    }).finally(() => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setLoading(false);
    });
    return () => {
      controller.abort();
      activeRefreshController.current?.abort();
      activeRefreshController.current = null;
    };
  }, [enabled, scopeKey]);

  const refresh = useCallback(async () => {
    if (!enabled || !scope || !available) return;
    activeRefreshController.current?.abort();
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    activeRefreshController.current = controller;
    setRefreshing(true);
    try {
      const overview = await loadCurrent(scope, selectedLayerIds, controller.signal);
      if (requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      setCurrent(overview.snapshots);
      setHealth(overview.health);
      setTopology(overview.topology);
      setError(null);
      setNow(Date.now());
    } catch (reason) {
      if (!controller.signal.aborted && requestId === requestSequence.current) setError(asError(reason));
    } finally {
      if (activeRefreshController.current === controller) activeRefreshController.current = null;
      if (!controller.signal.aborted && requestId === requestSequence.current) setRefreshing(false);
    }
  }, [available, enabled, scope, scopeKey, selectionKey]);

  useEffect(() => {
    if (!available || !scope || historyAt !== null) return;
    const refreshIfVisible = () => {
      if (typeof document === "undefined" || !document.hidden) void refresh();
    };
    const timer = window.setInterval(refreshIfVisible, SPATIAL_LAYER_POLL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [available, historyAt, refresh, scopeKey]);

  useEffect(() => {
    if (!available || historyAt !== null || !scope || typeof EventSource === "undefined") return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToSpatialLayerEvents(scope, (event) => {
      if (event.layerId && selectedLayerIds.length && !selectedLayerIds.includes(event.layerId)) return;
      // The visibility listener on the polling path performs one authoritative
      // refresh when the tab returns; streaming changes need not wake a hidden UI.
      if (typeof document !== "undefined" && document.hidden) return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, 200);
    }, setStreamState, () => setStreamState("reconnecting"));
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribe();
      setStreamState("idle");
    };
  }, [available, historyAt, refresh, scopeKey, selectionKey]);

  useEffect(() => {
    if (!available || !scope || historyQueryAt === null || selectedLayerIds.length === 0) {
      setHistory([]);
      setHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    setHistoryLoading(true);
    void loadHistory(scope, selectedLayerIds, historyQueryAt, boundedHistoryRange, controller.signal).then((snapshots) => {
      if (controller.signal.aborted || requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      setHistory(snapshots);
      setError(null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setError(asError(reason));
    }).finally(() => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setHistoryLoading(false);
    });
    return () => controller.abort();
  }, [available, boundedHistoryRange?.from, boundedHistoryRange?.to, historyQueryAt, scopeKey, selectionKey]);

  useEffect(() => {
    if (!available || historyAt !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [available, historyAt]);

  const snapshots = useMemo(() => {
    const source = historyAt === null ? current : history;
    const selected = source.filter((snapshot) => selectedLayerIds.includes(snapshot.layerId));
    return historyAt === null ? latestSnapshotPerLayer(selected) : latestSnapshotPerLayer(selected, historyAt);
  }, [current, history, historyAt, selectionKey]);

  const staleLayerIds = useMemo(() => historyAt === null
    ? snapshots.filter((snapshot) => isSnapshotStale(snapshot, now)).map((snapshot) => snapshot.layerId)
    : [], [historyAt, now, snapshots]);

  const setLayerSelected = useCallback((layerId: string, selected: boolean) => {
    setSelectedLayerIds((currentIds) => {
      if (selected) return currentIds.includes(layerId) ? currentIds : [...currentIds, layerId];
      return currentIds.filter((id) => id !== layerId);
    });
  }, []);

  return {
    available,
    loading,
    refreshing,
    historyLoading,
    error,
    streamState,
    engines,
    health,
    topology,
    snapshots,
    history,
    selectedLayerIds,
    staleLayerIds,
    setLayerSelected,
    refresh,
  };
}
