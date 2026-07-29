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
export function useClimateDataStore(context: Record<string, never>) {
  // Telemetry starts empty until the API positively confirms that this database
    // is still allowed to use demo data. This prevents a real installation from
    // flashing or regenerating mock values while its API is slow or unreachable.
    const initialHouseId = useRef(typeof window === "undefined" ? null : routeFromLocation(window.location).houseId);
  const sessionLockedRef = useRef(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [state, setStateInternal] = useState<ClimateState>(() => blankState());
  const setState = useCallback((next: SetStateAction<ClimateState>) => {
      // Once local logout locks the workspace, late completions from an aborted
      // request must not put old-session data back into React state.
      if (!sessionLockedRef.current) setStateInternal(next);
    }, []);
  const [loading, setLoading] = useState(true);
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [dataMode, setDataMode] = useState<DataMode>("unknown");
  const [streamConnections, setStreamConnections] = useState<StreamConnections>({
      legacy: "offline",
      measurements: "offline",
    });
  const connection = aggregateConnection(streamConnections);
  const [pollingFallback, setPollingFallback] = useState(false);
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  const [seriesStates, setSeriesStates] = useState<Record<string, SeriesLoadState>>({});
  const [scenario, setScenario] = useState<MockScenario["id"]>("normal");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tpLinkDevices, setTpLinkDevices] = useState<TpLinkDiscoveredDevice[]>([]);
  const tpLinkDevicesRef = useRef<TpLinkDiscoveredDevice[]>([]);
  const [tpLinkDevicesLoading, setTpLinkDevicesLoading] = useState(false);
  const [tpLinkDevicesError, setTpLinkDevicesError] = useState<string | null>(null);
  const tick = useRef(0);
  const apiAvailable = useRef(false);
  const dataModeRef = useRef<DataMode>("unknown");
  const stateRef = useRef(state);
  const streamConnectionsRef = useRef(streamConnections);
  const hasReachedLiveConnection = useRef(false);
  const hasHydratedActiveHouse = useRef(false);
  const heartbeatPollAt = useRef(0);
  const reconnectResyncTimer = useRef<number | null>(null);
  const heartbeatFallbackTimer = useRef<number | null>(null);
  const mutationRefreshTimer = useRef<number | null>(null);
  const sensorMoveQueues = useRef(new Map<string, Promise<void>>());
  const sensorMoveVersions = useRef(new Map<string, number>());
  const persistedSensorPoints = useRef(new Map<string, Point>());
  const activeHouseId = useRef<string | null>(initialHouseId.current);
  const activeHouseLoadVersion = useRef(0);
  const houseTelemetryVersions = useRef(new Map<string, number>());
  const seriesLoadVersions = useRef(new Map<string, number>());
  const seriesCommitVersions = useRef(new Map<string, SeriesCommit>());
  const seriesCommitSequence = useRef(0);
  const tpLinkPollStatus = useRef<Pick<IntegrationStatus["tpLink"], "lastPollAt" | "discoveredDevices"> | null>(null);
  const tpLinkRefreshVersion = useRef(0);
  const pendingMeasurementSamples = useRef<MeasurementSample[]>([]);
  const measurementFlushTimer = useRef<number | null>(null);
  const saveStateTimer = useRef<number | null>(null);
  const activeTelemetryLoadBuffers = useRef(new Set<Map<string, BufferedLiveTelemetry>>());
  const activeHouseMutationBuffers = useRef(new Set<HouseMutationBuffer>());
  const activeSeriesTelemetryBuffers = useRef(new Set<BufferedSeriesTelemetry>());
  const activeInventoryMutationBuffers = useRef(new Set<Map<string, HouseInventoryMutation>>());
  const activeStreamUnsubscribers = useRef(new Set<() => void>());
  const activeStreamGateReleases = useRef(new Set<() => void>());
  const sessionLifecycleEpoch = useRef(0);
  const globalFieldVersions = useRef({ alertRules: 0, alerts: 0, integration: 0 });
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { streamConnectionsRef.current = streamConnections; }, [streamConnections]);
  useEffect(() => () => {
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
      for (const unsubscribe of activeStreamUnsubscribers.current) unsubscribe();
      activeStreamUnsubscribers.current.clear();
      for (const release of activeStreamGateReleases.current) release();
      activeStreamGateReleases.current.clear();
    }, []);
  const recordResourceError = useCallback((key: string, error: unknown | null) => {
      setResourceErrors((current) => {
        if (error === null) {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        }
        const message = errorMessage(error, "This data source is temporarily unavailable");
        return current[key] === message ? current : { ...current, [key]: message };
      });
    }, []);
  const recordHouseMutation = useCallback((mutation: BufferedHouseMutation) => {
      const key = houseMutationKey(mutation);
      for (const buffer of activeHouseMutationBuffers.current) {
        buffer.delete(key);
        buffer.set(key, mutation);
      }
    }, []);
  const recordInventoryMutation = useCallback((mutation: HouseInventoryMutation) => {
      const id = mutation.action === "delete" ? mutation.id : mutation.value.id;
      for (const buffer of activeInventoryMutationBuffers.current) {
        buffer.delete(id);
        buffer.set(id, mutation);
      }
    }, []);
  const applyIntegrationStatus = useCallback((integration: IntegrationStatus) => {
      globalFieldVersions.current.integration += 1;
      if (integration.mock.mode === "real" && dataModeRef.current !== "real") {
        globalFieldVersions.current.alerts += 1;
      }
      dataModeRef.current = integration.mock.mode;
      setDataMode(integration.mock.mode);
      setState((current) => {
        const next = { ...current, integration };
        return integration.mock.mode === "real" && current.integration.mock.mode !== "real"
          ? withoutDemoTelemetry(next, true)
          : next;
      });
    }, []);
  return Object.assign(context, { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus });
}
