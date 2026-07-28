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
import { useBuildingScenePart03 } from "./part-03";
export function renderBuildingScene(context: ReturnType<typeof useBuildingScenePart03>) {
  const { house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId, referenceTimeMs, maxSampleAgeMs, outdoor, editing, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, onFloorSelect, onSensorSelect, onFloorChange, locale, t, houseOpeningStateObservations, metricLabel, markerId, camera, setCamera, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, mapInformationId, selectedElementKey, setSelectedElementKey, addableOpeningKind, setAddableOpeningKind, openingEditorMessage, setOpeningEditorMessage, dragRef, suppressClickRef, effectiveReferenceTimeMs, effectiveMaxAgeMs, freshness, boundsSignature, bounds, floorModels, volume, heatMin, heatMax, clouds, gradientFlows, allValues, project, outdoorContext, airflow, airflowPaths, activeGradientFlows, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, outdoorShellWorld, outdoorShellProjected, outdoorWindwardProjected, outdoorShellRail, projectedClouds, renderedSensors, orderedFloors, selectedElementFloor, selectedElement, changeCamera, rotateCamera, onPointerDown, onPointerMove, endPointer, onWheel, activateFloor, floorKeyDown, selectSensor, selectArchitecturalElement, updateSelectedElement, selectedWidthBounds, selectedHeightBounds, updateSelectedWidth, updateSelectedHeight, deleteSelectedElement, addOpeningIn3d, renderArchitecturalElement, observationName } = context;
  return (
      <div className="building-scene">
        <div className="building-scene-controls">
          <div><span className="eyebrow">{t("building.title")}</span><strong>{house.name}</strong></div>
          <div className="building-orbit-controls" role="group" aria-label={t("building.cameraControls")}>
            <button type="button" className="secondary-button" aria-label={t("building.rotateLeft")} onClick={() => rotateCamera(-.22, 0)}>↶</button>
            <button type="button" className="secondary-button" aria-label={t("building.rotateRight")} onClick={() => rotateCamera(.22, 0)}>↷</button>
            <button type="button" className="secondary-button" aria-label={t("building.tiltUp")} onClick={() => rotateCamera(0, .13)}>↑</button>
            <button type="button" className="secondary-button" aria-label={t("building.tiltDown")} onClick={() => rotateCamera(0, -.13)}>↓</button>
            <label className="building-zoom"><span>{t("building.zoom")}</span><input aria-label={t("building.zoom")} type="range" min="0.55" max="1.75" step="0.05" value={camera.zoom} onChange={(event) => changeCamera({ zoom: Number(event.target.value) })} /></label>
            <button type="button" className="secondary-button building-reset" onClick={() => setCamera(DEFAULT_CAMERA)}>{t("building.resetView")}</button>
            <output className="sr-only building-camera-state">{t("building.cameraState", {
              yaw: Math.round(camera.yaw * 180 / Math.PI), pitch: Math.round(camera.pitch * 180 / Math.PI), zoom: camera.zoom.toFixed(2),
            })}</output>
          </div>
        </div>
        {editing && <div className="building-element-editor" role="region" aria-label={t("twin.elementProperties")}>
          <div className="building-element-editor-heading">
            <span className="eyebrow">{t("twin.planElements")}</span>
            <strong>{selectedElement
              ? t(`planElement.${selectedElement.kind}` as TranslationKey)
              : t("twin.elementProperties")}</strong>
            {selectedElementFloor && <small>{selectedElementFloor.name}</small>}
          </div>
          {onFloorChange && <div className="building-element-add" role="group" aria-label={t("opening.addIn3d")}>
            <label><span>{t("twin.planElement")}</span><select value={addableOpeningKind} onChange={(event) => { setAddableOpeningKind(event.currentTarget.value as AddableOpeningKind); setOpeningEditorMessage(null); }}><option value="door">{t("planElement.door")}</option><option value="window">{t("planElement.window")}</option><option value="vent">{t("planElement.vent")}</option><option value="fireEscape">{t("planElement.fireEscape")}</option></select></label>
            <button type="button" className="tool-button" onClick={addOpeningIn3d}>{t("opening.addIn3d")}</button>
          </div>}
          {openingEditorMessage && <p className="editor-properties-note" role="status">{openingEditorMessage}</p>}
          <OpeningInventory floors={house.floors} selected={selectedElementKey} onSelect={(floorId, elementId) => { onFloorSelect(floorId); setSelectedElementKey({ floorId, elementId }); }} />
          {selectedElement && selectedElementFloor && selectedWidthBounds && selectedHeightBounds
            ? <>
              <PlanElementDimensionFields
                widthLabel={t("twin.elementWidth")}
                heightLabel={t("twin.elementHeight")}
                planUnitLabel={t("twin.planUnit")}
                metreLabel="m"
                width={selectedElement.width ?? defaultPlanElementWidth(selectedElementFloor, selectedElement.kind)}
                height={effectivePlanElementHeight(selectedElementFloor, selectedElement)}
                widthBounds={selectedWidthBounds}
                heightBounds={selectedHeightBounds}
                onWidthChange={updateSelectedWidth}
                onHeightChange={updateSelectedHeight}
              />
              {isAirflowPlanElement(selectedElement) && <PlanElementAirflowFields floor={selectedElementFloor} element={selectedElement} onChange={(patch) => updateSelectedElement(patch)} />}
              {(selectedElement.kind === "fireplace" || selectedElement.kind === "fireEscape") && <PlanElementFixtureFields floor={selectedElementFloor} element={selectedElement} planUnitLabel={t("twin.planUnit")} onChange={(patch) => updateSelectedElement(patch)} />}
              <button type="button" className="tool-button danger-tool building-element-delete" onClick={deleteSelectedElement}>{t("twin.deleteElement")}</button>
            </>
            : <p>{t("building.editElementHelp")}</p>}
        </div>}
        <div className="building-viewport">
          <svg
            className="building-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group"
            aria-label={t("building.aria", { house: house.name, floors: house.floors.length, sensors: sensors.filter((sensor) => sensor.enabled).length, metric: metricLabel })}
            data-camera-yaw={camera.yaw.toFixed(3)} data-camera-pitch={camera.pitch.toFixed(3)} data-camera-zoom={camera.zoom.toFixed(2)}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={onWheel}
          >
            <desc>{spatialLayerSnapshots.length || experimentalSensorCoverage || experimentalAirflowEnabled
              ? t("spatial.buildingDescription")
              : allValues.length
                ? t("building.volumeDescription", { metric: metricLabel })
                : definition.spatialInterpolation
                  ? t("twin.estimateUnavailable", { metric: metricLabel })
                  : t("building.noSpatial", { metric: metricLabel })}</desc>
            <defs>
              <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="building-arrow-head" /></marker>
              <marker id={`${markerId}-vertical`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="vertical-arrow-head" /></marker>
              <marker id={`${markerId}-airflow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
              <marker id={`${markerId}-airflow-vertical`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
              <filter id={`${markerId}-shadow`} x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodOpacity=".24" /></filter>
              <filter id={`${markerId}-cloud-soften`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="7" /></filter>
              {projectedClouds.map(({ blob }) => (
                <radialGradient key={blob.id} id={`${markerId}-cloud-${svgToken(blob.id)}`}>
                  <stop offset="0" stopColor={blob.color} stopOpacity={Math.min(.78, blob.opacity + .32)} />
                  <stop offset="52%" stopColor={blob.color} stopOpacity={blob.opacity} />
                  <stop offset="100%" stopColor={blob.color} stopOpacity="0" />
                </radialGradient>
              ))}
            </defs>

            {outdoorShellProjected && outdoorShellRail && (
              <g className={`building-outdoor-shell ${activeOutdoorColor ? "compared" : ""} ${outdoorContext?.stale ? "stale" : ""}`} style={activeOutdoorStyle} role="img" aria-label={outdoorShellLabel}>
                <polygon points={points(outdoorShellProjected.top)} className="building-outdoor-shell-face" />
                <polygon points={points(outdoorShellProjected.bottom)} className="building-outdoor-shell-outline building-outdoor-shell-bottom" />
                <polygon points={points(outdoorShellProjected.top)} className="building-outdoor-shell-outline building-outdoor-shell-top" />
                {outdoorWindwardProjected && (
                  <line
                    x1={outdoorWindwardProjected.start.x}
                    y1={outdoorWindwardProjected.start.y}
                    x2={outdoorWindwardProjected.end.x}
                    y2={outdoorWindwardProjected.end.y}
                    className="building-outdoor-windward-edge"
                    data-windward-edge={outdoorWindwardProjected.edge}
                    aria-hidden="true"
                  />
                )}
                {outdoorShellProjected.top.map((point, index) => (
                  <line
                    key={index}
                    x1={point.x}
                    y1={point.y}
                    x2={outdoorShellProjected.bottom[index]!.x}
                    y2={outdoorShellProjected.bottom[index]!.y}
                    className="building-outdoor-shell-edge"
                  />
                ))}
                <line
                  x1={outdoorShellRail.anchor.x}
                  y1={outdoorShellRail.anchor.y}
                  x2={outdoorShellRail.x + 209}
                  y2={outdoorShellRail.y + 53}
                  className="building-outdoor-shell-connector"
                />
                <g transform={`translate(${outdoorShellRail.x} ${outdoorShellRail.y})`} className="building-outdoor-shell-rail">
                  <g className="outdoor-shell-chip building-shell-title">
                    <rect width="132" height="52" rx="26" />
                    <text x="66" y="31" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellLabel")}</tspan></text>
                  </g>
                  <g transform="translate(140 0)" className={`outdoor-shell-chip building-temperature-chip ${outdoorTemperatureColor ? "condition-color" : ""}`} style={outdoorTemperatureStyle}>
                    <rect width="136" height="52" rx="26" />
                    <text x="68" y="18" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellTemperature")}</tspan></text>
                    <text x="68" y="38" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorTemperature ?? t("common.noData")}</tspan></text>
                  </g>
                  <g transform="translate(284 0)" className={`outdoor-shell-chip building-humidity-chip ${outdoorHumidityColor ? "condition-color" : ""}`} style={outdoorHumidityStyle}>
                    <rect width="136" height="52" rx="26" />
                    <text x="68" y="18" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellHumidity")}</tspan></text>
                    <text x="68" y="38" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorHumidity ?? t("common.noData")}</tspan></text>
                  </g>
                </g>
              </g>
            )}

            <g className="building-floors">
              {orderedFloors.map(({ floor, floorSensors, average }) => {
                const z = floor.elevation;
                const wallHeight = floor.roof?.style === "flat"
                  ? roofEavesZ(floor) - floor.elevation
                  : floor.wallHeight ?? floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES;
                const surface = [project({ x: 0, y: 0, z }), project({ x: floor.width, y: 0, z }), project({ x: floor.width, y: floor.height, z }), project({ x: 0, y: floor.height, z })];
                const slabBottom = [project({ x: 0, y: 0, z: z - .12 }), project({ x: floor.width, y: 0, z: z - .12 }), project({ x: floor.width, y: floor.height, z: z - .12 }), project({ x: 0, y: floor.height, z: z - .12 })];
                const active = floor.id === activeFloorId;
                const averageLabel = average == null ? t("common.noData") : formatMeasurement(average, definition, units);
                const labelPoint = surface.reduce((best, point) => point.x > best.x ? point : best, surface[0]!);
                return (
                  <g
                    key={floor.id} className={`building-floor ${active ? "active" : ""}`} role={editing ? "group" : "button"} tabIndex={editing ? undefined : 0}
                    data-wall-height={wallHeight.toFixed(3)}
                    aria-pressed={editing ? undefined : active} aria-label={t("building.floorAria", { floor: floor.name, height: floor.elevation.toFixed(1), sensors: floorSensors.length, metric: metricLabel, value: averageLabel })}
                    onClick={() => activateFloor(floor.id)} onKeyDown={editing ? undefined : (event) => floorKeyDown(event, floor.id)}
                  >
                    <polygon points={points([surface[1]!, surface[2]!, slabBottom[2]!, slabBottom[1]!])} className="floor-slab-side" />
                    <polygon points={points([surface[2]!, surface[3]!, slabBottom[3]!, slabBottom[2]!])} className="floor-slab-front" />
                    <polygon points={points(surface)} className="floor-surface" />
                    <g className="building-room-surfaces" aria-hidden="true">{floor.rooms.filter((room) => room.points.length >= 3).map((room) => (
                      <polygon
                        key={room.id}
                        points={points(room.points.map((point) => project({ ...point, z: z + .018 })))}
                        className="building-room-surface"
                        data-room-id={room.id}
                      />
                    ))}</g>
                    <g className="building-walls" aria-hidden="true">{floor.walls.map((wall) => {
                      const face = [
                        project({ x: wall.from.x, y: wall.from.y, z: z + .03 }),
                        project({ x: wall.to.x, y: wall.to.y, z: z + .03 }),
                        project({ x: wall.to.x, y: wall.to.y, z: z + wallHeight }),
                        project({ x: wall.from.x, y: wall.from.y, z: z + wallHeight }),
                      ];
                      return <g key={wall.id} data-wall-id={wall.id}>
                        <polygon points={points(face)} className="building-wall-face" />
                        <line x1={face[3]!.x} y1={face[3]!.y} x2={face[2]!.x} y2={face[2]!.y} className="building-wall-top" />
                      </g>;
                    })}</g>
                    <g className="building-floor-label" aria-hidden="true" transform={`translate(${Math.min(VIEW_WIDTH - 184, labelPoint.x + 10)} ${Math.max(8, labelPoint.y - 40)})`}>
                      <rect width="176" height="43" rx="9" />
                      <text x="11" y="17">{visualLabel(floor.name, 22)}</text>
                      <text x="11" y="33" className="sub-label">{t("building.floorSummary", { height: floor.elevation.toFixed(1), value: averageLabel })}</text>
                    </g>
                  </g>
                );
              })}
            </g>

            {!editing && <g className="building-plan-elements building-plan-elements-live">
              {orderedFloors.flatMap(({ floor }) => (floor.planElements ?? []).map((element, index) => renderArchitecturalElement(floor, element, index)))}
            </g>}

            <g className="building-roofs">
              {orderedFloors.flatMap(({ floor }) => roofSurfaces(floor).map((surface, index) => (
                <polygon key={`${floor.id}:roof:${index}`} points={points(surface.map(project))} className={`building-roof-face roof-${floor.roof?.style ?? "none"}`} data-floor-id={floor.id} />
              )))}
            </g>

            <g className="building-clouds building-volume-clouds" filter={`url(#${markerId}-cloud-soften)`} aria-hidden="true">
              {projectedClouds.map(({ blob, center, radiusX, radiusY, angle }) => (
                <ellipse
                  key={blob.id} className={`building-cloud-lobe building-volume-cloud volume-cloud ${blob.level}`}
                  cx={center.x} cy={center.y} rx={radiusX} ry={radiusY}
                  transform={`rotate(${angle.toFixed(1)} ${center.x.toFixed(1)} ${center.y.toFixed(1)})`}
                  fill={`url(#${markerId}-cloud-${svgToken(blob.id)})`}
                  data-world-x={blob.x.toFixed(2)} data-world-y={blob.y.toFixed(2)} data-world-z={blob.z.toFixed(2)} data-depth={center.depth.toFixed(4)}
                />
              ))}
            </g>

            {!editing && experimentalSensorCoverage && (
              <ExperimentalSensorCoverage3D house={house} assessment={experimentalSensorCoverage} project={project} />
            )}

            {!editing && spatialLayerSnapshots.length > 0 && (
              <SpatialLayerOverlay3D house={house} snapshots={spatialLayerSnapshots} topology={spatialLayerTopology} project={project} />
            )}

            {airflowPaths.length > 0 && <g className="building-volume-flows building-simulated-airflow" role="img" aria-label={airflowAria}>
              <title>{airflowAria}</title>
              {airflowPaths.map((flow) => {
                const projected = flow.points.map((point) => project(point));
                const path = smoothProjectedAirflowPath(projected);
                const fromPoint = flow.points[0]!;
                const toPoint = flow.points.at(-1)!;
                return (
                  <g
                    key={flow.id}
                    className={`building-volume-vector volume-flow-vector simulated-volume-flow ${flow.hasVerticalComponent ? "has-z" : "planar"}`}
                    aria-hidden="true"
                    data-floor-id={flow.floorId}
                    data-from-z={fromPoint.z.toFixed(3)} data-to-z={toPoint.z.toFixed(3)}
                    data-from-x={fromPoint.x.toFixed(2)} data-to-x={toPoint.x.toFixed(2)} data-from-y={fromPoint.y.toFixed(2)} data-to-y={toPoint.y.toFixed(2)}
                    data-dx={(toPoint.x - fromPoint.x).toFixed(3)} data-dy={(toPoint.y - fromPoint.y).toFixed(3)} data-dz={(toPoint.z - fromPoint.z).toFixed(3)}
                    data-relative-speed={flow.relativeSpeed.toFixed(3)} data-support={flow.support.toFixed(3)}
                  >
                    <path d={path} className="building-flow-path simulated-building-flow-path" markerEnd={`url(#${markerId}-airflow${flow.hasVerticalComponent ? "-vertical" : ""})`} />
                    {!reducedMotion && <circle r="4.5" className="building-flow-particle simulated-flow-particle"><animateMotion dur="3.4s" repeatCount="indefinite" path={path} /></circle>}
                  </g>
                );
              })}
            </g>}

            {activeGradientFlows.length > 0 && <g className="building-volume-flows building-gradient-flows" aria-label={t("twin.flow")}>
              {activeGradientFlows.map((flow, index) => {
                const from = project(flow.from);
                const to = project(flow.to);
                const path = `M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
                const dx = flow.to.x - flow.from.x;
                const dy = flow.to.y - flow.from.y;
                const dz = flow.to.z - flow.from.z;
                const label = t("twin.gradientAria", {
                  from: formatMeasurement(flow.from.value, definition, units),
                  to: formatMeasurement(flow.to.value, definition, units),
                  difference: formatMeasurementDelta(flow.difference, definition, units),
                });
                return (
                  <g
                    key={flow.id} className={`building-volume-vector volume-flow-vector ${flow.hasVerticalComponent ? "has-z" : "planar"}`}
                    role="img" aria-label={label} data-from-z={flow.from.z.toFixed(3)} data-to-z={flow.to.z.toFixed(3)}
                    data-from-x={flow.from.x.toFixed(2)} data-to-x={flow.to.x.toFixed(2)} data-from-y={flow.from.y.toFixed(2)} data-to-y={flow.to.y.toFixed(2)}
                    data-dx={dx.toFixed(3)} data-dy={dy.toFixed(3)} data-dz={dz.toFixed(3)}
                  >
                    <title>{label}</title>
                    <path d={path} className="building-flow-path" markerEnd={`url(#${markerId}${flow.hasVerticalComponent ? "-vertical" : ""})`} />
                    {!reducedMotion && <circle r="4.5" className="building-flow-particle"><animateMotion dur={`${2.7 + index * .22}s`} repeatCount="indefinite" path={path} /></circle>}
                  </g>
                );
              })}
            </g>}

            <g className="building-observations">
              {observations.filter((observation) => observation.x != null && observation.y != null).map((observation) => {
                const model = floorModels.find((item) => item.floor.id === observation.floorId);
                if (!model) return null;
                const position = project({ x: observation.x!, y: observation.y!, z: model.floor.elevation + .18 });
                const status = observation.status ?? "open";
                const label = t("building.observationAria", {
                  kind: observationName(observation), severity: t(`alerts.${observation.severity}`), floor: model.floor.name, note: observation.note,
                  status: t(`observations.status.${status}`),
                });
                return (
                  <g key={observation.id} transform={`translate(${position.x} ${position.y})`} className={`building-observation ${observation.severity} ${status}`} role="img" aria-label={label}>
                    <title>{label}</title><path d="M0-15C-8-15-14-9-14-1C-14 9 0 19 0 19S14 9 14-1C14-9 8-15 0-15Z" /><text textAnchor="middle" y="3">{status === "resolved" ? "✓" : "!"}</text>
                  </g>
                );
              })}
            </g>

            <g className="building-sensors">
              {renderedSensors.flatMap(({ sensor, model, position, anchor }) => {
                const measurements = sensorMeasurements[sensor.id] ?? {};
                const energyDevice = isEnergyDeviceSensor(sensor, measurements);
                if (!energyDevice && !climateSensorMarkersVisible && !editing) return [];
                if (energyDevice && !energyDevicesVisible && !editing) return [];
                const energyStats = energyDeviceMapStats(measurements, [definition], units);
                const rawSample = energyDevice ? energyStats.power ?? energyStats.energy ?? undefined : samples[sensor.id];
                const fresh = isSpatialSampleFresh(rawSample, freshness);
                const sampleValue = !energyDevice && fresh ? measurementValue(rawSample, definition.id) : null;
                const value = energyDevice
                  ? energyStats.short ?? t("twin.noEnergyStats")
                  : sampleValue == null ? t("common.noData") : formatMeasurement(sampleValue, definition, units);
                const selected = sensor.id === selectedSensorId;
                const status = !fresh
                  ? t("building.statusStale")
                  : rawSample?.quality === "estimated"
                    ? t("building.statusEstimated")
                    : t("building.statusCurrent");
                const height = relativeSensorHeight(sensor, model.floor.elevation);
                const label = energyDevice
                  ? t("building.energySensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), stats: value, status })
                  : t("building.sensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), metric: metricLabel, value, status });
                return (
                  <g
                    key={sensor.id} transform={`translate(${position.x} ${position.y})`} className={`building-sensor ${energyDevice ? "energy-device" : ""} ${selected ? "selected" : ""} ${!fresh ? "stale" : ""}`}
                    data-map-layer={energyDevice ? "energy-devices" : "sensors"}
                    role="button" tabIndex={0} aria-pressed={selected} aria-label={label}
                    onClick={(event) => selectSensor(event, sensor)} onKeyDown={(event) => selectSensor(event, sensor)}
                  >
                    <title>{label}</title>
                    <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="sensor-tether" aria-hidden="true" />
                    <circle r="34" className="building-sensor-hit" aria-hidden="true" />
                    <circle r="19" className="building-sensor-ring" />
                    <circle r="14" className="building-sensor-core" filter={`url(#${markerId}-shadow)`} />
                    {energyDevice
                      ? <path d="M2-10L-6 1H-1L-4 10L7-4H2Z" className="building-sensor-energy-glyph" aria-hidden="true" />
                      : <text textAnchor="middle" y="4" className="building-sensor-value">{sampleValue == null ? "—" : toDisplayValue(sampleValue, definition, units).toFixed(definition.precision)}</text>}
                    <text x="22" y={energyDevice ? -7 : -2} className="building-sensor-name">{visualLabel(sensor.name)}</text>
                    {energyDevice && <text x="22" y="9" className="building-sensor-energy-stats">{energyStats.short ?? "—"}</text>}
                  </g>
                );
              })}
            </g>

            {editing && <g className="building-plan-elements building-plan-elements-editing">
              {orderedFloors.flatMap(({ floor }) => (floor.planElements ?? []).map((element, index) => renderArchitecturalElement(floor, element, index)))}
            </g>}

          </svg>
          {outdoor && <OutdoorConditionsBadge outdoor={outdoor} units={units} />}
        </div>
        <div className={`building-legend ${!editing && !mapInformationExpanded ? "collapsed" : ""}`}>
          {(editing || mapInformationExpanded) && <div id={mapInformationId} className="building-legend-content">
            {editing ? <span className="building-structure-sync">{t("building.structureSync")}</span> : <span>{!definition.spatialInterpolation
              ? t("building.noSpatial", { metric: metricLabel })
              : allValues.length > 0
                ? <><i className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />{t("twin.estimatedField", { metric: metricLabel })}: {formatMeasurement(heatMin, definition, units)} – {formatMeasurement(heatMax, definition, units)}</>
                : t("common.noData")}</span>}
            {!editing && airflowPaths.length > 0 && <span className="building-airflow-key experimental-layer-legend"><i className="volume-vector-key simulated" aria-hidden="true">↝</i><span><strong>{t("spatial.airflow.title")}</strong><small>{airflowDescription}</small></span></span>}
            {!editing && airflowPaths.length === 0 && definition.spatialInterpolation && activeGradientFlows.length > 0 && <span><i className="volume-vector-key" aria-hidden="true">↗</i>{t("building.xyzGradient")}</span>}
            {!editing && experimentalSensorCoverage && <span className="building-airflow-key coverage-layer-legend"><i className="volume-vector-key coverage" aria-hidden="true">◎</i><span><strong>{t("spatial.coverage.title")}</strong><small>{t("spatial.coverage.legend", { support: Math.round(experimentalSensorCoverage.coverageScore * 100) })}</small></span></span>}
            {!editing && spatialLayerSnapshots.length > 0 && <span className="building-airflow-key spatial-layer-legend"><i className="volume-vector-key" aria-hidden="true">⇢</i><span><strong>{t("spatial.title")}</strong><small>{t("spatial.inferenceDisclaimer")}</small></span></span>}
          </div>}
          {!editing && <MapInformationToggle
            controls={mapInformationId}
            expanded={mapInformationExpanded}
            onExpandedChange={setMapInformationExpanded}
          />}
        </div>
        {(editing || mapInformationExpanded) && <p className="building-help">{editing ? t("building.editElementHelp") : airflowPaths.length ? t("spatial.airflow.help3d") : t("building.help")}</p>}
      </div>
    );
}
