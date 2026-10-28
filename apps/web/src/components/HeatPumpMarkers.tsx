import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type {
  Floor,
  HeatPumpMode,
  HeatPumpState,
  MeasurementDefinition,
  MeasurementSample,
  Point,
  UnitSystem,
} from "@climate-twin/contracts";
import { estimateHeatPumpInfluence } from "../heatPumpImpact";
import {
  heatPumpMarkerReading,
  heatPumpName,
  heatPumpSensorId,
} from "../heatPumpPresentation";
import { measurementLabel } from "../measurements";
import { DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS } from "../spatialFreshness";
import { useI18n, type TranslationKey } from "../i18n";

interface ProjectedPoint { x: number; y: number }

const modeKeys = {
  auto: "heatPump.mode.auto",
  cool: "heatPump.mode.cool",
  dry: "heatPump.mode.dry",
  fan: "heatPump.mode.fan",
  heat: "heatPump.mode.heat",
} as const satisfies Record<HeatPumpMode, TranslationKey>;

function UnitGlyph({ compact = false }: { compact?: boolean }) {
  const width = compact ? 25 : 38;
  const height = compact ? 13 : 20;
  return <g className="heat-pump-glyph" aria-hidden="true">
    <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={compact ? 3 : 4} />
    <path d={compact ? "M-8 2H8M-6 6H6" : "M-13 3H13M-10 8H10"} />
  </g>;
}

function markerState(
  t: ReturnType<typeof useI18n>["t"],
  state: HeatPumpState,
  pending: boolean,
  fresh: boolean,
): string {
  if (pending) return t("heatPump.pending");
  if (!state.available) return t("heatPump.unavailable");
  if (!fresh) return t("building.statusStale");
  if (state.power === false) return t("heatPump.off");
  if (state.selectedMode) return t(modeKeys[state.selectedMode]);
  return state.power ? t("heatPump.on") : t("common.noData");
}

function markerLabel(
  t: ReturnType<typeof useI18n>["t"],
  locale: string,
  state: HeatPumpState,
  floor: Floor,
  pending: boolean,
  definition: MeasurementDefinition,
  reading: ReturnType<typeof heatPumpMarkerReading>,
): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const impact = estimateHeatPumpInfluence(state);
  return t("heatPump.markerMetricAria", {
    device: heatPumpName(state),
    floor: floor.name,
    state: markerState(t, state, pending, reading.fresh),
    metric: measurementLabel(definition, locale),
    value: reading.formatted,
    influence: t(`heatPump.influence.${impact.kind}`),
    evidence: impact.compressorEvidence && state.compressorFrequencyHz !== null
      ? t("heatPump.frequencyEvidence", { value: number.format(state.compressorFrequencyHz) })
      : t("heatPump.selectedModeEvidence"),
  });
}

function influenceStyle(intensity: number): CSSProperties {
  return { "--heat-pump-influence": intensity } as CSSProperties;
}


