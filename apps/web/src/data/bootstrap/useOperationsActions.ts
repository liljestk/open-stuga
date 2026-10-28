import { useCallback } from "react";
import type { AlertRule, AlertRulePatch, House, HousePatch, ManualObservation, ManualObservationInput, ManualObservationPatch, MockScenario } from "@climate-twin/contracts";
import { api } from "../../api";
import { preferredHouseForProperty } from "../../domain";
import { replayHouseMutations, synchronizeSensorRoomLabels, withoutSensorIds } from "./support";
import type { HouseMutationBuffer } from "./support";
import type { ClimateDataStore, PipelineActions, OperationsActions } from "./pipelineTypes";
export function useOperationsActions(
  store: Pick<ClimateDataStore,
    | "activeHouseId" | "activeHouseMutationBuffers" | "activeTelemetryLoadBuffers" | "apiAvailable"
    | "dataModeRef" | "globalFieldVersions" | "houseTelemetryVersions" | "pendingMeasurementSamples"
    | "recordHouseMutation" | "recordInventoryMutation" | "saveStateTimer" | "seriesCommitVersions"
    | "seriesLoadVersions" | "sessionLockedRef" | "setSaveState" | "setScenario" | "setState"
    | "state" | "stateRef"
  >,
  actions: Pick<PipelineActions, "updateHouseDraft">,
): OperationsActions {
  const { apiAvailable, recordInventoryMutation, stateRef, houseTelemetryVersions, activeHouseId, pendingMeasurementSamples, activeTelemetryLoadBuffers, seriesLoadVersions, seriesCommitVersions, setState, setSaveState, saveStateTimer, sessionLockedRef, dataModeRef, setScenario, globalFieldVersions, recordHouseMutation, activeHouseMutationBuffers } = store;
  const { updateHouseDraft } = actions;
  const deleteHouse = useCallback(async (houseId: string): Promise<void> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The Home was not hidden.");
      await api.deleteHouse(houseId);
      recordInventoryMutation({ action: "delete", id: houseId });
      const removedSensorIds = new Set(stateRef.current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id));
      houseTelemetryVersions.current.set(houseId, (houseTelemetryVersions.current.get(houseId) ?? 0) + 1);
      if (activeHouseId.current === houseId) activeHouseId.current = null;
      pendingMeasurementSamples.current = pendingMeasurementSamples.current
        .filter((sample) => !removedSensorIds.has(sample.sensorId));
      for (const buffer of activeTelemetryLoadBuffers.current) {
        for (const [key, event] of buffer) {
          if (removedSensorIds.has(event.data.sensorId)) buffer.delete(key);
        }
      }
      for (const key of seriesLoadVersions.current.keys()) {
        const separator = key.indexOf("\u0000");
        if (separator >= 0 && removedSensorIds.has(key.slice(0, separator))) seriesLoadVersions.current.delete(key);
      }
      for (const key of seriesCommitVersions.current.keys()) {
        const separator = key.indexOf("\u0000");
        if (separator >= 0 && removedSensorIds.has(key.slice(0, separator))) seriesCommitVersions.current.delete(key);
      }
      setState((current) => ({
        ...current,
        houses: current.houses.filter((house) => house.id !== houseId),
        properties: current.properties.map((property) => {
          if (property.defaultHouseId !== houseId) return property;
          const replacement = preferredHouseForProperty(
            { id: property.id, defaultHouseId: null },
            current.houses.filter((house) => house.id !== houseId),
          );
          return { ...property, defaultHouseId: replacement?.id ?? null, updatedAt: new Date().toISOString() };
        }),
        sensors: current.sensors.filter((sensor) => sensor.houseId !== houseId),
        observations: current.observations.filter((observation) => observation.houseId !== houseId),
        staticParameters: current.staticParameters.filter((parameter) => parameter.houseId !== houseId),
        readings: withoutSensorIds(current.readings, removedSensorIds),
        latestMeasurements: withoutSensorIds(current.latestMeasurements, removedSensorIds),
        measurementHistory: withoutSensorIds(current.measurementHistory, removedSensorIds),
        measurementForecasts: withoutSensorIds(current.measurementForecasts, removedSensorIds),
      }));
    }, [recordInventoryMutation]);
  const saveLayout = useCallback(async (houseId: string, house: House) => {
      setSaveState("saving");
      const patch: HousePatch = {
        name: house.name,
        timezone: house.timezone,
        floors: house.floors,
        ...(house.mapPlacement ? { mapPlacement: house.mapPlacement } : {}),
      };
      updateHouseDraft(houseId, patch);
      try {
        if (!apiAvailable.current) throw new Error("The local API is unavailable. The layout was not saved.");
        const saved = await api.updateHouse(houseId, patch);
        recordInventoryMutation({ action: "upsert", value: saved });
        setState((current) => ({
          ...current,
          houses: [...current.houses.filter((item) => item.id !== houseId), saved],
          sensors: synchronizeSensorRoomLabels(current.sensors, houseId, saved.floors),
        }));
        setSaveState("saved");
        if (saveStateTimer.current !== null) window.clearTimeout(saveStateTimer.current);
        saveStateTimer.current = window.setTimeout(() => {
          saveStateTimer.current = null;
          if (!sessionLockedRef.current) setSaveState("idle");
        }, 1800);
      } catch (error) {
        setSaveState("error");
        throw error;
      }
    }, [recordInventoryMutation, updateHouseDraft]);
  const runScenario = useCallback(async (next: MockScenario["id"]) => {
      if (dataModeRef.current !== "demo") throw new Error("Scenarios are available only after demo mode is confirmed.");
      setScenario(next);
      if (apiAvailable.current) {
        try { await api.runScenario(next); } catch { /* Local simulation still runs when enabled. */ }
      }
    }, []);
  const createRule = useCallback(async (rule: Omit<AlertRule, "id">) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The rule was not saved.");
      const saved = await api.createAlertRule(rule);
      globalFieldVersions.current.alertRules += 1;
      setState((current) => ({ ...current, alertRules: [...current.alertRules, saved] }));
    }, []);
  const updateRule = useCallback(async (id: string, patch: AlertRulePatch) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The rule was not updated.");
      const saved = await api.updateAlertRule(id, patch);
      globalFieldVersions.current.alertRules += 1;
      setState((current) => ({
        ...current,
        alertRules: [...current.alertRules.filter((rule) => rule.id !== id), saved],
      }));
      return saved;
    }, []);
  const acknowledgeAlert = useCallback(async (id: string) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The alert was not acknowledged.");
      const saved = await api.acknowledgeAlert(id);
      globalFieldVersions.current.alerts += 1;
      setState((current) => ({ ...current, alerts: [saved, ...current.alerts.filter((alert) => alert.id !== id)] }));
    }, []);
  const createObservation = useCallback(async (observation: ManualObservationInput) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation was not saved.");
      const saved = await api.createObservation(observation);
      recordHouseMutation({ resource: "observation", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({ ...current, observations: [...current.observations, saved] }));
      return saved;
    }, [recordHouseMutation]);
  const reloadObservation = useCallback(async (id: string) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation could not be reloaded.");
      const current = stateRef.current.observations.find((observation) => observation.id === id);
      if (!current) throw new Error("The observation is no longer available.");
      const concurrentMutations: HouseMutationBuffer = new Map();
      activeHouseMutationBuffers.current.add(concurrentMutations);
      try {
        const fresh = await api.observations(current.houseId);
        const merged = replayHouseMutations(current.houseId, {
          sensors: [], observations: fresh, maintenanceTasks: [], staticParameters: [],
        }, concurrentMutations).observations;
        activeHouseMutationBuffers.current.delete(concurrentMutations);
        recordHouseMutation({ resource: "observation", action: "replace", houseId: current.houseId, values: merged });
        setState((state) => ({
          ...state,
          observations: [...state.observations.filter((item) => item.houseId !== current.houseId), ...merged],
        }));
        const reloaded = merged.find((observation) => observation.id === id);
        if (!reloaded) throw new Error("The observation is no longer available.");
        return reloaded;
      } finally {
        activeHouseMutationBuffers.current.delete(concurrentMutations);
      }
    }, [recordHouseMutation]);
  const updateObservation = useCallback(async (id: string, patch: ManualObservationPatch) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation was not updated.");
      const previous = stateRef.current.observations.find((observation) => observation.id === id);
      if (!previous) throw new Error("The observation is no longer available.");
      const currentRevision = previous.revision ?? 1;
      if (currentRevision !== patch.baseRevision) throw new Error("The observation changed before this edit could be saved.");

      const { baseRevision, ...changes } = patch;
      const optimisticAt = new Date().toISOString();
      const lifecycleChanges: Partial<ManualObservation> = changes.status === "resolved"
        ? {
            status: "resolved",
            resolutionNote: changes.resolutionNote ?? previous.resolutionNote ?? null,
            resolvedAt: (previous.status ?? "open") === "resolved" ? previous.resolvedAt ?? optimisticAt : optimisticAt,
          }
        : changes.status === "open"
          ? { status: "open", resolutionNote: null, resolvedAt: null }
          : {};
      const optimistic: ManualObservation = {
        ...previous,
        ...changes,
        ...lifecycleChanges,
        revision: baseRevision + 1,
        updatedAt: optimisticAt,
      };
      const publishOptimistically = changes.status === undefined;
      if (publishOptimistically) {
        setState((current) => ({
          ...current,
          observations: current.observations.map((observation) => observation.id === id ? optimistic : observation),
        }));
      }

      try {
        const saved = await api.updateObservation(id, patch);
        recordHouseMutation({ resource: "observation", action: "upsert", houseId: saved.houseId, value: saved });
        setState((current) => ({
          ...current,
          observations: [...current.observations.filter((observation) => observation.id !== id), saved],
        }));
        return saved;
      } catch (error) {
        if (publishOptimistically) {
          setState((current) => ({
            ...current,
            observations: current.observations.map((observation) => observation === optimistic ? previous : observation),
          }));
        }
        throw error;
      }
    }, [recordHouseMutation]);
  const observationRevisions = useCallback(async (id: string) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. Revision history could not be loaded.");
      return api.observationRevisions(id);
    }, []);
  return { deleteHouse, saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions };
}
