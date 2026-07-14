import { useEffect, useRef } from "react";
import type { Floor } from "@climate-twin/contracts";
import L, {
  type Map as LeafletMap,
  type Marker,
  type Polygon,
  type Polyline,
} from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapLocation {
  latitude: number;
  longitude: number;
}

export type HouseLocationMapFloor = Pick<Floor, "width" | "height" | "walls">;

export interface HouseLocationMapItem {
  id: string;
  label: string;
  location: MapLocation | null;
  orientationDegrees?: number;
  metersPerPlanUnit?: number;
  floor?: HouseLocationMapFloor;
}

export interface HouseLocationMapProps {
  items: readonly HouseLocationMapItem[];
  selectedHouseId: string | null;
  editable?: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, location: MapLocation) => void;
  ariaLabel: string;
  /** Controls intentional viewport moves. Draft coordinate changes do not retrigger one. */
  viewport?: "all" | "selected";
}

interface PlanPoint {
  x: number;
  y: number;
}

interface GeographicFootprint {
  polygon: L.LatLngTuple[];
  topEdge: L.LatLngTuple[];
}

interface HouseLayers {
  marker: Marker;
  polygon?: Polygon;
  topEdge?: Polyline;
}

const FINLAND_CENTER: L.LatLngExpression = [64.5, 26];
const DEFAULT_ZOOM = 5;
const HOUSE_LOCATION_ZOOM = 17;
const EARTH_RADIUS_METERS = 6_378_137;
const VIEWPORT_PADDING: L.PointExpression = [24, 24];
const MAX_PLAN_COORDINATE = 1_000_000;

function isLocation(value: MapLocation | null): value is MapLocation {
  return value !== null
    && Number.isFinite(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && Number.isFinite(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180;
}

function validOrientation(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 360;
}

function validScale(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safePlanCoordinate(value: number): number {
  return Math.max(-MAX_PLAN_COORDINATE, Math.min(MAX_PLAN_COORDINATE, value));
}

function planBounds(floor: HouseLocationMapFloor): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points: PlanPoint[] = [];
  if (Number.isFinite(floor.width) && Number.isFinite(floor.height) && floor.width > 0 && floor.height > 0) {
    points.push(
      { x: 0, y: 0 },
      { x: safePlanCoordinate(floor.width), y: safePlanCoordinate(floor.height) },
    );
  }
  for (const wall of floor.walls) {
    for (const point of [wall.from, wall.to]) {
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        points.push({ x: safePlanCoordinate(point.x), y: safePlanCoordinate(point.y) });
      }
    }
  }
  if (points.length < 2) return null;

  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return maxX > minX && maxY > minY ? { minX, minY, maxX, maxY } : null;
}

function geographicPoint(
  center: MapLocation,
  point: PlanPoint,
  planCenter: PlanPoint,
  metersPerPlanUnit: number,
  orientationDegrees: number,
): L.LatLngTuple {
  const radians = orientationDegrees * Math.PI / 180;
  const planEastMeters = (point.x - planCenter.x) * metersPerPlanUnit;
  const planSouthMeters = (point.y - planCenter.y) * metersPerPlanUnit;
  const eastMeters = planEastMeters * Math.cos(radians) - planSouthMeters * Math.sin(radians);
  const northMeters = -(planEastMeters * Math.sin(radians) + planSouthMeters * Math.cos(radians));
  const latitude = center.latitude + northMeters / EARTH_RADIUS_METERS * 180 / Math.PI;
  const longitudeScale = Math.max(Math.abs(Math.cos(center.latitude * Math.PI / 180)), 1e-6);
  const longitude = center.longitude + eastMeters / (EARTH_RADIUS_METERS * longitudeScale) * 180 / Math.PI;
  return [latitude, longitude];
}

function geographicFootprint(item: HouseLocationMapItem): GeographicFootprint | null {
  if (
    !isLocation(item.location)
    || !item.floor
    || !validOrientation(item.orientationDegrees)
    || !validScale(item.metersPerPlanUnit)
    || Math.abs(item.location.latitude) >= 89.9
  ) return null;

  const bounds = planBounds(item.floor);
  if (!bounds) return null;
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  const convert = (point: PlanPoint) => geographicPoint(
    item.location!,
    point,
    center,
    item.metersPerPlanUnit!,
    item.orientationDegrees!,
  );
  return {
    polygon: [
      convert({ x: bounds.minX, y: bounds.minY }),
      convert({ x: bounds.maxX, y: bounds.minY }),
      convert({ x: bounds.maxX, y: bounds.maxY }),
      convert({ x: bounds.minX, y: bounds.maxY }),
    ],
    topEdge: [
      convert({ x: bounds.minX, y: bounds.minY }),
      convert({ x: bounds.maxX, y: bounds.minY }),
    ],
  };
}

function handleIcon(selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `house-location-marker-wrap${selected ? " is-selected" : ""}`,
    // Labels never enter this HTML; they are assigned to DOM attributes below.
    html: '<span class="house-location-marker" aria-hidden="true"></span>',
    iconSize: [30, 38],
    iconAnchor: [15, 38],
  });
}

function updateHandle(marker: Marker, label: string, selected: boolean, draggable: boolean) {
  marker.options.title = label;
  marker.options.alt = label;
  marker.options.draggable = draggable;
  marker.setIcon(handleIcon(selected));
  marker.setZIndexOffset(selected ? 1000 : 0);
  if (draggable) marker.dragging?.enable();
  else marker.dragging?.disable();

  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
  element.setAttribute("role", "button");
  element.setAttribute("aria-pressed", String(selected));
}

