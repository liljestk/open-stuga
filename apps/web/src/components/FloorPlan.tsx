import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ImagePlus, MapPinPlus, PenLine, Trash2 } from "lucide-react";
import type { Floor, ManualObservation, MeasurementDefinition, MeasurementSample, Point, Sensor, UnitSystem, Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../spatialField";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../spatialFreshness";

export { heatColor, interpolateHeat } from "../spatialField";

interface FloorPlanProps {
  floor: Floor;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  editing: boolean;
  observationPlacement: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  onSensorSelect: (sensorId: string) => void;
  onSensorMove: (sensorId: string, point: Point) => void;
  onFloorChange: (floor: Floor) => void;
  onObservationPoint: (point: Point) => void;
  onCancelObservationPlacement: () => void;
}

export function floorRenderScale(floorWidth: number): number {
  return 1000 / Math.max(floorWidth, 1);
}

export function FloorPlan({
  floor, sensors, samples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing,
  observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement,
  referenceTimeMs, maxSampleAgeMs,
}: FloorPlanProps) {
  const { locale, t } = useI18n();
  const metricLabel = measurementLabel(definition, locale);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragging = useRef<string | null>(null);
  const mapHelpId = useId();
  const fieldId = `floor-field-${useId().replace(/:/g, "")}`;
  const [drawingWall, setDrawingWall] = useState(false);
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [keyboardPoint, setKeyboardPoint] = useState<Point>({ x: floor.width / 2, y: floor.height / 2 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const renderScale = floorRenderScale(floor.width);
  const renderWidth = floor.width * renderScale;
  const renderHeight = floor.height * renderScale;
  const resolvedReferenceTimeMs = referenceTimeMs ?? Date.now();
  const spatialFreshness = useMemo(() => ({
    referenceTimeMs: resolvedReferenceTimeMs,
    maxSampleAgeMs: maxSampleAgeMs ?? configuredSpatialMaxSampleAgeMs(),
  }), [resolvedReferenceTimeMs, maxSampleAgeMs]);
  const renderSensors = useMemo(() => sensors.map((sensor) => ({ ...sensor, x: sensor.x * renderScale, y: sensor.y * renderScale })), [sensors, renderScale]);
  const heat = useMemo(
    () => interpolateHeat(renderSensors, samples, definition, renderWidth, renderHeight, 25, spatialFreshness),
    [renderSensors, samples, definition, renderWidth, renderHeight, spatialFreshness],
  );
  const visualDomain = colorDomain ?? heat;
  const clouds = useMemo(() => createCloudLobes(heat, definition, 11, visualDomain), [heat, definition, visualDomain.min, visualDomain.max]);
  const flows = useMemo(() => estimateFieldFlows(heat, definition, 7), [heat, definition]);
  const transform = viewMode === "isometric" ? `translate(${renderWidth * .15} ${renderHeight * .02}) skewY(-12) scale(.82 .88)` : undefined;
  const keyboardPlacementActive = viewMode === "plan" && (observationPlacement || (editing && drawingWall));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!keyboardPlacementActive) return;
    const selected = sensors.find((sensor) => sensor.id === selectedSensorId);
    setKeyboardPoint(selected ? { x: selected.x, y: selected.y } : { x: floor.width / 2, y: floor.height / 2 });
    const timer = window.setTimeout(() => svgRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [keyboardPlacementActive, floor.id]);

  const roomName = (kind: string | undefined, fallback: string) => {
    const key = `room.${kind ?? ""}` as TranslationKey;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const pointFromEvent = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current!;
    const matrix = svg.getScreenCTM();
    if (matrix) {
      const screenPoint = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
      return {
        x: clamp(screenPoint.x / renderScale, 0, floor.width),
        y: clamp(screenPoint.y / renderScale, 0, floor.height),
      };
    }
    const bounds = svg.getBoundingClientRect();
    return {
      x: clamp((clientX - bounds.left) / bounds.width * floor.width, 0, floor.width),
      y: clamp((clientY - bounds.top) / bounds.height * floor.height, 0, floor.height),
    };
  };

  const mapPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (viewMode !== "plan") return;
    const point = pointFromEvent(event.clientX, event.clientY);
    setKeyboardPoint(point);
    if (observationPlacement) {
      onObservationPoint(point);
      return;
    }
    if (!editing || !drawingWall) return;
    if (!wallStart) {
      setWallStart(point);
      return;
    }
    const wall: Wall = { id: crypto.randomUUID(), from: wallStart, to: point };
    onFloorChange({ ...floor, walls: [...floor.walls, wall] });
    setWallStart(null);
  };

  const mapKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!keyboardPlacementActive) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setWallStart(null);
      if (observationPlacement) onCancelObservationPlacement();
      else setDrawingWall(false);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const multiplier = event.shiftKey ? 5 : 1;
      const xStep = floor.width / 100 * multiplier;
      const yStep = floor.height / 100 * multiplier;
      setKeyboardPoint((current) => ({
        x: clamp(current.x + (event.key === "ArrowRight" ? xStep : event.key === "ArrowLeft" ? -xStep : 0), 0, floor.width),
        y: clamp(current.y + (event.key === "ArrowDown" ? yStep : event.key === "ArrowUp" ? -yStep : 0), 0, floor.height),
      }));
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (observationPlacement) {
      onObservationPoint(keyboardPoint);
      return;
    }
    if (!wallStart) setWallStart(keyboardPoint);
    else {
      const wall: Wall = { id: crypto.randomUUID(), from: wallStart, to: keyboardPoint };
      onFloorChange({ ...floor, walls: [...floor.walls, wall] });
      setWallStart(null);
    }
  };

  const startSensorDrag = (event: ReactPointerEvent<SVGGElement>, sensorId: string) => {
    event.stopPropagation();
    onSensorSelect(sensorId);
    if (!editing || viewMode !== "plan") return;
    dragging.current = sensorId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveSensor = (event: ReactPointerEvent<SVGGElement>, sensorId: string) => {
    if (dragging.current !== sensorId) return;
    onSensorMove(sensorId, pointFromEvent(event.clientX, event.clientY));
  };

  const sensorKeyDown = (event: KeyboardEvent<SVGGElement>, sensor: Sensor) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onSensorSelect(sensor.id);
      return;
    }
    if (!editing || viewMode !== "plan" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? floor.width / 20 : floor.width / 100;
    onSensorMove(sensor.id, {
      x: clamp(sensor.x + (event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0), 0, floor.width),
      y: clamp(sensor.y + (event.key === "ArrowDown" ? distance : event.key === "ArrowUp" ? -distance : 0), 0, floor.height),
    });
  };

  const uploadBackground = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setUploadError(null);
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      setUploadError(t("twin.uploadInvalid"));
      event.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(t("twin.uploadTooLarge"));
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => onFloorChange({ ...floor, backgroundImage: String(reader.result) }));
    reader.addEventListener("error", () => setUploadError(t("twin.uploadInvalid")));
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const legendMin = formatMeasurement(visualDomain.min, definition, units);
  const legendMax = formatMeasurement(visualDomain.max, definition, units);

  return (
    <div className="floor-plan-wrap">
      {editing && (
        <div className="editor-toolbar" aria-label={t("common.edit")}>
          <button type="button" className={drawingWall ? "tool-button active" : "tool-button"} aria-pressed={drawingWall} onClick={() => { setDrawingWall((value) => !value); setWallStart(null); }}>
            <PenLine size={16} aria-hidden="true" />{drawingWall ? t("twin.stopDrawing") : t("twin.drawWall")}
          </button>
          <button type="button" className="tool-button" onClick={() => fileRef.current?.click()}><ImagePlus size={16} aria-hidden="true" />{t("twin.uploadPlan")}</button>
          <input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} aria-label={t("twin.uploadPlan")} />
          {floor.backgroundImage && <button type="button" className="tool-button" onClick={() => { const { backgroundImage: _, ...rest } = floor; onFloorChange(rest); }}><Trash2 size={16} aria-hidden="true" />{t("twin.removePlan")}</button>}
          <span className="editor-hint">{drawingWall ? (wallStart ? t("twin.wallEnd") : t("twin.wallStart")) : t("twin.dragHint")}</span>
          {uploadError && <span className="editor-error" role="alert">{uploadError}</span>}
        </div>
      )}
      {observationPlacement && <div className="placement-banner" role="status"><MapPinPlus size={17} aria-hidden="true" /><span>{t("observations.locationHint")}<small>{t("twin.keyboardPlacement")}</small></span></div>}
      <div className={`plan-stage ${viewMode === "isometric" ? "isometric" : ""}`}>
        <svg
          ref={svgRef}
          className="floor-plan"
          viewBox={`0 0 ${renderWidth} ${renderHeight}`}
          role="group"
          aria-label={t("twin.ariaMap", { metric: metricLabel, floor: floor.name })}
          aria-describedby={keyboardPlacementActive ? mapHelpId : undefined}
          tabIndex={keyboardPlacementActive ? 0 : undefined}
          onPointerDown={mapPointerDown}
          onKeyDown={mapKeyDown}
        >
          <desc>{clouds.length
            ? t("twin.estimatedFieldDescription", { metric: metricLabel })
            : definition.spatialInterpolation
              ? t("twin.estimateUnavailable", { metric: metricLabel })
              : t("building.noSpatial", { metric: metricLabel })}</desc>
          <defs>
            <clipPath id={`${fieldId}-clip`}><rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" /></clipPath>
            <filter id={`${fieldId}-soften`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="7" /></filter>
            <marker id={`${fieldId}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="flow-arrow-head" /></marker>
            <filter id={`${fieldId}-sensor-shadow`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="5" stdDeviation="6" floodOpacity=".22" /></filter>
            {clouds.map((cloud) => (
              <radialGradient key={`${cloud.id}-gradient`} id={`${fieldId}-${cloud.id}`}>
                <stop offset="0" stopColor={cloud.color} stopOpacity={Math.min(.82, cloud.opacity + .34)} />
                <stop offset="52%" stopColor={cloud.color} stopOpacity={cloud.opacity} />
                <stop offset="100%" stopColor={cloud.color} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>
          <g transform={transform} className="plan-transform">
            <rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" className="plan-base" />
            {viewMode === "isometric" && <path d={`M0 ${renderHeight} L${renderWidth} ${renderHeight} L${renderWidth} ${renderHeight + 38} L0 ${renderHeight + 38}Z`} className="floor-edge" />}
            {floor.backgroundImage && <image href={floor.backgroundImage} x="0" y="0" width={renderWidth} height={renderHeight} preserveAspectRatio="xMidYMid slice" className="plan-background" />}
            <g filter={`url(#${fieldId}-soften)`} clipPath={`url(#${fieldId}-clip)`} className="heat-field heat-clouds" aria-hidden="true">
              {clouds.map((cloud) => <ellipse key={cloud.id} cx={cloud.x} cy={cloud.y} rx={cloud.rx} ry={cloud.ry} fill={`url(#${fieldId}-${cloud.id})`} className={`heat-cloud-lobe ${cloud.level}`} />)}
            </g>
            <g className="rooms" aria-hidden="true">
              {floor.rooms.map((room) => {
                const centerX = room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length * renderScale;
                const centerY = room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length * renderScale;
                return <text key={room.id} x={centerX} y={centerY} textAnchor="middle">{roomName(room.kind, room.name)}</text>;
              })}
            </g>
            <g className="walls" aria-hidden="true">
              {floor.walls.map((wall) => <line key={wall.id} x1={wall.from.x * renderScale} y1={wall.from.y * renderScale} x2={wall.to.x * renderScale} y2={wall.to.y * renderScale} />)}
              {wallStart && <circle cx={wallStart.x * renderScale} cy={wallStart.y * renderScale} r="8" className="wall-start" />}
            </g>
            <g className="flow-layer" aria-label={t("twin.flow")}>
              {flows.map(({ id, from, to, difference }, index) => {
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
                    {!reducedMotion && <circle r="5" className="flow-particle"><animateMotion dur={`${2.8 + index * .32}s`} repeatCount="indefinite" path={path} /></circle>}
                  </g>
                );
              })}
            </g>
            <g className="observations-layer">
              {observations.filter((item) => item.x != null && item.y != null).map((item) => (
                <g key={item.id} transform={`translate(${item.x! * renderScale} ${item.y! * renderScale})`} className={`observation-marker ${item.severity}`} aria-label={`${t(`observations.${item.kind === "note" ? "noteKind" : item.kind}`)}: ${item.note}`}>
                  <path d="M0-18C-10-18-17-11-17-2C-17 10 0 23 0 23S17 10 17-2C17-11 10-18 0-18Z" />
                  <circle cy="-3" r="5" />
                </g>
              ))}
            </g>
            {keyboardPlacementActive && (
              <g transform={`translate(${keyboardPoint.x * renderScale} ${keyboardPoint.y * renderScale})`} className="placement-cursor" aria-hidden="true">
                <circle r="15" />
                <line x1="-22" x2="22" y1="0" y2="0" />
                <line x1="0" x2="0" y1="-22" y2="22" />
              </g>
            )}
            <g className="sensors-layer">
              {sensors.filter((sensor) => sensor.enabled).map((sensor) => {
                const sample = samples[sensor.id];
                const quality = !sample
                  ? null
                  : isSpatialSampleFresh(sample, spatialFreshness)
                    ? sample.quality
                    : "stale";
                const value = quality === "stale" ? undefined : measurementValue(sample, definition.id);
                const qualityLabel = quality === "stale"
                  ? t("building.statusStale")
                  : quality === "estimated"
                    ? t("building.statusEstimated")
                    : null;
                const selected = sensor.id === selectedSensorId;
                return (
                  <g
                    key={sensor.id}
                    transform={`translate(${sensor.x * renderScale} ${sensor.y * renderScale})`}
                    className={`sensor-marker ${selected ? "selected" : ""} ${editing ? "movable" : ""} ${quality ?? ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${sensor.name}, ${metricLabel}, ${value == null ? t("common.noData") : formatMeasurement(value, definition, units)}${qualityLabel ? `, ${qualityLabel}` : ""}`}
                    aria-pressed={selected}
                    onPointerDown={(event) => startSensorDrag(event, sensor.id)}
                    onPointerMove={(event) => moveSensor(event, sensor.id)}
                    onPointerUp={() => { dragging.current = null; }}
                    onKeyDown={(event) => sensorKeyDown(event, sensor)}
                  >
                    <circle r="28" className="sensor-halo" />
                    <circle r="21" className="sensor-core" filter={`url(#${fieldId}-sensor-shadow)`} />
                    <circle r="4" cy="-6" className="sensor-dot" />
                    <text y="9" textAnchor="middle" className="sensor-value">{value == null ? "—" : toDisplayValue(value, definition, units).toFixed(definition.precision)}</text>
                    <text y="45" textAnchor="middle" className="sensor-label">{sensor.name}</text>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        {clouds.length > 0 && <div className="heat-legend" aria-label={`${t("twin.estimatedField", { metric: metricLabel })}: ${legendMin} – ${legendMax}`}>
          <strong className="heat-legend-title">{t("twin.estimatedField", { metric: metricLabel })}</strong>
          <span>{t("twin.heatLegendLow")}</span>
          <span className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />
          <span>{t("twin.heatLegendHigh")}</span>
          <strong>{legendMin}</strong><strong>{legendMax}</strong>
        </div>}
        {flows.length > 0 && <div className="flow-legend"><span className="flow-sample" aria-hidden="true">→</span><span><strong>{t("twin.flow")}</strong><small>{t("twin.flowDescription")}</small></span></div>}
      </div>
      <span id={mapHelpId} className="sr-only">{t("twin.keyboardPlacement")}</span>
    </div>
  );
}
