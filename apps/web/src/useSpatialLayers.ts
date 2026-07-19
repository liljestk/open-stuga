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

export interface UseSpatialLayersOptions {
  scope: SpatialLayerScope | null;
  enabled?: boolean;
  historyAt?: number | null;
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

async function loadHistory(scope: SpatialLayerScope, selected: readonly string[], at: number, signal?: AbortSignal) {
  const options = {
    layerIds: selected,
    from: new Date(at - SPATIAL_LAYER_HISTORY_WINDOW_MS).toISOString(),
    to: new Date(at + 60_000).toISOString(),
    limit: 1_000,
  };
  return scope.kind === "house"
    ? api.houseSpatialLayersHistory(scope.id, options, signal)
    : api.propertySpatialLayersHistory(scope.id, options, signal);
}

export function useSpatialLayers({ scope, enabled = true, historyAt = null }: UseSpatialLayersOptions): UseSpatialLayersResult {
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : "";
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

  const selectionKey = selectedLayerIds.join(",");

  useEffect(() => {
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
    setStreamState("idle");
    if (!enabled || !scope) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    setLoading(true);
    void Promise.all([
      api.spatialLayerEngines(),
      loadCurrent(scope, [], controller.signal),
      scope.kind === "house" ? api.houseSpatialLayersHealth(scope.id, controller.signal) : api.propertySpatialLayersHealth(scope.id, controller.signal),
      scope.kind === "house" ? api.houseSpatialLayerConfig(scope.id, controller.signal) : api.propertySpatialLayerConfig(scope.id, controller.signal),
    ]).then(([catalog, snapshots, nextHealth, configuration]) => {
      if (controller.signal.aborted || requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      const supported = catalog.filter((engine) => engine.enabled !== false && engine.supportedScopes.includes(scope.kind));
      setEngines(supported);
      setCurrent(snapshots);
      setHealth(nextHealth);
      setTopology(configuration.topology ?? configuration.configuration.topology ?? null);
      setAvailable(supported.length > 0);
      setSelectedLayerIds(initialSelection(supported, snapshots));
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setAvailable(false);
      if (!capabilityUnavailable(reason)) setError(asError(reason));
    }).finally(() => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setLoading(false);
    });
    return () => controller.abort();
  }, [enabled, scopeKey]);

  const refresh = useCallback(async () => {
    if (!enabled || !scope || !available) return;
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    setRefreshing(true);
    try {
      const [snapshots, nextHealth, configuration] = await Promise.all([
        loadCurrent(scope, selectedLayerIds, controller.signal),
        scope.kind === "house" ? api.houseSpatialLayersHealth(scope.id, controller.signal) : api.propertySpatialLayersHealth(scope.id, controller.signal),
        scope.kind === "house" ? api.houseSpatialLayerConfig(scope.id, controller.signal) : api.propertySpatialLayerConfig(scope.id, controller.signal),
      ]);
      if (requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      setCurrent(snapshots);
      setHealth(nextHealth);
      setTopology(configuration.topology ?? configuration.configuration.topology ?? null);
      setError(null);
      setNow(Date.now());
    } catch (reason) {
      if (requestId === requestSequence.current) setError(asError(reason));
    } finally {
      if (requestId === requestSequence.current) setRefreshing(false);
    }
  }, [available, enabled, scope, scopeKey, selectionKey]);

  useEffect(() => {
    if (!available || !scope || historyAt !== null) return;
    const timer = window.setInterval(() => void refresh(), SPATIAL_LAYER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [available, historyAt, refresh, scopeKey]);

  useEffect(() => {
    if (!available || historyAt !== null || !scope || typeof EventSource === "undefined") return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToSpatialLayerEvents(scope, (event) => {
      if (event.layerId && selectedLayerIds.length && !selectedLayerIds.includes(event.layerId)) return;
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
    if (!available || !scope || historyAt === null || selectedLayerIds.length === 0) {
      setHistory([]);
      setHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    setHistoryLoading(true);
    void loadHistory(scope, selectedLayerIds, historyAt, controller.signal).then((snapshots) => {
      if (controller.signal.aborted || requestId !== requestSequence.current || activeScope.current !== scopeKey) return;
      setHistory(snapshots);
      setError(null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setError(asError(reason));
    }).finally(() => {
      if (!controller.signal.aborted && requestId === requestSequence.current) setHistoryLoading(false);
    });
    return () => controller.abort();
  }, [available, historyAt, scopeKey, selectionKey]);

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
