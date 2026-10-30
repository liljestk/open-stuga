import { useCallback } from "react";
import type { House, Sensor } from "@climate-twin/contracts";
import { api } from "../../api";
import { type ClimateState } from "../../domain";
import { enabledDefinitions } from "../../measurements";
import { mutationScope, type InventoryList, type MutationNotice, type StoreRefresh } from "../live/mutationScope";
import { replayHouseInventory, replayWorkspaceSensors, settleInBackground } from "./support";
import type { HouseInventoryMutation, HouseMutationBuffer } from "./support";
import type { PendingMutationRefresh } from "./useClimateDataStore";
import type { ClimateDataStore, MutationRefreshActions, PipelineActions } from "./pipelineTypes";

const MUTATION_REFRESH_DEBOUNCE_MS = 350;

type PlainInventoryList = Exclude<InventoryList, "houses" | "sensors">;

const PLAIN_INVENTORY_LOADERS: { [List in PlainInventoryList]: () => Promise<ClimateState[List]> } = {
  properties: () => api.properties(),
  propertyAreas: () => api.propertyAreas(),
  areaEquipment: () => api.areaEquipment(),
  propertyNotes: () => api.propertyNotes(),
  maintenanceTasks: () => api.maintenanceTasks(),
};

function sameHouseIds(left: readonly House[], right: readonly House[]): boolean {
  const ids = new Set(left.map((house) => house.id));
  return ids.size === right.length && right.every((house) => ids.has(house.id));
}

// A sensor being dragged keeps its local position until its own save settles.
function keepMovingSensors(loaded: Sensor[], current: readonly Sensor[], moving: ReadonlyMap<string, unknown>): Sensor[] {
  if (moving.size === 0) return loaded;
  const local = new Map(current.map((sensor) => [sensor.id, sensor]));
  return loaded.map((sensor) => (moving.has(sensor.id) ? local.get(sensor.id) ?? sensor : sensor));
}

/**
 * Turns workspace mutation events into the narrowest bootstrap-store reload
 * that reflects them. Only a change to the Home list, membership or sharing,
 * or a resource the viewer may not name, re-runs the whole workspace bootstrap.
 */
