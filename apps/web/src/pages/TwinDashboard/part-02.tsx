import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../../components/ReplayControls";
import { RoomComfortBoard } from "../../components/RoomComfortBoard";
import { MoistureCoach } from "../../components/MoistureCoach";
import { HomePulsePanel } from "../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../components/HomeOperationsPreview";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { formatInTimeZone } from "../../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../../measurements";
import { isEnergyDeviceSensor } from "../../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../../spatialFreshness";
import { createOutdoorBoundaryContext } from "../../outdoorContext";
import { useHouseWeather } from "../../useHouseWeather";
import type { OutdoorVisualizationState } from "../../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../../airflowSimulation";
import type { DataMode } from "../../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../../api";
import { useSpatialLayers } from "../../useSpatialLayers";
import { SpatialLayerPanel } from "../../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../../experimentalSpatialLayers";
import { readLocalStorage, writeLocalStorage } from "../../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { integrationForHouse } from "../../integrationScope";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, energyDeviceLayerPreferenceKey, experimentalVisualizationPreferenceKey, houseLocalDateTimeCandidates, initialEnergyDeviceLayerVisibility, initialExperimentalVisualizations, localDateTimeValue, localDateValue, mergeOpeningStateObservations, observationConfidences, observationKinds, observationSources, observationTimeFields, observationTimePrecisions, zonedDateTimeParts } from "./support";
import type { TwinDashboardProps } from "./support";
import { useTwinDashboardPart01 } from "./part-01";
export function useTwinDashboardPart02(context: ReturnType<typeof useTwinDashboardPart01>) {
  const { props, state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, readOnly, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, energyDevicesVisible, setEnergyDevicesVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce } = context;
  useEffect(() => {
      const now = new Date();
      replayWindowRequestRef.current += 1;
      setReplayActive(false);
      setReplayPlaying(false);
      setReplayPrepared(true);
      setReplayWindowFrom(localDateTimeValue(new Date(now.getTime() - 24 * 3_600_000), house.timezone));
      setReplayWindowTo(localDateTimeValue(now, house.timezone));
      setReplayRequestedBounds(null);
      setReplayLoadState("idle");
      setReplayLoadError(null);
      setReplayLoadPartial(false);
      setReplaySampleCount(null);
    }, [houseId, house.timezone]);
  useEffect(() => {
      if (!readOnly) return;
      setEditing(false);
      setObservationPlacement(false);
      setObservationDraft(null);
    }, [readOnly]);
  const houseWeather = useHouseWeather(house, !replayActive);
  const outdoorContext = useMemo(
      () => createOutdoorBoundaryContext(house, houseWeather.weather),
      [house, houseWeather.weather],
    );
  const outdoor = useMemo<OutdoorVisualizationState>(() => ({
      context: replayActive ? null : outdoorContext,
      loading: !replayActive && houseWeather.loading,
      unavailable: !replayActive && !houseWeather.loading && !outdoorContext
        && Boolean(houseWeather.error || houseWeather.weather),
      refreshFailed: !replayActive && Boolean(outdoorContext && houseWeather.error),
      hasLocation: Boolean(house.location),
      replayActive,
      timeZone: house.timezone,
      ...(house.orientationDegrees === undefined ? {} : { orientationDegrees: house.orientationDegrees }),
      ...(houseWeather.weather?.attribution ? { attribution: houseWeather.weather.attribution } : {}),
      ...(houseWeather.weather?.observationStation ? {
        station: {
          name: houseWeather.weather.observationStation.name,
          distanceKm: houseWeather.weather.observationStation.distanceKm,
        },
      } : {}),
    }), [house.location, house.orientationDegrees, house.timezone, houseWeather.error, houseWeather.loading, houseWeather.weather, outdoorContext, replayActive]);
  useEffect(() => {
      if (replayActive) return;
      const update = () => setLiveSpatialClockMs(Date.now());
      update();
      const timer = window.setInterval(update, 30_000);
      return () => window.clearInterval(timer);
    }, [replayActive]);
  const houseSensors = useMemo(
      () => state.sensors.filter((sensor) => sensor.houseId === houseId && sensor.enabled),
      [state.sensors, houseId],
    );
  const energyDeviceCount = useMemo(() => houseSensors.filter((sensor) => (
      isEnergyDeviceSensor(sensor, state.latestMeasurements[sensor.id] ?? {})
    )).length, [houseSensors, state.latestMeasurements]);
  const floorSensors = useMemo(
      () => houseSensors.filter((sensor) => sensor.floorId === floorId),
      [houseSensors, floorId],
    );
  const selectedSensor = houseSensors.find((sensor) => sensor.id === selectedSensorId) ?? floorSensors[0] ?? houseSensors[0] ?? null;
  const selectedFloor = house.floors.find((item) => item.id === selectedSensor?.floorId) ?? floor;
  const viewSensors = viewMode === "isometric" ? houseSensors : floorSensors;
  // Home-level status stays house-scoped so changing the visual view cannot
    // silently change the meaning of the headline values.
    const summarySensors = houseSensors;
  const definitions = enabledDefinitions(state.measurementDefinitions);
  const houseDefinitions = definitions.filter((definition) => houseSensors.some((sensor) =>
      state.latestMeasurements[sensor.id]?.[definition.id]
      || (state.measurementHistory[sensor.id]?.[definition.id]?.length ?? 0) > 0
      || Boolean(sensor.measurementEntityIds?.[definition.id]),
    ));
  const availableDefinitions = houseDefinitions.length ? houseDefinitions : definitions;
  const airflowDefinitions = definitions.filter((item) => item.id === "temperature" || item.id === "humidity" || item.id === "co2");
  const airflowMetricKey = airflowDefinitions.map((item) => item.id).join(",");
  const definition = definitionFor(definitions, metric);
  const metricOptions = availableDefinitions.some((item) => item.id === definition.id)
      ? availableDefinitions
      : [definition, ...availableDefinitions];
  const metricLabel = measurementLabel(definition, locale);
  const liveSamples = useMemo(() => Object.fromEntries(houseSensors.flatMap((sensor) => {
      const sample = state.latestMeasurements[sensor.id]?.[definition.id];
      return sample ? [[sensor.id, sample]] : [];
    })), [houseSensors, state.latestMeasurements, definition.id]);
  const houseSensorIdList = useMemo(() => houseSensors.map((sensor) => sensor.id), [houseSensors]);
  const houseSensorIds = houseSensorIdList.join(",");
  const replayMetricIds = useMemo(
      () => [...new Set([...availableDefinitions.map((candidate) => candidate.id), definition.id, "temperature", "humidity"])],
      [availableDefinitions, definition.id],
    );
  const loadedReplayBounds = useMemo(() => {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      let count = 0;
      for (const sensor of houseSensors) {
        for (const replayMetric of replayMetricIds) {
          for (const sample of state.measurementHistory[sensor.id]?.[replayMetric] ?? []) {
            const timestamp = Date.parse(sample.timestamp);
            if (!Number.isFinite(timestamp)) continue;
            minimum = Math.min(minimum, timestamp);
            maximum = Math.max(maximum, timestamp);
            count += 1;
          }
        }
      }
      return count > 0 ? { minimum, maximum, count } : null;
    }, [houseSensors, replayMetricIds, state.measurementHistory]);
  const fallbackReplayBounds = useMemo(() => {
      const maximum = Date.now();
      return { minimum: maximum - 24 * 3600000, maximum };
    }, [houseId]);
  const replayMin = replayRequestedBounds?.minimum ?? loadedReplayBounds?.minimum ?? fallbackReplayBounds.minimum;
  const replayMax = replayRequestedBounds?.maximum ?? loadedReplayBounds?.maximum ?? fallbackReplayBounds.maximum;
  const replayHistoryReady = useMemo(() => houseSensors.some((sensor) => replayMetricIds.some((replayMetric) => (
      state.measurementHistory[sensor.id]?.[replayMetric] ?? []
    ).some((sample) => {
      const timestamp = Date.parse(sample.timestamp);
      return Number.isFinite(timestamp) && timestamp >= replayMin && timestamp <= replayMax;
    }))), [houseSensors, replayMetricIds, replayMax, replayMin, state.measurementHistory]);
  const replayEvents = useMemo(() => detectReplayClimateEvents(
      state.measurementHistory,
      houseSensorIdList,
      { maxEvents: 24, from: replayMin, to: replayMax },
    ), [state.measurementHistory, houseSensorIdList, replayMin, replayMax]);
  const [replayTimestamp, setReplayTimestamp] = useState(replayMax);
  const spatialReferenceTimeMs = replayActive ? replayTimestamp : liveSpatialClockMs;
  const spatialLayerScope = useMemo(() => ({ kind: "house" as const, id: houseId }), [houseId]);
  const spatialLayers = useSpatialLayers({
      scope: spatialLayerScope,
      enabled: !editing,
      historyAt: replayActive ? replayTimestamp : null,
    });
  const liveSpatialMaxSampleAgeMs = configuredSpatialMaxSampleAgeMs();
  const spatialMaxSampleAgeMs = replayActive
      ? configuredSpatialReplayMaxSampleAgeMs()
      : liveSpatialMaxSampleAgeMs;
  const spatialFreshness = useMemo(() => ({
      referenceTimeMs: spatialReferenceTimeMs,
      maxSampleAgeMs: spatialMaxSampleAgeMs,
    }), [spatialReferenceTimeMs, spatialMaxSampleAgeMs]);
  useEffect(() => {
      setReplayTimestamp((current) => replayActive ? clamp(current, replayMin, replayMax) : replayMax);
    }, [replayActive, replayMin, replayMax]);
  useEffect(() => {
      const wasActive = previousReplayActiveRef.current;
      previousReplayActiveRef.current = replayActive;
      if (wasActive && !replayActive) effectSeriesLoadsRef.current.keys.clear();
    }, [replayActive]);
  useEffect(() => {
      if (!replayActive) {
        if (replayStartPending) setReplayStartPending(false);
        return;
      }
      if (!replayStartPending || !replayHistoryReady) return;
      setReplayTimestamp(replayMin);
      setReplayPlaying(true);
      setReplayStartPending(false);
    }, [replayActive, replayStartPending, replayHistoryReady, replayMin]);
  useEffect(() => {
      if (!replayPlaying) return;
      let previousTick = Date.now();
      const timer = window.setInterval(() => {
        const currentTick = Date.now();
        const elapsedRealMs = Math.max(0, currentTick - previousTick);
        previousTick = currentTick;
        setReplayTimestamp((current) => {
          const next = current + elapsedRealMs * replaySpeed * 60;
          if (next >= replayMax) { setReplayPlaying(false); return replayMax; }
          return next;
        });
      }, 250);
      return () => window.clearInterval(timer);
    }, [replayPlaying, replaySpeed, replayMax]);
  const changeReplayPlaying = (playing: boolean) => {
      if (!playing) {
        setReplayStartPending(false);
        setReplayPlaying(false);
        return;
      }
      if (!replayHistoryReady) {
        setReplayStartPending(true);
        setReplayPlaying(false);
        return;
      }
      setReplayStartPending(false);
      setReplayPlaying(true);
    };
  return Object.assign(context, { houseWeather, outdoorContext, outdoor, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, viewSensors, summarySensors, definitions, houseDefinitions, availableDefinitions, airflowDefinitions, airflowMetricKey, definition, metricOptions, metricLabel, liveSamples, houseSensorIdList, houseSensorIds, replayMetricIds, loadedReplayBounds, fallbackReplayBounds, replayMin, replayMax, replayHistoryReady, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLayerScope, spatialLayers, liveSpatialMaxSampleAgeMs, spatialMaxSampleAgeMs, spatialFreshness, changeReplayPlaying });
}