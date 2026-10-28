import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Copy,
  MapPin,
  Printer,
  QrCode,
  TriangleAlert,
} from "lucide-react";
import type {
  Floor,
  Sensor,
  SensorLabelDescriptor,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import { api } from "../../../api";
import { useI18n } from "../../../i18n";
import { type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../../../spatial/experimentalLayers";
import { qrCodeMatrix } from "../qrCode";
import { isTpLinkContactDevice } from "../../../tpLinkDeviceClassification";
import { clamp } from "./part-01";

export function deviceBindingKey(deviceId: string, connectionId?: string): string {
  return connectionId ? `${connectionId}\u0000${deviceId}` : deviceId;
}

export function availableForSensor(device: TpLinkDiscoveredDevice, sensorId: string | null, usedDeviceIds: Set<string>): boolean {
  if (isTpLinkContactDevice(device)) return false;
  if (sensorId && device.mappedSensorId === sensorId) return true;
  return device.mappedSensorId === null && !usedDeviceIds.has(deviceBindingKey(device.deviceId, device.connectionId));
}

export function SensorLabelCard({ sensor }: Readonly<{ sensor: Sensor }>) {
  const { t } = useI18n();
  const [label, setLabel] = useState<SensorLabelDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setLabel(null); setError(null); setCopied(false);
    void api.sensorLabel(sensor.id).then((value) => { if (active) setLabel(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : t("sensors.labelUnavailable")); });
    return () => { active = false; };
  }, [sensor.id, t]);
  const matrix = useMemo(() => label ? qrCodeMatrix(label.setupUri) : null, [label]);
  const copy = async () => {
    if (!label || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(label.setupUri);
    setCopied(true);
  };
  if (error) return <p className="sensor-details-error" role="alert"><TriangleAlert size={15} />{error}</p>;
  if (!label || !matrix) return null;
  return <section className="sensor-label-card" aria-labelledby="sensor-label-title">
    <svg className="sensor-label-qr" viewBox={`-4 -4 ${matrix.length + 8} ${matrix.length + 8}`} role="img" aria-label={t("sensors.labelQrAria", { sensor: label.sensorName })} shapeRendering="crispEdges"><rect x="-4" y="-4" width={matrix.length + 8} height={matrix.length + 8} fill="white" />{matrix.flatMap((row, y) => row.map((dark, x) => dark ? <rect key={`${x}:${y}`} x={x} y={y} width="1" height="1" fill="black" /> : null))}</svg>
    <div><span className="eyebrow"><QrCode size={14} aria-hidden="true" />{t("sensors.localSensorLabel")}</span><h3 id="sensor-label-title">{label.sensorName}</h3><p>{label.houseName}{label.roomName ? ` · ${label.roomName}` : ""}</p><code>{label.setupUri}</code><small>{t("sensors.labelHelp")}</small></div>
    <div className="sensor-label-actions"><button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? t("sensors.labelCopied") : t("sensors.copyLabelUri")}</button><button type="button" className="primary-button" onClick={() => window.print()}><Printer size={14} aria-hidden="true" />{t("sensors.printLabel")}</button></div>
  </section>;
}

export function PlacementPicker({
  floor,
  x,
  y,
  label,
  description,
  coverage,
  suggestion,
  onChange,
}: {
  floor: Floor;
  x: number;
  y: number;
  label: string;
  description: string;
  coverage?: SensorCoverageAssessment | null;
  suggestion?: SensorPlacementSuggestion | null;
  onChange: (point: { x: number; y: number }) => void;
}) {
  const descriptionId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const safeWidth = Math.max(1, floor.width);
  const safeHeight = Math.max(1, floor.height);
  const pinRadius = Math.max(.18, Math.min(safeWidth, safeHeight) * .035);
  const moveToPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scale = Math.min(bounds.width / safeWidth, bounds.height / safeHeight);
    const renderedWidth = safeWidth * scale;
    const renderedHeight = safeHeight * scale;
    const offsetX = (bounds.width - renderedWidth) / 2;
    const offsetY = (bounds.height - renderedHeight) / 2;
    onChange({
      x: clamp((event.clientX - bounds.left - offsetX) / scale, 0, floor.width),
      y: clamp((event.clientY - bounds.top - offsetY) / scale, 0, floor.height),
    });
  };
  const moveWithKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const multiplier = event.shiftKey ? 5 : 1;
    const xStep = Math.max(.1, floor.width / 100) * multiplier;
    const yStep = Math.max(.1, floor.height / 100) * multiplier;
    onChange({
      x: clamp(x + (event.key === "ArrowRight" ? xStep : event.key === "ArrowLeft" ? -xStep : 0), 0, floor.width),
      y: clamp(y + (event.key === "ArrowDown" ? yStep : event.key === "ArrowUp" ? -yStep : 0), 0, floor.height),
    });
  };
  return (
    <div className="sensor-placement-picker">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${safeWidth} ${safeHeight}`}
        role="group"
        aria-label={label}
        aria-describedby={descriptionId}
        tabIndex={0}
        onPointerDown={moveToPointer}
        onKeyDown={moveWithKeyboard}
      >
        <title>{label}</title>
        <desc>{description}</desc>
        <rect className="sensor-placement-base" x="0" y="0" width={safeWidth} height={safeHeight} rx={Math.min(safeWidth, safeHeight) * .025} />
        <g className="sensor-placement-rooms" aria-hidden="true">{floor.rooms.map((room) => room.points.length > 2 && <polygon key={room.id} points={room.points.map((point) => `${point.x},${point.y}`).join(" ")} />)}</g>
        <g className="sensor-placement-walls" aria-hidden="true">{floor.walls.map((wall) => <line key={wall.id} x1={wall.from.x} y1={wall.from.y} x2={wall.to.x} y2={wall.to.y} />)}</g>
        {coverage && <g className="sensor-placement-coverage" aria-hidden="true">{coverage.regions.filter((region) => region.floorId === floor.id).map((region) => <ellipse
          key={region.id}
          cx={region.x}
          cy={region.y}
          rx={region.radiusX}
          ry={region.radiusY}
          style={{ opacity: .055 + region.support * .075 }}
        />)}</g>}
        {suggestion && <g className="sensor-placement-target" transform={`translate(${suggestion.recommendation.x} ${suggestion.recommendation.y})`} aria-hidden="true">
          <circle r={pinRadius * 2.25} />
          <path d={`M${-pinRadius * .8} 0H${pinRadius * .8}M0 ${-pinRadius * .8}V${pinRadius * .8}`} />
        </g>}
        <g className="sensor-placement-pin" transform={`translate(${clamp(x, 0, floor.width)} ${clamp(y, 0, floor.height)})`} aria-hidden="true"><circle r={pinRadius * 1.8} /><circle r={pinRadius} /><path d={`M0 ${pinRadius * 2.7} L${-pinRadius * .7} ${pinRadius * 1.25} L${pinRadius * .7} ${pinRadius * 1.25}Z`} /></g>
      </svg>
      <p id={descriptionId}><MapPin size={14} aria-hidden="true" />{description}</p>
    </div>
  );
}
