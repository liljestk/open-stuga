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
import { useuseClimateDataPart01 } from "./part-01";
export function useuseClimateDataPart02(context: ReturnType<typeof useuseClimateDataPart01>) {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus } = context;
  const refreshTpLinkDevices = useCallback(async (houseId?: string) => {
      const refreshVersion = ++tpLinkRefreshVersion.current;
      if (!apiAvailable.current) {
        tpLinkDevicesRef.current = [];
        setTpLinkDevices([]);
        setTpLinkDevicesError(null);
        setTpLinkDevicesLoading(false);
        return [];
      }
      setTpLinkDevicesLoading(true);
      setTpLinkDevicesError(null);
      try {
        const devices = await api.tpLinkDevices(houseId);
        if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
        // A house-scoped inventory request is authoritative only for that house.
        // Keep sibling-house devices in memory so visiting Sensors or Setup for
        // one Home cannot make another Home's discovery notice disappear.
        const nextDevices = houseId
          ? [
              ...tpLinkDevicesRef.current.filter((device) => device.houseId !== houseId),
              ...devices,
            ]
          : devices;
        tpLinkDevicesRef.current = nextDevices;
        setTpLinkDevices(nextDevices);
        return devices;
      } catch (error) {
        // A superseded caller receives the authoritative newer inventory instead
        // of surfacing an obsolete failure in page-local error state.
        if (tpLinkRefreshVersion.current !== refreshVersion) return tpLinkDevicesRef.current;
        setTpLinkDevicesError(error instanceof Error ? error.message : "Could not load TP-Link devices");
        throw error;
      } finally {
        if (tpLinkRefreshVersion.current === refreshVersion) setTpLinkDevicesLoading(false);
      }
    }, []);
  const disconnectHomeAssistant = useCallback(async (houseId: string) => api.disconnectHomeAssistant(houseId), []);
  const applyDetachedTpLinkSensors = useCallback((sensorIds: string[]) => {
      const detached = new Set(sensorIds);
      for (const sensor of stateRef.current.sensors) {
        if (!detached.has(sensor.id)) continue;
        const updated = { ...sensor };
        delete updated.tpLinkDeviceId;
        delete updated.tpLinkConnectionId;
        recordHouseMutation({ resource: "sensor", action: "upsert", houseId: updated.houseId, value: updated });
      }
      if (detached.size > 0) {
        setState((current) => ({
          ...current,
          sensors: current.sensors.map((sensor) => {
            if (!detached.has(sensor.id)) return sensor;
            const updated = { ...sensor };
            delete updated.tpLinkDeviceId;
            delete updated.tpLinkConnectionId;
            return updated;
          }),
        }));
      }
    }, [recordHouseMutation]);
  const disconnectTpLink = useCallback(async (connectionId: string) => {
      const result = await api.disconnectTpLink(connectionId);
      applyDetachedTpLinkSensors(result.detachedSensorIds);
      settleInBackground(refreshTpLinkDevices());
      return result;
    }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);
  const moveHomeAssistant = useCallback(async (fromHouseId: string, houseId: string) => (
      api.moveHomeAssistant(fromHouseId, houseId)
    ), []);
  const moveTpLink = useCallback(async (connectionId: string, houseId: string) => {
      const result = await api.moveTpLink(connectionId, houseId);
      applyDetachedTpLinkSensors(result.detachedSensorIds);
      settleInBackground(refreshTpLinkDevices());
      return result;
    }, [applyDetachedTpLinkSensors, refreshTpLinkDevices]);
  return Object.assign(context, { refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink });
}