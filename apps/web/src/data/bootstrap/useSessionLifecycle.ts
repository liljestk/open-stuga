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
import { ApiVersionMismatchError, subscribeToApiVersionMismatch } from "../../apiRuntimeVersion";
import { subscribeToAuthEpoch } from "../../authEpoch";
import { createDemoState, nextMockReading, snapshotToReadings, timeRangeHours, type ClimateState, type TimeRange } from "../../domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "../../measurements";
import { routeFromLocation } from "../../routing";
import { publishHouseWeatherUpdate } from "../../useHouseWeather";
import { activateAccountStorage, deactivateAccountStorage } from "../../browserStorage";
import { LiveEventCoordinator } from "../live/LiveEventCoordinator";
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_TELEMETRY_BUFFER_LIMIT, MAX_SERIES_SAMPLES, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isPollingCompatibilityHeartbeat, legacySeries, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLoadedHouseTelemetry, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import type { SessionLifecycleActions, WorkspaceHydrationContext } from "./pipelineTypes";
type DeferredContext = {
  handleTelemetry: (event: TelemetryEvent) => void;
  handleMeasurement: (sample: MeasurementSample) => void;
};
/** Replays sensor mutations that arrived while the workspace sensor index loaded, house by house. */
function replayWorkspaceSensors(houses: readonly House[], sensors: readonly Sensor[], mutations: HouseMutationBuffer): Sensor[] {
  return houses.flatMap((house) => replayHouseMutations(house.id, {
    sensors: sensors.filter((sensor) => sensor.houseId === house.id),
    observations: [],
    maintenanceTasks: [],
    staticParameters: [],
  }, mutations).sensors);
}

export function useSessionLifecycle(
  context: WorkspaceHydrationContext,
): WorkspaceHydrationContext & SessionLifecycleActions {
  const deferred = context as typeof context & DeferredContext;
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData } = context;
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
  const enterIncompatibleState = useCallback((error: ApiVersionMismatchError) => {
      sessionLifecycleEpoch.current += 1;
      cancelPendingApiRequests();
      for (const unsubscribe of activeStreamUnsubscribers.current) unsubscribe();
      activeStreamUnsubscribers.current.clear();
      for (const release of activeStreamGateReleases.current) release();
      apiAvailable.current = false;
      hasHydratedActiveHouse.current = false;
      resetStreamConnections();
      setBootstrapError(error.message);
      setBootstrapStatus("incompatible");
      setLoading(false);
    }, [resetStreamConnections]);
  useEffect(() => subscribeToApiVersionMismatch(enterIncompatibleState), [enterIncompatibleState]);
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
      let unsubscribeStreams: (() => void) | undefined;
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
        const workspaceSensorMutations: HouseMutationBuffer = new Map();
        activeInventoryMutationBuffers.current.add(inventoryMutations);
        activeHouseMutationBuffers.current.add(workspaceSensorMutations);
        try {
          // Resolve authentication before any workspace resource is requested.
          const session = await api.session();
          if (invalidated()) return;
          if (!session.authenticated || session.setupRequired) {
            deactivateAccountStorage({ purge: true });
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
          activateAccountStorage(session);
          const [properties, rawHouses, propertyAreas, areaEquipment, propertyNotes, scopedMaintenanceResult, workspaceSensorsResult] = await Promise.all([
            api.properties(),
            api.houses(),
            api.propertyAreas(),
            api.areaEquipment(),
            api.propertyNotes(),
            api.maintenanceTasks().then(
              (tasks) => ({ tasks, error: null as unknown }),
              (error: unknown) => ({ tasks: null, error }),
            ),
            api.sensors().then(
              (sensors) => ({ sensors, error: null as unknown }),
              (error: unknown) => ({ sensors: null, error }),
            ),
          ]);
          const houses = replayHouseInventory(rawHouses, inventoryMutations);
          if (invalidated()) return;
          recordResourceError("maintenance:scoped", scopedMaintenanceResult.error);
          recordResourceError("sensors:workspace", workspaceSensorsResult.error);
          const workspaceSensors = workspaceSensorsResult.sensors;
          const accessibleHouseIds = new Set(houses.map((house) => house.id));
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
            // Replay inside the updater so mutations buffered until React applies it are included.
            sensors: workspaceSensors === null
              ? current.sensors.filter((sensor) => accessibleHouseIds.has(sensor.houseId))
              : replayWorkspaceSensors(houses, workspaceSensors, workspaceSensorMutations),
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
          const coordinator = new LiveEventCoordinator();
          unsubscribeStreams = coordinator.start({
            onTelemetry: (event) => {
              if (invalidated()) return;
              deferred.handleTelemetry(event);
              if (event.type === "heartbeat") handleHeartbeat(event.data);
            },
            onMeasurement: (sample) => {
              if (!invalidated()) deferred.handleMeasurement(sample);
            },
            onConnection: (stream, nextConnection) => {
              if (!invalidated()) updateStreamConnection(stream, nextConnection);
            },
            onOpen: markStreamOpen,
            onResume: () => {
              if (invalidated()) return;
              // Visibility resume takes the authoritative workspace bootstrap
              // path. Cancel the aggregate stream reconnect's narrower house
              // resync so the same Home is not hydrated twice.
              if (reconnectResyncTimer.current !== null) {
                window.clearTimeout(reconnectResyncTimer.current);
                reconnectResyncTimer.current = null;
              }
              setBootstrapAttempt((attempt) => attempt + 1);
            },
            houseIdForSensor: (sensorId) => (
              stateRef.current.sensors.find((sensor) => sensor.id === sensorId)?.houseId ?? null
            ),
          });
          activeStreamUnsubscribers.current.add(unsubscribeStreams);
          await activeHouseLoad;
          if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
          streamGateTimer = null;
          if (invalidated()) return;
          hasHydratedActiveHouse.current = true;
          if (!session.readOnly) settleInBackground(refreshTpLinkDevices());
          setBootstrapStatus("ready");
        } catch (error) {
          if (unsubscribeStreams) activeStreamUnsubscribers.current.delete(unsubscribeStreams);
          unsubscribeStreams?.();
          unsubscribeStreams = undefined;
          if (error instanceof ApiVersionMismatchError) {
            if (!invalidated()) enterIncompatibleState(error);
            return;
          }
          if (!invalidated()) {
            apiAvailable.current = false;
            resetStreamConnections();
            if (apiStatus(error) === 401) {
              deactivateAccountStorage({ purge: true });
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
          activeHouseMutationBuffers.current.delete(workspaceSensorMutations);
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
        if (unsubscribeStreams) activeStreamUnsubscribers.current.delete(unsubscribeStreams);
        unsubscribeStreams?.();
      };
    }, [bootstrapAttempt, enterIncompatibleState, handleHeartbeat, loadHouseData, refreshTpLinkDevices, resetStreamConnections, sessionLocked, updateStreamConnection]);
  return Object.assign(context, { scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat });
}
