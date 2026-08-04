import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Floor, HeatPumpState, Point } from "@climate-twin/contracts";
import { estimateHeatPumpInfluence } from "../heatPumpImpact";
import { useI18n, type TranslationKey } from "../i18n";

interface ProjectedPoint { x: number; y: number }

function unitName(state: HeatPumpState): string {
  return state.name ?? ([state.brand, state.model].filter(Boolean).join(" ") || "Gree/Wilfa");
}

function UnitGlyph({ compact = false }: { compact?: boolean }) {
  const width = compact ? 25 : 38;
  const height = compact ? 13 : 20;
  return <g className="heat-pump-glyph" aria-hidden="true">
    <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={compact ? 3 : 4} />
    <path d={compact ? "M-8 2H8M-6 6H6" : "M-13 3H13M-10 8H10"} />
  </g>;
}

function markerLabel(
  t: ReturnType<typeof useI18n>["t"],
  locale: string,
  state: HeatPumpState,
  floor: Floor,
  pending: boolean,
): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const impact = estimateHeatPumpInfluence(state);
  return t("heatPump.markerAria", {
    device: unitName(state),
    floor: floor.name,
    state: t(pending ? "heatPump.pending" : !state.available ? "heatPump.unavailable" : state.power ? "heatPump.on" : "heatPump.off"),
    mode: state.selectedMode ? t(`setup.greeMode${state.selectedMode[0]!.toUpperCase()}${state.selectedMode.slice(1)}` as TranslationKey) : t("common.noData"),
    current: state.currentTemperatureC === null ? t("common.noData") : `${number.format(state.currentTemperatureC)} °C`,
    target: state.targetTemperatureC === null ? t("common.noData") : `${number.format(state.targetTemperatureC)} °C`,
    influence: t(`heatPump.influence.${impact.kind}` as TranslationKey),
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
  editing,
  pending,
  influenceVisible,
  onMove,
  onMoveFromClient,
}: {
  state: HeatPumpState;
  floor: Floor;
  scale: number;
  editing: boolean;
  pending: boolean;
  influenceVisible: boolean;
  onMove?: (connectionId: string, point: Point) => void;
  onMoveFromClient?: (connectionId: string, clientX: number, clientY: number) => void;
}) {
  const { locale, t } = useI18n();
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const movable = editing && !pending && Boolean(onMove && onMoveFromClient);
  const impact = estimateHeatPumpInfluence(state);
  const label = markerLabel(t, locale, state, floor, pending);
  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const keyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (!movable || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? .5 : .1;
    onMove?.(state.connectionId, {
      x: Math.max(0, Math.min(floor.width, x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))),
      y: Math.max(0, Math.min(floor.height, y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))),
    });
  };
  const pointerUp = (event: PointerEvent<SVGGElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || start.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4) {
      onMoveFromClient?.(state.connectionId, event.clientX, event.clientY);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <g
    transform={`translate(${x * scale} ${y * scale})`}
    className={`heat-pump-marker ${impact.kind} ${!state.available ? "unavailable" : ""} ${pending ? "pending" : ""} ${movable ? "movable" : ""}`}
    data-map-layer="heat-pumps"
    role={movable ? "button" : "img"}
    tabIndex={movable ? 0 : undefined}
    aria-label={label}
    aria-disabled={pending || undefined}
    style={influenceStyle(impact.intensity)}
    onKeyDown={keyDown}
    onPointerDown={(event) => {
      if (!movable) return;
      event.preventDefault();
      event.stopPropagation();
      pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerUp={pointerUp}
    onPointerCancel={() => { pointerStart.current = null; }}
    onLostPointerCapture={() => { pointerStart.current = null; }}
  >
    <title>{label}</title>
    {influenceVisible && impact.visible && <g className={`heat-pump-influence ${impact.compressorEvidence ? "reported" : "inferred"}`} aria-hidden="true">
      <ellipse rx="92" ry="58" />
      <ellipse rx="58" ry="35" />
    </g>}
    <circle r="48" className="heat-pump-hit" aria-hidden="true" />
    <circle r="27" className="heat-pump-ring" />
    <circle r="21" className="heat-pump-core" />
    <UnitGlyph />
    <text y="45" textAnchor="middle" className="heat-pump-state">{t(`heatPump.influence.${impact.kind}` as TranslationKey)}</text>
    <text y="60" textAnchor="middle" className="heat-pump-name">{unitName(state)}</text>
  </g>;
}

export function HeatPumpMarker3D({
  state,
  floor,
  position,
  anchor,
  activeFloor,
  influenceVisible,
}: {
  state: HeatPumpState;
  floor: Floor;
  position: ProjectedPoint;
  anchor: ProjectedPoint;
  activeFloor: boolean;
  influenceVisible: boolean;
}) {
  const { locale, t } = useI18n();
  const impact = estimateHeatPumpInfluence(state);
  const label = markerLabel(t, locale, state, floor, false);
  return <g
    transform={`translate(${position.x} ${position.y})`}
    className={`building-heat-pump heat-pump-marker ${impact.kind} ${!state.available ? "unavailable" : ""} ${activeFloor ? "active-floor" : ""}`}
    data-map-layer="heat-pumps"
    role="img"
    aria-label={label}
    style={influenceStyle(impact.intensity)}
  >
    <title>{label}</title>
    {influenceVisible && impact.visible && <g className={`heat-pump-influence heat-pump-influence-3d ${impact.compressorEvidence ? "reported" : "inferred"}`} aria-hidden="true">
      <ellipse rx="75" ry="26" />
      <path d="M-55 0Q0 34 55 0" />
    </g>}
    <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="heat-pump-tether" aria-hidden="true" />
    <circle r="31" className="heat-pump-hit" aria-hidden="true" />
    <circle r="19" className="heat-pump-ring" />
    <circle r="15" className="heat-pump-core" />
    <UnitGlyph compact />
    <text x="23" y="-4" className="heat-pump-name">{unitName(state)}</text>
    <text x="23" y="11" className="heat-pump-state">{t(`heatPump.influence.${impact.kind}` as TranslationKey)}</text>
  </g>;
}
