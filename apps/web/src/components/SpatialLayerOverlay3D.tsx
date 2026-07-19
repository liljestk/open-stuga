import { useId, type CSSProperties } from "react";
import type { Floor, House, Point, Room } from "@climate-twin/contracts";
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
import type { Point3D, ProjectedPoint3D } from "../spatialVolume";
import { useI18n } from "../i18n";
import { spatialLayerLabel } from "./SpatialLayerPanel";

interface SpatialLayerOverlay3DProps {
  house: House;
  snapshots: readonly SpatialLayerSnapshot[];
  topology: SpatialTopology | null;
  project: (point: Point3D) => ProjectedPoint3D;
}

interface LocatedZone3D {
  zone: SpatialLayerZone;
  floor: Floor;
  room?: Room;
  polygon: Point3D[];
  center: Point3D;
}

function centroid(points: readonly Point[]): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(points.length, 1),
    y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(points.length, 1),
  };
}

function locateZone(zone: SpatialLayerZone, house: House, topology: SpatialTopology | null, frames: readonly SpatialCoordinateFrame[]): LocatedZone3D | null {
  const topologyZone = topology?.zones.find((candidate) => candidate.id === zone.zoneId);
  const snapshotFloorId = zone.floorId ?? frames.find((frame) => frame.id === zone.frameId)?.floorId;
  const match = house.floors.flatMap((floor) => floor.rooms.map((room) => ({ floor, room })))
    .find(({ floor, room }) => (!(snapshotFloorId ?? topologyZone?.floorId) || floor.id === (snapshotFloorId ?? topologyZone?.floorId))
      && (room.id === zone.roomId || room.id === topologyZone?.roomId || room.id === zone.zoneId || room.name.localeCompare(zone.label ?? topologyZone?.name ?? "", undefined, { sensitivity: "base" }) === 0));
  const floorId = snapshotFloorId ?? topologyZone?.floorId;
  const floor = match?.floor ?? (floorId ? house.floors.find((candidate) => candidate.id === floorId) : undefined);
  if (!floor) return null;
  const room = match?.room;
  const points = topologyZone?.polygon?.length ? topologyZone.polygon : zone.polygon?.length ? zone.polygon : room?.points ?? [];
  const flatCenter = zone.centroid ?? topologyZone?.centroid ?? (points.length ? centroid(points) : null);
  if (!flatCenter) return null;
  const z = zone.centroid?.z ?? topologyZone?.centroid.z ?? floor.elevation + .18;
  return {
    zone,
    floor,
    ...(room ? { room } : {}),
    center: { x: flatCenter.x, y: flatCenter.y, z },
    polygon: points.map((point) => ({ ...point, z })),
  };
}

function endpoint(
  value: SpatialLayerConnection["from"],
  zoneId: string | undefined,
  zones: ReadonlyMap<string, LocatedZone3D>,
  house: House,
  frameId?: string,
  frames: readonly SpatialCoordinateFrame[] = [],
): Point3D | null {
  if (!value) return zoneId ? zones.get(zoneId)?.center ?? null : null;
  const resolvedFloorId = value.floorId ?? frames.find((frame) => frame.id === frameId)?.floorId;
  const floor = resolvedFloorId ? house.floors.find((candidate) => candidate.id === resolvedFloorId) : undefined;
  return { x: value.x, y: value.y, z: value.z ?? (floor?.elevation ?? 0) + .18 };
}

function style(strength: number, confidence: number, opacity?: number): CSSProperties {
  return {
    "--spatial-strength": String(Math.max(.05, strength)),
    "--spatial-confidence": String(Math.max(.12, Math.min(confidence, opacity ?? 1))),
  } as CSSProperties;
}

