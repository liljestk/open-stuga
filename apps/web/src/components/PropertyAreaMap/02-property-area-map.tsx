import { useEffect, useRef } from "react";
import L, { type Circle, type Map as LeafletMap, type Marker, type Polygon } from "leaflet";
import "leaflet/dist/leaflet.css";
import { AREA_ZOOM, DEFAULT_CENTER, DEFAULT_ZOOM, PropertyAreaMapProps, VIEWPORT_PADDING, areaColors, equipmentIcon, equipmentMapPoint, fixedAssetIcon, houseCoordinate, houseIcon, houseLayerState, makeAreaLayerAccessible, makeEditableHandleAccessible, makeHouseMarkerAccessible, makeInformationalMarkerAccessible, memberIcon, midpoint, propertyIcon, propertyViewportPlan, tuples, validCoordinate, vertexIcon } from "./01-property-map-house-to-make-area-layer-accessible";

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
  trackedEquipment = [],
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
      if (event.dataTransfer?.types.includes("application/x-stugu-house-id")
        || event.dataTransfer?.types.includes("application/x-stugu-property-asset-id")) event.preventDefault();
    };
    const drop = (event: globalThis.DragEvent) => {
      const houseId = event.dataTransfer?.getData("application/x-stugu-house-id") ?? "";
      const assetId = event.dataTransfer?.getData("application/x-stugu-property-asset-id") ?? "";
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
    const stateByEquipmentId = new Map(trackedEquipment.map((state) => [state.equipment.id, state]));
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
      const freshness = state?.position?.freshness ?? "expected";
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
  }, [areas, editableEquipmentId, equipment, equipmentLabel, houses, selectedEquipmentId, trackedEquipment]);

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
    const stateByEquipmentId = new Map(trackedEquipment.map((state) => [state.equipment.id, state]));
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
  }, [areas, equipment, houses, members, propertyLocation, trackedEquipment, viewportKey]);

  return <div ref={containerRef} className={`property-area-map ${drawing ? "is-drawing" : ""}${editableHouseId || editableAssetId || editableEquipmentId ? " is-placing-house" : ""}`} role="region" aria-label={ariaLabel} />;
}
