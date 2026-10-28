import { useCallback } from "react";
import type { ConnectionState } from "@climate-twin/contracts";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, aggregateConnection, settleInBackground } from "./support";
import type { StreamConnections } from "./support";
import type { ClimateDataStore, PipelineActions, StreamConnectionActions } from "./pipelineTypes";

/** The live stream connections: their aggregate state, the heartbeat polling fallback and reconnect resyncs. */
export function useStreamConnections(
  store: Pick<ClimateDataStore,
    | "activeHouseId" | "apiAvailable" | "hasHydratedActiveHouse" | "hasReachedLiveConnection"
    | "heartbeatFallbackTimer" | "heartbeatPollAt" | "reconnectResyncTimer" | "setPollingFallback"
    | "setStreamConnections" | "streamConnectionsRef"
  >,
  actions: Pick<PipelineActions, "loadHouseData">,
): StreamConnectionActions {
  const { hasHydratedActiveHouse, apiAvailable, reconnectResyncTimer, activeHouseId, streamConnectionsRef, setStreamConnections, setPollingFallback, hasReachedLiveConnection, heartbeatFallbackTimer, heartbeatPollAt } = store;
  const { loadHouseData } = actions;
  const scheduleActiveHouseResync = useCallback((delay = 50) => {
      if (!hasHydratedActiveHouse.current || !apiAvailable.current) return;
      if (reconnectResyncTimer.current !== null) window.clearTimeout(reconnectResyncTimer.current);
      reconnectResyncTimer.current = window.setTimeout(() => {
        reconnectResyncTimer.current = null;
        const houseId = activeHouseId.current;
        if (houseId) settleInBackground(loadHouseData(houseId));
      }, delay);
    }, [loadHouseData]);
  const updateStreamConnection = useCallback((stream: keyof StreamConnections, next: ConnectionState) => {
      const previousAggregate = aggregateConnection(streamConnectionsRef.current);
      const updated = { ...streamConnectionsRef.current, [stream]: next };
      const nextAggregate = aggregateConnection(updated);
      streamConnectionsRef.current = updated;
      setStreamConnections(updated);
      if (nextAggregate === "live") {
        setPollingFallback(false);
        if (hasReachedLiveConnection.current && previousAggregate !== "live") scheduleActiveHouseResync();
        hasReachedLiveConnection.current = true;
      }
    }, [scheduleActiveHouseResync]);
  const resetStreamConnections = useCallback(() => {
      const offline: StreamConnections = { legacy: "offline", measurements: "offline" };
      streamConnectionsRef.current = offline;
      hasReachedLiveConnection.current = false;
      setStreamConnections(offline);
      setPollingFallback(false);
    }, []);
  // A heartbeat that arrives while no stream is live means the client should poll instead.
  const handleHeartbeat = useCallback(() => {
      if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
      heartbeatFallbackTimer.current = window.setTimeout(() => {
        heartbeatFallbackTimer.current = null;
        if (aggregateConnection(streamConnectionsRef.current) === "live") return;
        setPollingFallback(true);
        const now = Date.now();
        if (now - heartbeatPollAt.current < HEARTBEAT_POLL_MIN_INTERVAL_MS) return;
        heartbeatPollAt.current = now;
        scheduleActiveHouseResync(0);
      }, 1_000);
    }, [scheduleActiveHouseResync]);
  return { scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat };
}
