import { useEffect, useRef } from "react";
import type {
  AreaEquipment,
  GeoCoordinate,
  House,
  HouseLocation,
  PropertyArea,
  PropertyMemberLocation,
  TrackedEquipmentState,
} from "@climate-twin/contracts";
import L, { type Circle, type Map as LeafletMap, type Marker, type Polygon } from "leaflet";
import "leaflet/dist/leaflet.css";
import { layerConfidence, layerVisualStrength, type SpatialLayerSnapshot, type SpatialTopology } from "../../spatialLayers";

export type PropertyMapHouse = Pick<House, "id" | "name" | "location" | "mapPlacement">;

export interface PropertyAreaMapProps {
  areas: readonly PropertyArea[];
  houses?: readonly PropertyMapHouse[];
  propertyLocation?: Pick<HouseLocation, "latitude" | "longitude"> | null;
  propertyLabel?: string;
  selectedAreaId: string | null;
  selectedHouseId?: string | null;
  editableHouseId?: string | null;
  selectedAssetId?: string | null;
  editableAssetId?: string | null;
  visibleAssetIds?: ReadonlySet<string> | null;
  equipment?: readonly AreaEquipment[];
  trackedEquipment?: readonly TrackedEquipmentState[];
  members?: readonly PropertyMemberLocation[];
  selectedEquipmentId?: string | null;
  editableEquipmentId?: string | null;
  draftPolygon?: readonly GeoCoordinate[] | null;
  drawing?: boolean;
  onSelectArea: (id: string) => void;
  onSelectHouse?: (id: string) => void;
  onMoveHouse?: (id: string, point: GeoCoordinate) => void;
  onSelectAsset?: (id: string) => void;
  onMoveAsset?: (id: string, point: GeoCoordinate) => void;
  onSelectEquipment?: (id: string) => void;
  onMoveEquipment?: (id: string, point: GeoCoordinate) => void;
  onAppendVertex: (point: GeoCoordinate) => void;
  onMoveVertex?: (index: number, point: GeoCoordinate) => void;
  onInsertVertex?: (index: number, point: GeoCoordinate) => void;
  onFinishDrawing?: () => void;
  vertexLabel: (index: number, canFinish: boolean) => string;
  midpointLabel: (index: number) => string;
  ariaLabel: string;
  viewportKey?: string;
  spatialLayerSnapshots?: readonly SpatialLayerSnapshot[];
  spatialLayerTopology?: SpatialTopology | null;
  spatialLayerHouseLabel?: (houseName: string, layerCount: number) => string;
  equipmentLabel?: (equipment: AreaEquipment, state: TrackedEquipmentState | null, source: EquipmentMapSource) => string;
  memberLabel?: (member: PropertyMemberLocation) => string;
}

export const DEFAULT_CENTER: L.LatLngExpression = [64.5, 26];

export const DEFAULT_ZOOM = 5;

export const AREA_ZOOM = 17;

export const VIEWPORT_PADDING: L.PointExpression = [28, 28];

export const areaColors: Record<PropertyArea["kind"], string> = {
  well: "#1769aa",
  beach: "#0788a8",
  garage: "#6b7280",
  plantation: "#7a8d12",
  garden: "#378b45",
  field: "#9a7b19",
  forest: "#176b45",
  shoreline: "#0f7895",
  dock: "#7b5734",
  road: "#665b51",
  yard: "#5b8f54",
  building: "#8a4d35",
  other: "#6d5aa8",
};

export function validCoordinate(point: GeoCoordinate): boolean {
  return Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180;
}

export function tuples(points: readonly GeoCoordinate[]): L.LatLngTuple[] {
  return points.filter(validCoordinate).map((point) => [point.latitude, point.longitude]);
}

export function houseCoordinate(house: PropertyMapHouse | undefined): GeoCoordinate | null {
  if (!house) return null;
  const source = house.mapPlacement ?? house.location;
  if (!source) return null;
  const point = { latitude: source.latitude, longitude: source.longitude };
  return validCoordinate(point) ? point : null;
}

export function areaCoordinate(area: PropertyArea | undefined): GeoCoordinate | null {
  if (!area) return null;
  if (area.location && validCoordinate(area.location)) return area.location;
  const points = area.polygon.filter(validCoordinate);
  if (!points.length) return null;
  return {
    latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length,
    longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
  };
}

