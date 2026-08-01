import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  AppSession,
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AlertRule,
  AlertRulePatch,
  ConnectionState,
  Floor,
  House,
  IntegrationStatus,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MaintenanceTask,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MeasurementSample,
  MockScenario,
  Point,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  TelemetryEvent,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import {
  api,
  cancelPendingApiRequests,
  subscribeToApiAuthorizationChanges,
  type CreateHouseInput,
  type CreateSensorInput,
  type HousePatch,
  type HouseGeoreferencePatch,
  type MeasurementHistoryPage,
  type SensorPatch,
} from "../../api";
import { subscribeToAuthEpoch } from "../../authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, timeRangeHours, type ClimateState, type TimeRange } from "../../domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../../measurements";
import { routeFromLocation } from "../../routing";
import { publishHouseWeatherUpdate } from "../../useHouseWeather";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_TELEMETRY_BUFFER_LIMIT, MAX_SERIES_SAMPLES, PORTFOLIO_LOAD_CONCURRENCY, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isPollingCompatibilityHeartbeat, legacySeries, loadPortfolioInBackground, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLoadedHouseTelemetry, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import type { OperationsActions, PropertyContext } from "./pipelineTypes";
export function useOperationsActions(
  context: PropertyContext,
): PropertyContext & OperationsActions {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData, scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat, purgeSessionState, retryBootstrap, revalidateSession, endSession, handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements, loadSeries, loadHistoricalSeries, createSensor, updateSensor, deleteSensor, moveSensor, ensurePropertyWrite, refreshMovedPropertyContext, createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea, createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote, setHouseGeoreference, updateFloor, updateHouseDraft, updateHouse, createHouse } = context;
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
        sensors: current.sensors.filter((sensor) => sensor.houseId !== houseId),
        observations: current.observations.filter((observation) => observation.houseId !== houseId),
        staticParameters: current.staticParameters.filter((parameter) => parameter.houseId !== houseId),
        readings: withoutSensorIds(current.readings, removedSensorIds),
        history: withoutSensorIds(current.history, removedSensorIds),
        forecasts: withoutSensorIds(current.forecasts, removedSensorIds),
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
  const createMaintenanceTask = useCallback(async (input: MaintenanceTaskInput): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not saved.");
      const saved = await api.createMaintenanceTask(input);
      recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({ ...current, maintenanceTasks: [...current.maintenanceTasks, saved] }));
      return saved;
    }, [recordHouseMutation]);
  const reloadMaintenanceTask = useCallback(async (id: string): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task could not be reloaded.");
      const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
      if (!current) throw new Error("The maintenance task is no longer available.");
      const concurrentMutations: HouseMutationBuffer = new Map();
      activeHouseMutationBuffers.current.add(concurrentMutations);
      try {
        let fresh: MaintenanceTask | undefined;
        try {
          fresh = await api.maintenanceTask(id);
        } catch (error) {
          const status = error && typeof error === "object" && "status" in error
            ? (error as { status?: unknown }).status
            : null;
          if (status !== 404) throw error;
        }
        const reloaded = replayMaintenanceTaskMutation(
          id,
          fresh,
          concurrentMutations,
        );
        activeHouseMutationBuffers.current.delete(concurrentMutations);
        if (!reloaded) {
          recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
          setState((state) => ({
            ...state,
            maintenanceTasks: state.maintenanceTasks.filter((item) => item.id !== id),
          }));
          throw new Error("The maintenance task is no longer available.");
        }
        if (current.houseId !== reloaded.houseId) {
          recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
        }
        recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: reloaded.houseId, value: reloaded });
        setState((state) => ({
          ...state,
          maintenanceTasks: [...state.maintenanceTasks.filter((item) => item.id !== id), reloaded],
        }));
        return reloaded;
      } finally {
        activeHouseMutationBuffers.current.delete(concurrentMutations);
      }
    }, [recordHouseMutation]);
  const updateMaintenanceTask = useCallback(async (id: string, patch: MaintenanceTaskPatch): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not updated.");
      const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
      if (!current) throw new Error("The maintenance task is no longer available.");
      if (current.revision !== patch.baseRevision) throw new Error("The maintenance task changed before this edit could be saved.");
      const saved = await api.updateMaintenanceTask(id, patch);
      if (current.houseId !== saved.houseId) {
        recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
      }
      recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
      setState((state) => ({
        ...state,
        maintenanceTasks: [...state.maintenanceTasks.filter((task) => task.id !== id), saved],
      }));
      return saved;
    }, [recordHouseMutation]);
  const maintenanceTaskRevisions = useCallback(async (id: string) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. Revision history could not be loaded.");
      return api.maintenanceTaskRevisions(id);
    }, []);
  return Object.assign(context, { deleteHouse, saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions, createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions });
}
