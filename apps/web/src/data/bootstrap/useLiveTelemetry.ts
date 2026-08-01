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
import { appendLiveHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../../measurements";
import { routeFromLocation } from "../../routing";
import { publishHouseWeatherUpdate } from "../../useHouseWeather";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_SERIES_SAMPLES, LIVE_TELEMETRY_BUFFER_LIMIT, PORTFOLIO_LOAD_CONCURRENCY, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isPollingCompatibilityHeartbeat, isRemoteSharedDemoTelemetry, legacySeries, loadPortfolioInBackground, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLoadedHouseTelemetry, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import type { LiveTelemetryActions, SessionLifecycleContext } from "./pipelineTypes";
export function useLiveTelemetry(
  context: SessionLifecycleContext,
): SessionLifecycleContext & LiveTelemetryActions {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData, scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat } = context;
  const pendingLegacyReadings = useRef<Reading[]>([]);
  const isActiveHouseSensor = useCallback((sensorId: string) => {
      const houseId = activeHouseId.current;
      return houseId !== null && stateRef.current.sensors.some((sensor) => (
        sensor.id === sensorId && sensor.houseId === houseId
      ));
    }, []);
  const purgeSessionState = useCallback((locked: boolean) => {
      sessionLifecycleEpoch.current += 1;
      sessionLockedRef.current = locked;
      setSessionLocked(locked);
      cancelPendingApiRequests();
      apiAvailable.current = false;
      hasHydratedActiveHouse.current = false;
      hasReachedLiveConnection.current = false;
      heartbeatPollAt.current = 0;
      activeHouseId.current = null;
      initialHouseId.current = null;
      tick.current = 0;

      if (measurementFlushTimer.current !== null) window.clearTimeout(measurementFlushTimer.current);
      if (reconnectResyncTimer.current !== null) window.clearTimeout(reconnectResyncTimer.current);
      if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
      if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
      if (saveStateTimer.current !== null) window.clearTimeout(saveStateTimer.current);
      measurementFlushTimer.current = null;
      reconnectResyncTimer.current = null;
      heartbeatFallbackTimer.current = null;
      mutationRefreshTimer.current = null;
      saveStateTimer.current = null;
      pendingMeasurementSamples.current = [];
      pendingLegacyReadings.current = [];

      for (const unsubscribe of activeStreamUnsubscribers.current) unsubscribe();
      activeStreamUnsubscribers.current.clear();
      for (const release of activeStreamGateReleases.current) release();
      activeStreamGateReleases.current.clear();
      for (const buffer of activeTelemetryLoadBuffers.current) buffer.clear();
      activeTelemetryLoadBuffers.current.clear();
      for (const buffer of activeHouseMutationBuffers.current) buffer.clear();
      activeHouseMutationBuffers.current.clear();
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        buffer.samples.clear();
        buffer.readings.clear();
      }
      activeSeriesTelemetryBuffers.current.clear();
      for (const buffer of activeInventoryMutationBuffers.current) buffer.clear();
      activeInventoryMutationBuffers.current.clear();

      activeHouseLoadVersion.current += 1;
      tpLinkRefreshVersion.current += 1;
      seriesCommitSequence.current += 1;
      houseTelemetryVersions.current.clear();
      seriesLoadVersions.current.clear();
      seriesCommitVersions.current.clear();
      sensorMoveQueues.current.clear();
      sensorMoveVersions.current.clear();
      persistedSensorPoints.current.clear();
      tpLinkPollStatus.current = null;
      globalFieldVersions.current = {
        alertRules: globalFieldVersions.current.alertRules + 1,
        alerts: globalFieldVersions.current.alerts + 1,
        integration: globalFieldVersions.current.integration + 1,
      };

      const cleared = blankState();
      stateRef.current = cleared;
      setStateInternal(cleared);
      tpLinkDevicesRef.current = [];
      setTpLinkDevices([]);
      setTpLinkDevicesLoading(false);
      setTpLinkDevicesError(null);
      setResourceErrors({});
      setSeriesStates({});
      setScenario("normal");
      setSaveState("idle");
      setBootstrapError(null);
      setDataMode("unknown");
      dataModeRef.current = "unknown";
      resetStreamConnections();
      setBootstrapStatus(locked ? "login-required" : "loading");
      setLoading(!locked);
    }, [resetStreamConnections]);
  const retryBootstrap = useCallback(() => {
      sessionLockedRef.current = false;
      setSessionLocked(false);
      setBootstrapAttempt((attempt) => attempt + 1);
    }, []);
  const revalidateSession = useCallback(() => {
      purgeSessionState(false);
      setBootstrapAttempt((attempt) => attempt + 1);
    }, [purgeSessionState]);
  const endSession = useCallback(() => {
      purgeSessionState(true);
    }, [purgeSessionState]);
  useEffect(() => subscribeToApiAuthorizationChanges((change) => {
      if (change === "expired") endSession();
      else revalidateSession();
    }), [endSession, revalidateSession]);
  useEffect(() => subscribeToAuthEpoch(revalidateSession), [revalidateSession]);
  useEffect(() => {
      if (connection === "live" || dataMode !== "demo") return;
      const timer = window.setInterval(() => {
        tick.current += 1;
        setState((current) => dataModeRef.current === "demo"
          ? advanceMockTelemetry(current, scenario, tick.current)
          : current);
      }, 2000);
      return () => window.clearInterval(timer);
    }, [connection, dataMode, scenario]);
  const flushMeasurements = useCallback(() => {
      measurementFlushTimer.current = null;
      const queuedReadings = pendingLegacyReadings.current;
      const queuedSamples = pendingMeasurementSamples.current;
      pendingLegacyReadings.current = [];
      pendingMeasurementSamples.current = [];
      if (!queuedReadings.length && !queuedSamples.length) return;
      const readings = [...new Map(queuedReadings.map((reading) => [
        `${reading.sensorId}\u0000${reading.timestamp}`,
        reading,
      ])).values()];
      const streamedSamples = [...new Map(queuedSamples.map((sample) => [
        `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`,
        sample,
      ])).values()];
      setState((current) => {
        const currentHouseId = activeHouseId.current;
        const knownSensorIds = new Set(current.sensors
          .filter((sensor) => sensor.houseId === currentHouseId)
          .map((sensor) => sensor.id));
        const acceptedReadings = readings.filter((reading) => knownSensorIds.has(reading.sensorId)
          && (current.integration.mock.mode !== "real" || !isDemoSource(reading.source))
          && !isRemoteSharedDemoTelemetry(current, reading.sensorId, reading.source));
        const acceptedSamplesByKey = new Map<string, MeasurementSample>();
        for (const sample of [
          ...acceptedReadings.flatMap((reading) => readingSamples(reading, current.measurementDefinitions)),
          ...streamedSamples,
        ]) {
          if (!knownSensorIds.has(sample.sensorId)
            || (current.integration.mock.mode === "real" && isDemoSource(sample.source))
            || isRemoteSharedDemoTelemetry(current, sample.sensorId, sample.source)) continue;
          acceptedSamplesByKey.set(
            `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`,
            sample,
          );
        }
        const acceptedSamples = [...acceptedSamplesByKey.values()];
        if (!acceptedReadings.length && !acceptedSamples.length) return current;

        let readingsState = current.readings;
        let historyState = current.history;
        if (acceptedReadings.length) {
          readingsState = { ...current.readings };
          historyState = { ...current.history };
          const readingsBySensor = new Map<string, Reading[]>();
          for (const reading of acceptedReadings) {
            const sensorReadings = readingsBySensor.get(reading.sensorId) ?? [];
            sensorReadings.push(reading);
            readingsBySensor.set(reading.sensorId, sensorReadings);
          }
          for (const [sensorId, sensorReadings] of readingsBySensor) {
            let latest = readingsState[sensorId];
            for (const reading of sensorReadings) {
              const previousTime = latest ? Date.parse(latest.timestamp) : Number.NEGATIVE_INFINITY;
              const incomingTime = Date.parse(reading.timestamp);
              if (!latest || !Number.isFinite(previousTime) || !Number.isFinite(incomingTime) || incomingTime >= previousTime) {
                latest = reading;
              }
            }
            readingsState[sensorId] = latest!;
            const existing = current.history[sensorId] ?? [];
            historyState[sensorId] = mergeLegacySeries(
              existing,
              sensorReadings,
              Math.max(LIVE_SERIES_SAMPLES, existing.length),
            );
          }
        }

        return {
          ...current,
          readings: readingsState,
          history: historyState,
          latestMeasurements: upsertLatest(current.latestMeasurements, acceptedSamples),
          measurementHistory: appendLiveHistory(
            current.measurementHistory,
            acceptedSamples,
            LIVE_SERIES_SAMPLES,
          ),
        };
      });
    }, []);
  const handleTelemetry = useCallback((event: TelemetryEvent) => {
      if (event.type === "mutation") {
        if (mutationRefreshTimer.current !== null) window.clearTimeout(mutationRefreshTimer.current);
        mutationRefreshTimer.current = window.setTimeout(() => {
          mutationRefreshTimer.current = null;
          if (!sessionLockedRef.current) setBootstrapAttempt((attempt) => attempt + 1);
        }, 350);
      } else if (event.type === "opening") {
        setState((current) => current.houses.some((house) => house.id === event.data.houseId)
          ? { ...current, latestOpeningStateObservation: event.data }
          : current);
      } else if (event.type === "reading" && "temperature" in event.data && "humidity" in event.data) {
        const reading = event.data;
        if (!isActiveHouseSensor(reading.sensorId)
          || (dataModeRef.current === "real" && isDemoSource(reading.source))
          || isRemoteSharedDemoTelemetry(stateRef.current, reading.sensorId, reading.source)) return;
        for (const buffer of activeTelemetryLoadBuffers.current) {
          bufferLiveTelemetry(buffer, { type: "reading", data: reading });
        }
        for (const buffer of activeSeriesTelemetryBuffers.current) {
          if (buffer.sensorId === reading.sensorId) bufferSeriesValue(buffer.readings, reading.timestamp, reading);
        }
        pendingLegacyReadings.current.push(reading);
        if (measurementFlushTimer.current === null) {
          measurementFlushTimer.current = window.setTimeout(flushMeasurements, 16);
        }
      } else if (event.type === "alert" && "ruleId" in event.data) {
        const alert = event.data;
        globalFieldVersions.current.alerts += 1;
        setState((current) => ({ ...current, alerts: [alert, ...current.alerts.filter((item) => item.id !== alert.id)] }));
      } else if (event.type === "integration" && "homeAssistant" in event.data) {
        const integration = event.data as ClimateState["integration"];
        const previousTpLinkPollStatus = tpLinkPollStatus.current;
        const tpLinkPollAdvanced = previousTpLinkPollStatus !== null && (
          previousTpLinkPollStatus.lastPollAt !== integration.tpLink.lastPollAt
          || previousTpLinkPollStatus.discoveredDevices !== integration.tpLink.discoveredDevices
        );
        tpLinkPollStatus.current = {
          lastPollAt: integration.tpLink.lastPollAt,
          discoveredDevices: integration.tpLink.discoveredDevices,
        };
        applyIntegrationStatus(integration);
        if (tpLinkPollAdvanced) settleInBackground(refreshTpLinkDevices());
      } else if (event.type === "weather" && event.data.type === "weather.snapshot") {
        publishHouseWeatherUpdate(event.data);
      }
    }, [applyIntegrationStatus, flushMeasurements, isActiveHouseSensor, refreshTpLinkDevices]);
  const handleMeasurement = useCallback((sample: MeasurementSample) => {
      if (!isActiveHouseSensor(sample.sensorId)
        || (dataModeRef.current === "real" && isDemoSource(sample.source))
        || isRemoteSharedDemoTelemetry(stateRef.current, sample.sensorId, sample.source)) return;
      for (const buffer of activeTelemetryLoadBuffers.current) {
        bufferLiveTelemetry(buffer, { type: "measurement", data: sample });
      }
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === sample.sensorId && buffer.metric === sample.metric) {
          bufferSeriesValue(buffer.samples, sample.timestamp, sample);
        }
      }
      pendingMeasurementSamples.current.push(sample);
      if (measurementFlushTimer.current === null) {
        measurementFlushTimer.current = window.setTimeout(flushMeasurements, 16);
      }
    }, [flushMeasurements, isActiveHouseSensor]);
  const selectHouse = useCallback(async (houseId: string) => {
      activeHouseId.current = houseId;
      if (!apiAvailable.current) return;
      try { await loadHouseData(houseId); } catch { /* Keep the previous snapshot during transient failures. */ }
    }, [loadHouseData]);
  const importHistoricalMeasurements = useCallback(async (
      houseId: string,
      samples: MeasurementSample[],
      onProgress?: (completed: number, total: number) => void,
    ) => {
      if (!apiAvailable.current) throw new Error("Historical import requires a connection to the Stugu server.");
      const result = await api.importHistoricalMeasurements(samples, onProgress);
      await loadHouseData(houseId);
      return result;
    }, [loadHouseData]);
  return Object.assign(context, { purgeSessionState, retryBootstrap, revalidateSession, endSession, handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements });
}
