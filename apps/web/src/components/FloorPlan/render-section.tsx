import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, Minus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { floorMetersPerPlanUnit, isAirflowPlanElement, wallLengthPlanUnits, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type PlanElementKind, type Point, type Room, type Sensor, type UnitSystem, type Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../energyDeviceMap";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix, type FloorAirflowEstimate } from "../../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../../spatialFreshness";
import { cardinalDirection, normalizeDegrees, type PlanEdge } from "../../outdoorContext";
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
import { SpatialLayerOverlay2D } from "../SpatialLayerOverlay2D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../spatialLayers";
import type { SensorCoverageAssessment } from "../../experimentalSpatialLayers";
import { ExperimentalSensorCoverage2D } from "../ExperimentalSensorCoverage";
import { OutdoorInfluenceOverlay2D } from "../OutdoorInfluenceOverlay";
import { OutdoorWindFlow2D } from "../OutdoorWindFlow2D";
import { ConnectedDeviceMarker2D } from "../ConnectedDeviceMarkers";
import { HeatPumpMarker2D } from "../HeatPumpMarkers";
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
} from "../../planElementGeometry";
import { chimneyPenetrationsForFloor, fireplaceChimneyDimensions } from "../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { GEOMETRY_EPSILON, GRID_DENSITY_MULTIPLIER, OUTDOOR_SHELL_CHIP_GAP, OUTDOOR_SHELL_CHIP_HEIGHT, OUTDOOR_SHELL_CHIP_RIGHT_INSET, OUTDOOR_SHELL_CHIP_WIDTH, OUTDOOR_SHELL_OFFSET, PLAN_ELEMENT_KINDS, PLAN_VIEWPORT_MARGIN, PlanElementGlyph, ROOM_KINDS, defaultFloorGridSize, floorGridSize, floorRenderScale, insertRoomVertex, isValidRoomPolygon, nearestWallOpeningPlacement, nearestWallPlacement, orientation, outdoorWindwardEdgePath, pointOnSegment, pointsEqual, roomRectanglePoints, segmentsIntersect, smoothAirflowPath, snapPointToGrid, wallLengthInputValue } from "./support";
import type { DeletedWallUndo, EditorTool, FloorGridDensity, FloorPlanProps, PlanElementPatch, WallOpeningPlacementResult, WallPlacement } from "./support";
import { useFloorPlanPart05 } from "./part-05";