export type EquipmentMapSource = "live" | "zone" | "saved-pin" | "home" | "area";

export interface EquipmentMapPoint {
  coordinate: GeoCoordinate;
  source: EquipmentMapSource;
  accuracyRadiusMeters: number | null;
}

export function equipmentMapPoint(
  equipment: AreaEquipment,
  state: TrackedEquipmentState | null,
  areas: readonly PropertyArea[],
  houses: readonly PropertyMapHouse[],
): EquipmentMapPoint | null {
  const position = state?.position;
  if (position?.coordinate && validCoordinate(position.coordinate) && position.freshness !== "unknown") {
    return {
      coordinate: position.coordinate,
      source: "live",
      accuracyRadiusMeters: position.uncertaintyRadiusMeters,
    };
  }
  if (position?.zoneId) {
    const coordinate = areaCoordinate(areas.find((area) => area.id === position.zoneId));
    if (coordinate) return { coordinate, source: "zone", accuracyRadiusMeters: null };
  }
  if (equipment.location && validCoordinate(equipment.location)) {
    return { coordinate: equipment.location, source: "saved-pin", accuracyRadiusMeters: null };
  }
  if (equipment.houseId) {
    const coordinate = houseCoordinate(houses.find((house) => house.id === equipment.houseId));
    if (coordinate) return { coordinate, source: "home", accuracyRadiusMeters: null };
  }
  if (equipment.areaId) {
    const coordinate = areaCoordinate(areas.find((area) => area.id === equipment.areaId));
    if (coordinate) return { coordinate, source: "area", accuracyRadiusMeters: null };
  }
  return null;
}

export interface PropertyViewportPlan {
  state: string;
  points: L.LatLngTuple[];
}

/**
 * The property coordinate is a useful provisional center for an empty map.
 * Geometry gets a distinct state so the first mapped area or home can replace
 * that provisional viewport without making later vertex edits jump the map.
 */
export function propertyViewportPlan(
  areas: readonly PropertyArea[],
  houses: readonly PropertyMapHouse[],
  propertyLocation: Pick<HouseLocation, "latitude" | "longitude"> | null,
  viewportKey: string,
  additionalPoints: readonly GeoCoordinate[] = [],
): PropertyViewportPlan | null {
  const areaPoints = areas.flatMap((area) => [
    ...tuples(area.polygon),
    ...(area.location && validCoordinate(area.location)
      ? [[area.location.latitude, area.location.longitude] as L.LatLngTuple]
      : []),
  ]);
  const housePoints = houses.flatMap((house) => {
    const point = houseCoordinate(house);
    return point ? [[point.latitude, point.longitude] as L.LatLngTuple] : [];
  });
  const extraPoints = tuples(additionalPoints);
  if (areaPoints.length > 0 || housePoints.length > 0 || extraPoints.length > 0) {
    return { state: `${viewportKey}:geometry`, points: [...areaPoints, ...housePoints, ...extraPoints] };
  }
  if (!propertyLocation || !validCoordinate(propertyLocation)) return null;
  return {
    state: `${viewportKey}:property:${propertyLocation.latitude}:${propertyLocation.longitude}`,
    points: [[propertyLocation.latitude, propertyLocation.longitude]],
  };
}

export interface PropertyHouseLayerState {
  strength: number;
  confidence: number;
  layerCount: number;
}

