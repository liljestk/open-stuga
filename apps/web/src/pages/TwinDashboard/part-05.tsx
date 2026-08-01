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
import { useTwinDashboardPart04 } from "./part-04";
export function useTwinDashboardPart05(context: ReturnType<typeof useTwinDashboardPart04>) {
  const { props, state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, readOnly, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, energyDevicesVisible, setEnergyDevicesVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce, houseWeather, outdoorContext, outdoor, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, viewSensors, summarySensors, definitions, houseDefinitions, availableDefinitions, airflowDefinitions, airflowMetricKey, definition, metricOptions, metricLabel, liveSamples, houseSensorIdList, houseSensorIds, replayMetricIds, loadedReplayBounds, fallbackReplayBounds, replayMin, replayMax, replayHistoryReady, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLayerScope, spatialLayers, liveSpatialMaxSampleAgeMs, spatialMaxSampleAgeMs, spatialFreshness, changeReplayPlaying, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, openingStateAt, openingStateObservations, setOpeningStateObservations, pendingOpeningStateKeys, setPendingOpeningStateKeys, openingStateError, setOpeningStateError, openingStateAnnouncement, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations, controllableOpenings, hasOpeningElements, changeOpeningState, experimentalFloorAirflow, experimentalBuildingAirflow, experimentalAirflowEvidence, experimentalSuggestions, toggleExperimentalVisualization, values, hasUsableReadings, houseValues, activeOutdoorValue, activeOutdoorComparison, houseColorDomain, outdoorConditionColors, visualOutdoor, average, spread, openAlerts, floorObservations, houseObservations, houseParameters, inspectorSamples, changeRange, submitObservation, placeObservation, cancelObservationPlacement } = context;
  const submitParameter = async (event: FormEvent) => {
      event.preventDefault();
      const label = parameterLabel.trim();
      const value = parameterValue.trim();
      if (readOnly || !localAuthority || !label || !value || parameterPending) return;
      setParameterPending(true);
      setParameterFeedback(null);
      try {
        await props.onCreateStaticParameter({
          houseId,
          scopeType: "house",
          scopeId: houseId,
          key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || crypto.randomUUID(),
          label,
          value,
          unit: parameterUnit.trim() || null,
        });
        setParameterLabel("");
        setParameterValue("");
        setParameterUnit("");
        setParameterFeedback("saved");
      } catch {
        setParameterFeedback("error");
      } finally {
        setParameterPending(false);
      }
    };
  const startEditing = () => {
      if (readOnly) return;
      setFullPage(false);
      setEditing(true);
      cancelObservationPlacement();
    };
  const saveEdits = async () => {
      if (readOnly) return false;
      try {
        await props.onSaveLayout(house);
        return true;
      } catch {
        return false;
      }
    };
  const finishEditing = async () => {
      if (await saveEdits()) setEditing(false);
    };
  const openDecisionSensor = (targetFloorId: string, sensorId: string) => {
      props.onFloor(targetFloorId);
      props.onSensorSelect(sensorId);
      props.onViewMode("plan");
      setLiveMapOpen(true);
    };
  const openDecisionRoom = (targetFloorId: string, _roomId: string | null) => {
      props.onFloor(targetFloorId);
      props.onSensorSelect(null);
      props.onViewMode("plan");
      setLiveMapOpen(true);
    };
  const liveMapVisible = liveMapOpen || editing || replayActive || fullPage;
  return Object.assign(context, { submitParameter, startEditing, saveEdits, finishEditing, openDecisionSensor, openDecisionRoom, liveMapVisible });
}
