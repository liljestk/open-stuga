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
import { useuseClimateDataPart10 } from "./part-10";
export function renderuseClimateData(context: ReturnType<typeof useuseClimateDataPart10>) {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData, scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat, purgeSessionState, retryBootstrap, revalidateSession, endSession, handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements, loadSeries, loadHistoricalSeries, createSensor, updateSensor, deleteSensor, moveSensor, ensurePropertyWrite, refreshMovedPropertyContext, createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea, createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote, setHouseGeoreference, updateFloor, updateHouseDraft, updateHouse, createHouse, deleteHouse, saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions, createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter } = context;
  return {
      state, loading, bootstrapStatus, bootstrapError, retryBootstrap, endSession, dataMode, connection, pollingFallback,
      resourceErrors, seriesStates, scenario, saveState,
      tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, refreshTpLinkDevices,
      disconnectHomeAssistant, disconnectTpLink, moveHomeAssistant, moveTpLink,
      applyIntegrationStatus,
      selectHouse, loadSeries, loadHistoricalSeries, importHistoricalMeasurements,
      createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea,
      createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote,
      createHouse, deleteHouse, createSensor, updateSensor, deleteSensor, moveSensor, updateFloor, updateHouse, updateHouseDraft, setHouseGeoreference,
      saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions,
      createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter,
    };
}