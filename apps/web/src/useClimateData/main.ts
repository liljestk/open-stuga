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
import { useuseClimateDataPart02 } from "./part-02";
import { useuseClimateDataPart03 } from "./part-03";
import { useuseClimateDataPart04 } from "./part-04";
import { useuseClimateDataPart05 } from "./part-05";
import { useuseClimateDataPart06 } from "./part-06";
import { useuseClimateDataPart07 } from "./part-07";
import { useuseClimateDataPart08 } from "./part-08";
import { useuseClimateDataPart09 } from "./part-09";
import { useuseClimateDataPart10 } from "./part-10";
import { renderuseClimateData } from "./render";

export function useClimateData() {
  const context0 = {  };
  const context1 = useuseClimateDataPart01(context0);
  const context2 = useuseClimateDataPart02(context1);
  const context3 = useuseClimateDataPart03(context2);
  const context4 = useuseClimateDataPart04(context3);
  const context5 = useuseClimateDataPart05(context4);
  const context6 = useuseClimateDataPart06(context5);
  const context7 = useuseClimateDataPart07(context6);
  const context8 = useuseClimateDataPart08(context7);
  const context9 = useuseClimateDataPart09(context8);
  const context10 = useuseClimateDataPart10(context9);
  return renderuseClimateData(context10);
}
