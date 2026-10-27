import { useMemo, type FormEvent } from "react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type MeasurementSample, type Point } from "@climate-twin/contracts";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { round, type TimeRange } from "../../domain";
import { type TranslationKey } from "../../i18n";
import { definitionFor, measurementComparisonColor, measurementDomain, measurementValue, samplesAt } from "../../measurements";
import { isSpatialSampleFresh } from "../../spatialFreshness";
import type { OutdoorVisualizationState } from "../../components/OutdoorConditionsBadge";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type FloorAirflowEstimate,
} from "../../airflowSimulation";
import { api } from "../../api";
import {
  experimentalLayerSuggestions,
  nextExperimentalVisualizationSelection,
  type ExperimentalVisualizationId,
} from "../../experimentalSpatialLayers";
import { estimateOutdoorInfluence } from "../../outdoorInfluence";
import { openingStateCanChange, openingStateKey } from "../../openingState";
import { localDateTimeValue, localDateValue, mergeOpeningStateObservations } from "./support";
import { observationTimeFields } from "../../observationTime";
import { useTwinDashboardPart03 } from "./part-03";
export function useTwinDashboardPart04(context: ReturnType<typeof useTwinDashboardPart03>) {
  const { props, state, house, floor, houseId, floorId, viewMode, t, setLiveMapOpen, readOnly, localAuthority, setRange, replayActive, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, outdoorInfluenceMetric, setObservationPlacement, observationKind, observationSeverity, observationNote, setObservationNote, observationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, observationSourceDetail, observationConfidence, observationDraft, setObservationDraft, setObservationValidationError, setObservationStatus, setObservationError, outdoorContext, outdoor, houseSensors, floorSensors, selectedSensor, summarySensors, definitions, definition, replayTimestamp, spatialReferenceTimeMs, spatialLayers, liveSpatialMaxSampleAgeMs, spatialFreshness, displayedSamples, airflowSamples, sensorCoverage, setOpeningStateObservations, setPendingOpeningStateKeys, setOpeningStateError, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations } = context;
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
        outdoor: outdoorContext,
        openingStateObservations: houseOpeningStateObservations,
      }, 9) : null
    ), [spatialLayers.available, viewMode, floor, floorSensors, airflowSamples, spatialFreshness, outdoorContext, houseOpeningStateObservations]);
  const experimentalBuildingAirflow = useMemo<BuildingAirflowEstimate | null>(() => (
      spatialLayers.available && viewMode === "isometric" ? simulateBuildingAirflow({
        house,
        sensors: houseSensors,
        samples: airflowSamples,
        freshness: spatialFreshness,
        outdoor: outdoorContext,
        openingStateObservations: houseOpeningStateObservations,
      }, 14) : null
    ), [spatialLayers.available, viewMode, house, houseSensors, airflowSamples, spatialFreshness, outdoorContext, houseOpeningStateObservations]);
  const experimentalAirflowEvidence = experimentalFloorAirflow?.evidence ?? experimentalBuildingAirflow?.evidence ?? null;
  const experimentalSuggestions = useMemo(() => experimentalLayerSuggestions({
      house,
      coverage: sensorCoverage,
      airflow: experimentalAirflowEvidence,
      ...(viewMode === "plan" ? { floorId } : {}),
    }), [house, sensorCoverage, experimentalAirflowEvidence, viewMode, floorId]);
  const outdoorInfluence = useMemo(() => estimateOutdoorInfluence({
      metric: outdoorInfluenceMetric,
      sensors: viewMode === "plan" ? floorSensors : houseSensors,
      samples: airflowSamples,
      freshness: spatialFreshness,
      outdoor: outdoorContext,
    }), [outdoorInfluenceMetric, viewMode, floorSensors, houseSensors, airflowSamples, spatialFreshness, outdoorContext]);
  const outdoorInfluenceSelected = spatialLayers.available && experimentalVisualizations.includes("outdoor-influence");
  const toggleExperimentalVisualization = (layerId: ExperimentalVisualizationId, selected: boolean) => {
      setExperimentalVisualizations((current) => nextExperimentalVisualizationSelection(current, layerId, selected));
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
          const sample = airflowSamples[sensor.id]?.[conditionMetric];
          const value = measurementValue(sample, conditionMetric);
          return isSpatialSampleFresh(sample, spatialFreshness) && value != null ? [value] : [];
        });
      const comparison = conditionMetric === definition.id
        ? activeOutdoorComparison
        : measurementComparisonColor(conditionDefinition, indoorValues, outsideValue);
      if (comparison) outdoorConditionColors[conditionMetric] = comparison.color;
    }
  const visualOutdoor: OutdoorVisualizationState = { ...outdoor, conditionColors: outdoorConditionColors };
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const spread = values.length ? Math.max(...values) - Math.min(...values) : null;
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt && houseSensors.some((sensor) => sensor.id === alert.sensorId));
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
  return Object.assign(context, { changeOpeningState, experimentalFloorAirflow, experimentalBuildingAirflow, experimentalAirflowEvidence, experimentalSuggestions, outdoorInfluence, outdoorInfluenceSelected, toggleExperimentalVisualization, values, hasUsableReadings, houseValues, activeOutdoorValue, activeOutdoorComparison, houseColorDomain, outdoorConditionColors, visualOutdoor, average, spread, openAlerts, floorObservations, houseObservations, houseParameters, inspectorSamples, changeRange, submitObservation, placeObservation, cancelObservationPlacement });
}