export function SpatialLayerOverlay3D({ house, snapshots, topology, project }: SpatialLayerOverlay3DProps) {
  const { locale, t } = useI18n();
  const markerId = `spatial-3d-${useId().replaceAll(":", "")}`;
  if (!snapshots.length) return null;
  return <g className="spatial-backend-layers spatial-backend-layers-3d">{snapshots.map((snapshot, snapshotIndex) => {
    const zones = snapshot.zones.flatMap((zone) => {
      const located = locateZone(zone, house, topology, snapshot.coordinateFrames);
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
      <g className="spatial-zone-values">{zones.map(({ zone, polygon, center, room }) => {
        const confidence = layerConfidence(zone);
        const strength = layerVisualStrength(snapshot.layerId, zone);
        const metricText = layerMetricText(snapshot.layerId, zone, locale);
        const projected = polygon.map(project);
        const projectedCenter = project(center);
        const zoneLabel = zone.label ?? room?.name ?? zone.zoneId;
        return <g key={`${zone.floorId ?? "floor"}:${zone.zoneId}`} className="spatial-zone-value" style={style(strength, confidence, zone.style?.opacity)} data-confidence={confidence.toFixed(2)}>
          {projected.length >= 3
            ? <polygon points={projected.map((point) => `${point.x},${point.y}`).join(" ")} />
            : <ellipse cx={projectedCenter.x} cy={projectedCenter.y} rx={Math.max(14, 30 * strength)} ry={Math.max(8, 16 * strength)} />}
          {(metricText || strength >= .35) && <text x={projectedCenter.x} y={projectedCenter.y - 12} textAnchor="middle">{metricText ?? (activity ? t("spatial.activitySignal") : zoneLabel)}</text>}
        </g>;
      })}</g>
      {!activity && <g className="spatial-connection-values">{snapshot.connections.flatMap((connection) => {
        const firstAnchor = connection.anchorRefs?.[0];
        const lastAnchor = connection.anchorRefs?.at(-1);
        const from = firstAnchor
          ? endpoint(firstAnchor.position, undefined, zoneMap, house, firstAnchor.frameId, snapshot.coordinateFrames)
          : endpoint(connection.from, connection.fromZoneId, zoneMap, house, connection.frameId, snapshot.coordinateFrames);
        const to = lastAnchor
          ? endpoint(lastAnchor.position, undefined, zoneMap, house, lastAnchor.frameId, snapshot.coordinateFrames)
          : endpoint(connection.to, connection.toZoneId, zoneMap, house, connection.frameId, snapshot.coordinateFrames);
        if (!from || !to) return [];
        const confidence = layerConfidence(connection);
        const strength = layerStrength(connection);
        if (confidence < .35 || connection.state === "no_detectable_propagation" || connection.state === "insufficient_data") return [];
        const projectedFrom = project(from);
        const projectedTo = project(to);
        const direction = connection.style?.direction ?? (connection.state === "bidirectional" ? "both" : "forward");
        return [<line
          key={connection.connectionId}
          x1={projectedFrom.x}
          y1={projectedFrom.y}
          x2={projectedTo.x}
          y2={projectedTo.y}
          className={`spatial-connection-value ${connection.state ?? "uncertain"} ${connection.style?.line ?? ""}`}
          style={style(strength, confidence, connection.style?.opacity)}
          markerStart={direction === "both" || direction === "reverse" ? `url(#${token}-reverse)` : undefined}
          markerEnd={direction === "both" || direction === "forward" ? `url(#${token}-forward)` : undefined}
          data-confidence={confidence.toFixed(2)}
        />];
      })}</g>}
      {!activity && <g className="spatial-point-values">{snapshot.points.flatMap((point) => {
        if (point.x === undefined || point.y === undefined) return [];
        const pointFloorId = point.floorId ?? snapshot.coordinateFrames.find((frame) => frame.id === point.frameId)?.floorId;
        const floor = pointFloorId ? house.floors.find((candidate) => candidate.id === pointFloorId) : undefined;
        const projected = project({ x: point.x, y: point.y, z: point.z ?? (floor?.elevation ?? 0) + .18 });
        return [<circle key={point.id} cx={projected.x} cy={projected.y} r={6} style={style(layerVisualStrength(snapshot.layerId, point), layerConfidence(point), point.style?.opacity)} />];
      })}</g>}
    </g>;
  })}</g>;
}