export function HeatPumpMarker2D({
  state,
  floor,
  scale,
  definition,
  sample,
  units,
  editing,
  pending,
  selected = false,
  influenceVisible,
  referenceTimeMs = Date.now(),
  maxSampleAgeMs = DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS,
  onSelect,
  onMove,
  onMoveFromClient,
}: {
  state: HeatPumpState;
  floor: Floor;
  scale: number;
  definition: MeasurementDefinition;
  sample?: MeasurementSample;
  units: UnitSystem;
  editing: boolean;
  pending: boolean;
  selected?: boolean;
  influenceVisible: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  onSelect?: (connectionId: string, floorId: string) => void;
  onMove?: (connectionId: string, point: Point) => void;
  onMoveFromClient?: (connectionId: string, clientX: number, clientY: number) => void;
}) {
  const { locale, t } = useI18n();
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const movable = editing && !pending && Boolean(onMove && onMoveFromClient);
  const selectable = Boolean(onSelect);
  const interactive = movable || selectable;
  const impact = estimateHeatPumpInfluence(state);
  const reading = heatPumpMarkerReading({ state, sample, definition, units, referenceTimeMs, maxSampleAgeMs, locale, noData: t("common.noData") });
  const label = markerLabel(t, locale, state, floor, pending, definition, reading);
  const status = markerState(t, state, pending, reading.fresh);
  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const keyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (movable && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? .5 : .1;
      onMove?.(state.connectionId, {
        x: Math.max(0, Math.min(floor.width, x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))),
        y: Math.max(0, Math.min(floor.height, y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))),
      });
      return;
    }
    if (selectable && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      onSelect?.(state.connectionId, floor.id);
    }
  };
  const pointerUp = (event: PointerEvent<SVGGElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || start.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4;
    if (moved && movable) onMoveFromClient?.(state.connectionId, event.clientX, event.clientY);
    else if (!moved) onSelect?.(state.connectionId, floor.id);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <g
    transform={`translate(${x * scale} ${y * scale})`}
    className={`heat-pump-marker ${impact.kind} ${selected ? "selected" : ""} ${!state.available ? "unavailable" : !reading.fresh ? "stale" : ""} ${pending ? "pending" : ""} ${movable ? "movable" : ""} ${selectable ? "selectable" : ""}`}
    data-map-layer="heat-pumps"
    data-sensor-id={heatPumpSensorId(state.connectionId)}
    role={interactive ? "button" : "img"}
    tabIndex={interactive ? 0 : undefined}
    aria-label={label}
    aria-pressed={selectable ? selected : undefined}
    style={influenceStyle(impact.intensity)}
    onKeyDown={keyDown}
    onPointerDown={(event) => {
      if (!interactive) return;
      event.preventDefault();
      event.stopPropagation();
      pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerUp={pointerUp}
    onPointerCancel={() => { pointerStart.current = null; }}
    onLostPointerCapture={() => { pointerStart.current = null; }}
  >
    {influenceVisible && impact.visible && <g className={`heat-pump-influence ${impact.compressorEvidence ? "reported" : "inferred"}`} aria-hidden="true">
      <ellipse rx="92" ry="58" />
      <ellipse rx="58" ry="35" />
    </g>}
    <circle r="56" className="heat-pump-hit" aria-hidden="true" />
    <circle r="28" className="heat-pump-ring" />
    <circle r="21" className="heat-pump-core" />
    {reading.value === null ? <UnitGlyph compact /> : <text y="5" textAnchor="middle" className="heat-pump-value">{reading.compact}</text>}
    <text y="44" textAnchor="middle" className="heat-pump-state">{status}</text>
    <text y="59" textAnchor="middle" className="heat-pump-name">{heatPumpName(state)}</text>
  </g>;
}

export function HeatPumpMarker3D({
  state,
  floor,
  position,
  anchor,
  definition,
  sample,
  units,
  activeFloor,
  selected = false,
  influenceVisible,
  referenceTimeMs = Date.now(),
  maxSampleAgeMs = DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS,
  onSelect,
}: {
  state: HeatPumpState;
  floor: Floor;
  position: ProjectedPoint;
  anchor: ProjectedPoint;
  definition: MeasurementDefinition;
  sample?: MeasurementSample;
  units: UnitSystem;
  activeFloor: boolean;
  selected?: boolean;
  influenceVisible: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  onSelect?: (connectionId: string, floorId: string) => void;
}) {
  const { locale, t } = useI18n();
  const impact = estimateHeatPumpInfluence(state);
  const reading = heatPumpMarkerReading({ state, sample, definition, units, referenceTimeMs, maxSampleAgeMs, locale, noData: t("common.noData") });
  const label = markerLabel(t, locale, state, floor, false, definition, reading);
  const status = markerState(t, state, false, reading.fresh);
  return <g
    transform={`translate(${position.x} ${position.y})`}
    className={`building-heat-pump heat-pump-marker ${impact.kind} ${selected ? "selected" : ""} ${!state.available ? "unavailable" : !reading.fresh ? "stale" : ""} ${activeFloor ? "active-floor" : ""} ${onSelect ? "selectable" : ""}`}
    data-map-layer="heat-pumps"
    data-sensor-id={heatPumpSensorId(state.connectionId)}
    role={onSelect ? "button" : "img"}
    tabIndex={onSelect ? 0 : undefined}
    aria-pressed={onSelect ? selected : undefined}
    aria-label={label}
    style={influenceStyle(impact.intensity)}
    onClick={onSelect ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(state.connectionId, floor.id);
    } : undefined}
    onKeyDown={onSelect ? (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(state.connectionId, floor.id);
    } : undefined}
  >
    {influenceVisible && impact.visible && <g className={`heat-pump-influence heat-pump-influence-3d ${impact.compressorEvidence ? "reported" : "inferred"}`} aria-hidden="true">
      <ellipse rx="75" ry="26" />
      <path d="M-55 0Q0 34 55 0" />
    </g>}
    <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="heat-pump-tether" aria-hidden="true" />
    <circle r="34" className="heat-pump-hit" aria-hidden="true" />
    <circle r="20" className="heat-pump-ring" />
    <circle r="15" className="heat-pump-core" />
    {reading.value === null ? <UnitGlyph compact /> : <text y="4" textAnchor="middle" className="heat-pump-value compact">{reading.compact}</text>}
    <text x="23" y="-4" className="heat-pump-name">{heatPumpName(state)}</text>
    <text x="23" y="11" className="heat-pump-state">{status}</text>
  </g>;
}
