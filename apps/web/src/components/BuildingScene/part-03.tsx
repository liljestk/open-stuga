import {
  useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent,
} from "react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type Sensor, type UnitSystem } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../energyDeviceMap";
import {
  configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh, type SpatialFreshnessOptions,
} from "../../spatialFreshness";
import { simulateBuildingAirflow, type BuildingAirflowEstimate, type ClimateSampleMatrix } from "../../airflowSimulation";
import {
  clampCameraOrbit, createVolumeClouds, estimateVolumeFlows, interpolateVolume, projectPoint3D,
  type CameraOrbit, type Point3D, type ProjectedPoint3D, type VolumeBounds, type VolumeCloudBlob,
} from "../../spatialVolume";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "../OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "../PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "../PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "../PlanElementFixtureFields";
import { OpeningInventory } from "../OpeningInventory";
import { SpatialLayerOverlay3D } from "../SpatialLayerOverlay3D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../spatialLayers";
import type { SensorCoverageAssessment } from "../../experimentalSpatialLayers";
import { ExperimentalSensorCoverage3D } from "../ExperimentalSensorCoverage";
import {
  clampPlanElementHeight,
  clampPlanElementWidth,
  DEFAULT_CEILING_HEIGHT_METRES,
  defaultPlanElementHeight,
  defaultPlanElementWidth,
  defaultFireEscapeProjection,
  editablePlanElementWidthBounds,
  effectivePlanElementHeight,
  isWallAttachedPlanElement,
  isWallOpening,
  planElementBottomOffset,
  planElementHeightBounds,
  planElementWidthBounds,
} from "../../planElementGeometry";
import { fireplaceChimneyDimensions, fireplaceChimneyTop, isRoofSpanningFireplace, roofEavesZ, roofPeakZ, roofSurfaces } from "../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { DEFAULT_CAMERA, VIEW_HEIGHT, VIEW_WIDTH, buildingBounds, elementAxis, elementWorldGeometry, inferReferenceTime, points, projectedCloud, relativeSensorHeight, smoothProjectedAirflowPath, svgToken, visualLabel } from "./support";
import type { AddableOpeningKind, BuildingSceneProps, DragState, ElementWorldGeometry, ProjectedCloud, SelectedElementPatch } from "./support";
import { useBuildingScenePart02 } from "./part-02";
export function useBuildingScenePart03(context: ReturnType<typeof useBuildingScenePart02>) {
  const { house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId, referenceTimeMs, maxSampleAgeMs, outdoor, editing, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, energyDevicesVisible, onFloorSelect, onSensorSelect, onFloorChange, locale, t, houseOpeningStateObservations, metricLabel, markerId, camera, setCamera, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, mapInformationId, selectedElementKey, setSelectedElementKey, addableOpeningKind, setAddableOpeningKind, openingEditorMessage, setOpeningEditorMessage, dragRef, suppressClickRef, effectiveReferenceTimeMs, effectiveMaxAgeMs, freshness, boundsSignature, bounds, floorModels, volume, heatMin, heatMax, clouds, gradientFlows, allValues, project, outdoorContext, airflow, airflowPaths, activeGradientFlows, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, outdoorShellWorld, outdoorShellProjected, outdoorWindwardProjected, outdoorShellRail, projectedClouds, renderedSensors, orderedFloors, selectedElementFloor, selectedElement, changeCamera, rotateCamera, onPointerDown, onPointerMove, endPointer, onWheel, activateFloor, floorKeyDown, selectSensor, selectArchitecturalElement, updateSelectedElement, selectedWidthBounds, selectedHeightBounds, updateSelectedWidth, updateSelectedHeight, deleteSelectedElement, addOpeningIn3d } = context;
  const renderArchitecturalElement = (floor: Floor, element: PlanElement, index: number) => {
      const geometry = elementWorldGeometry(floor, element);
      const chimneyDimensions = isRoofSpanningFireplace(element) ? fireplaceChimneyDimensions(floor, element) : null;
      const chimneyGeometry = chimneyDimensions ? elementWorldGeometry(floor, element, {
        width: chimneyDimensions.width,
        depth: chimneyDimensions.depth,
        bottom: floor.elevation,
        height: Math.max(.05, fireplaceChimneyTop(house, floor, element) - floor.elevation),
      }) : null;
      const chimneyFront = chimneyGeometry?.front.map(project);
      const chimneyBack = chimneyGeometry?.back?.map(project);
      const chimneyLeft = chimneyGeometry?.left?.map(project);
      const chimneyRight = chimneyGeometry?.right?.map(project);
      const chimneyTop = chimneyGeometry?.top?.map(project);
      const front = geometry.front.map(project);
      const back = geometry.back?.map(project);
      const left = geometry.left?.map(project);
      const right = geometry.right?.map(project);
      const top = geometry.top?.map(project);
      const selected = selectedElementKey?.floorId === floor.id && selectedElementKey.elementId === element.id;
      const airflowElement = isAirflowPlanElement(element) ? element : null;
      const openingState = airflowElement
        ? effectiveOpeningState(house.id, floor.id, airflowElement, houseOpeningStateObservations, effectiveReferenceTimeMs)
        : null;
      const openingControlEnabled = Boolean(
        airflowElement && openingState && !editing && onOpeningStateChange && openingStateCanChange(airflowElement),
      );
      const openingPending = openingControlEnabled && pendingOpeningStateKeys.has(openingStateKey(floor.id, element.id));
      const nextOpeningState: ConfiguredOpeningState | null = openingState?.state === "open" ? "closed" : openingState ? "open" : null;
      const openingName = `${element.label ?? t(`planElement.${element.kind}` as TranslationKey)} ${index + 1}`;
      const stateLabel = openingState ? ` ${t("opening.state")} ${t(`opening.state.${openingState.state}` as TranslationKey)}.` : "";
      const geometryLabel = `${openingName}, ${floor.name}.${stateLabel} ${t("twin.elementWidth")} ${Number(geometry.width.toFixed(2))} ${t("twin.planUnit")}. ${t("twin.elementHeight")} ${geometry.height.toFixed(2)} m.`;
      const label = openingControlEnabled && openingState && nextOpeningState
        ? t("opening.toggleAria", {
          opening: `${openingName}, ${floor.name}`,
          state: t(`opening.state.${openingState.state}` as TranslationKey),
          action: t(`opening.state.${nextOpeningState}` as TranslationKey),
        })
        : geometryLabel;
      const verticalMidpoint = (a: ProjectedPoint3D, b: ProjectedPoint3D) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const bottomMid = verticalMidpoint(front[0]!, front[1]!);
      const topMid = verticalMidpoint(front[3]!, front[2]!);
      const leftMid = verticalMidpoint(front[0]!, front[3]!);
      const rightMid = verticalMidpoint(front[1]!, front[2]!);
      const frontXs = front.map((point) => point.x);
      const frontYs = front.map((point) => point.y);
      const hitPadding = 12;
      return (
        <g
          key={`${floor.id}:${element.id}`}
          className={`building-plan-element ${element.kind} ${openingState ? `opening-${openingState.state}` : ""} ${openingControlEnabled ? "opening-control" : ""} ${openingPending ? "pending" : ""} ${selected ? "selected" : ""} ${editing ? "editable" : ""}`}
          role={editing || openingControlEnabled ? "button" : "img"}
          tabIndex={editing || openingControlEnabled ? 0 : undefined}
          aria-label={label}
          aria-pressed={editing ? selected : openingControlEnabled ? openingState?.state === "open" : undefined}
          aria-busy={openingPending || undefined}
          data-element-id={element.id}
          data-floor-id={floor.id}
          data-kind={element.kind}
          data-width={geometry.width.toFixed(4)}
            data-height={geometry.height.toFixed(4)}
            data-bottom={geometry.bottom.toFixed(4)}
            data-depth={geometry.depth.toFixed(4)}
          data-opening-state={openingState?.state}
          data-opening-source={openingState?.source}
          onPointerDown={editing
            ? (event) => selectArchitecturalElement(event, floor.id, element.id)
            : openingControlEnabled
              ? (event) => { event.stopPropagation(); }
              : undefined}
          onClick={editing
            ? (event) => event.stopPropagation()
            : openingControlEnabled
              ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
              }
              : (event) => {
                event.stopPropagation();
                activateFloor(floor.id);
              }}
          onKeyDown={editing
            ? (event) => selectArchitecturalElement(event, floor.id, element.id)
            : openingControlEnabled
              ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
              }
              : undefined}
        >
          <title>{label}</title>
          {(editing || openingControlEnabled) && <rect
            x={Math.min(...frontXs) - hitPadding}
            y={Math.min(...frontYs) - hitPadding}
            width={Math.max(...frontXs) - Math.min(...frontXs) + hitPadding * 2}
            height={Math.max(...frontYs) - Math.min(...frontYs) + hitPadding * 2}
            className="building-element-hit-target"
          />}
          {chimneyGeometry && <g className="building-chimney" data-vertical-extent="roof" data-bottom={chimneyGeometry.bottom.toFixed(4)} data-height={chimneyGeometry.height.toFixed(4)} data-width={chimneyGeometry.width.toFixed(4)} data-depth={chimneyGeometry.depth.toFixed(4)}>
            {chimneyBack && <polygon points={points(chimneyBack)} className="building-chimney-side" />}
            {chimneyLeft && <polygon points={points(chimneyLeft)} className="building-chimney-side" />}
            {chimneyRight && <polygon points={points(chimneyRight)} className="building-chimney-side" />}
            {chimneyTop && <polygon points={points(chimneyTop)} className="building-chimney-cap" />}
            {chimneyFront && <polygon points={points(chimneyFront)} className="building-chimney-front" />}
            {chimneyFront && [.12, .24, .36, .48, .6, .72, .84].map((progress) => {
              const from = { x: chimneyFront[0]!.x + (chimneyFront[3]!.x - chimneyFront[0]!.x) * progress, y: chimneyFront[0]!.y + (chimneyFront[3]!.y - chimneyFront[0]!.y) * progress };
              const to = { x: chimneyFront[1]!.x + (chimneyFront[2]!.x - chimneyFront[1]!.x) * progress, y: chimneyFront[1]!.y + (chimneyFront[2]!.y - chimneyFront[1]!.y) * progress };
              return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="building-chimney-course" />;
            })}
          </g>}
          {back && <polygon points={points(back)} className="building-element-side building-element-back" />}
          {left && <polygon points={points(left)} className="building-element-side building-element-left" />}
          {right && <polygon points={points(right)} className="building-element-side building-element-right" />}
          {top && <polygon points={points(top)} className="building-element-side building-element-top" />}
          <polygon points={points(front)} className="building-element-front" />
          {element.kind === "window" && <>
            <line x1={bottomMid.x} y1={bottomMid.y} x2={topMid.x} y2={topMid.y} className="building-window-frame" />
            <line x1={leftMid.x} y1={leftMid.y} x2={rightMid.x} y2={rightMid.y} className="building-window-frame" />
          </>}
          {element.kind === "door" && <circle cx={(front[0]!.x * .24 + front[1]!.x * .66 + front[2]!.x * .1)} cy={(front[0]!.y * .24 + front[1]!.y * .66 + front[2]!.y * .1)} r="3.2" className="building-door-handle" />}
          {element.kind === "fireEscape" && (element.variant ?? "ladder") === "ladder" && <g className="building-fire-escape-detail">
            {[.14, .29, .44, .59, .74, .89].map((progress) => {
              const from = { x: front[0]!.x + (front[3]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[3]!.y - front[0]!.y) * progress };
              const to = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
              return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
            })}
            <line x1={front[0]!.x} y1={front[0]!.y} x2={front[3]!.x} y2={front[3]!.y} />
            <line x1={front[1]!.x} y1={front[1]!.y} x2={front[2]!.x} y2={front[2]!.y} />
          </g>}
          {element.kind === "fireEscape" && element.variant === "stairs" && <g className="building-fire-escape-detail stairs">
            <line x1={front[0]!.x} y1={front[0]!.y} x2={front[2]!.x} y2={front[2]!.y} />
            {[.18, .36, .54, .72, .9].map((progress) => {
              const point = { x: front[0]!.x + (front[2]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[2]!.y - front[0]!.y) * progress };
              const end = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
              return <line key={progress} x1={point.x} y1={point.y} x2={end.x} y2={end.y} />;
            })}
          </g>}
          {openingState && <circle cx={topMid.x} cy={topMid.y - 8} r="4.5" className="building-opening-state-dot" aria-hidden="true" />}
          {element.kind === "fireplace" && <path d={`M${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 - 7).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 3).toFixed(1)} ${topMid.x.toFixed(1)} ${topMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 + 9).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 5).toFixed(1)} ${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Z`} className="building-fireplace-flame" />}
          {selected && <polygon points={points(front)} className="building-element-selection" />}
        </g>
      );
    };
  const observationName = (observation: ManualObservation) => t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}` as TranslationKey);
  return Object.assign(context, { renderArchitecturalElement, observationName });
}