export function useMutationRefresh(
  store: Pick<ClimateDataStore,
    | "activeHouseId" | "activeHouseMutationBuffers" | "activeInventoryMutationBuffers" | "apiAvailable"
    | "applyIntegrationStatus" | "globalFieldVersions" | "hasHydratedActiveHouse" | "mutationRefreshTimer"
    | "pendingMutationRefresh" | "sensorMoveQueues" | "sessionLifecycleEpoch" | "sessionLockedRef"
    | "setBootstrapAttempt" | "setState" | "stateRef" | "tpLinkPollStatus"
  >,
  actions: Pick<PipelineActions, "loadHouseData" | "refreshTpLinkDevices">,
): MutationRefreshActions {
  const { activeHouseId, activeHouseMutationBuffers, activeInventoryMutationBuffers, apiAvailable, applyIntegrationStatus, globalFieldVersions, hasHydratedActiveHouse, mutationRefreshTimer, pendingMutationRefresh, sensorMoveQueues, sessionLifecycleEpoch, sessionLockedRef, setBootstrapAttempt, setState, stateRef, tpLinkPollStatus } = store;
  const { loadHouseData, refreshTpLinkDevices } = actions;
  const reloadPlainList = useCallback(async <List extends PlainInventoryList>(list: List, epoch: number) => {
      const value = await PLAIN_INVENTORY_LOADERS[list]();
      if (sessionLifecycleEpoch.current !== epoch) return;
      setState((current) => ({ ...current, [list]: value }));
    }, []);
  const reloadHouses = useCallback(async (epoch: number) => {
      const inventoryMutations = new Map<string, HouseInventoryMutation>();
      activeInventoryMutationBuffers.current.add(inventoryMutations);
      try {
        const loaded = await api.houses();
        if (sessionLifecycleEpoch.current !== epoch) return;
        const houses = replayHouseInventory(loaded, inventoryMutations);
        // A Home that appeared or disappeared changes what the workspace may load.
        if (!sameHouseIds(houses, stateRef.current.houses)) {
          setBootstrapAttempt((attempt) => attempt + 1);
          return;
        }
        setState((current) => ({ ...current, houses }));
      } finally {
        activeInventoryMutationBuffers.current.delete(inventoryMutations);
      }
    }, []);
  const reloadSensors = useCallback(async (epoch: number) => {
      const sensorMutations: HouseMutationBuffer = new Map();
      activeHouseMutationBuffers.current.add(sensorMutations);
      try {
        const loaded = await api.sensors();
        if (sessionLifecycleEpoch.current !== epoch) return;
        setState((current) => ({
          ...current,
          sensors: keepMovingSensors(
            replayWorkspaceSensors(current.houses, loaded, sensorMutations),
            current.sensors,
            sensorMoveQueues.current,
          ),
        }));
      } finally {
        activeHouseMutationBuffers.current.delete(sensorMutations);
      }
    }, []);
  const reloadAlerts = useCallback(async (epoch: number) => {
      const versions = { ...globalFieldVersions.current };
      const [alertRules, alerts] = await Promise.all([api.alertRules(), api.alerts()]);
      if (sessionLifecycleEpoch.current !== epoch) return;
      // A live alert that arrived during the request is newer than this list.
      setState((current) => ({
        ...current,
        alertRules: globalFieldVersions.current.alertRules === versions.alertRules ? alertRules : current.alertRules,
        alerts: globalFieldVersions.current.alerts === versions.alerts ? alerts : current.alerts,
      }));
    }, []);
  const reloadIntegrations = useCallback(async (epoch: number) => {
      if (stateRef.current.session.readOnly) return;
      const version = globalFieldVersions.current.integration;
      const integration = await api.integrations();
      if (sessionLifecycleEpoch.current !== epoch || globalFieldVersions.current.integration !== version) return;
      tpLinkPollStatus.current = {
        lastPollAt: integration.tpLink.lastPollAt,
        discoveredDevices: integration.tpLink.discoveredDevices,
      };
      applyIntegrationStatus(integration);
    }, [applyIntegrationStatus]);
  const reloadDefinitions = useCallback(async (epoch: number) => {
      const definitions = await api.measurementDefinitions();
      if (sessionLifecycleEpoch.current !== epoch) return;
      setState((current) => ({ ...current, measurementDefinitions: enabledDefinitions(definitions) }));
    }, []);
  const refreshTarget = useCallback(async (target: StoreRefresh, epoch: number): Promise<unknown> => {
      switch (target) {
      case "properties":
      case "propertyAreas":
      case "areaEquipment":
      case "propertyNotes":
      case "maintenanceTasks":
        return reloadPlainList(target, epoch);
      case "houses":
        return reloadHouses(epoch);
      case "sensors":
        return reloadSensors(epoch);
      case "homeSnapshot":
        return activeHouseId.current ? loadHouseData(activeHouseId.current) : undefined;
      case "alerts":
        return reloadAlerts(epoch);
      case "integrations":
        return reloadIntegrations(epoch);
      case "tpLinkDevices":
        return stateRef.current.session.readOnly ? undefined : refreshTpLinkDevices();
      case "measurementDefinitions":
        return reloadDefinitions(epoch);
      }
    }, [loadHouseData, refreshTpLinkDevices, reloadAlerts, reloadDefinitions, reloadHouses, reloadIntegrations, reloadPlainList, reloadSensors]);
  const runRefresh = useCallback((due: ReadonlySet<PendingMutationRefresh>) => {
      // Until the active Home has hydrated, the bootstrap in flight may already
      // have read the changed resource; restarting it is the only safe refresh.
      if (due.has("bootstrap") || !hasHydratedActiveHouse.current || !apiAvailable.current) {
        setBootstrapAttempt((attempt) => attempt + 1);
        return;
      }
      const epoch = sessionLifecycleEpoch.current;
      for (const target of due) {
        if (target !== "bootstrap") settleInBackground(refreshTarget(target, epoch));
      }
    }, [refreshTarget]);
  const scheduleMutationRefresh = useCallback((notice: MutationNotice) => {
      const scope = mutationScope(notice);
      const pending = pendingMutationRefresh.current;
      if (scope.bootstrap) pending.add("bootstrap");
      for (const target of scope.store) {
        // Another Home's snapshot is not on screen; it loads when selected.
        if (target === "homeSnapshot" && scope.houseId !== null && scope.houseId !== activeHouseId.current) continue;
        pending.add(target);
      }
      if (pending.size === 0) return;
      if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
      mutationRefreshTimer.current = window.setTimeout(() => {
        mutationRefreshTimer.current = null;
        const due = new Set(pending);
        pending.clear();
        if (!sessionLockedRef.current) runRefresh(due);
      }, MUTATION_REFRESH_DEBOUNCE_MS);
    }, [runRefresh]);
  return { scheduleMutationRefresh };
}
