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
import type { IntegrationContext, WorkspaceHydrationActions } from "./pipelineTypes";
export function useWorkspaceHydration(
  context: IntegrationContext,
): IntegrationContext & WorkspaceHydrationActions {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink } = context;
  const loadHouseData = useCallback(async (
      houseId: string,
      includeGlobalData = false,
      streamReady: Promise<void> | null = null,
      includeAdministrativeData = true,
    ) => {
      const bufferedLiveTelemetry = new Map<string, BufferedLiveTelemetry>();
      const bufferedHouseMutations: HouseMutationBuffer = new Map();
      activeTelemetryLoadBuffers.current.add(bufferedLiveTelemetry);
      activeHouseMutationBuffers.current.add(bufferedHouseMutations);
      const seriesVersionAtLoadStart = seriesCommitSequence.current;
      const globalVersionsAtLoadStart = { ...globalFieldVersions.current };
      activeHouseId.current = houseId;
      const activeVersion = ++activeHouseLoadVersion.current;
      const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
      houseTelemetryVersions.current.set(houseId, telemetryVersion);
      const isCurrentLoad = () => activeHouseId.current === houseId
        && activeHouseLoadVersion.current === activeVersion
        && houseTelemetryVersions.current.get(houseId) === telemetryVersion;
      const optionalResource = async <T,>(name: string, promise: Promise<T>): Promise<T | null> => {
        try {
          const value = await promise;
          if (isCurrentLoad()) recordResourceError(`${houseId}:${name}`, null);
          return value;
        } catch (error) {
          if (isCurrentLoad()) recordResourceError(`${houseId}:${name}`, error);
          return null;
        }
      };
      let houseMutationBufferDeferred = false;
      try {
        if (streamReady) await streamReady;
        if (!isCurrentLoad()) return;
        const measurementSnapshot = optionalResource("measurement-snapshot", api.measurementSnapshot(houseId));
        const observationsRequest = optionalResource("observations", api.observations(houseId));
        const maintenanceRequest = optionalResource("maintenance", api.maintenanceTasks({ houseId }));
        const staticParametersRequest = optionalResource("static-parameters", api.staticParameters(houseId));
        const definitionsRequest = includeGlobalData
          ? optionalResource("measurement-definitions", api.measurementDefinitions())
          : Promise.resolve(null);
        const alertRulesRequest = includeGlobalData
          ? optionalResource("alert-rules", api.alertRules())
          : Promise.resolve(null);
        const alertsRequest = includeGlobalData
          ? optionalResource("alerts", api.alerts())
          : Promise.resolve(null);
        const scenariosRequest = includeGlobalData && includeAdministrativeData
          ? optionalResource("scenarios", api.scenarios())
          : Promise.resolve(null);
        const integrationRequest = includeGlobalData && includeAdministrativeData
          ? api.integrations()
          : Promise.resolve(null);
        const [snapshot, integration] = await Promise.all([
          api.snapshot(houseId), integrationRequest,
        ]);
        if (!isCurrentLoad()) return;
        recordResourceError(`${houseId}:snapshot`, null);
        const integrationIsCurrent = globalFieldVersions.current.integration === globalVersionsAtLoadStart.integration;
        const enteringRealMode = Boolean(integrationIsCurrent
          && integration?.mock.mode === "real"
          && dataModeRef.current !== "real");
        if (integration && integrationIsCurrent) {
          tpLinkPollStatus.current = {
            lastPollAt: integration.tpLink.lastPollAt,
            discoveredDevices: integration.tpLink.discoveredDevices,
          };
          dataModeRef.current = integration.mock.mode;
          setDataMode(integration.mock.mode);
        }
        const sensors = snapshot.length ? sensorsFromSnapshots(snapshot) : await api.sensors(houseId);
        if (!isCurrentLoad()) return;
        setState((current) => {
          if (!isCurrentLoad()) return current;
          const definitions = enabledDefinitions(current.measurementDefinitions);
          const merged = replayHouseMutations(houseId, {
            sensors,
            observations: [],
            maintenanceTasks: [],
            staticParameters: [],
          }, bufferedHouseMutations);
          const legacyReadings = withoutSensorIds(snapshotToReadings(snapshot), merged.deletedSensorIds);
          const samples = Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, definitions));
          const loadedSensorIds = [...new Set(merged.sensors.map((sensor) => sensor.id))];
          const telemetryWithLiveEvents = replayBufferedLiveTelemetry(
            replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples),
            bufferedLiveTelemetry.values(),
            new Set(loadedSensorIds),
            definitions,
          );
          const telemetryWithSeries = preserveSeriesCommittedDuringLoad(
            telemetryWithLiveEvents,
            current,
            new Set(loadedSensorIds),
            seriesCommitVersions.current,
            seriesVersionAtLoadStart,
          );
          const telemetry = preserveMutatedSensorTelemetry(
            telemetryWithSeries, current, houseId, bufferedHouseMutations,
          );
          const nextIntegration = integration
            && globalFieldVersions.current.integration === globalVersionsAtLoadStart.integration
            ? integration
            : current.integration;
          const next = {
            ...current,
            ...telemetry,
            sensors: replaceHouseSensors(current.sensors, houseId, merged.sensors),
            integration: nextIntegration,
          };
          return nextIntegration.mock.mode === "real"
            ? withoutDemoTelemetry(next, enteringRealMode)
            : next;
        });

        const optionalUpdates: Promise<void>[] = [
          measurementSnapshot.then((generic) => {
            if (!generic || !isCurrentLoad()) return;
            setState((current) => {
              if (!isCurrentLoad()) return current;
              const merged = replayHouseMutations(houseId, {
                sensors: [], observations: [], maintenanceTasks: [], staticParameters: [],
              }, bufferedHouseMutations);
              const samples = generic
                .filter((item) => !merged.deletedSensorIds.has(item.sensorId))
                .flatMap((item) => Object.values(item.measurements))
                .filter((sample) => {
                  const existing = current.latestMeasurements[sample.sensorId]?.[sample.metric];
                  return !existing || Date.parse(sample.timestamp) > Date.parse(existing.timestamp);
                });
              return samples.length
                ? { ...current, latestMeasurements: upsertLatest(current.latestMeasurements, samples) }
                : current;
            });
          }),
          observationsRequest.then((observations) => {
            if (!observations || !isCurrentLoad()) return;
            setState((current) => {
              if (!isCurrentLoad()) return current;
              const merged = replayHouseMutations(houseId, {
                sensors: [], observations, maintenanceTasks: [], staticParameters: [],
              }, bufferedHouseMutations);
              return { ...current, observations: merged.observations };
            });
          }),
          maintenanceRequest.then((maintenanceTasks) => {
            if (!maintenanceTasks || !isCurrentLoad()) return;
            setState((current) => {
              if (!isCurrentLoad()) return current;
              const merged = replayHouseMutations(houseId, {
                sensors: [], observations: [], maintenanceTasks, staticParameters: [],
              }, bufferedHouseMutations);
              return {
                ...current,
                maintenanceTasks: [
                  ...current.maintenanceTasks.filter((task) => task.houseId !== houseId),
                  ...merged.maintenanceTasks,
                ],
              };
            });
          }),
          staticParametersRequest.then((staticParameters) => {
            if (!staticParameters || !isCurrentLoad()) return;
            setState((current) => {
              if (!isCurrentLoad()) return current;
              const merged = replayHouseMutations(houseId, {
                sensors: [], observations: [], maintenanceTasks: [], staticParameters,
              }, bufferedHouseMutations);
              return { ...current, staticParameters: merged.staticParameters };
            });
          }),
        ];
        if (includeGlobalData) {
          optionalUpdates.push(
            definitionsRequest.then((definitions) => {
              if (!definitions || !isCurrentLoad()) return;
              setState((current) => isCurrentLoad()
                ? { ...current, measurementDefinitions: enabledDefinitions(definitions) }
                : current);
            }),
            alertRulesRequest.then((alertRules) => {
              if (!alertRules || !isCurrentLoad()
                || globalFieldVersions.current.alertRules !== globalVersionsAtLoadStart.alertRules) return;
              setState((current) => isCurrentLoad()
                && globalFieldVersions.current.alertRules === globalVersionsAtLoadStart.alertRules
                ? { ...current, alertRules }
                : current);
            }),
            alertsRequest.then((alerts) => {
              if (!alerts || !isCurrentLoad()
                || globalFieldVersions.current.alerts !== globalVersionsAtLoadStart.alerts) return;
              setState((current) => isCurrentLoad()
                && globalFieldVersions.current.alerts === globalVersionsAtLoadStart.alerts
                ? { ...current, alerts }
                : current);
            }),
            scenariosRequest.then((scenarios) => {
              if (!scenarios || !isCurrentLoad()) return;
              setState((current) => isCurrentLoad() && scenarios.length
                ? { ...current, scenarios }
                : current);
            }),
          );
        }
        houseMutationBufferDeferred = true;
        settleInBackground(Promise.allSettled(optionalUpdates).finally(() => {
          activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
        }));
      } catch (error) {
        if (isCurrentLoad()) recordResourceError(`${houseId}:snapshot`, error);
        throw error;
      } finally {
        activeTelemetryLoadBuffers.current.delete(bufferedLiveTelemetry);
        if (!houseMutationBufferDeferred) activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
      }
    }, [recordResourceError]);
  const loadPortfolioHouseData = useCallback(async (houseId: string) => {
      if (activeHouseId.current === houseId) return;
      const bufferedLiveTelemetry = new Map<string, BufferedLiveTelemetry>();
      const bufferedHouseMutations: HouseMutationBuffer = new Map();
      activeTelemetryLoadBuffers.current.add(bufferedLiveTelemetry);
      activeHouseMutationBuffers.current.add(bufferedHouseMutations);
      const seriesVersionAtLoadStart = seriesCommitSequence.current;
      const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
      houseTelemetryVersions.current.set(houseId, telemetryVersion);
      try {
        const measurementSnapshot = api.measurementSnapshot(houseId).catch(() => null);
        const [snapshot, generic] = await Promise.all([api.snapshot(houseId), measurementSnapshot]);
        if (activeHouseId.current === houseId
          || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
        const sensors = snapshot.length ? sensorsFromSnapshots(snapshot) : await api.sensors(houseId);
        if (activeHouseId.current === houseId
          || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
        setState((current) => {
          if (activeHouseId.current === houseId
            || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return current;
          const merged = replayHouseMutations(houseId, {
            sensors,
            observations: [],
            maintenanceTasks: [],
            staticParameters: [],
          }, bufferedHouseMutations);
          const legacyReadings = withoutSensorIds(snapshotToReadings(snapshot), merged.deletedSensorIds);
          const samples = generic?.filter((item) => !merged.deletedSensorIds.has(item.sensorId))
            .flatMap((item) => Object.values(item.measurements))
            ?? Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, current.measurementDefinitions));
          const loadedSensorIds = [...new Set([
            ...merged.sensors.map((sensor) => sensor.id),
            ...(generic ?? []).filter((item) => !merged.deletedSensorIds.has(item.sensorId)).map((item) => item.sensorId),
          ])];
          const telemetryWithLiveEvents = replayBufferedLiveTelemetry(
            replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples),
            bufferedLiveTelemetry.values(),
            new Set(loadedSensorIds),
            current.measurementDefinitions,
          );
          const telemetryWithSeries = preserveSeriesCommittedDuringLoad(
            telemetryWithLiveEvents,
            current,
            new Set(loadedSensorIds),
            seriesCommitVersions.current,
            seriesVersionAtLoadStart,
          );
          const telemetry = preserveMutatedSensorTelemetry(
            telemetryWithSeries, current, houseId, bufferedHouseMutations,
          );
          const next = {
            ...current,
            ...telemetry,
            sensors: replaceHouseSensors(current.sensors, houseId, merged.sensors),
          };
          return current.integration.mock.mode === "real" ? withoutDemoTelemetry(next) : next;
        });
      } finally {
        activeTelemetryLoadBuffers.current.delete(bufferedLiveTelemetry);
        activeHouseMutationBuffers.current.delete(bufferedHouseMutations);
      }
    }, []);
  return Object.assign(context, { loadHouseData, loadPortfolioHouseData });
}
