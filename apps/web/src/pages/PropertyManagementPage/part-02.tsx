import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AreaEquipment,
  GeoCoordinate,
  PropertyNote,
} from "@climate-twin/contracts";
import "../PropertyManagementPage.css";
import { EQUIPMENT_DRAFT_MAP_ID, mapCoordinateInput, placementInput } from "./support";
import type { MapCatalogEntry, MapItemKind } from "./support";
import { usePropertyManagementPagePart01 } from "./part-01";
export function usePropertyManagementPagePart02(context: ReturnType<typeof usePropertyManagementPagePart01>) {
  const { t, now, property, houses, areas, fixedAssets, equipment, equipmentDestination, equipmentName, equipmentKind, equipmentManufacturer, equipmentModel, equipmentSerialNumber, equipmentStatus, equipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, structureQuery, mapItemQuery, mapItemFilter, mapItemLimit, mapItemSelection, trackedEquipment, trackingCapabilities, trackingSnapshot, trackingEndpoints, selectedEquipmentId } = context;
  const equipmentDocumentInputRef = useRef<HTMLInputElement>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<PropertyNote["kind"]>("note");
  const [noteTarget, setNoteTarget] = useState("property:");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceHouseId, setMaintenanceHouseId] = useState("");
  const [maintenanceEquipmentId, setMaintenanceEquipmentId] = useState("");
  const [placementHouseId, setPlacementHouseId] = useState("");
  const [placementLatitude, setPlacementLatitude] = useState("");
  const [placementLongitude, setPlacementLongitude] = useState("");
  const [placementWidth, setPlacementWidth] = useState("12");
  const [placementOrientation, setPlacementOrientation] = useState("");
  const [placementEditing, setPlacementEditing] = useState(false);
  const [placementAssetId, setPlacementAssetId] = useState("");
  const [assetPlacementEditing, setAssetPlacementEditing] = useState(false);
  const [assetDraftLocation, setAssetDraftLocation] = useState<GeoCoordinate | null>(null);
  const [assetLatitudeInput, setAssetLatitudeInput] = useState("");
  const [assetLongitudeInput, setAssetLongitudeInput] = useState("");
  const trackingStates = trackingSnapshot && property && trackingSnapshot.propertyId === property.id
      ? trackingSnapshot.equipment
      : trackedEquipment;
  const trackingByEquipmentId = useMemo(
      () => new Map(trackingStates.map((item) => [item.equipment.id, item])),
      [trackingStates],
    );
  const trackingEnabled = trackingCapabilities?.flags["tracking.enabled"] === true;
  const liveMapEnabled = trackingEnabled
      && trackingCapabilities?.flags["tracking.liveMap.enabled"] === true;
  const selectedEquipment = equipment.find((item) => item.id === selectedEquipmentId) ?? null;
  const mapSelectedEquipment = mapItemSelection?.kind === "equipment"
      ? equipment.find((item) => item.id === mapItemSelection.id) ?? null
      : null;
  const selectedEquipmentResourceId = selectedEquipment?.id ?? null;
  const selectedTracking = selectedEquipment ? trackingByEquipmentId.get(selectedEquipment.id) ?? null : null;
  const sharedMembers = useMemo(() => (
      trackingCapabilities?.flags["tracking.userLocationSharing.enabled"]
        ? trackingSnapshot?.members.filter((member) => (
          Number.isFinite(member.coordinate.latitude)
          && member.coordinate.latitude >= -90
          && member.coordinate.latitude <= 90
          && Number.isFinite(member.coordinate.longitude)
          && member.coordinate.longitude >= -180
          && member.coordinate.longitude <= 180
          && Number.isFinite(member.horizontalAccuracyMeters)
          && member.horizontalAccuracyMeters > 0
          && Date.parse(member.sharingUntil) > now
        )) ?? []
        : []
    ), [now, trackingCapabilities, trackingSnapshot?.members]);
  const assignedEndpointIds = useMemo(
      () => new Set(trackingStates.flatMap((item) => item.binding ? [item.binding.endpointId] : [])),
      [trackingStates],
    );
  const availableTrackingEndpoints = trackingEndpoints.filter((endpoint) => (
      (endpoint.claimStatus === "CLAIMED" || endpoint.claimStatus === "DEGRADED")
      && !assignedEndpointIds.has(endpoint.id)
    ));
  const equipmentLatitudeValue = Number(equipmentLatitude);
  const equipmentLongitudeValue = Number(equipmentLongitude);
  const equipmentPinEmpty = !equipmentLatitude.trim() && !equipmentLongitude.trim();
  const equipmentPinValid = equipmentPinEmpty || (
      equipmentLatitude.trim() !== ""
      && equipmentLongitude.trim() !== ""
      && Number.isFinite(equipmentLatitudeValue)
      && equipmentLatitudeValue >= -90
      && equipmentLatitudeValue <= 90
      && Number.isFinite(equipmentLongitudeValue)
      && equipmentLongitudeValue >= -180
      && equipmentLongitudeValue <= 180
    );
  const equipmentDraftMapLocation = !equipmentPinEmpty && equipmentPinValid
      ? { latitude: equipmentLatitudeValue, longitude: equipmentLongitudeValue }
      : null;
  const equipmentPinMapItem = useMemo<AreaEquipment | null>(() => {
      if (!property) return null;
      const placement = placementInput(equipmentDestination);
      return {
        id: EQUIPMENT_DRAFT_MAP_ID,
        propertyId: property.id,
        areaId: placement.areaId ?? null,
        houseId: placement.houseId ?? null,
        ...(equipmentDraftMapLocation ? { location: equipmentDraftMapLocation } : {}),
        name: equipmentName.trim() || t("properties.inventoryManualPin"),
        kind: equipmentKind.trim() || "equipment",
        manufacturer: equipmentManufacturer.trim() || null,
        model: equipmentModel.trim() || null,
        serialNumber: equipmentSerialNumber.trim() || null,
        status: equipmentStatus,
        notes: equipmentNotes.trim() || null,
        createdAt: "",
        updatedAt: "",
      };
    }, [
      equipmentDestination,
      equipmentDraftMapLocation,
      equipmentKind,
      equipmentManufacturer,
      equipmentModel,
      equipmentName,
      equipmentNotes,
      equipmentSerialNumber,
      equipmentStatus,
      property,
      t,
    ]);
  const updateEquipmentPinFromMap = useCallback((_id: string, point: GeoCoordinate) => {
      setEquipmentLatitude(mapCoordinateInput(point.latitude));
      setEquipmentLongitude(mapCoordinateInput(point.longitude));
    }, []);
  const equipmentLocationLabel = useCallback((item: AreaEquipment): string => {
      if (item.areaId) return areas.find((area) => area.id === item.areaId)?.name ?? t("properties.inventoryUnknownArea");
      if (item.houseId) return houses.find((house) => house.id === item.houseId)?.name ?? t("properties.inventoryUnknownHome");
      if (item.location) return t("properties.inventoryPinnedLocation");
      return t("properties.inventoryUnassigned");
    }, [areas, houses, t]);
  const normalizedStructureQuery = structureQuery.trim().toLocaleLowerCase();
  const sidebarHouses = useMemo(() => houses.filter((house) => !normalizedStructureQuery || [
      house.name,
      house.location?.label,
      house.timezone,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedStructureQuery))), [houses, normalizedStructureQuery]);
  const sidebarAreas = useMemo(() => areas.filter((area) => !normalizedStructureQuery || [
      area.name,
      area.description,
      t(`properties.areaKind.${area.kind}`),
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedStructureQuery))), [areas, normalizedStructureQuery, t]);
  const mapCatalogItems = useMemo<MapCatalogEntry[]>(() => {
      const entries: MapCatalogEntry[] = [
        ...houses.map((house) => {
          const detail = house.mapPlacement
            ? t("placement.scaled")
            : house.location ? t("placement.pinOnly") : t("placement.unplaced");
          return {
            id: house.id,
            kind: "home" as const,
            label: house.name,
            detail,
            searchText: `${house.name} ${house.location?.label ?? ""} ${house.timezone} ${t("properties.houses")} ${detail}`,
          };
        }),
        ...fixedAssets.map((asset) => {
          const detail = asset.location ? t("properties.assetPlaced") : t("placement.unplaced");
          return {
            id: asset.id,
            kind: "asset" as const,
            label: asset.name,
            detail,
            searchText: `${asset.name} ${asset.description ?? ""} ${t(`properties.areaKind.${asset.kind}`)} ${t("properties.fixedAssets")} ${detail}`,
          };
        }),
        ...equipment.map((item) => {
          const tracking = trackingByEquipmentId.get(item.id);
          const detail = tracking?.position?.freshness
            ? t(`properties.inventoryTracking.${tracking.position.freshness}`)
            : equipmentLocationLabel(item);
          return {
            id: item.id,
            kind: "equipment" as const,
            label: item.name,
            detail,
            searchText: `${item.name} ${item.kind} ${item.manufacturer ?? ""} ${item.model ?? ""} ${item.serialNumber ?? ""} ${t("properties.mapEquipment")} ${detail}`,
          };
        }),
        ...sharedMembers.map((member) => {
          const detail = t("properties.mapMemberAccuracy", { meters: Math.round(member.horizontalAccuracyMeters) });
          return {
            id: member.id,
            kind: "person" as const,
            label: member.memberLabel,
            detail,
            searchText: `${member.memberLabel} ${t("properties.mapPeople")} ${detail}`,
          };
        }),
      ];
      const kindOrder: Record<MapItemKind, number> = { home: 0, asset: 1, equipment: 2, person: 3 };
      return entries.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.label.localeCompare(right.label));
    }, [equipment, equipmentLocationLabel, fixedAssets, houses, sharedMembers, t, trackingByEquipmentId]);
  const normalizedMapItemQuery = mapItemQuery.trim().toLocaleLowerCase();
  const matchingMapCatalogItems = useMemo(() => mapCatalogItems.filter((item) => (
      (mapItemFilter === "all" || item.kind === mapItemFilter)
      && (!normalizedMapItemQuery || item.searchText.toLocaleLowerCase().includes(normalizedMapItemQuery))
    )), [mapCatalogItems, mapItemFilter, normalizedMapItemQuery]);
  const visibleMapCatalogItems = matchingMapCatalogItems.slice(0, mapItemLimit);
  return Object.assign(context, { equipmentDocumentInputRef, selectedEndpointId, setSelectedEndpointId, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, noteFormOpen, setNoteFormOpen, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, mapSelectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedEndpointIds, availableTrackingEndpoints, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems });
}
