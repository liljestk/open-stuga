import {
  useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent,
} from "react";
import type { House, ManualObservation, MeasurementDefinition, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import {
  configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh, type SpatialFreshnessOptions,
} from "../spatialFreshness";
import {
  clampCameraOrbit, createVolumeClouds, estimateVolumeFlows, interpolateVolume, projectPoint3D,
  type CameraOrbit, type Point3D, type ProjectedPoint3D, type VolumeBounds, type VolumeCloudBlob,
} from "../spatialVolume";

interface BuildingSceneProps {
  house: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  activeFloorId: string;
  selectedSensorId: string | null;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  onFloorSelect: (floorId: string) => void;
  onSensorSelect: (sensorId: string, floorId: string) => void;
}

interface ProjectedCloud {
  blob: VolumeCloudBlob;
  center: ProjectedPoint3D;
  radiusX: number;
  radiusY: number;
  angle: number;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  camera: CameraOrbit;
  moved: boolean;
}

const VIEW_WIDTH = 1100;
const VIEW_HEIGHT = 720;
const DEFAULT_CEILING_HEIGHT_METRES = 2.8;
const DEFAULT_CAMERA: CameraOrbit = { yaw: -.68, pitch: .63, zoom: 1 };

function points(projected: ProjectedPoint3D[]): string {
  return projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function svgToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function relativeSensorHeight(sensor: Sensor, floorElevation: number): number {
  return sensor.z - floorElevation;
}

function visualLabel(value: string, maximumCharacters = 20): string {
  const characters = Array.from(value);
  return characters.length > maximumCharacters
    ? `${characters.slice(0, maximumCharacters - 1).join("")}…`
    : value;
}

function inferReferenceTime(samples: Record<string, MeasurementSample>): number {
  const timestamps = Object.values(samples).map((sample) => Date.parse(sample.timestamp)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Date.now();
}

function buildingBounds(house: House, sensors: Sensor[]): VolumeBounds {
  const ordered = [...house.floors].sort((a, b) => a.elevation - b.elevation);
  const minFloor = Math.min(0, ...ordered.map((floor) => floor.elevation));
  const top = ordered.at(-1);
  const topSensorHeight = top
    ? Math.max(0, ...sensors.filter((sensor) => sensor.floorId === top.id).map((sensor) => sensor.z - top.elevation))
    : 0;
  return {
    width: Math.max(1, ...ordered.map((floor) => floor.width)),
    depth: Math.max(1, ...ordered.map((floor) => floor.height)),
    minZ: Math.min(minFloor, ...sensors.map((sensor) => sensor.z)),
    maxZ: Math.max(
      minFloor + 1,
      top ? top.elevation + Math.max(DEFAULT_CEILING_HEIGHT_METRES, topSensorHeight + .7) : 1,
      ...sensors.map((sensor) => sensor.z + .4),
    ),
  };
}

function projectedCloud(
  blob: VolumeCloudBlob,
  project: (point: Point3D) => ProjectedPoint3D,
): ProjectedCloud {
  const center = project(blob);
  const axes = [
    project({ x: blob.x + blob.radiusX, y: blob.y, z: blob.z }),
    project({ x: blob.x, y: blob.y + blob.radiusY, z: blob.z }),
    project({ x: blob.x, y: blob.y, z: blob.z + blob.radiusZ }),
  ].map((point) => ({ x: point.x - center.x, y: point.y - center.y }));
  const xx = axes.reduce((sum, axis) => sum + axis.x ** 2, 0);
  const yy = axes.reduce((sum, axis) => sum + axis.y ** 2, 0);
  const xy = axes.reduce((sum, axis) => sum + axis.x * axis.y, 0);
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2));
  return {
    blob,
    center,
    radiusX: Math.max(7, Math.sqrt(Math.max(1, (trace + discriminant) / 2))),
    radiusY: Math.max(5, Math.sqrt(Math.max(1, (trace - discriminant) / 2))),
    angle: Math.atan2(2 * xy, xx - yy) * 90 / Math.PI,
  };
}

export function BuildingScene({
  house, sensors, samples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId,
  referenceTimeMs, maxSampleAgeMs, onFloorSelect, onSensorSelect,
}: BuildingSceneProps) {
  const { locale, t } = useI18n();
  const metricLabel = measurementLabel(definition, locale);
  const markerId = `building-flow-${useId().replace(/:/g, "")}`;
  const [camera, setCamera] = useState<CameraOrbit>(DEFAULT_CAMERA);
  const [reducedMotion, setReducedMotion] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const effectiveReferenceTimeMs = referenceTimeMs ?? inferReferenceTime(samples);
  const effectiveMaxAgeMs = maxSampleAgeMs ?? configuredSpatialMaxSampleAgeMs();
  const freshness: SpatialFreshnessOptions = useMemo(() => ({
    referenceTimeMs: effectiveReferenceTimeMs,
    maxSampleAgeMs: effectiveMaxAgeMs,
  }), [effectiveReferenceTimeMs, effectiveMaxAgeMs]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const bounds = useMemo(() => buildingBounds(house, sensors), [house, sensors]);
  const floorModels = useMemo(() => [...house.floors].sort((a, b) => a.elevation - b.elevation).map((floor) => {
    const floorSensors = sensors.filter((sensor) => sensor.floorId === floor.id && sensor.enabled);
    const values = floorSensors.flatMap((sensor) => {
      const sample = samples[sensor.id];
      const value = measurementValue(sample, definition.id);
      return isSpatialSampleFresh(sample, freshness) && value != null ? [value] : [];
    });
    return {
      floor,
      floorSensors,
      values,
      average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    };
  }), [house.floors, sensors, samples, definition.id, freshness]);

  const volume = useMemo(() => interpolateVolume(
    sensors, samples, definition, bounds, freshness, 11,
  ), [sensors, samples, definition, bounds, freshness]);
  const heatMin = colorDomain?.min ?? volume.min;
  const heatMax = colorDomain?.max ?? volume.max;
  const clouds = useMemo(() => createVolumeClouds(
    volume, definition, 24, { min: heatMin, max: heatMax },
  ), [volume, definition, heatMin, heatMax]);
  const flows = useMemo(() => estimateVolumeFlows(volume, definition, 11), [volume, definition]);
  const allValues = volume.anchors.map((anchor) => anchor.value);
  const project = (point: Point3D) => projectPoint3D(point, bounds, camera, {
    width: VIEW_WIDTH, height: VIEW_HEIGHT, padding: 72,
  });

  const projectedClouds = clouds.map((cloud) => projectedCloud(cloud, project))
    .sort((a, b) => a.center.depth - b.center.depth);
  const renderedSensors = sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
    const model = floorModels.find((item) => item.floor.id === sensor.floorId);
    if (!model) return [];
    const position = project(sensor);
    const anchor = project({ x: sensor.x, y: sensor.y, z: model.floor.elevation + .05 });
    return [{ sensor, model, position, anchor }];
  }).sort((a, b) => a.position.depth - b.position.depth);
  const orderedFloors = floorModels.map((model) => ({
    ...model,
    depth: project({ x: model.floor.width / 2, y: model.floor.height / 2, z: model.floor.elevation }).depth,
  })).sort((a, b) => a.depth - b.depth);

  const changeCamera = (patch: Partial<CameraOrbit>) => setCamera((current) => clampCameraOrbit({ ...current, ...patch }));
  const rotateCamera = (yaw: number, pitch: number) => setCamera((current) => clampCameraOrbit({
    ...current, yaw: current.yaw + yaw, pitch: current.pitch + pitch,
  }));
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    suppressClickRef.current = drag.moved;
    setCamera(clampCameraOrbit({
      ...drag.camera,
      yaw: drag.camera.yaw - dx * .008,
      pitch: drag.camera.pitch - dy * .006,
    }));
  };
  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const moved = dragRef.current.moved;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    if (moved) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    changeCamera({ zoom: camera.zoom * Math.exp(-event.deltaY * .0012) });
  };
  const activateFloor = (floorId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onFloorSelect(floorId);
  };
  const floorKeyDown = (event: KeyboardEvent<SVGGElement>, floorId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFloorSelect(floorId);
  };
  const selectSensor = (event: MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement>, sensor: Sensor) => {
    event.stopPropagation();
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    if (!("key" in event) && suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    event.preventDefault();
    onFloorSelect(sensor.floorId);
    onSensorSelect(sensor.id, sensor.floorId);
  };

  const observationName = (observation: ManualObservation) => t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}` as TranslationKey);

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
          <output className="sr-only building-camera-state" aria-live="polite">{t("building.cameraState", {
            yaw: Math.round(camera.yaw * 180 / Math.PI), pitch: Math.round(camera.pitch * 180 / Math.PI), zoom: camera.zoom.toFixed(2),
          })}</output>
        </div>
      </div>
      <div className="building-viewport">
        <svg
          className="building-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group"
          aria-label={t("building.aria", { house: house.name, floors: house.floors.length, sensors: sensors.filter((sensor) => sensor.enabled).length, metric: metricLabel })}
          data-camera-yaw={camera.yaw.toFixed(3)} data-camera-pitch={camera.pitch.toFixed(3)} data-camera-zoom={camera.zoom.toFixed(2)}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={onWheel}
        >
          <desc>{allValues.length
            ? t("building.volumeDescription", { metric: metricLabel })
            : definition.spatialInterpolation
              ? t("twin.estimateUnavailable", { metric: metricLabel })
              : t("building.noSpatial", { metric: metricLabel })}</desc>
          <defs>
            <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="building-arrow-head" /></marker>
            <marker id={`${markerId}-vertical`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="vertical-arrow-head" /></marker>
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

          <g className="building-floors">
            {orderedFloors.map(({ floor, floorSensors, average }) => {
              const z = floor.elevation;
              const surface = [project({ x: 0, y: 0, z }), project({ x: floor.width, y: 0, z }), project({ x: floor.width, y: floor.height, z }), project({ x: 0, y: floor.height, z })];
              const slabBottom = [project({ x: 0, y: 0, z: z - .12 }), project({ x: floor.width, y: 0, z: z - .12 }), project({ x: floor.width, y: floor.height, z: z - .12 }), project({ x: 0, y: floor.height, z: z - .12 })];
              const active = floor.id === activeFloorId;
              const averageLabel = average == null ? t("common.noData") : formatMeasurement(average, definition, units);
              const labelPoint = surface.reduce((best, point) => point.x > best.x ? point : best, surface[0]!);
              return (
                <g
                  key={floor.id} className={`building-floor ${active ? "active" : ""}`} role="button" tabIndex={0}
                  aria-pressed={active} aria-label={t("building.floorAria", { floor: floor.name, height: floor.elevation.toFixed(1), sensors: floorSensors.length, metric: metricLabel, value: averageLabel })}
                  onClick={() => activateFloor(floor.id)} onKeyDown={(event) => floorKeyDown(event, floor.id)}
                >
                  <polygon points={points([surface[1]!, surface[2]!, slabBottom[2]!, slabBottom[1]!])} className="floor-slab-side" />
                  <polygon points={points([surface[2]!, surface[3]!, slabBottom[3]!, slabBottom[2]!])} className="floor-slab-front" />
                  <polygon points={points(surface)} className="floor-surface" />
                  <g className="building-walls" aria-hidden="true">{floor.walls.map((wall) => {
                    const from = project({ x: wall.from.x, y: wall.from.y, z: z + .07 });
                    const to = project({ x: wall.to.x, y: wall.to.y, z: z + .07 });
                    return <line key={wall.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
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

          <g className="building-volume-flows" aria-label={t("twin.flow")}>
            {flows.map((flow, index) => {
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
          </g>

          <g className="building-observations">
            {observations.filter((observation) => observation.x != null && observation.y != null).map((observation) => {
              const model = floorModels.find((item) => item.floor.id === observation.floorId);
              if (!model) return null;
              const position = project({ x: observation.x!, y: observation.y!, z: model.floor.elevation + .18 });
              const label = t("building.observationAria", {
                kind: observationName(observation), severity: t(`alerts.${observation.severity}`), floor: model.floor.name, note: observation.note,
              });
              return (
                <g key={observation.id} transform={`translate(${position.x} ${position.y})`} className={`building-observation ${observation.severity}`} role="img" aria-label={label}>
                  <title>{label}</title><path d="M0-15C-8-15-14-9-14-1C-14 9 0 19 0 19S14 9 14-1C14-9 8-15 0-15Z" /><text textAnchor="middle" y="3">!</text>
                </g>
              );
            })}
          </g>

          <g className="building-sensors">
            {renderedSensors.map(({ sensor, model, position, anchor }) => {
              const rawSample = samples[sensor.id];
              const fresh = isSpatialSampleFresh(rawSample, freshness);
              const sampleValue = fresh ? measurementValue(rawSample, definition.id) : null;
              const value = sampleValue == null ? t("common.noData") : formatMeasurement(sampleValue, definition, units);
              const selected = sensor.id === selectedSensorId;
              const status = !fresh
                ? t("building.statusStale")
                : rawSample?.quality === "estimated"
                  ? t("building.statusEstimated")
                  : t("building.statusCurrent");
              const height = relativeSensorHeight(sensor, model.floor.elevation);
              const label = t("building.sensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), metric: metricLabel, value, status });
              return (
                <g
                  key={sensor.id} transform={`translate(${position.x} ${position.y})`} className={`building-sensor ${selected ? "selected" : ""} ${!fresh ? "stale" : ""}`}
                  role="button" tabIndex={0} aria-pressed={selected} aria-label={label}
                  onClick={(event) => selectSensor(event, sensor)} onKeyDown={(event) => selectSensor(event, sensor)}
                >
                  <title>{label}</title>
                  <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="sensor-tether" aria-hidden="true" />
                  <circle r="34" className="building-sensor-hit" aria-hidden="true" />
                  <circle r="19" className="building-sensor-ring" />
                  <circle r="14" className="building-sensor-core" filter={`url(#${markerId}-shadow)`} />
                  <text textAnchor="middle" y="4" className="building-sensor-value">{sampleValue == null ? "—" : toDisplayValue(sampleValue, definition, units).toFixed(definition.precision)}</text>
                  <text x="22" y="-2" className="building-sensor-name">{visualLabel(sensor.name)}</text>
                </g>
              );
            })}
          </g>

        </svg>
      </div>
      <div className="building-legend" aria-live="polite">
        <span>{!definition.spatialInterpolation
          ? t("building.noSpatial", { metric: metricLabel })
          : allValues.length > 0
            ? <><i className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />{t("twin.estimatedField", { metric: metricLabel })}: {formatMeasurement(heatMin, definition, units)} – {formatMeasurement(heatMax, definition, units)}</>
            : t("common.noData")}</span>
        {definition.spatialInterpolation && flows.length > 0 && <span><i className="volume-vector-key" aria-hidden="true">↗</i>{t("building.xyzGradient")}</span>}
      </div>
      <p className="building-help">{t("building.help")}</p>
    </div>
  );
}
