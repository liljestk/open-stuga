import { useCallback, useEffect } from "react";
import type {
  MeasurementSample,
  Reading,
  TelemetryEvent,
} from "@climate-twin/contracts";
import {
  api,
} from "../../api";
import { type ClimateState } from "../../domain";
import { appendLiveHistory, readingSamples, upsertLatest } from "../../measurements";
import { publishHouseWeatherUpdate } from "../../useHouseWeather";
import { LIVE_SERIES_SAMPLES, advanceMockTelemetry, bufferLiveTelemetry, bufferSeriesValue, isDemoSource, isRemoteSharedDemoTelemetry, settleInBackground } from "./support";
import type { ClimateDataStore, PipelineActions, LiveTelemetryActions } from "./pipelineTypes";

// Live values only count for the active Home's sensors, and never as demo data in a real workspace.
function acceptsLiveValue(
  current: ClimateState,
  knownSensorIds: ReadonlySet<string>,
  value: { sensorId: string; source: Reading["source"] | MeasurementSample["source"] },
): boolean {
  return knownSensorIds.has(value.sensorId)
    && (current.integration.mock.mode !== "real" || !isDemoSource(value.source))
    && !isRemoteSharedDemoTelemetry(current, value.sensorId, value.source);
}

// The newest reading per sensor becomes its latest value.
function withLiveReadings(
  current: ClimateState,
  acceptedReadings: readonly Reading[],
): Pick<ClimateState, "readings"> {
  if (!acceptedReadings.length) return { readings: current.readings };
  const readingsState = { ...current.readings };
  const readingsBySensor = new Map<string, Reading[]>();
  for (const reading of acceptedReadings) {
    const sensorReadings = readingsBySensor.get(reading.sensorId) ?? [];
    sensorReadings.push(reading);
    readingsBySensor.set(reading.sensorId, sensorReadings);
  }
  for (const [sensorId, sensorReadings] of readingsBySensor) {
    readingsState[sensorId] = newestReading(readingsState[sensorId], sensorReadings);
  }
  return { readings: readingsState };
}

function newestReading(previous: Reading | undefined, readings: readonly Reading[]): Reading {
  let latest = previous;
  for (const reading of readings) {
    const previousTime = latest ? Date.parse(latest.timestamp) : Number.NEGATIVE_INFINITY;
    const incomingTime = Date.parse(reading.timestamp);
    if (!latest || !Number.isFinite(previousTime) || !Number.isFinite(incomingTime) || incomingTime >= previousTime) {
      latest = reading;
    }
  }
  return latest!;
}

function withLiveTelemetry(
  current: ClimateState,
  currentHouseId: string | null,
  readings: readonly Reading[],
  streamedSamples: readonly MeasurementSample[],
): ClimateState {
  const knownSensorIds = new Set(current.sensors
    .filter((sensor) => sensor.houseId === currentHouseId)
    .map((sensor) => sensor.id));
  const acceptedReadings = readings.filter((reading) => acceptsLiveValue(current, knownSensorIds, reading));
  const acceptedSamplesByKey = new Map<string, MeasurementSample>();
  for (const sample of [
    ...acceptedReadings.flatMap((reading) => readingSamples(reading, current.measurementDefinitions)),
    ...streamedSamples,
  ]) {
    if (!acceptsLiveValue(current, knownSensorIds, sample)) continue;
    acceptedSamplesByKey.set(
      `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`,
      sample,
    );
  }
  const acceptedSamples = [...acceptedSamplesByKey.values()];
  if (!acceptedReadings.length && !acceptedSamples.length) return current;
  return {
    ...current,
    ...withLiveReadings(current, acceptedReadings),
    latestMeasurements: upsertLatest(current.latestMeasurements, acceptedSamples),
    measurementHistory: appendLiveHistory(
      current.measurementHistory,
      acceptedSamples,
      LIVE_SERIES_SAMPLES,
    ),
  };
}