function removeHouseLayers(map: LeafletMap, layers: HouseLayers) {
  layers.marker.removeFrom(map);
  layers.polygon?.removeFrom(map);
  layers.topEdge?.removeFrom(map);
}

function locationPoints(item: HouseLocationMapItem): L.LatLngTuple[] {
  if (!isLocation(item.location)) return [];
  return geographicFootprint(item)?.polygon ?? [[item.location.latitude, item.location.longitude]];
}

export function HouseLocationMap({
  items,
  selectedHouseId,
  editable = false,
  onSelect,
  onChange,
  ariaLabel,
  viewport = "all",
}: HouseLocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef(new Map<string, HouseLayers>());
  const appliedViewportRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  const onChangeRef = useRef(onChange);
  const selectedHouseIdRef = useRef(selectedHouseId);
  const editableRef = useRef(editable);
  const itemIdsRef = useRef(new Set(items.map((item) => item.id)));

  onSelectRef.current = onSelect;
  onChangeRef.current = onChange;
  selectedHouseIdRef.current = selectedHouseId;
  editableRef.current = editable;
  itemIdsRef.current = new Set(items.map((item) => item.id));

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
      center: FINLAND_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      const id = selectedHouseIdRef.current;
      if (!editableRef.current || id === null || !itemIdsRef.current.has(id)) return;
      onChangeRef.current(id, { latitude: event.latlng.lat, longitude: event.latlng.lng });
    });
    mapRef.current = map;
    const invalidateTimer = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(invalidateTimer);
      layersRef.current.clear();
      appliedViewportRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const locatedItems = new Map<string, HouseLocationMapItem>();
    for (const item of items) {
      if (isLocation(item.location)) locatedItems.set(item.id, item);
    }

    for (const [id, layers] of layersRef.current) {
      if (!locatedItems.has(id)) {
        removeHouseLayers(map, layers);
        layersRef.current.delete(id);
      }
    }

    for (const item of locatedItems.values()) {
      const location = item.location!;
      const selected = item.id === selectedHouseId;
      const draggable = selected && editable;
      const latLng: L.LatLngExpression = [location.latitude, location.longitude];
      let layers = layersRef.current.get(item.id);
      if (!layers) {
        const marker = L.marker(latLng, {
          draggable,
          keyboard: true,
          title: item.label,
          alt: item.label,
          icon: handleIcon(selected),
          autoPan: true,
        }).addTo(map);
        marker.on("click", () => onSelectRef.current(item.id));
        marker.on("dragend", () => {
          const next = marker.getLatLng();
          onChangeRef.current(item.id, { latitude: next.lat, longitude: next.lng });
        });
        layers = { marker };
        layersRef.current.set(item.id, layers);
      } else {
        layers.marker.setLatLng(latLng);
      }
      updateHandle(layers.marker, item.label, selected, draggable);

      const footprint = geographicFootprint(item);
      if (!footprint) {
        layers.polygon?.removeFrom(map);
        layers.topEdge?.removeFrom(map);
        delete layers.polygon;
        delete layers.topEdge;
        continue;
      }

      const footprintStyle: L.PathOptions = {
        color: selected ? "#0755c9" : "#174f43",
        fillColor: selected ? "#4f9d8a" : "#79aa9c",
        fillOpacity: selected ? 0.34 : 0.22,
        opacity: selected ? 1 : 0.82,
        weight: selected ? 3 : 2,
        interactive: false,
      };
      if (layers.polygon) {
        layers.polygon.setLatLngs(footprint.polygon);
        layers.polygon.setStyle(footprintStyle);
      } else {
        layers.polygon = L.polygon(footprint.polygon, footprintStyle).addTo(map);
      }
      if (layers.topEdge) {
        layers.topEdge.setLatLngs(footprint.topEdge);
        layers.topEdge.setStyle({ color: "#c75b12", opacity: 1, weight: selected ? 5 : 4, interactive: false });
      } else {
        layers.topEdge = L.polyline(footprint.topEdge, {
          color: "#c75b12",
          opacity: 1,
          weight: selected ? 5 : 4,
          interactive: false,
        }).addTo(map);
      }
    }
  }, [editable, items, selectedHouseId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const viewportKey = viewport === "selected" ? `selected:${selectedHouseId ?? ""}` : "all";
    if (appliedViewportRef.current === viewportKey) return;

    const requestedItems = viewport === "selected"
      ? items.filter((item) => item.id === selectedHouseId && isLocation(item.location))
      : items.filter((item) => isLocation(item.location));
    const points = requestedItems.flatMap(locationPoints);
    if (points.length === 0) return;

    if (requestedItems.length === 1) {
      const location = requestedItems[0]!.location!;
      map.setView([location.latitude, location.longitude], HOUSE_LOCATION_ZOOM, { animate: false });
    } else {
      map.fitBounds(points, { animate: false, maxZoom: HOUSE_LOCATION_ZOOM, padding: VIEWPORT_PADDING });
    }
    appliedViewportRef.current = viewportKey;
  }, [items, selectedHouseId, viewport]);

  return <div ref={containerRef} className="house-location-map" role="region" aria-label={ariaLabel} />;
}
