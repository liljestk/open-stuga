import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { ConnectedDeviceState, Floor, Point } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";

interface ProjectedPoint {
  x: number;
  y: number;
}

function deviceColor(device: ConnectedDeviceState): CSSProperties | undefined {
  if (!device.power || !device.color) return undefined;
  return {
    "--connected-device-color": `hsl(${device.color.hue} ${device.color.saturation}% ${Math.max(38, device.color.value)}%)`,
  } as CSSProperties;
}

function DeviceGlyph({ kind, compact = false }: {
  kind: ConnectedDeviceState["kind"];
  compact?: boolean;
}) {
  if (kind === "light") {
    return <g className="connected-device-glyph" aria-hidden="true">
      <path d={compact ? "M0-9A7 7 0 0 0-4 4L-3 7H3L4 4A7 7 0 0 0 0-9Z" : "M0-15A11 11 0 0 0-6 6L-5 11H5L6 6A11 11 0 0 0 0-15Z"} />
      <line x1={compact ? -3 : -5} x2={compact ? 3 : 5} y1={compact ? 10 : 15} y2={compact ? 10 : 15} />
    </g>;
  }
  if (kind === "outlet") {
    const radius = compact ? 8 : 13;
    return <g className="connected-device-glyph" aria-hidden="true">
      <rect x={-radius} y={-radius} width={radius * 2} height={radius * 2} rx={compact ? 3 : 5} />
      <line x1={compact ? -3 : -5} x2={compact ? -3 : -5} y1={compact ? -3 : -5} y2={compact ? 2 : 3} />
      <line x1={compact ? 3 : 5} x2={compact ? 3 : 5} y1={compact ? -3 : -5} y2={compact ? 2 : 3} />
    </g>;
  }
  return <g className="connected-device-glyph" aria-hidden="true">
    <rect x={compact ? -9 : -14} y={compact ? -7 : -10} width={compact ? 18 : 28} height={compact ? 14 : 20} rx="4" />
    <line x1={compact ? -4 : -7} x2={compact ? 4 : 7} y1="0" y2="0" />
  </g>;
}

function stateKey(device: ConnectedDeviceState, pending: boolean): TranslationKey {
  if (pending) return "connectedDevice.state.changing";
  if (!device.available) return "connectedDevice.state.unavailable";
  if (device.power === true) return "connectedDevice.state.on";
  if (device.power === false) return "connectedDevice.state.off";
  return "connectedDevice.state.unknown";
}

function markerLabel(
  t: ReturnType<typeof useI18n>["t"],
  device: ConnectedDeviceState,
  floorName: string,
  pending: boolean,
  movable: boolean,
): string {
  const values = {
    device: device.name,
    floor: floorName,
    kind: t(`connectedDevice.kind.${device.kind}` as TranslationKey),
    state: t(stateKey(device, pending)),
  };
  return t(movable ? "twin.connectedDeviceMoveAria" : "twin.connectedDeviceAria", values);
}

