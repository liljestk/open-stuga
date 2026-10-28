import { useCallback, useRef } from "react";
import type {
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import {
  api,
} from "../../api";
import { settleInBackground } from "./support";
import type { ClimateDataStore, IntegrationActions } from "./pipelineTypes";
export function useIntegrationActions(
  store: Pick<ClimateDataStore,
    | "apiAvailable" | "recordHouseMutation" | "sessionLifecycleEpoch" | "setState"
    | "setTpLinkDevices" | "setTpLinkDevicesError" | "setTpLinkDevicesLoading" | "stateRef"
    | "tpLinkDevicesRef" | "tpLinkRefreshVersion"
  >,
): IntegrationActions {
  const { tpLinkRefreshVersion, apiAvailable, tpLinkDevicesRef, setTpLinkDevices, setTpLinkDevicesError, setTpLinkDevicesLoading, sessionLifecycleEpoch, stateRef, recordHouseMutation, setState } = store;
  const tpLinkRefreshes = useRef(new Map<string, Promise<TpLinkDiscoveredDevice[]>>());
  const tpLinkForcedRefreshes = useRef(new Map<string, Promise<TpLinkDiscoveredDevice[]>>());
  const tpLinkForceVersions = useRef(new Map<string, number>());
  const startTpLinkRefresh = useCallback((refreshKey: string, houseId?: string) => {
      const refreshVersion = ++tpLinkRefreshVersion.current;
      const request = (async () => {
        if (!apiAvailable.current) {
          tpLinkDevicesRef.current = [];
          setTpLinkDevices([]);
          setTpLinkDevicesError(null);
          setTpLinkDevicesLoading(false);
          return [];
        }
        setTpLinkDevicesLoading(true);
        setTpLinkDevicesError(null);
        try {
          const devices = await api.tpLinkDevices(houseId);
          if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
          // A house-scoped inventory request is authoritative only for that house.
          // Keep sibling-house devices in memory so visiting Sensors or Setup for
          // one Home cannot make another Home's discovery notice disappear.
          const nextDevices = houseId
            ? [
                ...tpLinkDevicesRef.current.filter((device) => device.houseId !== houseId),
                ...devices,
              ]
            : devices;
          tpLinkDevicesRef.current = nextDevices;
          setTpLinkDevices(nextDevices);
          return devices;
        } catch (error) {
          // A superseded caller receives the authoritative newer inventory instead
          // of surfacing an obsolete failure in page-local error state.
          if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
          setTpLinkDevicesError(error instanceof Error ? error.message : "Could not load TP-Link devices");
          throw error;
        } finally {
          if (tpLinkRefreshVersion.current === refreshVersion) setTpLinkDevicesLoading(false);
        }
      })();
      tpLinkRefreshes.current.set(refreshKey, request);
      const clearRequest = () => {
        if (tpLinkRefreshes.current.get(refreshKey) === request) {
          tpLinkRefreshes.current.delete(refreshKey);
        }
      };
      void request.then(clearRequest, clearRequest);
      return request;
    }, []);
  const refreshTpLinkDevices = useCallback((
      houseId?: string,
      options: { force?: boolean } = {},
    ) => {
      const refreshEpoch = sessionLifecycleEpoch.current;
      const refreshKey = `${refreshEpoch}\u0000${houseId ?? "*"}`;
      if (!options.force) {
        return tpLinkRefreshes.current.get(refreshKey)
          ?? startTpLinkRefresh(refreshKey, houseId);
      }

      tpLinkForceVersions.current.set(
        refreshKey,
        (tpLinkForceVersions.current.get(refreshKey) ?? 0) + 1,
      );
      const existingForcedRefresh = tpLinkForcedRefreshes.current.get(refreshKey);
      if (existingForcedRefresh) return existingForcedRefresh;

      const forcedRefresh = (async () => {
        // Let forced callers in the same turn join one refresh before issuing it.
        await Promise.resolve();
        while (sessionLifecycleEpoch.current === refreshEpoch) {
          await tpLinkRefreshes.current.get(refreshKey)?.catch(() => undefined);
          if (sessionLifecycleEpoch.current !== refreshEpoch) break;
          const forceVersion = tpLinkForceVersions.current.get(refreshKey);
          try {
            const devices = await startTpLinkRefresh(refreshKey, houseId);
            if (tpLinkForceVersions.current.get(refreshKey) === forceVersion) return devices;
          } catch (error) {
            if (tpLinkForceVersions.current.get(refreshKey) === forceVersion) throw error;
          }
        }
        return tpLinkDevicesRef.current;
      })();
      tpLinkForcedRefreshes.current.set(refreshKey, forcedRefresh);
      const clearForcedRefresh = () => {
        if (tpLinkForcedRefreshes.current.get(refreshKey) !== forcedRefresh) return;
        tpLinkForcedRefreshes.current.delete(refreshKey);
        tpLinkForceVersions.current.delete(refreshKey);
      };
      void forcedRefresh.then(clearForcedRefresh, clearForcedRefresh);
      return forcedRefresh;
    }, [startTpLinkRefresh]);
  const disconnectHomeAssistant = useCallback(async (houseId: string) => api.disconnectHomeAssistant(houseId), []);
  const applyDetachedTpLinkSensors = useCallback((sensorIds: string[]) => {
      const detached = new Set(sensorIds);
      for (const sensor of stateRef.current.sensors) {
        if (!detached.has(sensor.id)) continue;
        const updated = { ...sensor };
        delete updated.tpLinkDeviceId;
        delete updated.tpLinkConnectionId;
        recordHouseMutation({ resource: "sensor", action: "upsert", houseId: updated.houseId, value: updated });
      }
      if (detached.size > 0) {
        setState((current) => ({
          ...current,
          sensors: current.sensors.map((sensor) => {
            if (!detached.has(sensor.id)) return sensor;
            const updated = { ...sensor };
            delete updated.tpLinkDeviceId;
            delete updated.tpLinkConnectionId;
            return updated;
          }),
        }));
      }
    }, [recordHouseMutation]);
  const disconnectTpLink = useCallback(async (connectionId: string) => {
      const result = await api.disconnectTpLink(connectionId);
      applyDetachedTpLinkSensors(result.detachedSensorIds);
      settleInBackground(refreshTpLinkDevices(undefined, { force: true }));
      return result;
    }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);
  const moveHomeAssistant = useCallback(async (fromHouseId: string, houseId: string) => (
      api.moveHomeAssistant(fromHouseId, houseId)
    ), []);
  const moveTpLink = useCallback(async (connectionId: string, houseId: string) => {
      const result = await api.moveTpLink(connectionId, houseId);
      applyDetachedTpLinkSensors(result.detachedSensorIds);
      settleInBackground(refreshTpLinkDevices(undefined, { force: true }));
      return result;
    }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);
  return { refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink };
}