export function useLiveTelemetry(
  store: Pick<ClimateDataStore,
    | "activeHouseId" | "activeSeriesTelemetryBuffers" | "activeTelemetryLoadBuffers" | "apiAvailable"
    | "applyIntegrationStatus" | "connection" | "dataMode" | "dataModeRef" | "globalFieldVersions"
    | "measurementFlushTimer" | "pendingLegacyReadings"
    | "pendingMeasurementSamples" | "scenario"
    | "setState" | "stateRef" | "tick" | "tpLinkPollStatus"
  >,
  actions: Pick<PipelineActions, "refreshTpLinkDevices" | "loadHouseData" | "scheduleMutationRefresh">,
): LiveTelemetryActions {
  const { activeHouseId, stateRef, connection, dataMode, tick, setState, dataModeRef, scenario, measurementFlushTimer, pendingLegacyReadings, pendingMeasurementSamples, activeTelemetryLoadBuffers, activeSeriesTelemetryBuffers, tpLinkPollStatus, applyIntegrationStatus, globalFieldVersions, apiAvailable } = store;
  const { refreshTpLinkDevices, loadHouseData, scheduleMutationRefresh } = actions;
  const isActiveHouseSensor = useCallback((sensorId: string) => {
      const houseId = activeHouseId.current;
      return houseId !== null && stateRef.current.sensors.some((sensor) => (
        sensor.id === sensorId && sensor.houseId === houseId
      ));
    }, []);
  useEffect(() => {
      if (connection === "live" || dataMode !== "demo") return;
      const timer = window.setInterval(() => {
        tick.current += 1;
        setState((current) => dataModeRef.current === "demo"
          ? advanceMockTelemetry(current, scenario, tick.current)
          : current);
      }, 2000);
      return () => window.clearInterval(timer);
    }, [connection, dataMode, scenario]);
  const flushMeasurements = useCallback(() => {
      measurementFlushTimer.current = null;
      const queuedReadings = pendingLegacyReadings.current;
      const queuedSamples = pendingMeasurementSamples.current;
      pendingLegacyReadings.current = [];
      pendingMeasurementSamples.current = [];
      if (!queuedReadings.length && !queuedSamples.length) return;
      const readings = [...new Map(queuedReadings.map((reading) => [
        `${reading.sensorId}\u0000${reading.timestamp}`,
        reading,
      ])).values()];
      const streamedSamples = [...new Map(queuedSamples.map((sample) => [
        `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`,
        sample,
      ])).values()];
      setState((current) => withLiveTelemetry(current, activeHouseId.current, readings, streamedSamples));
    }, []);
  const queueLiveReading = useCallback((reading: Reading) => {
      if (!isActiveHouseSensor(reading.sensorId)
        || (dataModeRef.current === "real" && isDemoSource(reading.source))
        || isRemoteSharedDemoTelemetry(stateRef.current, reading.sensorId, reading.source)) return;
      for (const buffer of activeTelemetryLoadBuffers.current) {
        bufferLiveTelemetry(buffer, { type: "reading", data: reading });
      }
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === reading.sensorId) bufferSeriesValue(buffer.readings, reading.timestamp, reading);
      }
      pendingLegacyReadings.current.push(reading);
      if (measurementFlushTimer.current === null) {
        measurementFlushTimer.current = window.setTimeout(flushMeasurements, 16);
      }
    }, [flushMeasurements, isActiveHouseSensor]);
  // A TP-Link poll that moved on may have found new child devices.
  const applyLiveIntegration = useCallback((integration: ClimateState["integration"]) => {
      const previousTpLinkPollStatus = tpLinkPollStatus.current;
      const tpLinkPollAdvanced = previousTpLinkPollStatus !== null && (
        previousTpLinkPollStatus.lastPollAt !== integration.tpLink.lastPollAt
        || previousTpLinkPollStatus.discoveredDevices !== integration.tpLink.discoveredDevices
      );
      tpLinkPollStatus.current = {
        lastPollAt: integration.tpLink.lastPollAt,
        discoveredDevices: integration.tpLink.discoveredDevices,
      };
      applyIntegrationStatus(integration);
      if (tpLinkPollAdvanced) settleInBackground(refreshTpLinkDevices());
    }, [applyIntegrationStatus, refreshTpLinkDevices]);
  const handleTelemetry = useCallback((event: TelemetryEvent) => {
      if (event.type === "heartbeat") {
        setState((current) => ({ ...current, latestTelemetryHeartbeatAt: Date.now() }));
      } else if (event.type === "mutation") {
        scheduleMutationRefresh(event.data);
      } else if (event.type === "opening") {
        setState((current) => current.houses.some((house) => house.id === event.data.houseId)
          ? { ...current, latestOpeningStateObservation: event.data }
          : current);
      } else if (event.type === "reading") {
        queueLiveReading(event.data);
      } else if (event.type === "alert") {
        const alert = event.data;
        globalFieldVersions.current.alerts += 1;
        setState((current) => ({ ...current, alerts: [alert, ...current.alerts.filter((item) => item.id !== alert.id)] }));
      } else if (event.type === "integration") {
        applyLiveIntegration(event.data);
      } else if (event.type === "weather") {
        publishHouseWeatherUpdate(event.data);
      }
    }, [applyLiveIntegration, queueLiveReading, scheduleMutationRefresh]);
  const handleMeasurement = useCallback((sample: MeasurementSample) => {
      if (!isActiveHouseSensor(sample.sensorId)
        || (dataModeRef.current === "real" && isDemoSource(sample.source))
        || isRemoteSharedDemoTelemetry(stateRef.current, sample.sensorId, sample.source)) return;
      for (const buffer of activeTelemetryLoadBuffers.current) {
        bufferLiveTelemetry(buffer, { type: "measurement", data: sample });
      }
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === sample.sensorId && buffer.metric === sample.metric) {
          bufferSeriesValue(buffer.samples, sample.timestamp, sample);
        }
      }
      pendingMeasurementSamples.current.push(sample);
      if (measurementFlushTimer.current === null) {
        measurementFlushTimer.current = window.setTimeout(flushMeasurements, 16);
      }
    }, [flushMeasurements, isActiveHouseSensor]);
  const selectHouse = useCallback(async (houseId: string) => {
      activeHouseId.current = houseId;
      if (!apiAvailable.current) return;
      try { await loadHouseData(houseId); } catch { /* Keep the previous snapshot during transient failures. */ }
    }, [loadHouseData]);
  const importHistoricalMeasurements = useCallback(async (
      houseId: string,
      samples: MeasurementSample[],
      onProgress?: (completed: number, total: number) => void,
    ) => {
      if (!apiAvailable.current) throw new Error("Historical import requires a connection to the Stugu server.");
      const result = await api.importHistoricalMeasurements(samples, onProgress);
      await loadHouseData(houseId);
      return result;
    }, [loadHouseData]);
  return { handleTelemetry, flushMeasurements, handleMeasurement, selectHouse, importHistoricalMeasurements };
}
