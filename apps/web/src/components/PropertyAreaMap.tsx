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
import { layerConfidence, layerVisualStrength, type SpatialLayerSnapshot, type SpatialTopology } from "../spatialLayers";

type PropertyMapHouse = Pick<House, "id" | "name" | "location" | "mapPlacement">;

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
  trackedAssets?: readonly TrackedEquipmentState[];
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

const DEFAULT_CENTER: L.LatLngExpression = [64.5, 26];
const DEFAULT_ZOOM = 5;
const AREA_ZOOM = 17;
const VIEWPORT_PADDING: L.PointExpression = [28, 28];

const areaColors: Record<PropertyArea["kind"], string> = {
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

function validCoordinate(point: GeoCoordinate): boolean {
  return Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180;
}

function tuples(points: readonly GeoCoordinate[]): L.LatLngTuple[] {
  return points.filter(validCoordinate).map((point) => [point.latitude, point.longitude]);
}

function houseCoordinate(house: PropertyMapHouse | undefined): GeoCoordinate | null {
  if (!house) return null;
  const source = house.mapPlacement ?? house.location;
  if (!source) return null;
  const point = { latitude: source.latitude, longitude: source.longitude };
  return validCoordinate(point) ? point : null;
}

function areaCoordinate(area: PropertyArea | undefined): GeoCoordinate | null {
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
  if (position?.coordinate && validCoordinate(position.coordinate) && position.freshnessState !== "unknown") {
    return {
      coordinate: position.coordinate,
      source: "live",
      accuracyRadiusMeters: position.accuracyRadiusMeters,
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

interface PropertyHouseLayerState {
  strength: number;
  confidence: number;
  layerCount: number;
}

function houseLayerState(snapshots: readonly SpatialLayerSnapshot[], houseId: string, topology: SpatialTopology | null): PropertyHouseLayerState | null {
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

function houseIcon(layer: PropertyHouseLayerState | null, selected: boolean): L.DivIcon {
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

function propertyIcon(): L.DivIcon {
  return L.divIcon({
    className: "property-center-marker-wrap",
    html: '<span class="property-center-marker" aria-hidden="true"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function fixedAssetIcon(kind: PropertyArea["kind"], selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-asset-marker-wrap kind-${kind}${selected ? " is-selected" : ""}`,
    html: '<span class="property-asset-marker" aria-hidden="true"></span>',
    iconSize: [28, 34],
    iconAnchor: [14, 30],
  });
}

function equipmentIcon(source: EquipmentMapSource, freshness: string, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-equipment-marker-wrap source-${source} freshness-${freshness}${selected ? " is-selected" : ""}`,
    html: '<span class="property-equipment-marker" aria-hidden="true"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function memberIcon(reducedAccuracy: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-member-marker-wrap${reducedAccuracy ? " reduced-accuracy" : ""}`,
    html: '<span class="property-member-marker" aria-hidden="true"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function vertexIcon(kind: "vertex" | "midpoint"): L.DivIcon {
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

function midpoint(left: GeoCoordinate, right: GeoCoordinate): GeoCoordinate {
  return { latitude: (left.latitude + right.latitude) / 2, longitude: (left.longitude + right.longitude) / 2 };
}

function makeHouseMarkerAccessible(marker: Marker, label: string, selected: boolean, onActivate: () => void) {
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

function makeInformationalMarkerAccessible(marker: Marker, label: string) {
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

export function PropertyAreaMap({
  areas,
  houses = [],
  propertyLocation = null,
  propertyLabel,
  selectedAreaId,
  selectedHouseId = null,
  editableHouseId = null,
  selectedAssetId = null,
  editableAssetId = null,
  visibleAssetIds = null,
  equipment = [],
  trackedAssets = [],
  members = [],
  selectedEquipmentId = null,
  editableEquipmentId = null,
  draftPolygon = null,
  drawing = false,
  onSelectArea,
  onSelectHouse,
  onMoveHouse,
  onSelectAsset,
  onMoveAsset,
  onSelectEquipment,
  onMoveEquipment,
  onAppendVertex,
  onMoveVertex,
  onInsertVertex,
  onFinishDrawing,
  vertexLabel,
  midpointLabel,
  ariaLabel,
  viewportKey = "default",
  spatialLayerSnapshots = [],
  spatialLayerTopology = null,
  spatialLayerHouseLabel,
  equipmentLabel,
  memberLabel,
}: Readonly<PropertyAreaMapProps>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const areaLayersRef = useRef(new Map<string, Polygon>());
  const propertyLayerRef = useRef<Marker | null>(null);
  const houseLayersRef = useRef(new Map<string, Marker>());
  const assetLayersRef = useRef(new Map<string, Marker>());
  const equipmentLayersRef = useRef(new Map<string, Marker>());
  const equipmentAccuracyLayersRef = useRef(new Map<string, Circle>());
  const memberLayersRef = useRef(new Map<string, Marker>());
  const memberAccuracyLayersRef = useRef(new Map<string, Circle>());
  const draftLayerRef = useRef<Polygon | null>(null);
  const editHandlesRef = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelectArea);
  const onSelectHouseRef = useRef(onSelectHouse);
  const onMoveHouseRef = useRef(onMoveHouse);
  const onSelectAssetRef = useRef(onSelectAsset);
  const onMoveAssetRef = useRef(onMoveAsset);
  const onSelectEquipmentRef = useRef(onSelectEquipment);
  const onMoveEquipmentRef = useRef(onMoveEquipment);
  const onAppendRef = useRef(onAppendVertex);
  const onMoveRef = useRef(onMoveVertex);
  const onInsertRef = useRef(onInsertVertex);
  const onFinishRef = useRef(onFinishDrawing);
  const drawingRef = useRef(drawing);
  const editableHouseIdRef = useRef(editableHouseId);
  const editableAssetIdRef = useRef(editableAssetId);
  const editableEquipmentIdRef = useRef(editableEquipmentId);
  const houseIdsRef = useRef(new Set(houses.map((house) => house.id)));
  const assetIdsRef = useRef(new Set(areas.map((area) => area.id)));
  const equipmentIdsRef = useRef(new Set(equipment.map((item) => item.id)));
  const primaryMapActionRef = useRef<(point: Pick<L.LatLng, "lat" | "lng">) => boolean>(() => false);
  const appliedViewportRef = useRef<string | null>(null);

  onSelectRef.current = onSelectArea;
  onSelectHouseRef.current = onSelectHouse;
  onMoveHouseRef.current = onMoveHouse;
  onSelectAssetRef.current = onSelectAsset;
  onMoveAssetRef.current = onMoveAsset;
  onSelectEquipmentRef.current = onSelectEquipment;
  onMoveEquipmentRef.current = onMoveEquipment;
  onAppendRef.current = onAppendVertex;
  onMoveRef.current = onMoveVertex;
  onInsertRef.current = onInsertVertex;
  onFinishRef.current = onFinishDrawing;
  drawingRef.current = drawing;
  editableHouseIdRef.current = editableHouseId;
  editableAssetIdRef.current = editableAssetId;
  editableEquipmentIdRef.current = editableEquipmentId;
  houseIdsRef.current = new Set(houses.map((house) => house.id));
  assetIdsRef.current = new Set(areas.map((area) => area.id));
  equipmentIdsRef.current = new Set(equipment.map((item) => item.id));
  primaryMapActionRef.current = (point) => {
    if (drawingRef.current) {
      onAppendRef.current({ latitude: point.lat, longitude: point.lng });
      return true;
    }
    const houseId = editableHouseIdRef.current;
    if (houseId && houseIdsRef.current.has(houseId)) {
      onMoveHouseRef.current?.(houseId, { latitude: point.lat, longitude: point.lng });
      return true;
    }
    const assetId = editableAssetIdRef.current;
    if (assetId && assetIdsRef.current.has(assetId)) {
      onMoveAssetRef.current?.(assetId, { latitude: point.lat, longitude: point.lng });
      return true;
    }
    const equipmentId = editableEquipmentIdRef.current;
    if (equipmentId && equipmentIdsRef.current.has(equipmentId)) {
      onMoveEquipmentRef.current?.(equipmentId, { latitude: point.lat, longitude: point.lng });
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      primaryMapActionRef.current(event.latlng);
    });
    const container = containerRef.current;
    const dragOver = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("application/x-stuga-house-id")
        || event.dataTransfer?.types.includes("application/x-stuga-property-asset-id")) event.preventDefault();
    };
    const drop = (event: globalThis.DragEvent) => {
      const houseId = event.dataTransfer?.getData("application/x-stuga-house-id") ?? "";
      const assetId = event.dataTransfer?.getData("application/x-stuga-property-asset-id") ?? "";
      if ((!houseId || !houseIdsRef.current.has(houseId)) && (!assetId || !assetIdsRef.current.has(assetId))) return;
      event.preventDefault();
      const latLng = map.mouseEventToLatLng(event);
      if (houseId && houseIdsRef.current.has(houseId)) {
        onMoveHouseRef.current?.(houseId, { latitude: latLng.lat, longitude: latLng.lng });
      } else if (assetId && assetIdsRef.current.has(assetId)) {
        onMoveAssetRef.current?.(assetId, { latitude: latLng.lat, longitude: latLng.lng });
      }
    };
    container.addEventListener("dragover", dragOver);
    container.addEventListener("drop", drop);
    mapRef.current = map;
    const invalidateTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(invalidateTimer);
      areaLayersRef.current.clear();
      propertyLayerRef.current = null;
      houseLayersRef.current.clear();
      assetLayersRef.current.clear();
      equipmentLayersRef.current.clear();
      equipmentAccuracyLayersRef.current.clear();
      memberLayersRef.current.clear();
      memberAccuracyLayersRef.current.clear();
      draftLayerRef.current = null;
      editHandlesRef.current.length = 0;
      appliedViewportRef.current = null;
      mapRef.current = null;
      container.removeEventListener("dragover", dragOver);
      container.removeEventListener("drop", drop);
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!propertyLabel || !propertyLocation || !validCoordinate(propertyLocation)) {
      propertyLayerRef.current?.removeFrom(map);
      propertyLayerRef.current = null;
      return;
    }
    const latLng: L.LatLngExpression = [propertyLocation.latitude, propertyLocation.longitude];
    const marker = propertyLayerRef.current ?? L.marker(latLng, {
      icon: propertyIcon(),
      keyboard: false,
      interactive: false,
      title: propertyLabel,
      alt: propertyLabel,
      zIndexOffset: -500,
    }).addTo(map);
    marker.setLatLng(latLng).setIcon(propertyIcon());
    makeInformationalMarkerAccessible(marker, propertyLabel);
    propertyLayerRef.current = marker;
  }, [propertyLabel, propertyLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const currentIds = new Set(areas.map((area) => area.id));
    for (const [id, layer] of areaLayersRef.current) {
      if (!currentIds.has(id)) {
        layer.removeFrom(map);
        areaLayersRef.current.delete(id);
      }
    }
    for (const area of areas) {
      const points = tuples(area.id === selectedAreaId && draftPolygon ? draftPolygon : area.polygon);
      if (points.length < 3) {
        areaLayersRef.current.get(area.id)?.removeFrom(map);
        areaLayersRef.current.delete(area.id);
        continue;
      }
      const selected = area.id === selectedAreaId;
      const style: L.PathOptions = {
        color: selected ? "#0755c9" : areaColors[area.kind],
        fillColor: areaColors[area.kind],
        fillOpacity: selected ? 0.32 : 0.2,
        opacity: 0.95,
        weight: selected ? 4 : 2,
      };
      let layer = areaLayersRef.current.get(area.id);
      if (!layer) {
        layer = L.polygon(points, style).addTo(map);
        layer.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          if (primaryMapActionRef.current(event.latlng)) return;
          onSelectRef.current(area.id);
        });
        areaLayersRef.current.set(area.id, layer);
      } else {
        layer.setLatLngs(points);
        layer.setStyle(style);
      }
      const element = layer.getElement();
      if (element) {
        makeAreaLayerAccessible(element, area.name, selected, () => onSelectRef.current(area.id));
      }
    }
  }, [areas, draftPolygon, selectedAreaId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const locatedAssets = new Set(areas
      .filter((area) => area.location
        && validCoordinate(area.location)
        && (!visibleAssetIds || visibleAssetIds.has(area.id)))
      .map((area) => area.id));
    for (const [id, marker] of assetLayersRef.current) {
      if (!locatedAssets.has(id)) {
        marker.removeFrom(map);
        assetLayersRef.current.delete(id);
      }
    }
    for (const area of areas) {
      if (!area.location || !validCoordinate(area.location) || (visibleAssetIds && !visibleAssetIds.has(area.id))) continue;
      const selected = area.id === selectedAssetId;
      const draggable = area.id === editableAssetId;
      const latLng: L.LatLngExpression = [area.location.latitude, area.location.longitude];
      const existing = assetLayersRef.current.get(area.id);
      const marker = existing ?? L.marker(latLng, {
        icon: fixedAssetIcon(area.kind, selected), keyboard: true, draggable, autoPan: true, bubblingMouseEvents: true, title: area.name, alt: area.name,
      }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(fixedAssetIcon(area.kind, selected));
      else {
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          if (primaryMapActionRef.current(event.latlng)) return;
          onSelectAssetRef.current?.(area.id);
        });
        marker.on("dragend", () => {
          const next = marker.getLatLng();
          onMoveAssetRef.current?.(area.id, { latitude: next.lat, longitude: next.lng });
        });
        assetLayersRef.current.set(area.id, marker);
      }
      marker.setZIndexOffset(selected ? 900 : 0);
      if (draggable) marker.dragging?.enable();
      else marker.dragging?.disable();
      makeHouseMarkerAccessible(marker, area.name, selected, () => onSelectAssetRef.current?.(area.id));
    }
  }, [areas, editableAssetId, selectedAssetId, visibleAssetIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const currentIds = new Set(houses.map((house) => house.id));
    for (const [id, marker] of houseLayersRef.current) {
      if (!currentIds.has(id)) {
        marker.removeFrom(map);
        houseLayersRef.current.delete(id);
      }
    }
    for (const house of houses) {
      const point = houseCoordinate(house);
      const existing = houseLayersRef.current.get(house.id);
      if (!point) {
        existing?.removeFrom(map);
        houseLayersRef.current.delete(house.id);
        continue;
      }
      const latLng: L.LatLngExpression = [point.latitude, point.longitude];
      const layer = houseLayerState(spatialLayerSnapshots, house.id, spatialLayerTopology);
      const selected = house.id === selectedHouseId;
      const draggable = house.id === editableHouseId;
      const marker = existing ?? L.marker(latLng, { icon: houseIcon(layer, selected), keyboard: true, draggable, autoPan: true, bubblingMouseEvents: true, title: house.name, alt: house.name }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(houseIcon(layer, selected));
      else {
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          if (primaryMapActionRef.current(event.latlng)) return;
          onSelectHouseRef.current?.(house.id);
        });
        marker.on("dragend", () => {
          const next = marker.getLatLng();
          onMoveHouseRef.current?.(house.id, { latitude: next.lat, longitude: next.lng });
        });
        houseLayersRef.current.set(house.id, marker);
      }
      marker.setZIndexOffset(selected ? 1000 : 0);
      if (draggable) marker.dragging?.enable();
      else marker.dragging?.disable();
      const label = layer && spatialLayerHouseLabel ? spatialLayerHouseLabel(house.name, layer.layerCount) : house.name;
      makeHouseMarkerAccessible(marker, label, selected, () => onSelectHouseRef.current?.(house.id));
    }
  }, [editableHouseId, houses, selectedHouseId, spatialLayerHouseLabel, spatialLayerSnapshots, spatialLayerTopology]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const stateByEquipmentId = new Map(trackedAssets.map((state) => [state.equipment.id, state]));
    const plotted = equipment.flatMap((item) => {
      const state = stateByEquipmentId.get(item.id) ?? null;
      const point = equipmentMapPoint(item, state, areas, houses);
      return point ? [{ item, state, point }] : [];
    });
    const currentIds = new Set(plotted.map(({ item }) => item.id));
    for (const [id, marker] of equipmentLayersRef.current) {
      if (!currentIds.has(id)) {
        marker.removeFrom(map);
        equipmentLayersRef.current.delete(id);
      }
    }
    for (const [id, circle] of equipmentAccuracyLayersRef.current) {
      if (!currentIds.has(id)) {
        circle.removeFrom(map);
        equipmentAccuracyLayersRef.current.delete(id);
      }
    }
    for (const { item, state, point } of plotted) {
      const selected = item.id === selectedEquipmentId;
      const draggable = item.id === editableEquipmentId;
      const freshness = state?.position?.freshnessState ?? "expected";
      const latLng: L.LatLngExpression = [point.coordinate.latitude, point.coordinate.longitude];
      const existing = equipmentLayersRef.current.get(item.id);
      const marker = existing ?? L.marker(latLng, {
        icon: equipmentIcon(point.source, freshness, selected),
        keyboard: true,
        bubblingMouseEvents: true,
        draggable,
        autoPan: true,
        title: item.name,
        alt: item.name,
      }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(equipmentIcon(point.source, freshness, selected));
      else {
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          if (primaryMapActionRef.current(event.latlng)) return;
          onSelectEquipmentRef.current?.(item.id);
        });
        marker.on("dragend", () => {
          const next = marker.getLatLng();
          onMoveEquipmentRef.current?.(item.id, { latitude: next.lat, longitude: next.lng });
        });
        equipmentLayersRef.current.set(item.id, marker);
      }
      marker.setZIndexOffset(selected ? 1_200 : point.source === "live" ? 700 : 300);
      if (draggable) marker.dragging?.enable();
      else marker.dragging?.disable();
      const label = equipmentLabel?.(item, state, point.source) ?? item.name;
      if (draggable) {
        makeEditableHandleAccessible(
          marker,
          label,
          () => onSelectEquipmentRef.current?.(item.id),
          (coordinate) => onMoveEquipmentRef.current?.(item.id, coordinate),
        );
        marker.getElement()?.setAttribute("aria-pressed", String(selected));
      } else {
        makeHouseMarkerAccessible(marker, label, selected, () => onSelectEquipmentRef.current?.(item.id));
      }

      const radius = point.source === "live" && point.accuracyRadiusMeters && point.accuracyRadiusMeters > 0
        ? point.accuracyRadiusMeters
        : null;
      const existingCircle = equipmentAccuracyLayersRef.current.get(item.id);
      if (!radius) {
        existingCircle?.removeFrom(map);
        equipmentAccuracyLayersRef.current.delete(item.id);
        continue;
      }
      const style: L.PathOptions = {
        color: freshness === "stale" ? "#8a7665" : "#1769aa",
        fillColor: freshness === "stale" ? "#baa99a" : "#6faee0",
        fillOpacity: freshness === "stale" ? 0.08 : 0.12,
        opacity: freshness === "stale" ? 0.45 : 0.72,
        dashArray: freshness === "stale" ? "6 5" : undefined,
        weight: 1.5,
      };
      if (existingCircle) {
        existingCircle.setLatLng(latLng).setRadius(radius).setStyle(style);
      } else {
        equipmentAccuracyLayersRef.current.set(
          item.id,
          L.circle(latLng, { ...style, radius }).addTo(map),
        );
      }
    }
  }, [areas, editableEquipmentId, equipment, equipmentLabel, houses, selectedEquipmentId, trackedAssets]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibleMembers = members.filter((member) => (
      validCoordinate(member.coordinate)
      && Number.isFinite(member.horizontalAccuracyMeters)
      && member.horizontalAccuracyMeters > 0
      && Date.parse(member.sharingUntil) > Date.now()
    ));
    const currentIds = new Set(visibleMembers.map((member) => member.id));
    for (const [id, marker] of memberLayersRef.current) {
      if (!currentIds.has(id)) {
        marker.removeFrom(map);
        memberLayersRef.current.delete(id);
      }
    }
    for (const [id, circle] of memberAccuracyLayersRef.current) {
      if (!currentIds.has(id)) {
        circle.removeFrom(map);
        memberAccuracyLayersRef.current.delete(id);
      }
    }
    for (const member of visibleMembers) {
      const latLng: L.LatLngExpression = [member.coordinate.latitude, member.coordinate.longitude];
      const existing = memberLayersRef.current.get(member.id);
      const marker = existing ?? L.marker(latLng, {
        icon: memberIcon(member.reducedAccuracy),
        keyboard: true,
        bubblingMouseEvents: true,
        title: member.memberLabel,
        alt: member.memberLabel,
      }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(memberIcon(member.reducedAccuracy));
      else memberLayersRef.current.set(member.id, marker);
      marker.setZIndexOffset(950);
      makeInformationalMarkerAccessible(marker, memberLabel?.(member) ?? member.memberLabel);
      const style: L.PathOptions = {
        color: "#7a4aa8",
        fillColor: "#a779c7",
        fillOpacity: member.reducedAccuracy ? 0.08 : 0.13,
        opacity: 0.65,
        dashArray: member.reducedAccuracy ? "6 5" : undefined,
        weight: 1.5,
      };
      const circle = memberAccuracyLayersRef.current.get(member.id);
      if (circle) {
        circle.setLatLng(latLng).setRadius(member.horizontalAccuracyMeters).setStyle(style);
      } else {
        memberAccuracyLayersRef.current.set(
          member.id,
          L.circle(latLng, { ...style, radius: member.horizontalAccuracyMeters }).addTo(map),
        );
      }
    }
  }, [memberLabel, members]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = tuples(draftPolygon ?? []);
    if (selectedAreaId || points.length === 0) {
      draftLayerRef.current?.removeFrom(map);
      draftLayerRef.current = null;
      return;
    }
    const style: L.PathOptions = { color: "#0755c9", dashArray: "7 5", fillColor: "#4f9d8a", fillOpacity: 0.22, weight: 3 };
    if (!draftLayerRef.current) draftLayerRef.current = L.polygon(points, style).addTo(map);
    else draftLayerRef.current.setLatLngs(points).setStyle(style);
  }, [draftPolygon, selectedAreaId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const handle of editHandlesRef.current) handle.removeFrom(map);
    editHandlesRef.current = [];
    const points = (draftPolygon ?? []).filter(validCoordinate);
    if (!drawing || points.length === 0) return;

    points.forEach((point, index) => {
      const marker = L.marker([point.latitude, point.longitude], {
        icon: vertexIcon("vertex"),
        draggable: true,
        keyboard: true,
        title: vertexLabel(index, index === 0 && points.length >= 3),
      }).addTo(map);
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        if (index === 0 && points.length >= 3) onFinishRef.current?.();
      });
      marker.on("drag", () => {
        const latLng = marker.getLatLng();
        const next = points.map((candidate, candidateIndex) => candidateIndex === index
          ? [latLng.lat, latLng.lng] as L.LatLngTuple
          : [candidate.latitude, candidate.longitude] as L.LatLngTuple);
        const polygon = selectedAreaId ? areaLayersRef.current.get(selectedAreaId) : draftLayerRef.current;
        polygon?.setLatLngs(next);
      });
      marker.on("dragend", () => {
        const latLng = marker.getLatLng();
        onMoveRef.current?.(index, { latitude: latLng.lat, longitude: latLng.lng });
      });
      makeEditableHandleAccessible(
        marker,
        vertexLabel(index, index === 0 && points.length >= 3),
        () => { if (index === 0 && points.length >= 3) onFinishRef.current?.(); },
        (next) => onMoveRef.current?.(index, next),
      );
      editHandlesRef.current.push(marker);
    });

    if (points.length >= 2) points.forEach((point, index) => {
      const nextIndex = (index + 1) % points.length;
      if (points.length < 3 && nextIndex === 0) return;
      const center = midpoint(point, points[nextIndex]!);
      const marker = L.marker([center.latitude, center.longitude], {
        icon: vertexIcon("midpoint"), keyboard: true, title: midpointLabel(index),
      }).addTo(map);
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        onInsertRef.current?.(nextIndex, center);
      });
      makeEditableHandleAccessible(marker, midpointLabel(index), () => onInsertRef.current?.(nextIndex, center));
      editHandlesRef.current.push(marker);
    });
  }, [draftPolygon, drawing, midpointLabel, selectedAreaId, vertexLabel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const stateByEquipmentId = new Map(trackedAssets.map((state) => [state.equipment.id, state]));
    const additionalPoints = [
      ...equipment.flatMap((item) => {
        const point = equipmentMapPoint(item, stateByEquipmentId.get(item.id) ?? null, areas, houses);
        return point ? [point.coordinate] : [];
      }),
      ...members.filter((member) => (
        validCoordinate(member.coordinate)
        && Date.parse(member.sharingUntil) > Date.now()
      )).map((member) => member.coordinate),
    ];
    const plan = propertyViewportPlan(areas, houses, propertyLocation, viewportKey, additionalPoints);
    if (!plan || appliedViewportRef.current === plan.state) return;
    if (plan.points.length === 1) map.setView(plan.points[0]!, AREA_ZOOM, { animate: false });
    else map.fitBounds(plan.points, { animate: false, maxZoom: AREA_ZOOM, padding: VIEWPORT_PADDING });
    appliedViewportRef.current = plan.state;
  }, [areas, equipment, houses, members, propertyLocation, trackedAssets, viewportKey]);

  return <div ref={containerRef} className={`property-area-map ${drawing ? "is-drawing" : ""}${editableHouseId || editableAssetId || editableEquipmentId ? " is-placing-house" : ""}`} role="region" aria-label={ariaLabel} />;
}
