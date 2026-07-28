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
import { useTwinDashboardPart03 } from "./part-03";
export function useTwinDashboardPart04(context: ReturnType<typeof useTwinDashboardPart03>) {
  const { props, state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, readOnly, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, energyDevicesVisible, setEnergyDevicesVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce, houseWeather, outdoorContext, outdoor, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, viewSensors, summarySensors, definitions, houseDefinitions, availableDefinitions, airflowDefinitions, airflowMetricKey, definition, metricOptions, metricLabel, liveSamples, houseSensorIdList, houseSensorIds, replayMetricIds, loadedReplayBounds, fallbackReplayBounds, replayMin, replayMax, replayHistoryReady, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLayerScope, spatialLayers, liveSpatialMaxSampleAgeMs, spatialMaxSampleAgeMs, spatialFreshness, changeReplayPlaying, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, openingStateAt, openingStateObservations, setOpeningStateObservations, pendingOpeningStateKeys, setPendingOpeningStateKeys, openingStateError, setOpeningStateError, openingStateAnnouncement, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations, controllableOpenings, hasOpeningElements } = context;
  const changeOpeningState = async (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => {
      if (readOnly || !localAuthority || replayActive) return;
      const requestContext = openingStateContextRef.current;
      const requestKey = openingStateKey(targetFloorId, elementId);
      if (openingStateRequestsRef.current.has(requestKey)) return;
      const targetFloor = house.floors.find((candidate) => candidate.id === targetFloorId);
      const elementIndex = targetFloor?.planElements?.findIndex((candidate) => candidate.id === elementId) ?? -1;
      const element = elementIndex >= 0 ? targetFloor?.planElements?.[elementIndex] : undefined;
      if (!element || !isAirflowPlanElement(element) || !openingStateCanChange(element)) return;
      const openingName = element.label ?? `${t(`planElement.${element.kind}` as TranslationKey)} ${elementIndex + 1}`;
      openingStateRequestsRef.current.add(requestKey);
      setPendingOpeningStateKeys((current) => new Set([...current, requestKey]));
      setOpeningStateError(null);
      try {
        const observation = await api.recordOpeningState(requestContext.houseId, {
          floorId: targetFloorId,
          elementId,
          state: nextState,
          source: "manual",
        });
        if (openingStateContextRef.current !== requestContext) return;
        setLiveSpatialClockMs((current) => Math.max(current, Date.parse(observation.observedAt), Date.now()));
        setOpeningStateObservations((current) => mergeOpeningStateObservations(current, [observation]));
        setOpeningStateAnnouncement(t("opening.updated", {
          opening: openingName,
          state: t(`opening.state.${nextState}` as TranslationKey),
        }));
      } catch {
        if (openingStateContextRef.current === requestContext) {
          setOpeningStateError(t("opening.updateError", { opening: openingName }));
        }
      } finally {
        if (openingStateContextRef.current !== requestContext) return;
        openingStateRequestsRef.current.delete(requestKey);
        setPendingOpeningStateKeys((current) => {
          const next = new Set(current);
          next.delete(requestKey);
          return next;
        });
      }
    };
  const experimentalFloorAirflow = useMemo<FloorAirflowEstimate | null>(() => (
      spatialLayers.available && viewMode === "plan" ? simulateFloorAirflow({
        floor,
        sensors: floorSensors,
        samples: airflowSamples,
        freshness: spatialFreshness,
        outdoor: replayActive ? null : outdoorContext,
        openingStateObservations: houseOpeningStateObservations,
      }, 9) : null
    ), [spatialLayers.available, viewMode, floor, floorSensors, airflowSamples, spatialFreshness, replayActive, outdoorContext, houseOpeningStateObservations]);
  const experimentalBuildingAirflow = useMemo<BuildingAirflowEstimate | null>(() => (
      spatialLayers.available && viewMode === "isometric" ? simulateBuildingAirflow({
        house,
        sensors: houseSensors,
        samples: airflowSamples,
        freshness: spatialFreshness,
        outdoor: replayActive ? null : outdoorContext,
        openingStateObservations: houseOpeningStateObservations,
      }, 14) : null
    ), [spatialLayers.available, viewMode, house, houseSensors, airflowSamples, spatialFreshness, replayActive, outdoorContext, houseOpeningStateObservations]);
  const experimentalAirflowEvidence = experimentalFloorAirflow?.evidence ?? experimentalBuildingAirflow?.evidence ?? null;
  const experimentalSuggestions = useMemo(() => experimentalLayerSuggestions({
      house,
      coverage: sensorCoverage,
      airflow: experimentalAirflowEvidence,
      ...(viewMode === "plan" ? { floorId } : {}),
    }), [house, sensorCoverage, experimentalAirflowEvidence, viewMode, floorId]);
  const toggleExperimentalVisualization = (layerId: ExperimentalVisualizationId, selected: boolean) => {
      setExperimentalVisualizations((current) => {
        return selected
          ? current.includes(layerId) ? current : [...current, layerId]
          : current.filter((candidate) => candidate !== layerId);
      });
    };
  const values = summarySensors.flatMap((sensor) => {
      const sample = displayedSamples[sensor.id];
      const value = measurementValue(sample, definition.id);
      return isSpatialSampleFresh(sample, spatialFreshness) && value != null ? [value] : [];
    });
  const hasUsableReadings = houseSensors.some((sensor) => Object.values(state.latestMeasurements[sensor.id] ?? {})
      .some((sample) => Number.isFinite(sample.value) && isSpatialSampleFresh(sample, {
        referenceTimeMs: spatialReferenceTimeMs,
        maxSampleAgeMs: liveSpatialMaxSampleAgeMs,
      })));
  const houseValues = houseSensors.flatMap((sensor) => {
      const sample = displayedSamples[sensor.id];
      const value = measurementValue(sample, definition.id);
      return isSpatialSampleFresh(sample, spatialFreshness) && value != null ? [value] : [];
    });
  const activeOutdoorValue = definition.id === "temperature"
      ? outdoor.context?.conditions.temperatureC
      : definition.id === "humidity"
        ? outdoor.context?.conditions.relativeHumidityPercent
        : undefined;
  const activeOutdoorComparison = measurementComparisonColor(definition, houseValues, activeOutdoorValue);
  const houseColorDomain = activeOutdoorComparison?.domain ?? measurementDomain(definition, houseValues);
  const outdoorConditionColors: NonNullable<OutdoorVisualizationState["conditionColors"]> = {};
  for (const conditionMetric of ["temperature", "humidity"] as const) {
      const conditionDefinition = definitionFor(definitions, conditionMetric);
      const outsideValue = conditionMetric === "temperature"
        ? outdoor.context?.conditions.temperatureC
        : outdoor.context?.conditions.relativeHumidityPercent;
      const indoorValues = conditionMetric === definition.id
        ? houseValues
        : houseSensors.flatMap((sensor) => {
          const sample = state.latestMeasurements[sensor.id]?.[conditionMetric];
          const value = measurementValue(sample, conditionMetric);
          return isSpatialSampleFresh(sample, {
            referenceTimeMs: spatialReferenceTimeMs,
            maxSampleAgeMs: liveSpatialMaxSampleAgeMs,
          }) && value != null ? [value] : [];
        });
      const comparison = conditionMetric === definition.id
        ? activeOutdoorComparison
        : measurementComparisonColor(conditionDefinition, indoorValues, outsideValue);
      if (comparison) outdoorConditionColors[conditionMetric] = comparison.color;
    }
  const visualOutdoor: OutdoorVisualizationState = { ...outdoor, conditionColors: outdoorConditionColors };
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const spread = values.length ? Math.max(...values) - Math.min(...values) : null;
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt && summarySensors.some((sensor) => sensor.id === alert.sensorId));
  const floorObservations = state.observations.filter((observation) => observation.houseId === houseId && observation.floorId === floorId);
  const houseObservations = state.observations.filter((observation) => observation.houseId === houseId);
  const houseParameters = state.staticParameters.filter((parameter) => parameter.houseId === houseId);
  const inspectorSamples = useMemo<Record<string, MeasurementSample>>(() => {
      if (!selectedSensor) return {};
      const samples: Record<string, MeasurementSample> = replayActive
        ? Object.fromEntries(definitions.flatMap((candidate) => {
            const replaySample = samplesAt(
              state.measurementHistory,
              [selectedSensor.id],
              candidate.id,
              replayTimestamp,
            )[selectedSensor.id];
            return replaySample ? [[candidate.id, replaySample]] : [];
          }))
        : { ...(state.latestMeasurements[selectedSensor.id] ?? {}) };
      return Object.fromEntries(Object.keys(samples).map((measurementId) => {
        const sample = samples[measurementId]!;
        return [measurementId, isSpatialSampleFresh(sample, spatialFreshness)
          ? sample
          : { ...sample, quality: "stale" as const }];
      }));
    }, [selectedSensor?.id, state.latestMeasurements, state.measurementHistory, replayActive, replayTimestamp, definitions, spatialFreshness]);
  const changeRange = (next: TimeRange) => {
      setRange(next);
    };
  const submitObservation = (event: FormEvent) => {
      event.preventDefault();
      if (readOnly) return;
      const time = observationTimeFields(observationTimePrecision, observationDateTime, observationDate, observationValidFrom, observationValidTo, house.timezone);
      if (!time) {
        setObservationValidationError(true);
        return;
      }
      setObservationDraft({
        houseId,
        floorId,
        sensorId: null,
        kind: observationKind,
        severity: observationSeverity,
        note: observationNote.trim() || t(`observations.${observationKind === "note" ? "noteKind" : observationKind}` as TranslationKey),
        source: observationSource,
        sourceDetail: observationSourceDetail.trim() || null,
        confidence: observationConfidence,
        ...time,
      });
      props.onViewMode("plan");
      setLiveMapOpen(true);
      setObservationPlacement(true);
      setObservationStatus(false);
      setObservationError(false);
      setObservationValidationError(false);
    };
  const placeObservation = async (point: Point) => {
      if (readOnly || !observationDraft) return;
      try {
        await props.onCreateObservation({
          ...observationDraft,
          x: round(point.x),
          y: round(point.y),
        });
        setObservationStatus(true);
        setObservationNote("");
        setObservationDateTime(localDateTimeValue(new Date(), house.timezone));
        setObservationDate(localDateValue(new Date(), house.timezone));
        setObservationValidFrom(localDateValue(new Date(), house.timezone));
        setObservationValidTo(localDateValue(new Date(), house.timezone));
      } catch {
        setObservationError(true);
      } finally {
        setObservationPlacement(false);
        setObservationDraft(null);
      }
    };
  const cancelObservationPlacement = () => {
      setObservationPlacement(false);
      setObservationDraft(null);
    };
  return Object.assign(context, { changeOpeningState, experimentalFloorAirflow, experimentalBuildingAirflow, experimentalAirflowEvidence, experimentalSuggestions, toggleExperimentalVisualization, values, hasUsableReadings, houseValues, activeOutdoorValue, activeOutdoorComparison, houseColorDomain, outdoorConditionColors, visualOutdoor, average, spread, openAlerts, floorObservations, houseObservations, houseParameters, inspectorSamples, changeRange, submitObservation, placeObservation, cancelObservationPlacement });
}
