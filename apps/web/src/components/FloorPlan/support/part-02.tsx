import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { floorMetersPerPlanUnit, isAirflowPlanElement, wallLengthPlanUnits, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type PlanElementKind, type Point, type Room, type Sensor, type UnitSystem, type Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../../energyDeviceMap";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../../../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix, type FloorAirflowEstimate } from "../../../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../../../spatialFreshness";
import { cardinalDirection, normalizeDegrees, type PlanEdge } from "../../../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "../../OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "../../PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "../../PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "../../PlanElementFixtureFields";
import { OpeningInventory } from "../../OpeningInventory";
import { SpatialLayerOverlay2D } from "../../SpatialLayerOverlay2D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../../spatialLayers";
import type { SensorCoverageAssessment } from "../../../experimentalSpatialLayers";
import { ExperimentalSensorCoverage2D } from "../../ExperimentalSensorCoverage";
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
  planElementHeightBounds,
} from "../../../planElementGeometry";
import { chimneyPenetrationsForFloor, fireplaceChimneyDimensions } from "../../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../../openingState";

export interface PlanElementPatch extends AirflowPlanElementPatch, FixturePlanElementPatch {
  position?: Point;
  rotationDegrees?: number;
  width?: number;
  height?: number;
  wallId?: string;
}

export interface DeletedWallUndo {
  floorId: string;
  wall: Wall;
  wallIndex: number;
  openings: Array<{ element: PlanElement; index: number }>;
}

export function PlanElementGlyph({ kind, width, state, projection }: { kind: PlanElementKind; width: number; state?: ConfiguredOpeningState | undefined; projection?: number | undefined }) {
  const half = width / 2;
  const depth = Math.max(18, Math.min(width * .55, 42));
  if (kind === "door") return (
    <g className="door-glyph">
      <line x1={-half} x2={half} className="plan-element-wall-cutout" />
      {state === "closed"
        ? <line x1={-half} y1="0" x2={half} y2="0" className="plan-element-stroke" />
        : <><line x1={-half} y1="0" x2={-half} y2={-width} className="plan-element-stroke" /><path d={`M${-half} ${-width}A${width} ${width} 0 0 1 ${half} 0`} className="plan-element-detail" /></>}
      <circle cx={-half} r="4" className="plan-element-fill" />
    </g>
  );
  if (kind === "window") return (
    <g className="window-glyph">
      <line x1={-half} x2={half} className="plan-element-wall-cutout" />
      <line x1={-half} x2={half} y1="-5" y2="-5" className="plan-element-stroke" />
      <line x1={-half} x2={half} y1="5" y2="5" className="plan-element-stroke" />
      <line x1={-half} x2={-half} y1="-9" y2="9" className="plan-element-detail" />
      <line x1={half} x2={half} y1="-9" y2="9" className="plan-element-detail" />
      {state === "open" && <line x1="0" y1="-5" x2={Math.min(half, 22)} y2="-20" className="plan-element-detail" />}
    </g>
  );
  if (kind === "fireplace") return (
    <g className="fireplace-glyph">
      <rect x={-half} y={-depth / 2} width={width} height={depth} rx="3" className="plan-element-body" />
      <path d={`M0 ${depth * .28}C${-width * .16} ${depth * .05} ${-width * .1} ${-depth * .25} 0 ${-depth * .34}C${width * .18} ${-depth * .08} ${width * .16} ${depth * .12} 0 ${depth * .28}Z`} className="plan-element-flame" />
    </g>
  );
  if (kind === "fireEscape") {
    const escapeDepth = Math.max(24, projection ?? width * .65);
    return <g className="fire-escape-glyph">
      <rect x={-half} y="0" width={width} height={escapeDepth} rx="2" className="plan-element-body" />
      {[-.32, -.1, .12, .34, .56, .78].map((offset) => <line key={offset} x1={-half * .72} x2={half * .72} y1={escapeDepth * (offset + .1)} y2={escapeDepth * (offset + .1)} className="plan-element-detail" />)}
      <line x1={-half * .78} x2={-half * .78} y1="0" y2={escapeDepth} className="plan-element-stroke" />
      <line x1={half * .78} x2={half * .78} y1="0" y2={escapeDepth} className="plan-element-stroke" />
    </g>;
  }
  const ventHeight = Math.max(18, Math.min(width * .45, 34));
  return (
    <g className="vent-glyph">
      <rect x={-half} y={-ventHeight / 2} width={width} height={ventHeight} rx="4" className="plan-element-body" />
      {[-.3, -.1, .1, .3].map((offset) => <line key={offset} x1={width * offset} x2={width * offset} y1={-ventHeight * .32} y2={ventHeight * .32} className="plan-element-detail" />)}
      {state === "closed" && <><line x1={-half * .7} y1={-ventHeight * .34} x2={half * .7} y2={ventHeight * .34} className="plan-element-stroke" /><line x1={half * .7} y1={-ventHeight * .34} x2={-half * .7} y2={ventHeight * .34} className="plan-element-stroke" /></>}
    </g>
  );
}
