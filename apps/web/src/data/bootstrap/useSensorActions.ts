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
import { useSensorMutations } from "../sensors/sensorMutations";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_TELEMETRY_BUFFER_LIMIT, MAX_SERIES_SAMPLES, PORTFOLIO_LOAD_CONCURRENCY, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isPollingCompatibilityHeartbeat, legacySeries, loadPortfolioInBackground, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLoadedHouseTelemetry, replaceMeasurementSeriesWindow, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import type { SensorActions, SeriesContext } from "./pipelineTypes";
export function useSensorActions(
  context: SeriesContext,
): SeriesContext & SensorActions {
  const sensorMutations = useSensorMutations();
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData, scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat, purgeSessionState, retryBootstrap, revalidateSession, endSession, handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements, loadSeries } = context;
  const loadHistoricalSeries = useCallback(async (
      sensorId: string,
      metric: string,
      window: HistoricalSeriesWindow,
      signal?: AbortSignal,
    ): Promise<MeasurementHistoryPage> => {
      const fromMs = Date.parse(window.from);
      const toMs = Date.parse(window.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        throw new Error("Historical replay requires a valid start and end time");
      }
      if (window.bucketSeconds !== null
        && (!Number.isSafeInteger(window.bucketSeconds) || window.bucketSeconds < 1 || window.bucketSeconds > 86_400)) {
        throw new Error("Historical replay resolution must be between 1 second and 1 day");
      }

      const requestedFrom = new Date(fromMs).toISOString();
      const requestedTo = new Date(toMs).toISOString();
      const seriesKey = seriesStateKey(sensorId, metric);
      const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
      seriesLoadVersions.current.set(seriesKey, requestVersion);
      const isCurrentRequest = () => seriesLoadVersions.current.get(seriesKey) === requestVersion;
      setSeriesStates((current) => {
        const previous = current[seriesKey];
        return {
          ...current,
          [seriesKey]: {
            status: "loading",
            error: null,
            forecastError: previous?.forecastError ?? null,
            requestedFrom,
            requestedTo,
            loadedFrom: previous?.loadedFrom ?? null,
            loadedTo: previous?.loadedTo ?? null,
            partial: previous?.partial ?? false,
          },
        };
      });

      const fail = (error: unknown) => {
        if (!isCurrentRequest()) return;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            ...(current[seriesKey] ?? {
              forecastError: null, loadedFrom: null, loadedTo: null, partial: false,
            }),
            status: "error",
            error: errorMessage(error, "History data is temporarily unavailable"),
            requestedFrom,
            requestedTo,
          },
        }));
      };

      if (!apiAvailable.current) {
        const error = new Error("History data is unavailable while the service is offline");
        fail(error);
        throw error;
      }

      const liveTelemetry: BufferedSeriesTelemetry = {
        sensorId,
        metric,
        samples: new Map(),
        readings: new Map(),
      };
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === sensorId && buffer.metric === metric) activeSeriesTelemetryBuffers.current.delete(buffer);
      }
      activeSeriesTelemetryBuffers.current.add(liveTelemetry);

      try {
        const history = signal
          ? await api.measurementHistoryPage(
              sensorId,
              metric,
              requestedFrom,
              requestedTo,
              MAX_SERIES_SAMPLES,
              window.bucketSeconds ?? undefined,
              signal,
            )
          : await api.measurementHistoryPage(
              sensorId,
              metric,
              requestedFrom,
              requestedTo,
              MAX_SERIES_SAMPLES,
              window.bucketSeconds ?? undefined,
            );
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("Historical replay was cancelled", "AbortError");
        }
        if (!isCurrentRequest()) return history;

        seriesCommitSequence.current += 1;
        seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: false });
        setState((current) => {
          const samples = replaceMeasurementSeriesWindow(
            current.measurementHistory[sensorId]?.[metric] ?? [],
            history.samples,
            liveTelemetry.samples.values(),
            requestedFrom,
            requestedTo,
            history.truncated,
          );
          return {
            ...current,
            measurementHistory: {
              ...current.measurementHistory,
              [sensorId]: { ...current.measurementHistory[sensorId], [metric]: samples },
            },
          };
        });
        const loadedFrom = history.samples[0]?.timestamp ?? null;
        const loadedTo = history.samples.at(-1)?.timestamp ?? null;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            status: "ready",
            error: null,
            forecastError: current[seriesKey]?.forecastError ?? null,
            requestedFrom,
            requestedTo,
            loadedFrom,
            loadedTo,
            partial: history.truncated,
          },
        }));
        return history;
      } catch (error) {
        if (signal?.aborted) throw error;
        fail(error);
        throw error;
      } finally {
        activeSeriesTelemetryBuffers.current.delete(liveTelemetry);
      }
    }, []);
  const createSensor = useCallback(async (input: CreateSensorInput): Promise<Sensor> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not saved.");
      const saved = await sensorMutations.createSensor(input);
      recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({
        ...current,
        sensors: [...current.sensors.filter((sensor) => sensor.id !== saved.id), saved],
      }));
      if (saved.tpLinkDeviceId) settleInBackground(refreshTpLinkDevices(undefined, { force: true }));
      return saved;
    }, [recordHouseMutation, refreshTpLinkDevices, sensorMutations.createSensor]);
  const updateSensor = useCallback(async (sensorId: string, patch: SensorPatch): Promise<Sensor> => {
      await sensorMoveQueues.current.get(sensorId)?.catch(() => undefined);
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not updated.");
      const previousHouseId = stateRef.current.sensors.find((sensor) => sensor.id === sensorId)?.houseId;
      const saved = await sensorMutations.updateSensor({ sensorId, patch, previousHouseId });
      if (previousHouseId && previousHouseId !== saved.houseId) {
        recordHouseMutation({ resource: "sensor", action: "delete", houseId: previousHouseId, id: sensorId });
      }
      recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
      persistedSensorPoints.current.set(sensorId, { x: saved.x, y: saved.y });
      setState((current) => ({
        ...current,
        sensors: [...current.sensors.filter((sensor) => sensor.id !== sensorId), saved],
      }));
      if (Object.hasOwn(patch, "tpLinkDeviceId")) {
        settleInBackground(refreshTpLinkDevices(undefined, { force: true }));
      }
      return saved;
    }, [recordHouseMutation, refreshTpLinkDevices, sensorMutations.updateSensor]);
  const deleteSensor = useCallback(async (sensorId: string): Promise<void> => {
      await sensorMoveQueues.current.get(sensorId)?.catch(() => undefined);
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not deleted.");
      const houseId = stateRef.current.sensors.find((sensor) => sensor.id === sensorId)?.houseId;
      const detachedObservations = stateRef.current.observations
        .filter((observation) => observation.sensorId === sensorId)
        .map((observation) => ({ ...observation, sensorId: null }));
      const removedStaticParameters = stateRef.current.staticParameters.filter((parameter) => (
        parameter.scopeType === "sensor" && parameter.scopeId === sensorId
      ));
      await sensorMutations.deleteSensor({ sensorId, houseId });
      if (houseId) recordHouseMutation({ resource: "sensor", action: "delete", houseId, id: sensorId });
      for (const observation of detachedObservations) {
        recordHouseMutation({ resource: "observation", action: "upsert", houseId: observation.houseId, value: observation });
      }
      for (const parameter of removedStaticParameters) {
        recordHouseMutation({ resource: "static", action: "delete", houseId: parameter.houseId, id: parameter.id });
      }
      pendingMeasurementSamples.current = pendingMeasurementSamples.current
        .filter((sample) => sample.sensorId !== sensorId);
      for (const buffer of activeTelemetryLoadBuffers.current) {
        for (const [key, event] of buffer) {
          if (event.data.sensorId === sensorId) buffer.delete(key);
        }
      }
      sensorMoveQueues.current.delete(sensorId);
      sensorMoveVersions.current.delete(sensorId);
      persistedSensorPoints.current.delete(sensorId);
      for (const key of seriesLoadVersions.current.keys()) {
        if (key.startsWith(`${sensorId}\u0000`)) seriesLoadVersions.current.delete(key);
      }
      for (const key of seriesCommitVersions.current.keys()) {
        if (key.startsWith(`${sensorId}\u0000`)) seriesCommitVersions.current.delete(key);
      }
      setState((current) => {
        const removedSensorIds = new Set([sensorId]);
        return {
          ...current,
          sensors: current.sensors.filter((sensor) => sensor.id !== sensorId),
          readings: withoutSensorIds(current.readings, removedSensorIds),
          history: withoutSensorIds(current.history, removedSensorIds),
          forecasts: withoutSensorIds(current.forecasts, removedSensorIds),
          latestMeasurements: withoutSensorIds(current.latestMeasurements, removedSensorIds),
          measurementHistory: withoutSensorIds(current.measurementHistory, removedSensorIds),
          measurementForecasts: withoutSensorIds(current.measurementForecasts, removedSensorIds),
          alertRules: current.alertRules.filter((rule) => rule.sensorId !== sensorId),
          alerts: current.alerts.filter((alert) => alert.sensorId !== sensorId),
          observations: current.observations.map((observation) => observation.sensorId === sensorId
            ? { ...observation, sensorId: null }
            : observation),
          staticParameters: current.staticParameters.filter((parameter) => !(
            parameter.scopeType === "sensor" && parameter.scopeId === sensorId
          )),
        };
      });
      settleInBackground(refreshTpLinkDevices(undefined, { force: true }));
    }, [recordHouseMutation, refreshTpLinkDevices, sensorMutations.deleteSensor]);
  const moveSensor = useCallback((sensorId: string, point: Point) => {
      if (!apiAvailable.current) return;
      const currentSensor = stateRef.current.sensors.find((sensor) => sensor.id === sensorId);
      if (!currentSensor) return;
      if (!persistedSensorPoints.current.has(sensorId)) {
        persistedSensorPoints.current.set(sensorId, { x: currentSensor.x, y: currentSensor.y });
      }
      setState((current) => ({
        ...current,
        sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...point } : sensor),
      }));
      const version = (sensorMoveVersions.current.get(sensorId) ?? 0) + 1;
      sensorMoveVersions.current.set(sensorId, version);
      const previous = sensorMoveQueues.current.get(sensorId) ?? Promise.resolve();
      const queued = previous.catch(() => undefined).then(async () => {
        try {
          const saved = await sensorMutations.moveSensor({
            sensorId,
            point,
            previousHouseId: currentSensor.houseId,
          });
          if (currentSensor.houseId !== saved.houseId) {
            recordHouseMutation({ resource: "sensor", action: "delete", houseId: currentSensor.houseId, id: sensorId });
          }
          recordHouseMutation({ resource: "sensor", action: "upsert", houseId: saved.houseId, value: saved });
          persistedSensorPoints.current.set(sensorId, { x: saved.x, y: saved.y });
          if (sensorMoveVersions.current.get(sensorId) !== version) return;
          setState((current) => ({
            ...current,
            sensors: [...current.sensors.filter((sensor) => sensor.id !== sensorId), saved],
          }));
        } catch (error) {
          if (sensorMoveVersions.current.get(sensorId) === version) {
            const persisted = persistedSensorPoints.current.get(sensorId);
            if (persisted) {
              setState((current) => ({
                ...current,
                sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...persisted } : sensor),
              }));
            }
          }
          throw error;
        }
      });
      sensorMoveQueues.current.set(sensorId, queued);
      settleInBackground(queued.catch(() => undefined).finally(() => {
        if (sensorMoveQueues.current.get(sensorId) === queued) sensorMoveQueues.current.delete(sensorId);
      }));
    }, [recordHouseMutation, sensorMutations.moveSensor]);
  const ensurePropertyWrite = useCallback(() => {
      if (stateRef.current.session.readOnly) throw new Error("This guest account is read-only.");
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not saved.");
    }, []);
  const refreshMovedPropertyContext = useCallback(async (includeEquipment: boolean): Promise<void> => {
      const requests: Promise<void>[] = [
        api.propertyNotes().then((propertyNotes) => {
          setState((current) => ({ ...current, propertyNotes }));
        }),
        api.maintenanceTasks().then((maintenanceTasks) => {
          setState((current) => ({ ...current, maintenanceTasks }));
        }),
      ];
      if (includeEquipment) {
        requests.push(api.areaEquipment().then((areaEquipment) => {
          setState((current) => ({ ...current, areaEquipment }));
        }));
      }
      await Promise.all(requests);
    }, []);
  return Object.assign(context, { loadHistoricalSeries, createSensor, updateSensor, deleteSensor, moveSensor, ensurePropertyWrite, refreshMovedPropertyContext });
}