export function ConnectedDeviceMarker2D({
  device,
  floor,
  scale,
  editing,
  pending,
  onPowerChange,
  onMove,
  onMoveFromClient,
}: {
  device: ConnectedDeviceState;
  floor: Floor;
  scale: number;
  editing: boolean;
  pending: boolean;
  onPowerChange?: (connectionId: string, power: boolean) => void;
  onMove?: (connectionId: string, point: Point) => void;
  onMoveFromClient?: (connectionId: string, clientX: number, clientY: number) => void;
}) {
  const { t } = useI18n();
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const moveEnabled = editing && Boolean(onMove && onMoveFromClient);
  const movable = moveEnabled && !pending;
  const controllable = !editing && Boolean(onPowerChange && device.capabilities.power);
  const disabled = pending || !device.available || device.power === null;
  const interactive = moveEnabled || controllable;
  const label = markerLabel(t, device, floor.name, pending, moveEnabled);
  const x = device.x ?? 0;
  const y = device.y ?? 0;

  const toggle = () => {
    if (!controllable || disabled || device.power === null) return;
    onPowerChange?.(device.connectionId, !device.power);
  };

  const keyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (movable && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? .5 : .1;
      onMove?.(device.connectionId, {
        x: Math.max(0, Math.min(floor.width, x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))),
        y: Math.max(0, Math.min(floor.height, y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))),
      });
      return;
    }
    if (!editing && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      toggle();
    }
  };

  const pointerDown = (event: PointerEvent<SVGGElement>) => {
    if (!movable) return;
    event.preventDefault();
    event.stopPropagation();
    pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerUp = (event: PointerEvent<SVGGElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || start.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4;
    if (moved) {
      suppressClick.current = true;
      onMoveFromClient?.(device.connectionId, event.clientX, event.clientY);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return <g
    transform={`translate(${x * scale} ${y * scale})`}
    className={`connected-device-marker ${device.kind} ${device.power ? "on" : "off"} ${!device.available ? "unavailable" : ""} ${pending ? "pending" : ""} ${moveEnabled ? "movable" : ""}`}
    data-map-layer="connected-devices"
    role={interactive ? "button" : "img"}
    tabIndex={interactive ? 0 : undefined}
    aria-label={label}
    aria-disabled={moveEnabled && pending || controllable && disabled ? true : undefined}
    aria-pressed={controllable && device.power !== null ? device.power : undefined}
    style={deviceColor(device)}
    onClick={(event) => {
      event.stopPropagation();
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      toggle();
    }}
    onKeyDown={keyDown}
    onPointerDown={pointerDown}
    onPointerUp={pointerUp}
    onPointerCancel={() => { pointerStart.current = null; }}
    onLostPointerCapture={() => { pointerStart.current = null; }}
  >
    <title>{label}</title>
    <circle r="48" className="connected-device-hit" aria-hidden="true" />
    <circle r="25" className="connected-device-ring" />
    <circle r="19" className="connected-device-core" />
    <DeviceGlyph kind={device.kind} />
    <text y="43" textAnchor="middle" className="connected-device-state">{t(stateKey(device, pending))}</text>
    <text y="59" textAnchor="middle" className="connected-device-name">{device.name}</text>
  </g>;
}

export function ConnectedDeviceMarker3D({
  device,
  floor,
  position,
  anchor,
  activeFloor,
  pending,
  onPowerChange,
}: {
  device: ConnectedDeviceState;
  floor: Floor;
  position: ProjectedPoint;
  anchor: ProjectedPoint;
  activeFloor: boolean;
  pending: boolean;
  onPowerChange?: (connectionId: string, power: boolean) => void;
}) {
  const { t } = useI18n();
  const controllable = Boolean(onPowerChange && device.capabilities.power);
  const disabled = pending || !device.available || device.power === null;
  const label = markerLabel(t, device, floor.name, pending, false);
  const toggle = () => {
    if (!controllable || disabled || device.power === null) return;
    onPowerChange?.(device.connectionId, !device.power);
  };
  return <g
    transform={`translate(${position.x} ${position.y})`}
    className={`building-connected-device connected-device-marker ${device.kind} ${device.power ? "on" : "off"} ${!device.available ? "unavailable" : ""} ${pending ? "pending" : ""} ${activeFloor ? "active-floor" : ""}`}
    data-map-layer="connected-devices"
    role={controllable ? "button" : "img"}
    tabIndex={controllable ? 0 : undefined}
    aria-label={label}
    aria-disabled={controllable && disabled ? true : undefined}
    aria-pressed={controllable && device.power !== null ? device.power : undefined}
    style={deviceColor(device)}
    onClick={(event) => {
      event.stopPropagation();
      toggle();
    }}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    }}
  >
    <title>{label}</title>
    <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="connected-device-tether" aria-hidden="true" />
    <circle r="32" className="connected-device-hit" aria-hidden="true" />
    <circle r="18" className="connected-device-ring" />
    <circle r="14" className="connected-device-core" />
    <DeviceGlyph kind={device.kind} compact />
    <text x="21" y="-3" className="connected-device-name">{device.name}</text>
    <text x="21" y="11" className="connected-device-state">{t(stateKey(device, pending))}</text>
  </g>;
}
