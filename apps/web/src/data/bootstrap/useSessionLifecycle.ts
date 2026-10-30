import { errorMessage } from "../../api/support/request-error";
import { useCallback,useEffect } from "react";
import type { AppSession, House, Sensor } from "@climate-twin/contracts";
import {
api,
cancelPendingApiRequests
} from "../../api";
import { ApiVersionMismatchError,subscribeToApiVersionMismatch } from "../../apiRuntimeVersion";
import { type ClimateState } from "../../domain";
import { activateAccountStorage,deactivateAccountStorage } from "../../browserStorage";
import { subscribeToApiAuthorizationChanges } from "../../api";
import { subscribeToAuthEpoch } from "../../authEpoch";
import { LiveEventCoordinator } from "../live/LiveEventCoordinator";
import { STREAM_BOOTSTRAP_WAIT_MS, apiStatus, blankState, replayHouseInventory, replayWorkspaceSensors, settleInBackground, withoutDemoTelemetry } from "./support";
import type { HouseInventoryMutation,HouseMutationBuffer,StreamConnections } from "./support";
import type { ClimateDataStore, PipelineActions, SessionLifecycleActions } from "./pipelineTypes";

// Scoped maintenance and workspace sensors may fail on their own without failing the bootstrap.
async function loadWorkspaceInventory() {
  const [properties, rawHouses, propertyAreas, areaEquipment, propertyNotes, scopedMaintenance, workspaceSensors] = await Promise.all([
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
  return { properties, rawHouses, propertyAreas, areaEquipment, propertyNotes, scopedMaintenance, workspaceSensors };
}

type WorkspaceInventory = Awaited<ReturnType<typeof loadWorkspaceInventory>>;

function hydratedWorkspaceSensors(
  current: ClimateState,
  { houses, workspaceSensors, sensorMutations }: {
    houses: House[];
    workspaceSensors: Sensor[] | null;
    sensorMutations: HouseMutationBuffer;
  },
): Sensor[] {
  if (workspaceSensors === null) {
    const accessibleHouseIds = new Set(houses.map((house) => house.id));
    return current.sensors.filter((sensor) => accessibleHouseIds.has(sensor.houseId));
  }
  return replayWorkspaceSensors(houses, workspaceSensors, sensorMutations);
}

// Keep the Home already on screen, then the one the URL asked for, then the first.
function activeHouseFor(houses: House[], currentHouseId: string | null, requestedHouseId: string | null): House {
  const currentHouse = currentHouseId
    ? houses.find((house) => house.id === currentHouseId)
    : undefined;
  const requestedHouse = requestedHouseId
    ? houses.find((house) => house.id === requestedHouseId)
    : undefined;
  return currentHouse ?? requestedHouse ?? houses[0]!;
}
export function useSessionLifecycle(
  store: Pick<ClimateDataStore,
    | "activeHouseId" | "activeHouseLoadVersion" | "activeHouseMutationBuffers"
    | "activeInventoryMutationBuffers" | "activeSeriesTelemetryBuffers" | "activeStreamGateReleases"
    | "activeStreamUnsubscribers" | "activeTelemetryLoadBuffers" | "apiAvailable" | "bootstrapAttempt"
    | "dataModeRef" | "globalFieldVersions" | "hasHydratedActiveHouse" | "hasReachedLiveConnection"
    | "heartbeatFallbackTimer" | "heartbeatPollAt" | "houseTelemetryVersions" | "initialHouseId"
    | "measurementFlushTimer" | "mutationRefreshTimer" | "pendingLegacyReadings" | "pendingMutationRefresh"
    | "pendingMeasurementSamples" | "persistedSensorPoints" | "reconnectResyncTimer"
    | "recordResourceError" | "saveStateTimer" | "sensorMoveQueues" | "sensorMoveVersions"
    | "seriesCommitSequence" | "seriesCommitVersions" | "seriesLoadVersions" | "sessionLifecycleEpoch"
    | "sessionLocked" | "sessionLockedRef" | "setBootstrapAttempt" | "setBootstrapError"
    | "setBootstrapStatus" | "setDataMode" | "setLoading" | "setResourceErrors" | "setSaveState"
    | "setScenario" | "setSeriesStates" | "setSessionLocked" | "setState" | "setStateInternal"
    | "setTpLinkDevices" | "setTpLinkDevicesError" | "setTpLinkDevicesLoading" | "stateRef" | "tick"
    | "tpLinkDevicesRef" | "tpLinkPollStatus" | "tpLinkRefreshVersion"
  >,
  actions: Pick<PipelineActions, "resetStreamConnections" | "handleTelemetry" | "handleHeartbeat" | "handleMeasurement" | "updateStreamConnection" | "loadHouseData" | "refreshTpLinkDevices">,
): SessionLifecycleActions {
  const { sessionLifecycleEpoch, activeStreamUnsubscribers, activeStreamGateReleases, apiAvailable, hasHydratedActiveHouse, setBootstrapError, setBootstrapStatus, setLoading, sessionLockedRef, setSessionLocked, hasReachedLiveConnection, heartbeatPollAt, activeHouseId, initialHouseId, tick, measurementFlushTimer, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, pendingMutationRefresh, saveStateTimer, pendingMeasurementSamples, pendingLegacyReadings, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeHouseLoadVersion, tpLinkRefreshVersion, seriesCommitSequence, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, tpLinkPollStatus, globalFieldVersions, stateRef, setStateInternal, tpLinkDevicesRef, setTpLinkDevices, setTpLinkDevicesLoading, setTpLinkDevicesError, setResourceErrors, setSeriesStates, setScenario, setSaveState, setDataMode, dataModeRef, setBootstrapAttempt, sessionLocked, setState, recordResourceError, bootstrapAttempt } = store;
  const { resetStreamConnections, handleTelemetry, handleHeartbeat, handleMeasurement, updateStreamConnection, loadHouseData, refreshTpLinkDevices } = actions;
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
      pendingMutationRefresh.current.clear();
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
      deactivateAccountStorage({ purge: true });
      purgeSessionState(true);
    }, [purgeSessionState]);
  useEffect(() => subscribeToApiAuthorizationChanges((change) => {
      if (change === "expired") endSession();
      else revalidateSession();
    }), [endSession, revalidateSession]);
  useEffect(() => subscribeToAuthEpoch(revalidateSession), [revalidateSession]);
  useEffect(() => {
      if (sessionLocked) return undefined;
      let cancelled = false;
      const initializationEpoch = sessionLifecycleEpoch.current;
      const invalidated = () => cancelled || sessionLifecycleEpoch.current !== initializationEpoch;
      let unsubscribeStreams: (() => void) | undefined;
      let streamGateTimer: number | null = null;
      let releaseStreamGate: (() => void) | undefined;
      const showSignedOutWorkspace = (session: AppSession) => {
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
      };
      const showHouselessWorkspace = (session: AppSession, workspace: WorkspaceInventory) => {
        setState((current) => ({
          ...withoutDemoTelemetry(current, true),
          session,
          properties: workspace.properties,
          propertyAreas: workspace.propertyAreas,
          areaEquipment: workspace.areaEquipment,
          propertyNotes: workspace.propertyNotes,
          houses: [],
          sensors: [],
          observations: [],
          maintenanceTasks: workspace.scopedMaintenance.tasks ?? current.maintenanceTasks,
          staticParameters: [],
        }));
        setDataMode("unknown");
        dataModeRef.current = "unknown";
        resetStreamConnections();
        setBootstrapStatus(workspace.properties.length === 0 && !session.readOnly ? "empty" : "ready");
      };
      const showWorkspaceInventory = (
        session: AppSession,
        workspace: WorkspaceInventory,
        houses: House[],
        sensorMutations: HouseMutationBuffer,
      ) => {
        setState((current) => ({
          ...current,
          session,
          properties: workspace.properties,
          propertyAreas: workspace.propertyAreas,
          areaEquipment: workspace.areaEquipment,
          propertyNotes: workspace.propertyNotes,
          maintenanceTasks: workspace.scopedMaintenance.tasks ?? current.maintenanceTasks,
          houses,
          // Replay inside the updater so mutations buffered until React applies it are included.
          sensors: hydratedWorkspaceSensors(current, {
            houses,
            workspaceSensors: workspace.workspaceSensors.sensors,
            sensorMutations,
          }),
        }));
      };
      // The gate opens once both streams are listening, or after the bootstrap wait.
      const openStreamGate = () => {
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
        return { streamReady, markStreamOpen };
      };
      const subscribeToLiveEvents = (markStreamOpen: (stream: keyof StreamConnections) => void) => {
        const coordinator = new LiveEventCoordinator();
        unsubscribeStreams = coordinator.start({
          onTelemetry: (event) => {
            if (invalidated()) return;
            handleTelemetry(event);
            if (event.type === "heartbeat") handleHeartbeat();
          },
          onMeasurement: (sample) => {
            if (!invalidated()) handleMeasurement(sample);
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
      };
      const hydrateActiveHouse = async (session: AppSession, activeHouse: House) => {
        // Register the replay buffers first, establish both event listeners,
        // then request snapshots. This closes the snapshot/subscribe race while
        // retaining events delivered during hydration.
        const { streamReady, markStreamOpen } = openStreamGate();
        streamGateTimer = window.setTimeout(() => releaseStreamGate?.(), STREAM_BOOTSTRAP_WAIT_MS);
        const activeHouseLoad = loadHouseData(activeHouse.id, true, streamReady, !session.readOnly);
        // A synchronous subscription setup failure must not leave a later load
        // rejection unobserved; the awaited branch still drives normal errors.
        settleInBackground(activeHouseLoad);
        subscribeToLiveEvents(markStreamOpen);
        await activeHouseLoad;
        if (streamGateTimer !== null) window.clearTimeout(streamGateTimer);
        streamGateTimer = null;
      };
      const hydrateWorkspace = async (
        session: AppSession,
        inventoryMutations: Map<string, HouseInventoryMutation>,
        workspaceSensorMutations: HouseMutationBuffer,
      ) => {
        activateAccountStorage(session);
        const workspace = await loadWorkspaceInventory();
        const houses = replayHouseInventory(workspace.rawHouses, inventoryMutations);
        if (invalidated()) return;
        recordResourceError("maintenance:scoped", workspace.scopedMaintenance.error);
        recordResourceError("sensors:workspace", workspace.workspaceSensors.error);
        apiAvailable.current = true;
        if (houses.length === 0) {
          showHouselessWorkspace(session, workspace);
          return;
        }
        showWorkspaceInventory(session, workspace, houses, workspaceSensorMutations);
        await hydrateActiveHouse(session, activeHouseFor(houses, activeHouseId.current, initialHouseId.current));
        if (invalidated()) return;
        hasHydratedActiveHouse.current = true;
        if (!session.readOnly) settleInBackground(refreshTpLinkDevices());
        setBootstrapStatus("ready");
      };
      const lockExpiredSession = () => {
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
      };
      const showInitializationFailure = (error: unknown, hadInventory: boolean) => {
        if (error instanceof ApiVersionMismatchError) {
          enterIncompatibleState(error);
          return;
        }
        apiAvailable.current = false;
        resetStreamConnections();
        if (apiStatus(error) === 401) {
          lockExpiredSession();
          return;
        }
        setBootstrapError(errorMessage(error, "The Stugu service could not be reached."));
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
      };
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
            showSignedOutWorkspace(session);
            return;
          }
          await hydrateWorkspace(session, inventoryMutations, workspaceSensorMutations);
        } catch (error) {
          if (unsubscribeStreams) activeStreamUnsubscribers.current.delete(unsubscribeStreams);
          unsubscribeStreams?.();
          unsubscribeStreams = undefined;
          if (!invalidated()) showInitializationFailure(error, hadInventory);
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
  return { purgeSessionState, retryBootstrap, revalidateSession, endSession };
}
