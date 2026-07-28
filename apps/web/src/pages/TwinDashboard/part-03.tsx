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
import { createOutdoorBoundaryContext, createOutdoorBoundaryContextFromConditions } from "../../outdoorContext";
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
import { replayOutdoorAttribution, replayOutdoorConditions, replayOutdoorSampleAt } from "../../replayWeather";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { integrationForHouse } from "../../integrationScope";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, energyDeviceLayerPreferenceKey, experimentalVisualizationPreferenceKey, houseLocalDateTimeCandidates, initialEnergyDeviceLayerVisibility, initialExperimentalVisualizations, localDateTimeValue, localDateValue, mergeOpeningStateObservations, observationConfidences, observationKinds, observationSources, observationTimeFields, observationTimePrecisions, zonedDateTimeParts } from "./support";
import type { TwinDashboardProps } from "./support";
import { useTwinDashboardPart02 } from "./part-02";
export function useTwinDashboardPart03(context: ReturnType<typeof useTwinDashboardPart02>) {
  const { props, state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, readOnly, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, energyDevicesVisible, setEnergyDevicesVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce, houseWeather, outdoorContext, outdoor, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, viewSensors, summarySensors, definitions, houseDefinitions, availableDefinitions, airflowDefinitions, airflowMetricKey, definition, metricOptions, metricLabel, liveSamples, houseSensorIdList, houseSensorIds, replayMetricIds, loadedReplayBounds, fallbackReplayBounds, replayMin, replayMax, replayHistoryReady, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLayerScope, spatialLayers, liveSpatialMaxSampleAgeMs, spatialMaxSampleAgeMs, spatialFreshness, changeReplayPlaying } = context;
  const selectReplayEvent = (event: ReplayClimateEvent) => {
      props.onMetric(event.metric);
      const sensor = houseSensors.find((candidate) => candidate.id === event.sensorId);
      if (!sensor) return;
      if (sensor.floorId !== floorId) props.onFloor(sensor.floorId);
      props.onSensorSelect(sensor.id);
    };
  const loadReplayWindow = async () => {
      if (!props.onLoadReplaySeries) {
        setReplayLoadState("error");
        setReplayLoadError(t("replay.windowUnavailable"));
        return;
      }
      const fromCandidates = houseLocalDateTimeCandidates(replayWindowFrom, house.timezone);
      const toCandidates = houseLocalDateTimeCandidates(replayWindowTo, house.timezone);
      const from = fromCandidates?.[0] ?? null;
      const to = toCandidates?.at(-1) ?? null;
      if (!from || !to || Date.parse(from) >= Date.parse(to)) {
        setReplayLoadState("error");
        setReplayLoadError(t("replay.invalidWindow"));
        return;
      }

      const requestId = replayWindowRequestRef.current + 1;
      replayWindowRequestRef.current = requestId;
      setReplayLoadState("loading");
      setReplayLoadError(null);
      setReplayLoadPartial(false);
      setReplaySampleCount(null);
      context.setReplayOutdoorLoading(Boolean(house.location));
      context.setReplayOutdoorPartial(false);
      setReplayPlaying(false);
      setReplayStartPending(false);
      setReplayPrepared(true);
      try {
        const [pages, outdoorResult] = await Promise.all([
          Promise.all(houseSensors.flatMap((sensor) => replayMetricIds.map((replayMetric) => (
            props.onLoadReplaySeries!(sensor.id, replayMetric, {
              from,
              to,
              bucketSeconds: replayResolutionSeconds,
            })
          )))),
          house.location
            ? api.outdoorTemperatureHistory(houseId, from, to)
              .then((page) => ({ page, failed: false as const }))
              .catch(() => ({ page: null, failed: true as const }))
            : Promise.resolve({ page: null, failed: false as const }),
        ]);
        if (replayWindowRequestRef.current !== requestId) return;
        const minimum = Date.parse(from);
        const maximum = Date.parse(to);
        const outdoorSamples = outdoorResult.page?.samples ?? [];
        const sampleCount = pages.reduce((total, page) => total + page.samples.length, outdoorSamples.length);
        setReplayRequestedBounds({ minimum, maximum });
        setReplayTimestamp(minimum);
        context.setReplayOutdoorSamples(outdoorSamples);
        context.setReplayOutdoorPartial(outdoorResult.failed || Boolean(outdoorResult.page?.truncated));
        setReplayLoadPartial(pages.some((page) => page.truncated)
          || outdoorResult.failed
          || Boolean(outdoorResult.page?.truncated));
        setReplaySampleCount(sampleCount);
        setReplayLoadState("ready");
        setReplayActive(sampleCount > 0);
      } catch (error) {
        if (replayWindowRequestRef.current !== requestId) return;
        setReplayLoadState("error");
        setReplayLoadError(error instanceof Error && error.message.trim() ? error.message : t("replay.loadFailed"));
      } finally {
        if (replayWindowRequestRef.current === requestId) context.setReplayOutdoorLoading(false);
      }
    };
  useEffect(() => {
      if (!house.location || replayRequestedBounds || (!historyOpen && !replayActive)) return;
      const from = new Date(replayMin).toISOString();
      const to = new Date(replayMax).toISOString();
      const batchKey = `${houseId}:${from}:${to}`;
      if (context.replayOutdoorBatchRef.current === batchKey) return;
      context.replayOutdoorBatchRef.current = batchKey;
      const controller = new AbortController();
      context.setReplayOutdoorLoading(true);
      context.setReplayOutdoorPartial(false);
      void api.outdoorTemperatureHistory(houseId, from, to, 20_000, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          context.setReplayOutdoorSamples(page.samples);
          context.setReplayOutdoorPartial(page.truncated);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          context.setReplayOutdoorSamples([]);
          context.setReplayOutdoorPartial(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) context.setReplayOutdoorLoading(false);
        });
      return () => controller.abort();
    }, [historyOpen, replayActive, replayRequestedBounds, replayMin, replayMax, houseId, house.location?.latitude, house.location?.longitude]);
  useEffect(() => {
      if (replayActive && replayRequestedBounds) return;
      if (selectedSensor) loadSeriesOnce(selectedSensor.id, definition);
    }, [replayActive, replayRequestedBounds, selectedSensor?.id, definition.id, range, definition.forecastSupported]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds) {
        replayBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${definition.id}:${range}:${houseSensorIds}`;
      if (replayBatchRef.current === batchKey) return;
      replayBatchRef.current = batchKey;
      houseSensors.forEach((sensor) => {
        if (sensor.id !== selectedSensor?.id) loadSeriesOnce(sensor.id, definition);
      });
    }, [replayActive, replayRequestedBounds, houseId, definition.id, definition.forecastSupported, range, houseSensorIds, selectedSensor?.id]);
  useEffect(() => {
      if (!replayPrepared || replayRequestedBounds) {
        replayPreparationBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}`;
      if (replayPreparationBatchRef.current === batchKey) return;
      replayPreparationBatchRef.current = batchKey;
      definitions
        .filter((candidate) => replayMetricIds.includes(candidate.id))
        .forEach((replayDefinition) => houseSensors.forEach((sensor) => {
          loadSeriesOnce(sensor.id, replayDefinition);
        }));
    }, [replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, replayMetricIds]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds) {
        airflowReplayBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}:${definition.id}:${replayPrepared}`;
      if (airflowReplayBatchRef.current === batchKey) return;
      airflowReplayBatchRef.current = batchKey;
      airflowDefinitions.forEach((airflowDefinition) => {
        if (airflowDefinition.id === definition.id) return;
        if (replayPrepared && (airflowDefinition.id === "temperature" || airflowDefinition.id === "humidity")) return;
        houseSensors.forEach((sensor) => {
          loadSeriesOnce(sensor.id, airflowDefinition);
        });
      });
    }, [replayActive, replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, airflowMetricKey, definition.id]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds || !selectedSensor) {
        inspectorReplayBatchRef.current = "";
        return;
      }
      const supported = definitions.filter((candidate) => candidate.id !== definition.id
        && !airflowDefinitions.some((airflow) => airflow.id === candidate.id)
        && (selectedSensor.measurementEntityIds?.[candidate.id]
          || state.latestMeasurements[selectedSensor.id]?.[candidate.id]
          || state.measurementHistory[selectedSensor.id]?.[candidate.id]?.length));
      const batchKey = `${selectedSensor.id}:${range}:${supported.map((candidate) => candidate.id).join(",")}`;
      if (inspectorReplayBatchRef.current === batchKey) return;
      inspectorReplayBatchRef.current = batchKey;
      supported.forEach((candidate) => {
        loadSeriesOnce(selectedSensor.id, candidate);
      });
    }, [replayActive, replayRequestedBounds, selectedSensor?.id, range, definition.id, airflowMetricKey, state.latestMeasurements, state.measurementHistory]);
  const replayOutdoorSample = useMemo(
      () => replayOutdoorSampleAt(context.replayOutdoorSamples, replayTimestamp),
      [context.replayOutdoorSamples, replayTimestamp],
    );
  const historicalOutdoorContext = useMemo(() => {
      if (!replayOutdoorSample) return null;
      const observedAt = Date.parse(replayOutdoorSample.timestamp);
      const stale = !Number.isFinite(observedAt)
        || replayTimestamp - observedAt > spatialMaxSampleAgeMs;
      return createOutdoorBoundaryContextFromConditions(
        house,
        replayOutdoorConditions(replayOutdoorSample),
        stale,
      );
    }, [house, replayOutdoorSample, replayTimestamp, spatialMaxSampleAgeMs]);
  const replayAwareOutdoor = useMemo<OutdoorVisualizationState>(() => {
      if (!replayActive) return outdoor;
      const attribution = replayOutdoorSample ? replayOutdoorAttribution(replayOutdoorSample) : null;
      return {
        context: historicalOutdoorContext,
        loading: context.replayOutdoorLoading,
        unavailable: !context.replayOutdoorLoading && !historicalOutdoorContext,
        refreshFailed: false,
        hasLocation: Boolean(house.location),
        replayActive: true,
        timeZone: house.timezone,
        ...(house.orientationDegrees === undefined ? {} : { orientationDegrees: house.orientationDegrees }),
        ...(attribution ? { attribution } : {}),
      };
    }, [replayActive, outdoor, historicalOutdoorContext, context.replayOutdoorLoading, house.location, house.orientationDegrees, house.timezone, replayOutdoorSample]);
  const replayAwareOutdoorContext = replayActive ? historicalOutdoorContext : outdoorContext;
  const displayedSamples = useMemo(() => replayActive
      ? samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), definition.id, replayTimestamp)
      : liveSamples,
    [replayActive, replayTimestamp, houseSensors, state.measurementHistory, liveSamples, definition.id]);
  const mapSensorMeasurements = useMemo<LatestMeasurements>(() => {
      if (!replayActive) return state.latestMeasurements;
      const replaySamples = replayMetricIds.map((replayMetric) => (
        samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), replayMetric, replayTimestamp)
      ));
      return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
        replaySamples.flatMap((samplesBySensor) => {
          const sample = samplesBySensor[sensor.id];
          return sample ? [[sample.metric, sample]] : [];
        }),
      )]));
    }, [replayActive, replayTimestamp, houseSensors, replayMetricIds, state.latestMeasurements, state.measurementHistory]);
  const airflowSamples = useMemo<ClimateSampleMatrix>(() => {
      if (!replayActive) {
        return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id] ?? {}]));
      }
      const replayByMetric = Object.fromEntries(airflowDefinitions.map((airflowDefinition) => [
        airflowDefinition.id,
        samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), airflowDefinition.id, replayTimestamp),
      ]));
      return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
        airflowDefinitions.flatMap((airflowDefinition) => {
          const sample = replayByMetric[airflowDefinition.id]?.[sensor.id];
          return sample ? [[airflowDefinition.id, sample]] : [];
        }),
      )]));
    }, [replayActive, replayTimestamp, houseSensors, state.latestMeasurements, state.measurementHistory, airflowMetricKey]);
  const sensorCoverage = useMemo(() => assessSensorCoverage({
      house,
      sensors: houseSensors,
      samples: airflowSamples,
      freshness: spatialFreshness,
    }), [house, houseSensors, airflowSamples, spatialFreshness]);
  const airMovementSelected = spatialLayers.available && experimentalVisualizations.includes("air-movement");
  const coverageSelected = spatialLayers.available && experimentalVisualizations.includes("sensor-coverage");
  const openingStateAt = replayActive ? new Date(replayTimestamp).toISOString() : undefined;
  const [openingStateObservations, setOpeningStateObservations] = useState<OpeningStateObservation[]>([]);
  const [pendingOpeningStateKeys, setPendingOpeningStateKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [openingStateError, setOpeningStateError] = useState<string | null>(null);
  const [openingStateAnnouncement, setOpeningStateAnnouncement] = useState("");
  const openingStateRequestsRef = useRef(new Set<string>());
  const openingStateContextRef = useRef({ houseId });
  if (openingStateContextRef.current.houseId !== houseId) openingStateContextRef.current = { houseId };
  const houseOpeningStateObservations = useMemo(
      () => openingStateObservationsForHouse(houseId, openingStateObservations),
      [houseId, openingStateObservations],
    );
  const controllableOpenings = useMemo(() => house.floors.flatMap((candidateFloor) => (
      (candidateFloor.planElements ?? []).flatMap((element, index) => (
        isAirflowPlanElement(element) && openingStateCanChange(element)
          ? [{ floor: candidateFloor, element, index }]
          : []
      ))
    )), [house.floors]);
  const hasOpeningElements = useMemo(() => house.floors.some((candidateFloor) => (
      (candidateFloor.planElements ?? []).some(isAirflowPlanElement)
    )), [house.floors]);
  useEffect(() => {
      setOpeningStateObservations([]);
      setPendingOpeningStateKeys(new Set());
      setOpeningStateError(null);
      setOpeningStateAnnouncement("");
      openingStateRequestsRef.current.clear();
    }, [houseId]);
  useEffect(() => {
      const observation = state.latestOpeningStateObservation;
      if (openingStateAt !== undefined || observation?.houseId !== houseId) return;
      const observedAtMs = Date.parse(observation.observedAt);
      setLiveSpatialClockMs((current) => Math.max(
        current,
        Date.now(),
        Number.isFinite(observedAtMs) ? observedAtMs : 0,
      ));
      setOpeningStateObservations((current) => mergeOpeningStateObservations(current, [observation]));
    }, [houseId, openingStateAt, state.latestOpeningStateObservation]);
  useEffect(() => {
      if (!hasOpeningElements) return;
      const controller = new AbortController();
      let loading = false;
      const load = async () => {
        if (loading) return;
        loading = true;
        try {
          const result = await api.openingStates(houseId, openingStateAt, controller.signal);
          if (!controller.signal.aborted) {
            setOpeningStateObservations((current) => mergeOpeningStateObservations(current, result.observations));
          }
        } catch {
          // Keep the last-good states; configured/manual fallbacks remain authoritative.
        } finally {
          loading = false;
        }
      };
      void load();
      const refreshMs = connection === "live" ? 30_000 : 5_000;
      const timer = openingStateAt === undefined ? window.setInterval(() => { void load(); }, refreshMs) : null;
      return () => {
        controller.abort();
        if (timer !== null) window.clearInterval(timer);
      };
    }, [connection, hasOpeningElements, houseId, openingStateAt]);
  return Object.assign(context, { outdoor: replayAwareOutdoor, outdoorContext: replayAwareOutdoorContext, replayOutdoorSample, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, openingStateAt, openingStateObservations, setOpeningStateObservations, pendingOpeningStateKeys, setPendingOpeningStateKeys, openingStateError, setOpeningStateError, openingStateAnnouncement, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations, controllableOpenings, hasOpeningElements });
}
