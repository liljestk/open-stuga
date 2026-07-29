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
import { useClimateDataStore } from "./useClimateDataStore";
import { useIntegrationActions } from "./useIntegrationActions";
import { useWorkspaceHydration } from "./useWorkspaceHydration";
import { useSessionLifecycle } from "./useSessionLifecycle";
import { useLiveTelemetry } from "./useLiveTelemetry";
import { useSeriesQueries } from "./useSeriesQueries";
import { useSensorActions } from "./useSensorActions";
import { usePropertyActions } from "./usePropertyActions";
import { useOperationsActions } from "./useOperationsActions";
import { useMaintenanceActions } from "./useMaintenanceActions";
import { createClimateDataPublicModel } from "./publicModel";

export function useClimateData() {
  const store = useClimateDataStore({});
  const integrations = useIntegrationActions(store);
  const hydration = useWorkspaceHydration(integrations);
  const lifecycle = useSessionLifecycle(hydration);
  const telemetry = useLiveTelemetry(lifecycle);
  const series = useSeriesQueries(telemetry);
  const sensors = useSensorActions(series);
  const properties = usePropertyActions(sensors);
  const operations = useOperationsActions(properties);
  const maintenance = useMaintenanceActions(operations);
  return createClimateDataPublicModel(maintenance);
}
