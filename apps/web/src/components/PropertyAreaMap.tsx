import { useEffect, useRef } from "react";
import type { GeoCoordinate, House, HouseLocation, PropertyArea } from "@climate-twin/contracts";
import L, { type Map as LeafletMap, type Marker, type Polygon } from "leaflet";
import "leaflet/dist/leaflet.css";
import { layerConfidence, layerVisualStrength, type SpatialLayerSnapshot, type SpatialTopology } from "../spatialLayers";

type PropertyMapHouse = Pick<House, "id" | "name" | "location" | "mapPlacement">;

export interface PropertyAreaMapProps {
  areas: readonly PropertyArea[];
  houses?: readonly PropertyMapHouse[];
  propertyLocation?: Pick<HouseLocation, "latitude" | "longitude"> | null;
  selectedAreaId: string | null;
  selectedHouseId?: string | null;
  editableHouseId?: string | null;
  selectedAssetId?: string | null;
  editableAssetId?: string | null;
  draftPolygon?: readonly GeoCoordinate[] | null;
  drawing?: boolean;
  onSelectArea: (id: string) => void;
  onSelectHouse?: (id: string) => void;
  onMoveHouse?: (id: string, point: GeoCoordinate) => void;
  onSelectAsset?: (id: string) => void;
  onMoveAsset?: (id: string, point: GeoCoordinate) => void;
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

function houseCoordinate(house: PropertyMapHouse): GeoCoordinate | null {
  const source = house.mapPlacement ?? house.location;
  if (!source) return null;
  const point = { latitude: source.latitude, longitude: source.longitude };
  return validCoordinate(point) ? point : null;
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
  if (areaPoints.length > 0 || housePoints.length > 0) {
    return { state: `${viewportKey}:geometry`, points: [...areaPoints, ...housePoints] };
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

function fixedAssetIcon(kind: PropertyArea["kind"], selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `property-asset-marker-wrap kind-${kind}${selected ? " is-selected" : ""}`,
    html: '<span class="property-asset-marker" aria-hidden="true"></span>',
    iconSize: [28, 34],
    iconAnchor: [14, 30],
  });
}

function vertexIcon(kind: "vertex" | "midpoint"): L.DivIcon {
  const size = kind === "vertex" ? 18 : 12;
  return L.divIcon({
    className: `property-map-handle-wrap ${kind}`,
    html: `<span class="property-map-handle" aria-hidden="true"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
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
  selectedAreaId,
  selectedHouseId = null,
  editableHouseId = null,
  selectedAssetId = null,
  editableAssetId = null,
  draftPolygon = null,
  drawing = false,
  onSelectArea,
  onSelectHouse,
  onMoveHouse,
  onSelectAsset,
  onMoveAsset,
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
}: Readonly<PropertyAreaMapProps>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const areaLayersRef = useRef(new Map<string, Polygon>());
  const houseLayersRef = useRef(new Map<string, Marker>());
  const assetLayersRef = useRef(new Map<string, Marker>());
  const draftLayerRef = useRef<Polygon | null>(null);
  const editHandlesRef = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelectArea);
  const onSelectHouseRef = useRef(onSelectHouse);
  const onMoveHouseRef = useRef(onMoveHouse);
  const onSelectAssetRef = useRef(onSelectAsset);
  const onMoveAssetRef = useRef(onMoveAsset);
  const onAppendRef = useRef(onAppendVertex);
  const onMoveRef = useRef(onMoveVertex);
  const onInsertRef = useRef(onInsertVertex);
  const onFinishRef = useRef(onFinishDrawing);
  const drawingRef = useRef(drawing);
  const editableHouseIdRef = useRef(editableHouseId);
  const editableAssetIdRef = useRef(editableAssetId);
  const houseIdsRef = useRef(new Set(houses.map((house) => house.id)));
  const assetIdsRef = useRef(new Set(areas.map((area) => area.id)));
  const appliedViewportRef = useRef<string | null>(null);

  onSelectRef.current = onSelectArea;
  onSelectHouseRef.current = onSelectHouse;
  onMoveHouseRef.current = onMoveHouse;
  onSelectAssetRef.current = onSelectAsset;
  onMoveAssetRef.current = onMoveAsset;
  onAppendRef.current = onAppendVertex;
  onMoveRef.current = onMoveVertex;
  onInsertRef.current = onInsertVertex;
  onFinishRef.current = onFinishDrawing;
  drawingRef.current = drawing;
  editableHouseIdRef.current = editableHouseId;
  editableAssetIdRef.current = editableAssetId;
  houseIdsRef.current = new Set(houses.map((house) => house.id));
  assetIdsRef.current = new Set(areas.map((area) => area.id));

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      if (drawingRef.current) {
        onAppendRef.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
        return;
      }
      const houseId = editableHouseIdRef.current;
      if (houseId && houseIdsRef.current.has(houseId)) {
        onMoveHouseRef.current?.(houseId, { latitude: event.latlng.lat, longitude: event.latlng.lng });
        return;
      }
      const assetId = editableAssetIdRef.current;
      if (assetId && assetIdsRef.current.has(assetId)) {
        onMoveAssetRef.current?.(assetId, { latitude: event.latlng.lat, longitude: event.latlng.lng });
      }
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
      houseLayersRef.current.clear();
      assetLayersRef.current.clear();
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
    const locatedAssets = new Set(areas.filter((area) => area.location && validCoordinate(area.location)).map((area) => area.id));
    for (const [id, marker] of assetLayersRef.current) {
      if (!locatedAssets.has(id)) {
        marker.removeFrom(map);
        assetLayersRef.current.delete(id);
      }
    }
    for (const area of areas) {
      if (!area.location || !validCoordinate(area.location)) continue;
      const selected = area.id === selectedAssetId;
      const draggable = area.id === editableAssetId;
      const latLng: L.LatLngExpression = [area.location.latitude, area.location.longitude];
      const existing = assetLayersRef.current.get(area.id);
      const marker = existing ?? L.marker(latLng, {
        icon: fixedAssetIcon(area.kind, selected), keyboard: true, draggable, autoPan: true, title: area.name, alt: area.name,
      }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(fixedAssetIcon(area.kind, selected));
      else {
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
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
  }, [areas, editableAssetId, selectedAssetId]);

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
      const marker = existing ?? L.marker(latLng, { icon: houseIcon(layer, selected), keyboard: true, draggable, autoPan: true, title: house.name, alt: house.name }).addTo(map);
      if (existing) marker.setLatLng(latLng).setIcon(houseIcon(layer, selected));
      else {
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
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
      editHandlesRef.current.push(marker);
    });
  }, [draftPolygon, drawing, midpointLabel, selectedAreaId, vertexLabel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const plan = propertyViewportPlan(areas, houses, propertyLocation, viewportKey);
    if (!plan || appliedViewportRef.current === plan.state) return;
    if (plan.points.length === 1) map.setView(plan.points[0]!, AREA_ZOOM, { animate: false });
    else map.fitBounds(plan.points, { animate: false, maxZoom: AREA_ZOOM, padding: VIEWPORT_PADDING });
    appliedViewportRef.current = plan.state;
  }, [areas, houses, propertyLocation, viewportKey]);

  return <div ref={containerRef} className={`property-area-map ${drawing ? "is-drawing" : ""}${editableHouseId || editableAssetId ? " is-placing-house" : ""}`} role="region" aria-label={ariaLabel} />;
}
