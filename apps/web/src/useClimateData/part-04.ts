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
  subscribeToEvents,
  subscribeToMeasurementEvents,
  type CreateHouseInput,
  type CreateSensorInput,
  type HousePatch,
  type HouseGeoreferencePatch,
  type MeasurementHistoryPage,
  type SensorPatch,
} from "../api";
import { subscribeToAuthEpoch } from "../authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, timeRangeHours, type ClimateState, type TimeRange } from "../domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../measurements";
import { routeFromLocation } from "../routing";
import { publishHouseWeatherUpdate } from "../useHouseWeather";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_TELEMETRY_BUFFER_LIMIT, MAX_SERIES_SAMPLES, PORTFOLIO_LOAD_CONCURRENCY, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isPollingCompatibilityHeartbeat, legacySeries, loadPortfolioInBackground, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLoadedHouseTelemetry, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import { useuseClimateDataPart03 } from "./part-03";
type DeferredContext = {
  handleTelemetry: (event: TelemetryEvent) => void;
  handleMeasurement: (sample: MeasurementSample) => void;
};
export function useuseClimateDataPart04(context: ReturnType<typeof useuseClimateDataPart03>) {
  const deferred = context as typeof context & DeferredContext;
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData } = context;
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
  const handleHeartbeat = useCallback((data: unknown) => {
      const pollingCompatibility = isPollingCompatibilityHeartbeat(data);
      if (heartbeatFallbackTimer.current !== null) window.clearTimeout(heartbeatFallbackTimer.current);
      const activatePollingFallback = () => {
        heartbeatFallbackTimer.current = null;
        if (!pollingCompatibility && aggregateConnection(streamConnectionsRef.current) === "live") return;
        if (pollingCompatibility) updateStreamConnection("legacy", "reconnecting");
        setPollingFallback(true);
        const now = Date.now();
        if (now - heartbeatPollAt.current < HEARTBEAT_POLL_MIN_INTERVAL_MS) return;
        heartbeatPollAt.current = now;
        scheduleActiveHouseResync(0);
      };
      if (pollingCompatibility) activatePollingFallback();
      else heartbeatFallbackTimer.current = window.setTimeout(activatePollingFallback, 1_000);
    }, [scheduleActiveHouseResync, updateStreamConnection]);
  useEffect(() => {
      if (sessionLocked) return undefined;
      let cancelled = false;
      const initializationEpoch = sessionLifecycleEpoch.current;
      const invalidated = () => cancelled || sessionLifecycleEpoch.current !== initializationEpoch;
      let unsubscribe: (() => void) | undefined;
      let unsubscribeMeasurements: (() => void) | undefined;
      let streamGateTimer: number | null = null;
      let releaseStreamGate: (() => void) | undefined;
      const initialize = async () => {
        const hadInventory = stateRef.current.houses.length > 0;
        if (!hadInventory) {
          setLoading(true);
          setBootstrapStatus("loading");
        }
        setBootstrapError(null);
        apiAvailable.current = false;
        hasHydratedActiveHouse.current = false;
        resetStreamConnections();
        const inventoryMutations = new Map<string, HouseInventoryMutation>();
        activeInventoryMutationBuffers.current.add(inventoryMutations);
        try {
          // Resolve authentication before any workspace resource is requested.
          const session = await api.session();
          if (invalidated()) return;
          if (!session.authenticated || session.setupRequired) {
            apiAvailable.current = false;
            const locked = !session.setupRequired;
            sessionLockedRef.current = locked;
            setSessionLocked(locked);
            const cleared = blankState(session);
            stateRef.current = cleared;
            setStateInternal(cleared);
            setDataMode("unknown");
            dataModeRef.current = "unknown";
            resetStreamConnections();
            setBootstrapStatus(session.setupRequired ? "setup-required" : "login-required");
            return;
          }
          const [properties, rawHouses, propertyAreas, areaEquipment, propertyNotes, scopedMaintenanceResult] = await Promise.all([
            api.properties(),
            api.houses(),
            api.propertyAreas(),
            api.areaEquipment(),
            api.propertyNotes(),
            api.maintenanceTasks().then(
              (tasks) => ({ tasks, error: null as unknown }),
              (error: unknown) => ({ tasks: null, error }),
            ),
          ]);
          const houses = replayHouseInventory(rawHouses, inventoryMutations);
          if (invalidated()) return;
          recordResourceError("maintenance:scoped", scopedMaintenanceResult.error);
          apiAvailable.current = true;
          if (houses.length === 0) {
            setState((current) => ({
              ...withoutDemoTelemetry(current, true),
              session,
              properties,
              propertyAreas,
              areaEquipment,
              propertyNotes,
              houses: [],
              sensors: [],
              observations: [],
              maintenanceTasks: scopedMaintenanceResult.tasks ?? current.maintenanceTasks,
              staticParameters: [],
            }));
            setDataMode("unknown");
            dataModeRef.current = "unknown";
            resetStreamConnections();
            setBootstrapStatus(properties.length === 0 && !session.readOnly ? "empty" : "ready");
            return;
          }
          setState((current) => ({
            ...current,
            session,
            properties,
            propertyAreas,
            areaEquipment,
            propertyNotes,
            maintenanceTasks: scopedMaintenanceResult.tasks ?? current.maintenanceTasks,
            houses,
          }));
          const currentHouse = activeHouseId.current
            ? houses.find((house) => house.id === activeHouseId.current)
            : undefined;
          const requestedHouse = initialHouseId.current
            ? houses.find((house) => house.id === initialHouseId.current)
            : undefined;
          const activeHouse = currentHouse ?? requestedHouse ?? houses[0]!;
          // Register the replay buffers first, establish both event listeners,
          // then request snapshots. This closes the snapshot/subscribe race while
          // retaining events delivered during hydration.
          let legacyStreamOpened = false;
          let measurementStreamOpened = false;
          const streamReady = new Promise<void>((resolve) => {
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              activeStreamGateReleases.current.delete(release);
              resolve();
            };
            releaseStreamGate = release;
            activeStreamGateReleases.current.add(release);
          });
          const markStreamOpen = (stream: keyof StreamConnections) => {
            if (invalidated()) return;
            if (stream === "legacy") legacyStreamOpened = true;
            else measurementStreamOpened = true;
            if (legacyStreamOpened && measurementStreamOpened) releaseStreamGate?.();
          };
          streamGateTimer = window.setTimeout(() => releaseStreamGate?.(), STREAM_BOOTSTRAP_WAIT_MS);
          const activeHouseLoad = loadHouseData(activeHouse.id, true, streamReady, !session.readOnly);
          // A synchronous subscription setup failure must not leave a later load
          // rejection unobserved; the awaited branch still drives normal errors.
          settleInBackground(activeHouseLoad);
          unsubscribe = subscribeToEvents((event) => {
            if (invalidated()) return;
            deferred.handleTelemetry(event);
            if (event.type === "heartbeat") handleHeartbeat(event.data);
          }, (nextConnection) => {
            if (!invalidated()) updateStreamConnection("legacy", nextConnection);
          }, () => markStreamOpen("legacy"));
          activeStreamUnsubscribers.current.add(unsubscribe);
          unsubscribeMeasurements = subscribeToMeasurementEvents(
            (sample) => { if (!invalidated()) deferred.handleMeasurement(sample); },
            (nextConnection) => {
              if (!invalidated()) updateStreamConnection("measurements", nextConnection);
            },
            () => markStreamOpen("measurements"),
          );
          activeStreamUnsubscribers.current.add(unsubscribeMeasurements);
          await activeHouseLoad;
          if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
          streamGateTimer = null;
          if (invalidated()) return;
          hasHydratedActiveHouse.current = true;
          if (!session.readOnly) settleInBackground(refreshTpLinkDevices());
          setBootstrapStatus("ready");
          const secondaryHouseIds = houses.filter((house) => house.id !== activeHouse.id).map((house) => house.id);
          settleInBackground(loadPortfolioInBackground(
            secondaryHouseIds,
            loadPortfolioHouseData,
            invalidated,
          ));
        } catch (error) {
          if (unsubscribe) activeStreamUnsubscribers.current.delete(unsubscribe);
          unsubscribe?.();
          unsubscribe = undefined;
          if (unsubscribeMeasurements) activeStreamUnsubscribers.current.delete(unsubscribeMeasurements);
          unsubscribeMeasurements?.();
          unsubscribeMeasurements = undefined;
          if (!invalidated()) {
            apiAvailable.current = false;
            resetStreamConnections();
            if (apiStatus(error) === 401) {
              sessionLockedRef.current = true;
              setSessionLocked(true);
              setBootstrapError(null);
              setDataMode("unknown");
              dataModeRef.current = "unknown";
              const cleared = blankState();
              stateRef.current = cleared;
              setStateInternal(cleared);
              setBootstrapStatus("login-required");
              return;
            }
            setBootstrapError(error instanceof Error && error.message.trim() ? error.message : "The Stugu service could not be reached.");
            if (hadInventory) {
              // Keep the last confirmed real snapshot visible and mark transport
              // failure separately; a retry must not turn a transient outage into
              // an empty installation or erase the user's spatial context.
              setState((current) => withoutDemoTelemetry(current));
              setBootstrapStatus("ready");
            } else {
              dataModeRef.current = "unknown";
              setDataMode("unknown");
              setState((current) => ({
                ...withoutDemoTelemetry(current, true),
                houses: [],
                sensors: [],
                observations: [],
                staticParameters: [],
              }));
              setBootstrapStatus("unavailable");
            }
          }
        } finally {
          activeInventoryMutationBuffers.current.delete(inventoryMutations);
          if (!invalidated()) setLoading(false);
        }
      };
      settleInBackground(initialize());
      return () => {
        cancelled = true;
        hasHydratedActiveHouse.current = false;
        activeHouseLoadVersion.current += 1;
        if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
        releaseStreamGate?.();
        releaseStreamGate = undefined;
        if (unsubscribe) activeStreamUnsubscribers.current.delete(unsubscribe);
        unsubscribe?.();
        if (unsubscribeMeasurements) activeStreamUnsubscribers.current.delete(unsubscribeMeasurements);
        unsubscribeMeasurements?.();
      };
    }, [bootstrapAttempt, handleHeartbeat, loadHouseData, loadPortfolioHouseData, refreshTpLinkDevices, resetStreamConnections, sessionLocked, updateStreamConnection]);
  return Object.assign(context, { scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat });
}