export function houseLayerState(snapshots: readonly SpatialLayerSnapshot[], houseId: string, topology: SpatialTopology | null): PropertyHouseLayerState | null {
  const topologyZoneIds = new Set(topology?.zones.filter((zone) => zone.tags?.includes(`house:${houseId}`)
    || zone.id === houseId || zone.id.endsWith(`:house:${houseId}`)).map((zone) => zone.id) ?? []);
  const values = snapshots.flatMap((snapshot) => [
    ...snapshot.zones.filter((zone) => zone.houseId === houseId || zone.tags?.includes(`house:${houseId}`) || zone.zoneId === houseId || topologyZoneIds.has(zone.zoneId)),
    ...snapshot.points.filter((point) => point.houseId === houseId || point.zoneId === houseId || (point.zoneId ? topologyZoneIds.has(point.zoneId) : false)),
  ].map((value) => ({ layerId: snapshot.layerId, value })));
  if (!values.length) return null;
  const matchingLayers = snapshots.filter((snapshot) => snapshot.zones.some((zone) => zone.houseId === houseId || zone.tags?.includes(`house:${houseId}`) || zone.zoneId === houseId)
    || snapshot.zones.some((zone) => topologyZoneIds.has(zone.zoneId))
    || snapshot.points.some((point) => point.houseId === houseId || point.zoneId === houseId || (point.zoneId ? topologyZoneIds.has(point.zoneId) : false)));
  return {
    strength: Math.max(...values.map(({ layerId, value }) => layerVisualStrength(layerId, value))),
    confidence: Math.max(...values.map(({ value }) => layerConfidence(value))),
    layerCount: new Set(matchingLayers.map((snapshot) => snapshot.layerId)).size,
  };
}

export function houseIcon(layer: PropertyHouseLayerState | null, selected: boolean): L.DivIcon {
  const spatialClass = layer ? " has-spatial-layer" : "";
  const selectedClass = selected ? " is-selected" : "";
  const style = layer ? ` style="--property-layer-strength:${layer.strength.toFixed(3)};--property-layer-confidence:${layer.confidence.toFixed(3)}"` : "";
  return L.divIcon({
    className: `property-house-marker-wrap${spatialClass}${selectedClass}`,
    html: `<span class="property-house-marker"${style} aria-hidden="true"></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function propertyIcon(): L.DivIcon {
  return L.divIcon({
    className: "property-center-marker-wrap",
    html: '<span class="property-center-marker" aria-hidden="true"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function fixedAssetIcon(kind: PropertyArea["kind"], selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-asset-marker-wrap kind-${kind}${selected ? " is-selected" : ""}`,
    html: '<span class="property-asset-marker" aria-hidden="true"></span>',
    iconSize: [28, 34],
    iconAnchor: [14, 30],
  });
}

export function equipmentIcon(source: EquipmentMapSource, freshness: string, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-equipment-marker-wrap source-${source} freshness-${freshness}${selected ? " is-selected" : ""}`,
    html: '<span class="property-equipment-marker" aria-hidden="true"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function memberIcon(reducedAccuracy: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-member-marker-wrap${reducedAccuracy ? " reduced-accuracy" : ""}`,
    html: '<span class="property-member-marker" aria-hidden="true"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export function vertexIcon(kind: "vertex" | "midpoint"): L.DivIcon {
  const size = kind === "vertex" ? 32 : 28;
  return L.divIcon({
    className: `property-map-handle-wrap ${kind}`,
    html: `<span class="property-map-handle" aria-hidden="true"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function makeEditableHandleAccessible(
  marker: Marker,
  label: string,
  onActivate: () => void,
  onMove?: (point: GeoCoordinate) => void,
) {
  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
  element.setAttribute("role", "button");
  element.tabIndex = 0;
  element.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onActivate();
      return;
    }
    if (!onMove || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = marker.getLatLng();
    const step = event.shiftKey ? .0001 : .00001;
    const latitude = current.lat + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0);
    const longitude = current.lng + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0);
    marker.setLatLng([latitude, longitude]);
    onMove({ latitude, longitude });
  };
}

export function midpoint(left: GeoCoordinate, right: GeoCoordinate): GeoCoordinate {
  return { latitude: (left.latitude + right.latitude) / 2, longitude: (left.longitude + right.longitude) / 2 };
}

export function makeHouseMarkerAccessible(marker: Marker, label: string, selected: boolean, onActivate: () => void) {
  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
  element.setAttribute("role", "button");
  element.setAttribute("aria-pressed", String(selected));
  element.tabIndex = 0;
  element.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
}

export function makeInformationalMarkerAccessible(marker: Marker, label: string) {
  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
  element.setAttribute("role", "img");
}

export function makeAreaLayerAccessible(
  element: Element,
  label: string,
  selected: boolean,
  onActivate: () => void,
): void {
  element.setAttribute("aria-label", label);
  element.setAttribute("aria-pressed", String(selected));
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  (element as SVGElement).onkeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
}
