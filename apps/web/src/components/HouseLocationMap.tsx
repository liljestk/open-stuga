import { useEffect, useRef } from "react";
import L, { type Map as LeafletMap, type Marker } from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapLocation {
  latitude: number;
  longitude: number;
}

interface HouseLocationMapProps {
  value: MapLocation | null;
  onChange: (location: MapLocation) => void;
  ariaLabel: string;
  markerLabel: string;
}

const FINLAND_CENTER: L.LatLngExpression = [64.5, 26];

function updateMarkerLabel(marker: Marker, label: string) {
  marker.options.title = label;
  marker.options.alt = label;
  const element = marker.getElement();
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
}

export function HouseLocationMap({ value, onChange, ariaLabel, markerLabel }: HouseLocationMapProps) {
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
    if (markerRef.current) {
      markerRef.current.setLatLng(latLng);
      updateMarkerLabel(markerRef.current, markerLabel);
      map.panTo(latLng, { animate: false });
      return;
    }

    const marker = L.marker(latLng, {
      draggable: true,
      keyboard: true,
      title: markerLabel,
      alt: markerLabel,
      icon: L.divIcon({
        className: "house-location-marker-wrap",
        html: '<span class="house-location-marker" aria-hidden="true"></span>',
        iconSize: [30, 38],
        iconAnchor: [15, 38],
      }),
    }).addTo(map);
    updateMarkerLabel(marker, markerLabel);
    marker.on("dragend", () => {
      const next = marker.getLatLng();
      onChangeRef.current({ latitude: next.lat, longitude: next.lng });
    });
    markerRef.current = marker;
    map.panTo(latLng, { animate: false });
  }, [markerLabel, value]);

  return <div ref={containerRef} className="house-location-map" role="region" aria-label={ariaLabel} />;
}
