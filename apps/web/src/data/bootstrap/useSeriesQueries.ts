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
import { HEARTBEAT_POLL_MIN_INTERVAL_MS, LIVE_TELEMETRY_BUFFER_LIMIT, MAX_SERIES_SAMPLES, PORTFOLIO_LOAD_CONCURRENCY, STREAM_BOOTSTRAP_WAIT_MS, advanceMockTelemetry, aggregateConnection, apiStatus, blankState, bufferLiveTelemetry, bufferSeriesValue, canonicalSeries, errorMessage, houseMutationKey, isDemoSource, isLegacySeriesCompatibilityError, isPollingCompatibilityHeartbeat, legacySeries, loadPortfolioInBackground, mergeLegacySeries, mergeMeasurementSeries, metricForecastSamples, metricHistorySamples, optionalForecast, preserveMutatedSensorTelemetry, preserveSeriesCommittedDuringLoad, replaceFloor, replaceHouseSensors, replaceLegacySeriesWindow, replaceLoadedHouseTelemetry, replaceMeasurementSeriesWindow, replayBufferedLiveTelemetry, replayHouseInventory, replayHouseMutations, replayMaintenanceTaskMutation, sensorsFromSnapshots, seriesBucketSeconds, seriesLimit, seriesStateKey, settleInBackground, synchronizeSensorRoomLabels, unauthenticatedSession, withoutDemoTelemetry, withoutSensorIds } from "./support";
import type { BootstrapStatus, BufferedHouseMutation, BufferedLiveTelemetry, BufferedSeriesTelemetry, DataMode, HistoricalSeriesWindow, HouseInventoryMutation, HouseMutationBuffer, LoadedTelemetryState, SeriesCommit, SeriesLoadState, SeriesLoadStatus, StreamConnections } from "./support";
import type { LiveTelemetryContext, SeriesActions } from "./pipelineTypes";
export function useSeriesQueries(
  context: LiveTelemetryContext,
): LiveTelemetryContext & SeriesActions {
  const { initialHouseId, sessionLockedRef, sessionLocked, setSessionLocked, state, setStateInternal, setState, loading, setLoading, bootstrapStatus, setBootstrapStatus, bootstrapError, setBootstrapError, bootstrapAttempt, setBootstrapAttempt, dataMode, setDataMode, streamConnections, setStreamConnections, connection, pollingFallback, setPollingFallback, resourceErrors, setResourceErrors, seriesStates, setSeriesStates, scenario, setScenario, saveState, setSaveState, tpLinkDevices, setTpLinkDevices, tpLinkDevicesRef, tpLinkDevicesLoading, setTpLinkDevicesLoading, tpLinkDevicesError, setTpLinkDevicesError, tick, apiAvailable, dataModeRef, stateRef, streamConnectionsRef, hasReachedLiveConnection, hasHydratedActiveHouse, heartbeatPollAt, reconnectResyncTimer, heartbeatFallbackTimer, mutationRefreshTimer, sensorMoveQueues, sensorMoveVersions, persistedSensorPoints, activeHouseId, activeHouseLoadVersion, houseTelemetryVersions, seriesLoadVersions, seriesCommitVersions, seriesCommitSequence, tpLinkPollStatus, tpLinkRefreshVersion, pendingMeasurementSamples, measurementFlushTimer, saveStateTimer, activeTelemetryLoadBuffers, activeHouseMutationBuffers, activeSeriesTelemetryBuffers, activeInventoryMutationBuffers, activeStreamUnsubscribers, activeStreamGateReleases, sessionLifecycleEpoch, globalFieldVersions, recordResourceError, recordHouseMutation, recordInventoryMutation, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, applyDetachedTpLinkSensors, disconnectTpLink, moveHomeAssistant, moveTpLink, loadHouseData, loadPortfolioHouseData, scheduleActiveHouseResync, updateStreamConnection, resetStreamConnections, handleHeartbeat, purgeSessionState, retryBootstrap, revalidateSession, endSession, handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements } = context;
  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true, signal?: AbortSignal) => {
      const seriesKey = seriesStateKey(sensorId, metric);
      const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
      seriesLoadVersions.current.set(seriesKey, requestVersion);
      const isCurrentRequest = () => seriesLoadVersions.current.get(seriesKey) === requestVersion;
      const to = new Date();
      const from = new Date(to.getTime() - timeRangeHours(range) * 3600000);
      const requestedFrom = from.toISOString();
      const requestedTo = to.toISOString();
      const limit = seriesLimit(range);
      setSeriesStates((current) => {
        const previous = current[seriesKey];
        return {
          ...current,
          [seriesKey]: {
            status: "loading",
            error: null,
            forecastError: previous?.forecastError ?? null,
            requestedFrom,
            requestedTo,
            loadedFrom: previous?.loadedFrom ?? null,
            loadedTo: previous?.loadedTo ?? null,
            partial: previous?.partial ?? false,
          },
        };
      });
      const fail = (error: unknown) => {
        if (!isCurrentRequest()) return;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            ...(current[seriesKey] ?? {
              forecastError: null, loadedFrom: null, loadedTo: null, partial: false,
            }),
            status: "error",
            error: errorMessage(error, "History data is temporarily unavailable"),
            requestedFrom,
            requestedTo,
          },
        }));
      };
      if (!apiAvailable.current) {
        fail(new Error("History data is unavailable while the service is offline"));
        return;
      }
      const liveTelemetry: BufferedSeriesTelemetry = {
        sensorId,
        metric,
        samples: new Map(),
        readings: new Map(),
      };
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === sensorId && buffer.metric === metric) {
          activeSeriesTelemetryBuffers.current.delete(buffer);
        }
      }
      activeSeriesTelemetryBuffers.current.add(liveTelemetry);
      try {
        let loaded: Awaited<ReturnType<typeof canonicalSeries>> | null = null;
        let canonicalError: unknown = null;
        try {
          loaded = await canonicalSeries(sensorId, metric, range, requestedFrom, requestedTo, forecastSupported, signal);
        } catch (error) {
          canonicalError = error;
          // The v1 projection below remains available during a staggered upgrade.
        }
        if (signal?.aborted) return;
        if (!isCurrentRequest()) return;
        if (loaded) {
          const refreshedSamples = mergeMeasurementSeries(
            loaded.samples,
            liveTelemetry.samples.values(),
            MAX_SERIES_SAMPLES,
          );
          seriesCommitSequence.current += 1;
          seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: false });
          setState((current) => {
            const samples = replaceMeasurementSeriesWindow(
              current.measurementHistory[sensorId]?.[metric] ?? [],
              loaded.samples,
              liveTelemetry.samples.values(),
              requestedFrom,
              requestedTo,
              loaded.history.truncated,
            );
            const next = {
              ...current,
              measurementHistory: {
                ...current.measurementHistory,
                [sensorId]: { ...current.measurementHistory[sensorId], [metric]: samples },
              },
            };
            return loaded.forecast.value === null ? next : {
              ...next,
              measurementForecasts: {
                ...current.measurementForecasts,
                [sensorId]: { ...current.measurementForecasts[sensorId], [metric]: loaded.forecast.value },
              },
            };
          });
          const loadedFrom = refreshedSamples[0]?.timestamp ?? null;
          const loadedTo = refreshedSamples.at(-1)?.timestamp ?? null;
          setSeriesStates((current) => ({
            ...current,
            [seriesKey]: {
              status: "ready",
              error: null,
              forecastError: loaded.forecast.error,
              requestedFrom,
              requestedTo,
              loadedFrom,
              loadedTo,
              partial: loaded.history.truncated
                || (loadedFrom !== null && Date.parse(loadedFrom) > from.getTime() + (loaded.history.bucketSeconds ?? 0) * 1_000),
            },
          }));
          return;
        }
        if ((metric !== "temperature" && metric !== "humidity")
          || !isLegacySeriesCompatibilityError(canonicalError)) {
          fail(canonicalError);
          return;
        }
        let fallback: Awaited<ReturnType<typeof legacySeries>>;
        try {
          fallback = await legacySeries(sensorId, range, requestedFrom, requestedTo, forecastSupported, signal);
        } catch (error) {
          if (signal?.aborted) return;
          fail(error ?? canonicalError);
          return;
        }
        if (!isCurrentRequest()) return;
        const refreshedHistory = mergeLegacySeries(fallback.history, liveTelemetry.readings.values(), limit);
        seriesCommitSequence.current += 1;
        seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: true });
        setState((current) => {
          const history = replaceLegacySeriesWindow(
            current.history[sensorId] ?? [],
            fallback.history,
            liveTelemetry.readings.values(),
            requestedFrom,
            requestedTo,
          );
          const metricSamples = replaceMeasurementSeriesWindow(
            current.measurementHistory[sensorId]?.[metric] ?? [],
            metricHistorySamples(refreshedHistory, current.measurementDefinitions, metric),
            liveTelemetry.samples.values(),
            requestedFrom,
            requestedTo,
          );
          const next = {
            ...current,
            history: { ...current.history, [sensorId]: history },
            measurementHistory: {
              ...current.measurementHistory,
              [sensorId]: { ...current.measurementHistory[sensorId], [metric]: metricSamples },
            },
          };
          if (fallback.forecasts.value === null) return next;
          return {
            ...next,
            forecasts: { ...current.forecasts, [sensorId]: fallback.forecasts.value },
            measurementForecasts: {
              ...current.measurementForecasts,
              [sensorId]: {
                ...current.measurementForecasts[sensorId],
                [metric]: metricForecastSamples(fallback.forecasts.value, current.measurementDefinitions, metric),
              },
            },
          };
        });
        const loadedFrom = refreshedHistory[0]?.timestamp ?? null;
        const loadedTo = refreshedHistory.at(-1)?.timestamp ?? null;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            status: "ready",
            error: null,
            forecastError: fallback.forecasts.error,
            requestedFrom,
            requestedTo,
            loadedFrom,
            loadedTo,
            partial: refreshedHistory.length >= limit && loadedFrom !== null && Date.parse(loadedFrom) > from.getTime(),
          },
        }));
      } finally {
        activeSeriesTelemetryBuffers.current.delete(liveTelemetry);
      }
    }, []);
  return Object.assign(context, { loadSeries });
}