export function renderFloorPlanEditorSection(context: ReturnType<typeof useFloorPlanPart05>) {
  const extended = context as typeof context & {
    heatPumps: NonNullable<FloorPlanProps["heatPumps"]>;
    heatPumpInfluenceVisible: NonNullable<FloorPlanProps["heatPumpInfluenceVisible"]>;
    pendingHeatPumpIds: NonNullable<FloorPlanProps["pendingHeatPumpIds"]>;
    onHeatPumpMove: FloorPlanProps["onHeatPumpMove"];
  };
  const { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled, outdoorExtrasVisible, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, connectedDevices, connectedDevicesVisible, pendingConnectedDeviceIds, heatPumps, heatPumpInfluenceVisible, pendingHeatPumpIds, onConnectedDevicePowerChange, onConnectedDeviceMove, onHeatPumpMove, allowBackgroundImageEditing, locale, t, houseOpeningStateObservations, metricLabel, svgRef, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, dragging, draggingElement, draggingRoomVertex, roomVertexRefs, pendingRoomVertexFocus, planElementRefs, mapHelpId, mapInformationId, roomNameErrorId, wallLengthErrorId, fieldId, editorTool, setEditorTool, wallStart, setWallStart, roomStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, placementError, setPlacementError, roomNameError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, undoMessage, setUndoMessage, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, keyboardPoint, setKeyboardPoint, placementAnnouncement, setPlacementAnnouncement, uploadError, setUploadError, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, planZoom, effectivePlanZoom, changePlanZoom, stepPlanZoom, planViewBox, renderScale, metresPerPlanUnit, placementCoordinateScale, placementCoordinateUnit, renderWidth, renderHeight, gridSize, renderedGridSize, viewportMargin, resolvedReferenceTimeMs, spatialFreshness, renderSensors, heat, visualDomain, clouds, gradientFlows, transform, layoutEditing, drawingWall, drawingRoom, placingElement, selectingLayout, keyboardPlacementActive, wallSelectionActive, roomSelectionActive, planElementSelectionActive, showMonitoringOverlays, planElements, chimneyPenetrations, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount, roomName, pointFromEvent, placementPoint, clearLayoutSelection, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, nextUnusedRoomName, addWall, deleteWall, undoLastDeletion, addRoom, updateRoom, addRoomVertex, commitRoomName, deleteRoom, resolveElementPlacement, placementFailureMessage, addPlanElement, updatePlanElement, movePlanElement, updatePlanElementWidth, updatePlanElementHeight, deletePlanElement, mapPointerDown, mapPointerMove, mapKeyDown, wallPointerDown, wallKeyDown, roomPointerDown, roomKeyDown, roomVertexPointerDown, roomEdgeKeyDown, moveRoomVertex, roomVertexKeyDown, planElementPointerDown, planElementPointerMove, planElementKeyDown, startSensorDrag, moveSensor, sensorKeyDown, uploadBackground, legendMin, legendMax, outdoorContext, airflow, airflowPaths, activeGradientFlows, hasOutdoorWindCue, hasMapInformation, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, edgeLabels, elementPreviewPlacement, selectedElementWidthBounds, selectedElementHeightBounds, selectedElementRotation, selectedElementHasCardinalRotation, wallPreview, editorHint } = extended;
  const windLabel = outdoorWindDirection ? t("outdoor.windFromAria", { value: outdoorWindDirection }) : null;
  return (<div className="outdoor-map-layout floor-plan-layout">
        {showMonitoringOverlays && outdoor && <OutdoorConditionsBadge outdoor={outdoor} units={units} showCompass />}
        <div className={`plan-stage ${viewMode === "isometric" ? "isometric" : ""}`}>
          <svg
            ref={svgRef}
            className={`floor-plan ${layoutEditing || observationPlacement ? "direct-manipulation" : "monitoring"}`}
            viewBox={planViewBox}
            role="group"
            data-plan-zoom={effectivePlanZoom.toFixed(2)}
            aria-label={layoutEditing ? t("twin.ariaEditMap", { floor: floor.name }) : t("twin.ariaMap", { metric: metricLabel, floor: floor.name })}
            aria-describedby={keyboardPlacementActive ? mapHelpId : undefined}
            tabIndex={keyboardPlacementActive ? 0 : undefined}
            onPointerDown={mapPointerDown}
            onPointerMove={mapPointerMove}
            onKeyDown={mapKeyDown}
          >
            <desc>{layoutEditing
              ? t("twin.editMapDescription")
              : spatialLayerSnapshots.length || experimentalSensorCoverage || experimentalOutdoorInfluence || experimentalAirflowEnabled
                ? t("spatial.mapDescription")
                : clouds.length
                  ? t("twin.estimatedFieldDescription", { metric: metricLabel })
                  : definition.spatialInterpolation
                    ? t("twin.estimateUnavailable", { metric: metricLabel })
                    : t("building.noSpatial", { metric: metricLabel })}</desc>
            <defs>
              <clipPath id={`${fieldId}-clip`}><rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" /></clipPath>
              <filter id={`${fieldId}-soften`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="7" /></filter>
              <marker id={`${fieldId}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="flow-arrow-head" /></marker>
              <marker id={`${fieldId}-airflow-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
              <filter id={`${fieldId}-sensor-shadow`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="5" stdDeviation="6" floodOpacity=".22" /></filter>
              <pattern id={`${fieldId}-grid-minor`} width={renderedGridSize} height={renderedGridSize} patternUnits="userSpaceOnUse">
                <path d={`M${renderedGridSize} 0H0V${renderedGridSize}`} className="plan-grid-minor-line" />
              </pattern>
              <pattern id={`${fieldId}-grid-major`} width={renderedGridSize * 5} height={renderedGridSize * 5} patternUnits="userSpaceOnUse">
                <rect width={renderedGridSize * 5} height={renderedGridSize * 5} fill={`url(#${fieldId}-grid-minor)`} />
                <path d={`M${renderedGridSize * 5} 0H0V${renderedGridSize * 5}`} className="plan-grid-major-line" />
              </pattern>
              {clouds.map((cloud) => (
                <radialGradient key={`${cloud.id}-gradient`} id={`${fieldId}-${cloud.id}`}>
                  <stop offset="0" stopColor={cloud.color} stopOpacity={Math.min(.82, cloud.opacity + .34)} />
                  <stop offset="52%" stopColor={cloud.color} stopOpacity={cloud.opacity} />
                  <stop offset="100%" stopColor={cloud.color} stopOpacity="0" />
                </radialGradient>
              ))}
            </defs>
            <g transform={transform} className="plan-transform">
              {showMonitoringOverlays && viewMode === "plan" && outdoorContext && (
                <g className={`outdoor-shell ${activeOutdoorColor ? "compared" : ""} ${outdoorContext.stale ? "stale" : ""}`} style={activeOutdoorStyle} role="img" aria-label={outdoorShellLabel}>
                  <rect
                    x={-OUTDOOR_SHELL_OFFSET}
                    y={-OUTDOOR_SHELL_OFFSET}
                    width={renderWidth + OUTDOOR_SHELL_OFFSET * 2}
                    height={renderHeight + OUTDOOR_SHELL_OFFSET * 2}
                    rx="32"
                    className="outdoor-shell-halo"
                  />
                  <rect
                    x={-OUTDOOR_SHELL_OFFSET}
                    y={-OUTDOOR_SHELL_OFFSET}
                    width={renderWidth + OUTDOOR_SHELL_OFFSET * 2}
                    height={renderHeight + OUTDOOR_SHELL_OFFSET * 2}
                    rx="32"
                    className="outdoor-shell-border"
                  />
                  {outdoorContext.windwardEdge && outdoorContext.planWindFromDegrees !== null && <OutdoorWindFlow2D
                    context={outdoorContext}
                    width={renderWidth}
                    height={renderHeight}
                    shellOffset={OUTDOOR_SHELL_OFFSET}
                    windLabel={windLabel}
                    animationsEnabled={mapAnimationsEnabled}
                    extrasVisible={outdoorExtrasVisible}
                    reducedMotion={reducedMotion}
                  />}
                  {outdoorExtrasVisible && <><g transform={`translate(${renderWidth - OUTDOOR_SHELL_CHIP_RIGHT_INSET - OUTDOOR_SHELL_CHIP_WIDTH * 2 - OUTDOOR_SHELL_CHIP_GAP} ${-OUTDOOR_SHELL_OFFSET})`} className={`outdoor-shell-chip outdoor-temperature-chip ${outdoorTemperatureColor ? "condition-color" : ""}`} style={outdoorTemperatureStyle}>
                    <rect width={OUTDOOR_SHELL_CHIP_WIDTH} height={OUTDOOR_SHELL_CHIP_HEIGHT} x="0" y={-OUTDOOR_SHELL_CHIP_HEIGHT / 2} rx={OUTDOOR_SHELL_CHIP_HEIGHT / 2} />
                    <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="-8" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellTemperature")}</tspan></text>
                    <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="15" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorTemperature ?? t("common.noData")}</tspan></text>
                  </g>
                  <g transform={`translate(${renderWidth - OUTDOOR_SHELL_CHIP_RIGHT_INSET - OUTDOOR_SHELL_CHIP_WIDTH} ${-OUTDOOR_SHELL_OFFSET})`} className={`outdoor-shell-chip outdoor-humidity-chip ${outdoorHumidityColor ? "condition-color" : ""}`} style={outdoorHumidityStyle}>
                    <rect width={OUTDOOR_SHELL_CHIP_WIDTH} height={OUTDOOR_SHELL_CHIP_HEIGHT} x="0" y={-OUTDOOR_SHELL_CHIP_HEIGHT / 2} rx={OUTDOOR_SHELL_CHIP_HEIGHT / 2} />
                    <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="-8" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellHumidity")}</tspan></text>
                    <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="15" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorHumidity ?? t("common.noData")}</tspan></text>
                  </g></>}
                </g>
              )}
              <rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" className="plan-base" />
              {viewMode === "isometric" && <path d={`M0 ${renderHeight} L${renderWidth} ${renderHeight} L${renderWidth} ${renderHeight + 38} L0 ${renderHeight + 38}Z`} className="floor-edge" />}
              {floor.backgroundImage && <image href={floor.backgroundImage} x="0" y="0" width={renderWidth} height={renderHeight} preserveAspectRatio="xMidYMid slice" className="plan-background" />}
              {showMonitoringOverlays && (
                <g filter={`url(#${fieldId}-soften)`} clipPath={`url(#${fieldId}-clip)`} className="heat-field heat-clouds" aria-hidden="true">
                  {clouds.map((cloud) => <ellipse key={cloud.id} cx={cloud.x} cy={cloud.y} rx={cloud.rx} ry={cloud.ry} fill={`url(#${fieldId}-${cloud.id})`} className={`heat-cloud-lobe ${cloud.level}`} />)}
                </g>
              )}
              {showMonitoringOverlays && experimentalSensorCoverage && (
                <ExperimentalSensorCoverage2D floor={floor} assessment={experimentalSensorCoverage} scale={renderScale} />
              )}
              {layoutEditing && <rect data-testid="floor-snap-grid" x="0" y="0" width={renderWidth} height={renderHeight} rx="20" fill={`url(#${fieldId}-grid-major)`} className="plan-grid" aria-hidden="true" />}
              {floor.roof && <g className={`plan-roof-overlay ${floor.roof.style}`} role="img" aria-label={t("twin.roofOverlay", { style: t(`roofStyle.${floor.roof.style}` as TranslationKey) })}>
                <rect x={-floor.roof.overhang * renderScale} y={-floor.roof.overhang * renderScale} width={renderWidth + floor.roof.overhang * renderScale * 2} height={renderHeight + floor.roof.overhang * renderScale * 2} rx="5" className="plan-roof-eaves" />
                {floor.roof.style !== "flat" && (floor.roof.ridgeAxis === "x"
                  ? <line x1="0" y1={renderHeight / 2} x2={renderWidth} y2={renderHeight / 2} className="plan-roof-ridge" />
                  : <line x1={renderWidth / 2} y1="0" x2={renderWidth / 2} y2={renderHeight} className="plan-roof-ridge" />)}
                {floor.roof.style === "hip" && (floor.roof.ridgeAxis === "x" ? <>
                  <line x1={-floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                  <line x1={-floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                  <line x1={renderWidth + floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth - renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                  <line x1={renderWidth + floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth - renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                </> : <>
                  <line x1={-floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderWidth / 2} className="plan-roof-hip" />
                  <line x1={renderWidth + floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderWidth / 2} className="plan-roof-hip" />
                  <line x1={-floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderHeight - renderWidth / 2} className="plan-roof-hip" />
                  <line x1={renderWidth + floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderHeight - renderWidth / 2} className="plan-roof-hip" />
                </>)}
              </g>}
              <g className={`rooms ${layoutEditing ? "editable" : ""}`}>
                {floor.rooms.filter((room) => room.points.length >= 3).map((room) => {
                  const selected = room.id === selectedRoomId;
                  const centerX = room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length * renderScale;
                  const centerY = room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length * renderScale;
                  const renderedPoints = room.points.map((point) => `${point.x * renderScale},${point.y * renderScale}`).join(" ");
                  return (
                    <g
                      key={room.id}
                      className={`room-zone ${selected ? "selected" : ""}`}
                      role={roomSelectionActive ? "button" : "img"}
                      tabIndex={roomSelectionActive ? 0 : undefined}
                      aria-label={t("twin.roomAria", { name: room.name })}
                      aria-pressed={roomSelectionActive ? selected : undefined}
                      onPointerDown={roomSelectionActive ? (event) => roomPointerDown(event, room.id) : undefined}
                      onKeyDown={roomSelectionActive ? (event) => roomKeyDown(event, room.id) : undefined}
                    >
                      {layoutEditing && <polygon points={renderedPoints} className="room-zone-area" />}
                      <text x={centerX} y={centerY} textAnchor="middle">{room.name}</text>
                    </g>
                  );
                })}
                {roomStart && (
                  <g className="room-preview" aria-hidden="true">
                    <polygon points={roomRectanglePoints(roomStart, keyboardPoint).map((point) => `${point.x * renderScale},${point.y * renderScale}`).join(" ")} />
                    <circle cx={roomStart.x * renderScale} cy={roomStart.y * renderScale} r="8" />
                  </g>
                )}
              </g>
              <g className="walls" aria-hidden={wallSelectionActive ? undefined : true}>
                {floor.walls.map((wall, index) => {
                  const selected = wall.id === selectedWallId;
                  const wallLabel = t("twin.wallAria", { number: index + 1 });
                  const planLength = wallLengthPlanUnits(wall);
                  const physicalLength = metresPerPlanUnit === null ? null : planLength * metresPerPlanUnit;
                  const dimensionLabel = physicalLength === null
                    ? t("twin.wallLengthPlanUnits", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(planLength) })
                    : t("twin.wallLengthMetres", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(physicalLength) });
                  const coordinates = {
                    x1: wall.from.x * renderScale,
                    y1: wall.from.y * renderScale,
                    x2: wall.to.x * renderScale,
                    y2: wall.to.y * renderScale,
                  };
                  const focusBounds = {
                    x: Math.min(coordinates.x1, coordinates.x2) - 14,
                    y: Math.min(coordinates.y1, coordinates.y2) - 14,
                    width: Math.max(Math.abs(coordinates.x2 - coordinates.x1), 1) + 28,
                    height: Math.max(Math.abs(coordinates.y2 - coordinates.y1), 1) + 28,
                  };
                  const angle = Math.atan2(coordinates.y2 - coordinates.y1, coordinates.x2 - coordinates.x1) * 180 / Math.PI;
                  const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
                  const midpoint = { x: (coordinates.x1 + coordinates.x2) / 2, y: (coordinates.y1 + coordinates.y2) / 2 };
                  return (
                    <g
                      key={wall.id}
                      className={`wall-segment-group ${selected ? "selected" : ""}`}
                      role={wallSelectionActive ? "button" : undefined}
                      tabIndex={wallSelectionActive ? 0 : undefined}
                      aria-label={wallSelectionActive ? wallLabel : undefined}
                      aria-pressed={wallSelectionActive ? selected : undefined}
                      onPointerDown={wallSelectionActive ? (event) => wallPointerDown(event, wall.id) : undefined}
                      onKeyDown={wallSelectionActive ? (event) => wallKeyDown(event, wall.id) : undefined}
                    >
                      {wallSelectionActive && <rect {...focusBounds} className="wall-focus-bounds" aria-hidden="true" />}
                      {wallSelectionActive && <line {...coordinates} className="wall-hit-target" />}
                      <line {...coordinates} className="wall-segment" />
                      {layoutEditing && <text
                        x={midpoint.x}
                        y={midpoint.y - 17}
                        transform={`rotate(${readableAngle} ${midpoint.x} ${midpoint.y})`}
                        className={`wall-length-label ${physicalLength === null ? "uncalibrated" : "calibrated"}`}
                        textAnchor="middle"
                        dominantBaseline="central"
                        aria-hidden="true"
                      >{dimensionLabel}</text>}
                    </g>
                  );
                })}
                {wallPreview && (
                  <g className="wall-preview-group" aria-hidden="true">
                    <line {...wallPreview.coordinates} className="wall-preview" />
                    <text
                      x={wallPreview.midpoint.x}
                      y={wallPreview.midpoint.y - 17}
                      transform={`rotate(${wallPreview.readableAngle} ${wallPreview.midpoint.x} ${wallPreview.midpoint.y})`}
                      className={`wall-length-label wall-preview-length ${wallPreview.physicalLength === null ? "uncalibrated" : "calibrated"}`}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >{wallPreview.dimensionLabel}</text>
                    <circle cx={wallPreview.start.x * renderScale} cy={wallPreview.start.y * renderScale} r="8" className="wall-start" />
                  </g>
                )}
              </g>
              {showMonitoringOverlays && outdoorExtrasVisible && edgeLabels.length > 0 && (
                <g className="outdoor-edge-labels" aria-hidden="true">
                  {edgeLabels.map((item) => (
                    <text key={item.edge} x={item.x} y={item.y} textAnchor="middle" dominantBaseline="middle" data-plan-edge={item.edge}>
                      {t(`outdoor.cardinal.${item.cardinal}` as TranslationKey)} {Math.round(item.bearing)}°
                    </text>
                  ))}
                </g>
              )}
              {showMonitoringOverlays && spatialLayerSnapshots.length > 0 && (
                <SpatialLayerOverlay2D floor={floor} snapshots={spatialLayerSnapshots} topology={spatialLayerTopology} scale={renderScale} />
              )}
              {showMonitoringOverlays && experimentalOutdoorInfluence && (
                <OutdoorInfluenceOverlay2D floor={floor} estimate={experimentalOutdoorInfluence} scale={renderScale} units={units} />
              )}
              {showMonitoringOverlays && airflowPaths.length > 0 && (
                <g className="flow-layer simulated-airflow-layer" role="img" aria-label={airflowAria}>
                  <title>{airflowAria}</title>
                  {airflowPaths.map((flow) => {
                    const path = smoothAirflowPath(flow.points, renderScale);
                    const midpoint = flow.points[Math.floor(flow.points.length / 2)]!;
                    const verticalCue = flow.verticalTendency > .13 ? "↑" : flow.verticalTendency < -.13 ? "↓" : "";
                    return (
                      <g
                        key={flow.id}
                        aria-hidden="true"
                        data-relative-speed={flow.relativeSpeed.toFixed(3)}
                        data-support={flow.support.toFixed(3)}
                        data-vertical={flow.verticalTendency.toFixed(3)}
                      >
                        <path d={path} className="flow-path simulated-flow-path" markerEnd={`url(#${fieldId}-airflow-arrow)`} />
                        {mapAnimationsEnabled && !reducedMotion && <circle r="5" className="flow-particle simulated-flow-particle"><animateMotion dur="3.4s" repeatCount="indefinite" path={path} /></circle>}
                        {verticalCue && <text x={midpoint.x * renderScale} y={midpoint.y * renderScale - 12} textAnchor="middle" className="airflow-vertical-cue" aria-hidden="true">{verticalCue}</text>}
                      </g>
                    );
                  })}
                </g>
              )}
              {showMonitoringOverlays && activeGradientFlows.length > 0 && <g className="flow-layer gradient-flow-layer" aria-label={t("twin.flow")}>
                {activeGradientFlows.map(({ id, from, to, difference }, index) => {
                  const fromX = from.x;
                  const fromY = from.y;
                  const toX = to.x;
                  const toY = to.y;
                  const distance = Math.max(1, Math.hypot(toX - fromX, toY - fromY));
                  const bend = Math.min(34, distance * .13) * (index % 2 ? 1 : -1);
                  const curveX = (fromX + toX) / 2 - (toY - fromY) / distance * bend;
                  const curveY = (fromY + toY) / 2 + (toX - fromX) / distance * bend;
                  const path = `M${fromX} ${fromY} Q${curveX} ${curveY} ${toX} ${toY}`;
                  const label = t("twin.gradientAria", {
                    from: formatMeasurement(from.value, definition, units),
                    to: formatMeasurement(to.value, definition, units),
                    difference: formatMeasurementDelta(difference, definition, units),
                  });
                  return (
                    <g key={id} role="img" aria-label={label}>
                      <title>{label}</title>
                      <path d={path} className="flow-path" markerEnd={`url(#${fieldId}-arrow)`} />
                      {mapAnimationsEnabled && !reducedMotion && <circle r="5" className="flow-particle"><animateMotion dur={`${2.8 + index * .32}s`} repeatCount="indefinite" path={path} /></circle>}
                    </g>
                  );
                })}
              </g>}
              {showMonitoringOverlays && <g className="observations-layer">
                {observations.filter((item) => item.x != null && item.y != null).map((item) => {
                  const status = item.status ?? "open";
                  const label = `${t(`observations.${item.kind === "note" ? "noteKind" : item.kind}`)}: ${item.note} (${t(`observations.status.${status}`)})`;
                  return (
                    <g key={item.id} transform={`translate(${item.x! * renderScale} ${item.y! * renderScale})`} className={`observation-marker ${item.severity} ${status}`} role="img" aria-label={label}>
                      <title>{label}</title>
                      <path d="M0-18C-10-18-17-11-17-2C-17 10 0 23 0 23S17 10 17-2C17-11 10-18 0-18Z" />
                      {status === "resolved" ? <path className="observation-resolution-check" d="m-6-3 4 5 8-10" /> : <circle cy="-3" r="5" />}
                    </g>
                  );
                })}
              </g>}
              {selectedRoom && roomSelectionActive && (
                <g className="room-handles" role="group" aria-label={t("twin.roomCorners", { name: selectedRoom.name })}>
                  {selectedRoom.points.map((point, edgeIndex) => {
                    const nextIndex = (edgeIndex + 1) % selectedRoom.points.length;
                    const next = selectedRoom.points[nextIndex]!;
                    const x = (point.x + next.x) / 2 * renderScale;
                    const y = (point.y + next.y) / 2 * renderScale;
                    const label = t("twin.addRoomCornerAria", {
                      name: selectedRoom.name,
                      start: edgeIndex + 1,
                      end: nextIndex + 1,
                    });
                    return (
                      <g
                        key={`edge-${edgeIndex}`}
                        transform={`translate(${x} ${y})`}
                        className="room-edge-handle"
                        role="button"
                        tabIndex={0}
                        aria-label={label}
                        onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                        onClick={(event) => { event.preventDefault(); event.stopPropagation(); addRoomVertex(selectedRoom.id, edgeIndex); }}
                        onKeyDown={(event) => roomEdgeKeyDown(event, selectedRoom.id, edgeIndex)}
                      >
                        <title>{label}</title>
                        <circle r="20" className="room-edge-hit-target" />
                        <circle r="16" className="room-edge-add" />
                        <path d="M-8 0H8M0-8V8" />
                      </g>
                    );
                  })}
                  {selectedRoom.points.map((point, pointIndex) => (
                    <circle
                      key={pointIndex}
                      ref={(node) => {
                        const key = `${selectedRoom.id}:${pointIndex}`;
                        if (node) roomVertexRefs.current.set(key, node);
                        else roomVertexRefs.current.delete(key);
                      }}
                      cx={point.x * renderScale}
                      cy={point.y * renderScale}
                      r="9"
                      className="room-vertex-handle"
                      role="button"
                      tabIndex={0}
                      aria-label={t("twin.roomCornerAria", { name: selectedRoom.name, number: pointIndex + 1 })}
                      onPointerDown={(event) => roomVertexPointerDown(event, selectedRoom.id, pointIndex)}
                      onPointerMove={(event) => moveRoomVertex(event, selectedRoom.id, pointIndex)}
                      onPointerUp={() => { draggingRoomVertex.current = null; }}
                      onPointerCancel={() => { draggingRoomVertex.current = null; }}
                      onLostPointerCapture={() => { draggingRoomVertex.current = null; }}
                      onKeyDown={(event) => roomVertexKeyDown(event, selectedRoom.id, pointIndex)}
                    />
                  ))}
                </g>
              )}
              {keyboardPlacementActive && (
                <g transform={`translate(${keyboardPoint.x * renderScale} ${keyboardPoint.y * renderScale})`} className="placement-cursor" aria-hidden="true">
                  <circle r="15" />
                  <line x1="-22" x2="22" y1="0" y2="0" />
                  <line x1="0" x2="0" y1="-22" y2="22" />
                </g>
              )}
              <g className="sensors-layer">
                {sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
                  const measurements = sensorMeasurements[sensor.id] ?? {};
                  const energyDevice = isEnergyDeviceSensor(sensor, measurements);
                  if (!energyDevice && !climateSensorMarkersVisible && !editing) return [];
                  if (energyDevice && !energyDevicesVisible && !editing) return [];
                  const energyStats = energyDeviceMapStats(measurements, [definition], units);
                  const sample = energyDevice ? energyStats.power ?? energyStats.energy ?? undefined : samples[sensor.id];
                  const quality = !sample
                    ? null
                    : isSpatialSampleFresh(sample, spatialFreshness)
                      ? sample.quality
                      : "stale";
                  const value = energyDevice || quality === "stale" ? undefined : measurementValue(sample, definition.id);
                  const qualityLabel = quality === "stale"
                    ? t("building.statusStale")
                    : quality === "estimated"
                      ? t("building.statusEstimated")
                      : null;
                  const selected = sensor.id === selectedSensorId;
                  const markerValue = energyDevice
                    ? energyStats.short ?? t("twin.noEnergyStats")
                    : value == null ? t("common.noData") : formatMeasurement(value, definition, units);
                  return (
                    <g
                      key={sensor.id}
                      transform={`translate(${sensor.x * renderScale} ${sensor.y * renderScale})`}
                      className={`sensor-marker ${energyDevice ? "energy-device" : ""} ${selected ? "selected" : ""} ${layoutEditing && selectingLayout ? "movable" : ""} ${quality ?? ""}`}
                      data-map-layer={energyDevice ? "energy-devices" : "sensors"}
                      role="button"
                      tabIndex={0}
                      aria-label={`${sensor.name}, ${energyDevice ? t("twin.energyDevice") : metricLabel}, ${markerValue}${qualityLabel ? `, ${qualityLabel}` : ""}`}
                      aria-pressed={selected}
                      onPointerDown={(event) => startSensorDrag(event, sensor.id)}
                      onPointerMove={(event) => moveSensor(event, sensor.id)}
                      onPointerUp={() => { dragging.current = null; }}
                      onPointerCancel={() => { dragging.current = null; }}
                      onLostPointerCapture={() => { dragging.current = null; }}
                      onKeyDown={(event) => sensorKeyDown(event, sensor)}
                    >
                      <circle r="56" className="sensor-hit-target" />
                      <circle r="28" className="sensor-halo" />
                      <circle r="21" className="sensor-core" filter={`url(#${fieldId}-sensor-shadow)`} />
                      {energyDevice
                        ? <path d="M3-16L-9 2H-2L-6 16L10-6H3Z" className="sensor-energy-glyph" aria-hidden="true" />
                        : <><circle r="4" cy="-6" className="sensor-dot" /><text y="9" textAnchor="middle" className="sensor-value">{value == null ? "—" : toDisplayValue(value, definition, units).toFixed(definition.precision)}</text></>}
                      {energyDevice && <text y="43" textAnchor="middle" className="sensor-energy-stats">{energyStats.short ?? "—"}</text>}
                      <text y={energyDevice ? 58 : 45} textAnchor="middle" className="sensor-label">{sensor.name}</text>
                    </g>
                  );
                })}
              </g>
              <g className="plan-elements">
                {chimneyPenetrations.map(({ sourceFloorId, element }) => {
                  const dimensions = fireplaceChimneyDimensions(floor, element);
                  const width = Math.max(28, dimensions.width * renderScale);
                  const depth = Math.max(20, dimensions.depth * renderScale);
                  return <g key={`${sourceFloorId}:${element.id}`} transform={`translate(${element.position.x * renderScale} ${element.position.y * renderScale}) rotate(${element.rotationDegrees})`} className="chimney-penetration" role="img" aria-label={t("twin.chimneyPenetration")}>
                    <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx="2" />
                    <line x1={-width / 2} y1={-depth / 2} x2={width / 2} y2={depth / 2} />
                    <line x1={width / 2} y1={-depth / 2} x2={-width / 2} y2={depth / 2} />
                  </g>;
                })}
                {planElements.map((element, index) => {
                  const selected = element.id === selectedPlanElementId;
                  const airflowElement = isAirflowPlanElement(element) ? element : null;
                  const openingState = airflowElement
                    ? effectiveOpeningState(house?.id, floor.id, airflowElement, houseOpeningStateObservations, resolvedReferenceTimeMs)
                    : null;
                  const openingControlEnabled = Boolean(
                    airflowElement && openingState && !layoutEditing && !observationPlacement
                      && onOpeningStateChange && openingStateCanChange(airflowElement),
                  );
                  const openingPending = openingControlEnabled && pendingOpeningStateKeys.has(openingStateKey(floor.id, element.id));
                  const interactive = planElementSelectionActive || openingControlEnabled;
                  const symbolWidth = Math.max(28, (element.width ?? defaultPlanElementWidth(floor, element.kind)) * renderScale);
                  const baseLabel = t("twin.elementAria", {
                    element: t(`planElement.${element.kind}` as TranslationKey),
                    number: index + 1,
                  });
                  const nextOpeningState: ConfiguredOpeningState | null = openingState?.state === "open" ? "closed" : openingState ? "open" : null;
                  const label = openingState
                    ? openingControlEnabled && nextOpeningState
                      ? t("opening.toggleAria", {
                        opening: baseLabel,
                        state: t(`opening.state.${openingState.state}` as TranslationKey),
                        action: t(`opening.state.${nextOpeningState}` as TranslationKey),
                      })
                      : `${baseLabel}, ${t(`opening.state.${openingState.state}` as TranslationKey)}`
                    : baseLabel;
                  const glyphHeight = element.kind === "door"
                    ? symbolWidth
                    : element.kind === "window"
                      ? 20
                      : element.kind === "fireEscape"
                        ? Math.max(24, (element.projection ?? defaultFireEscapeProjection(floor, element.width ?? defaultPlanElementWidth(floor, "fireEscape"))) * renderScale)
                        : Math.max(18, Math.min(symbolWidth * (element.kind === "vent" ? .45 : .55), 42));
                  const glyphTop = element.kind === "door" ? -symbolWidth : element.kind === "fireEscape" ? 0 : -glyphHeight / 2;
                  return (
                    <g
                      key={element.id}
                      ref={(node) => { if (node) planElementRefs.current.set(element.id, node); else planElementRefs.current.delete(element.id); }}
                      transform={`translate(${element.position.x * renderScale} ${element.position.y * renderScale}) rotate(${element.rotationDegrees})`}
                      className={`plan-element ${element.kind} ${openingState ? `opening-${openingState.state}` : ""} ${openingControlEnabled ? "opening-control" : ""} ${openingPending ? "pending" : ""} ${selected ? "selected" : ""}`}
                      data-opening-state={openingState?.state}
                      data-opening-source={openingState?.source}
                      role={interactive ? "button" : "img"}
                      tabIndex={interactive ? 0 : undefined}
                      aria-label={label}
                      aria-pressed={planElementSelectionActive ? selected : openingControlEnabled ? openingState?.state === "open" : undefined}
                      aria-busy={openingPending || undefined}
                      aria-keyshortcuts={planElementSelectionActive ? isWallAttachedPlanElement(element) ? "R Delete Backspace" : "R Shift+R Delete Backspace" : undefined}
                      onPointerDown={planElementSelectionActive
                        ? (event) => planElementPointerDown(event, element.id)
                        : openingControlEnabled
                          ? (event) => { event.stopPropagation(); }
                          : undefined}
                      onPointerMove={planElementSelectionActive ? (event) => planElementPointerMove(event, element.id) : undefined}
                      onPointerUp={() => { draggingElement.current = null; }}
                      onPointerCancel={() => { draggingElement.current = null; }}
                      onLostPointerCapture={() => { draggingElement.current = null; }}
                      onClick={openingControlEnabled ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
                      } : undefined}
                      onKeyDown={planElementSelectionActive
                        ? (event) => planElementKeyDown(event, element)
                        : openingControlEnabled
                          ? (event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
                          }
                          : undefined}
                    >
                      <rect x={-symbolWidth / 2 - 12} y={glyphTop - 12} width={symbolWidth + 24} height={glyphHeight + 24} className="plan-element-hit-target" />
                      {selected && <rect x={-symbolWidth / 2 - 9} y={glyphTop - 9} width={symbolWidth + 18} height={glyphHeight + 18} rx="8" className="plan-element-selection" />}
                      <PlanElementGlyph kind={element.kind} width={symbolWidth} state={openingState?.state} projection={element.kind === "fireEscape" ? (element.projection ?? defaultFireEscapeProjection(floor, element.width ?? defaultPlanElementWidth(floor, "fireEscape"))) * renderScale : undefined} />
                      {openingState && <circle cx={symbolWidth / 2 - 3} cy={glyphTop + 3} r="6" className="plan-opening-state-dot" aria-hidden="true" />}
                    </g>
                  );
                })}
                {placingElement && elementPreviewPlacement && (
                  <g
                    transform={`translate(${elementPreviewPlacement.position.x * renderScale} ${elementPreviewPlacement.position.y * renderScale}) rotate(${elementPreviewPlacement.rotationDegrees})`}
                    className="plan-element preview"
                    aria-hidden="true"
                  >
                    <PlanElementGlyph kind={planElementKind} width={Math.max(28, defaultPlanElementWidth(floor, planElementKind) * renderScale)} state={planElementKind === "vent" ? "open" : planElementKind === "door" || planElementKind === "window" ? "closed" : undefined} />
                  </g>
                )}
              </g>
              {(editing || connectedDevicesVisible) && <g className="connected-devices-layer">
                {connectedDevices.filter((device) => (
                  device.floorId === floor.id && device.x !== null && device.y !== null
                )).map((device) => <ConnectedDeviceMarker2D
                  key={device.id}
                  device={device}
                  floor={floor}
                  scale={renderScale}
                  editing={editing}
                  pending={pendingConnectedDeviceIds.has(device.connectionId)}
                  {...(onConnectedDevicePowerChange ? { onPowerChange: onConnectedDevicePowerChange } : {})}
                  {...(onConnectedDeviceMove ? {
                    onMove: onConnectedDeviceMove,
                    onMoveFromClient: (connectionId: string, clientX: number, clientY: number) => {
                      const point = pointFromEvent(clientX, clientY);
                      onConnectedDeviceMove(connectionId, {
                        x: clamp(point.x, 0, floor.width),
                        y: clamp(point.y, 0, floor.height),
                      });
                    },
                  } : {})}
                />)}
              </g>}
              <g className="heat-pumps-layer">
                {heatPumps.filter((state) => (
                  state.floorId === floor.id && state.x !== null && state.y !== null
                )).map((state) => <HeatPumpMarker2D
                  key={state.connectionId}
                  state={state}
                  floor={floor}
                  scale={renderScale}
                  editing={editing}
                  pending={pendingHeatPumpIds.has(state.connectionId)}
                  influenceVisible={heatPumpInfluenceVisible}
                  {...(onHeatPumpMove ? {
                    onMove: onHeatPumpMove,
                    onMoveFromClient: (connectionId: string, clientX: number, clientY: number) => {
                      const point = pointFromEvent(clientX, clientY);
                      onHeatPumpMove(connectionId, {
                        x: clamp(point.x, 0, floor.width),
                        y: clamp(point.y, 0, floor.height),
                      });
                    },
                  } : {})}
                />)}
              </g>
            </g>
          </svg>
          {viewMode === "plan" && <div className="plan-zoom-controls" role="group" aria-label={t("twin.planControls")}>
            <button type="button" aria-label={t("twin.zoomIn")} title={t("twin.zoomIn")} disabled={planZoom >= 2} onClick={() => stepPlanZoom(1)}><Plus size={17} aria-hidden="true" /></button>
            <span aria-label={t("twin.zoomState", { zoom: Math.round(planZoom * 100) })}>{Math.round(planZoom * 100)}%</span>
            <button type="button" aria-label={t("twin.zoomOut")} title={t("twin.zoomOut")} disabled={planZoom <= .6} onClick={() => stepPlanZoom(-1)}><Minus size={17} aria-hidden="true" /></button>
            <button type="button" aria-label={t("twin.resetView")} title={t("twin.resetView")} disabled={planZoom === 1} onClick={() => changePlanZoom(1)}><RotateCcw size={16} aria-hidden="true" /></button>
          </div>}
          {showMonitoringOverlays && hasMapInformation && <MapInformationToggle
            controls={mapInformationId}
            expanded={mapInformationExpanded}
            onExpandedChange={setMapInformationExpanded}
          />}
          {showMonitoringOverlays && hasMapInformation && mapInformationExpanded && <div id={mapInformationId} className="map-information-content">
            {clouds.length > 0 && <div className="heat-legend" aria-label={`${t("twin.estimatedField", { metric: metricLabel })}: ${legendMin} – ${legendMax}`}>
              <strong className="heat-legend-title">{t("twin.estimatedField", { metric: metricLabel })}</strong>
              <span>{t("twin.heatLegendLow")}</span>
              <span className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />
              <span>{t("twin.heatLegendHigh")}</span>
              <strong>{legendMin}</strong><strong>{legendMax}</strong>
            </div>}
            {(hasOutdoorWindCue || airflowPaths.length > 0 || activeGradientFlows.length > 0 || experimentalSensorCoverage || experimentalOutdoorInfluence || spatialLayerSnapshots.length > 0) && <div className="map-layer-legends">
              {hasOutdoorWindCue && <div className="flow-legend outdoor-wind-legend"><span className="flow-sample outdoor-wind" aria-hidden="true">≋</span><span><strong>{t("outdoor.windFlowTitle")}</strong><small>{t("outdoor.windFlowDisclaimer")}</small></span></div>}
              {experimentalOutdoorInfluence && <div className="flow-legend outdoor-influence-legend"><span className="flow-sample outdoor-influence" aria-hidden="true">→</span><span><strong>{t("spatial.outdoorInfluence.title")}</strong><small>{t("spatial.outdoorInfluence.disclaimer")}</small></span></div>}
              {airflowPaths.length > 0 && <div className="flow-legend simulated-flow-legend experimental-layer-legend"><span className="flow-sample simulated" aria-hidden="true">↝</span><span><strong>{t("spatial.airflow.title")}</strong><small>{airflowDescription}</small></span></div>}
              {airflowPaths.length === 0 && activeGradientFlows.length > 0 && <div className="flow-legend"><span className="flow-sample" aria-hidden="true">→</span><span><strong>{t("twin.flow")}</strong><small>{t("twin.flowDescription")}</small></span></div>}
              {experimentalSensorCoverage && <div className="flow-legend coverage-layer-legend"><span className="flow-sample coverage" aria-hidden="true">◎</span><span><strong>{t("spatial.coverage.title")}</strong><small>{t("spatial.coverage.legend", { support: Math.round(experimentalSensorCoverage.coverageScore * 100) })}</small></span></div>}
              {spatialLayerSnapshots.length > 0 && <div className="flow-legend spatial-layer-legend"><span className="flow-sample" aria-hidden="true">⇢</span><span><strong>{t("spatial.title")}</strong><small>{t("spatial.inferenceDisclaimer")}</small></span></div>}
            </div>}
          </div>}
        </div>
      </div>);
}
