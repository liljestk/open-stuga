import { useId, type CSSProperties } from "react";
import type { Floor, Point, Room } from "@climate-twin/contracts";
import {
  isActivityLayer,
  layerConfidence,
  layerMetricText,
  layerStrength,
  layerVisualStrength,
  type SpatialLayerConnection,
  type SpatialCoordinateFrame,
  type SpatialLayerSnapshot,
  type SpatialTopology,
  type SpatialLayerZone,
} from "../spatialLayers";
import { useI18n } from "../i18n";
import { spatialLayerLabel } from "./SpatialLayerPanel";

interface SpatialLayerOverlay2DProps {
  floor: Floor;
  snapshots: readonly SpatialLayerSnapshot[];
  topology: SpatialTopology | null;
  scale: number;
}

interface LocatedZone {
  zone: SpatialLayerZone;
  polygon: Point[];
  center: Point;
  label: string;
}

function centroid(points: readonly Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function roomFor(zone: SpatialLayerZone, floor: Floor, topology: SpatialTopology | null): Room | undefined {
  const topologyZone = topology?.zones.find((candidate) => candidate.id === zone.zoneId);
  return floor.rooms.find((room) => room.id === zone.roomId)
    ?? floor.rooms.find((room) => room.id === topologyZone?.roomId)
    ?? floor.rooms.find((room) => room.id === zone.zoneId)
    ?? floor.rooms.find((room) => room.name.localeCompare(topologyZone?.name ?? zone.label ?? "", undefined, { sensitivity: "base" }) === 0);
}

function locateZone(zone: SpatialLayerZone, floor: Floor, topology: SpatialTopology | null, frames: readonly SpatialCoordinateFrame[]): LocatedZone | null {
  const topologyZone = topology?.zones.find((candidate) => candidate.id === zone.zoneId);
  const floorId = zone.floorId ?? frames.find((frame) => frame.id === zone.frameId)?.floorId ?? topologyZone?.floorId;
  if (floorId && floorId !== floor.id) return null;
  const room = roomFor(zone, floor, topology);
  if (!floorId && !room) return null;
  const polygon = topologyZone?.polygon?.length ? topologyZone.polygon : zone.polygon?.length ? zone.polygon : room?.points ?? [];
  const center = zone.centroid ?? topologyZone?.centroid ?? (polygon.length ? centroid(polygon) : null);
  return center ? { zone, polygon, center, label: topologyZone?.name ?? zone.label ?? room?.name ?? zone.zoneId } : null;
}

function connectionEndpoints(
  connection: SpatialLayerConnection,
  zones: ReadonlyMap<string, LocatedZone>,
  frames: readonly SpatialCoordinateFrame[],
  floorId: string,
): { from: Point; to: Point } | null {
  const currentFrameIds = new Set(frames.filter((frame) => frame.floorId === floorId).map((frame) => frame.id));
  const frameAnchors = connection.anchorRefs?.filter((anchor) => currentFrameIds.has(anchor.frameId)).map((anchor) => anchor.position) ?? [];
  if (frameAnchors.length >= 2) return { from: frameAnchors[0]!, to: frameAnchors.at(-1)! };
  if (connection.frameId && currentFrameIds.size && !currentFrameIds.has(connection.frameId)) return null;
  const from = connection.from ?? (connection.fromZoneId ? zones.get(connection.fromZoneId)?.center : undefined);
  const to = connection.to ?? (connection.toZoneId ? zones.get(connection.toZoneId)?.center : undefined);
  return from && to ? { from, to } : null;
}

function renderedPoint(point: Point, scale: number): string {
  return `${point.x * scale},${point.y * scale}`;
}

function overlayStyle(strength: number, confidence: number, opacity?: number): CSSProperties {
  return {
    "--spatial-strength": String(Math.max(.05, strength)),
    "--spatial-confidence": String(Math.max(.12, Math.min(confidence, opacity ?? 1))),
  } as CSSProperties;
}

export function SpatialLayerOverlay2D({ floor, snapshots, topology, scale }: SpatialLayerOverlay2DProps) {
  const { locale, t } = useI18n();
  const markerId = `spatial-2d-${useId().replaceAll(":", "")}`;
  if (!snapshots.length) return null;

  return <g className="spatial-backend-layers">{snapshots.map((snapshot, snapshotIndex) => {
    const zones = snapshot.zones.flatMap((zone) => {
      const located = locateZone(zone, floor, topology, snapshot.coordinateFrames);
      return located ? [located] : [];
    });
    const zoneMap = new Map(zones.map((zone) => [zone.zone.zoneId, zone]));
    const activity = isActivityLayer(snapshot.layerId);
    const label = `${spatialLayerLabel(snapshot.layerId, t)}. ${t("spatial.inferenceDisclaimer")}`;
    const token = `${markerId}-${snapshotIndex}`;
    return <g key={`${snapshot.layerId}:${snapshot.generatedAt}`} className="spatial-backend-layer" data-layer-id={snapshot.layerId} data-maturity={snapshot.model.maturity} role="img" aria-label={label}>
      <title>{label}</title>
      <defs>
        <marker id={`${token}-forward`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" className="spatial-layer-arrow" /></marker>
        <marker id={`${token}-reverse`} markerWidth="10" markerHeight="10" refX="2" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" className="spatial-layer-arrow" /></marker>
      </defs>
      <g className="spatial-zone-values">{zones.map(({ zone, polygon, center, label: zoneLabel }) => {
        const confidence = layerConfidence(zone);
        const strength = layerVisualStrength(snapshot.layerId, zone);
        const metricText = layerMetricText(snapshot.layerId, zone, locale);
        return <g key={zone.zoneId} className="spatial-zone-value" style={overlayStyle(strength, confidence, zone.style?.opacity)} data-confidence={confidence.toFixed(2)}>
          {polygon.length >= 3
            ? <polygon points={polygon.map((point) => renderedPoint(point, scale)).join(" ")} />
            : <circle cx={center.x * scale} cy={center.y * scale} r={Math.max(18, 34 * strength)} />}
          {(metricText || strength >= .35) && <text x={center.x * scale} y={center.y * scale - 18} textAnchor="middle">{metricText ?? (activity ? t("spatial.activitySignal") : zoneLabel)}</text>}
        </g>;
      })}</g>
      {!activity && <g className="spatial-connection-values">{snapshot.connections.flatMap((connection) => {
        if (connection.floorId && connection.floorId !== floor.id) return [];
        const endpoints = connectionEndpoints(connection, zoneMap, snapshot.coordinateFrames, floor.id);
        if (!endpoints) return [];
        const confidence = layerConfidence(connection);
        const strength = layerStrength(connection);
        if (confidence < .35 || connection.state === "no_detectable_propagation" || connection.state === "insufficient_data") return [];
        const direction = connection.style?.direction ?? (connection.state === "bidirectional" ? "both" : "forward");
        const className = `spatial-connection-value ${connection.state ?? "uncertain"} ${connection.style?.line ?? ""}`;
        return [<line
          key={connection.connectionId}
          x1={endpoints.from.x * scale}
          y1={endpoints.from.y * scale}
          x2={endpoints.to.x * scale}
          y2={endpoints.to.y * scale}
          className={className}
          style={overlayStyle(strength, confidence, connection.style?.opacity)}
          markerStart={direction === "both" || direction === "reverse" ? `url(#${token}-reverse)` : undefined}
          markerEnd={direction === "both" || direction === "forward" ? `url(#${token}-forward)` : undefined}
          data-confidence={confidence.toFixed(2)}
        />];
      })}</g>}
      {!activity && <g className="spatial-point-values">{snapshot.points.flatMap((point) => {
        const pointFloorId = point.floorId ?? snapshot.coordinateFrames.find((frame) => frame.id === point.frameId)?.floorId;
        if (pointFloorId && pointFloorId !== floor.id) return [];
        if (point.x === undefined || point.y === undefined) return [];
        const confidence = layerConfidence(point);
        return [<circle key={point.id} cx={point.x * scale} cy={point.y * scale} r={6} style={overlayStyle(layerVisualStrength(snapshot.layerId, point), confidence, point.style?.opacity)} />];
      })}</g>}
    </g>;
  })}</g>;
}
