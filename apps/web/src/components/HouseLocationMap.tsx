import { useEffect, useRef } from "react";
import type { Floor } from "@climate-twin/contracts";
import L, { type DivIcon, type Map as LeafletMap, type Marker } from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapLocation {
  latitude: number;
  longitude: number;
}

type FootprintFloor = Pick<Floor, "width" | "height" | "walls">;

interface HouseLocationMapProps {
  value: MapLocation | null;
  onChange: (location: MapLocation) => void;
  ariaLabel: string;
  markerLabel: string;
  orientationDegrees?: number;
  floor?: FootprintFloor;
  northLabel?: string;
  planTopLabel?: string;
  notToScaleLabel?: string;
}

const FINLAND_CENTER: L.LatLngExpression = [64.5, 26];
const ICON_SIZE = 112;
const DRAWING_SIZE = 64;
const DRAWING_PADDING = 9;
const MAX_PLAN_COORDINATE = 1_000_000;

function validOrientation(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 360;
}

function number(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function planCoordinate(value: number): number {
  return Math.max(-MAX_PLAN_COORDINATE, Math.min(MAX_PLAN_COORDINATE, value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function footprintMarkup(floor: FootprintFloor | undefined): { walls: string; top: string } {
  const validWalls = (floor?.walls ?? [])
    .filter((wall) => [wall.from.x, wall.from.y, wall.to.x, wall.to.y].every(Number.isFinite))
    .map((wall) => ({
      from: { x: planCoordinate(wall.from.x), y: planCoordinate(wall.from.y) },
      to: { x: planCoordinate(wall.to.x), y: planCoordinate(wall.to.y) },
    }));
  const coordinates = validWalls.flatMap((wall) => [wall.from, wall.to]);
  const fallbackWidth = floor && Number.isFinite(floor.width) && floor.width > 0 ? Math.min(floor.width, MAX_PLAN_COORDINATE) : 1;
  const fallbackHeight = floor && Number.isFinite(floor.height) && floor.height > 0 ? Math.min(floor.height, MAX_PLAN_COORDINATE) : 1;
  const minX = Math.min(0, ...coordinates.map((point) => point.x));
  const minY = Math.min(0, ...coordinates.map((point) => point.y));
  const maxX = Math.max(fallbackWidth, ...coordinates.map((point) => point.x));
  const maxY = Math.max(fallbackHeight, ...coordinates.map((point) => point.y));
  const width = Math.max(maxX - minX, 0.001);
  const height = Math.max(maxY - minY, 0.001);
  const usable = DRAWING_SIZE - DRAWING_PADDING * 2;
  const scale = Math.min(usable / width, usable / height);
  const offsetX = (DRAWING_SIZE - width * scale) / 2 - minX * scale;
  const offsetY = (DRAWING_SIZE - height * scale) / 2 - minY * scale;
  const x = (value: number) => number(offsetX + value * scale);
  const y = (value: number) => number(offsetY + value * scale);

  const walls = validWalls.length
    ? validWalls.map((wall) => `<line x1="${x(wall.from.x)}" y1="${y(wall.from.y)}" x2="${x(wall.to.x)}" y2="${y(wall.to.y)}" />`).join("")
    : `<rect x="${x(minX)}" y="${y(minY)}" width="${number(width * scale)}" height="${number(height * scale)}" />`;
  const top = `<line x1="${x(minX)}" y1="${y(minY)}" x2="${x(maxX)}" y2="${y(minY)}" />`;
  return { walls, top };
}

function neutralMarkerIcon(): DivIcon {
  return L.divIcon({
    className: "house-location-marker-wrap",
    html: '<span class="house-location-marker" aria-hidden="true"></span>',
    iconSize: [30, 38],
    iconAnchor: [15, 38],
  });
}

function orientedMarkerIcon(
  orientationDegrees: number,
  floor: FootprintFloor | undefined,
  northLabel: string,
  planTopLabel: string,
  notToScaleLabel: string,
): DivIcon {
  const drawing = footprintMarkup(floor);
  const safeNorthLabel = escapeHtml(northLabel);
  const safePlanTopLabel = escapeHtml(planTopLabel);
  const safeNotToScaleLabel = escapeHtml(notToScaleLabel);
  return L.divIcon({
    className: "house-orientation-marker-wrap",
    html: `<span class="house-orientation-marker" aria-hidden="true">
      <span class="house-map-north"><b>${safeNorthLabel}</b><i></i></span>
      <span class="house-footprint-rotator" style="transform:rotate(${number(orientationDegrees)}deg)">
        <svg viewBox="0 0 ${DRAWING_SIZE} ${DRAWING_SIZE}" focusable="false">
          <g class="house-footprint-walls">${drawing.walls}</g>
          <g class="house-plan-top-edge">${drawing.top}</g>
        </svg>
        <span class="house-plan-top-label">${safePlanTopLabel}</span>
      </span>
      <span class="house-map-not-scale">${safeNotToScaleLabel}</span>
    </span>`,
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
  });
}

function updateMarkerLabel(marker: Marker, label: string) {
  marker.options.title = label;
  marker.options.alt = label;
  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
}

export function HouseLocationMap({
  value,
  onChange,
  ariaLabel,
  markerLabel,
  orientationDegrees,
  floor,
  northLabel = "N",
  planTopLabel = "TOP",
  notToScaleLabel = "Not to scale",
}: HouseLocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;
    const initialCenter: L.LatLngExpression = value ? [value.latitude, value.longitude] : FINLAND_CENTER;
    const map = L.map(containerRef.current, {
      center: initialCenter,
      zoom: value ? 11 : 5,
      zoomControl: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      onChangeRef.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    });
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      markerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // The initial position is deliberately read once. Subsequent changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      if (markerRef.current) {
        markerRef.current.removeFrom(map);
        markerRef.current = null;
      }
      return;
    }

    const latLng = L.latLng(value.latitude, value.longitude);
    const icon = validOrientation(orientationDegrees)
      ? orientedMarkerIcon(orientationDegrees, floor, northLabel, planTopLabel, notToScaleLabel)
      : neutralMarkerIcon();
    if (markerRef.current) {
      markerRef.current.setLatLng(latLng);
      markerRef.current.setIcon(icon);
      updateMarkerLabel(markerRef.current, markerLabel);
      map.panTo(latLng, { animate: false });
      return;
    }

    const marker = L.marker(latLng, {
      draggable: true,
      keyboard: true,
      title: markerLabel,
      alt: markerLabel,
      icon,
    }).addTo(map);
    updateMarkerLabel(marker, markerLabel);
    marker.on("dragend", () => {
      const next = marker.getLatLng();
      onChangeRef.current({ latitude: next.lat, longitude: next.lng });
    });
    markerRef.current = marker;
    map.panTo(latLng, { animate: false });
  }, [floor, markerLabel, northLabel, notToScaleLabel, orientationDegrees, planTopLabel, value]);

  return <div ref={containerRef} className="house-location-map" role="region" aria-label={ariaLabel} />;
}
