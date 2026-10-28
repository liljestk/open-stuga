import { useEffect, useMemo } from "react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  PropertyArea,
} from "@climate-twin/contracts";
import { api } from "../../api";
import "../PropertyManagementPage.css";
import { MAP_ITEM_BATCH_SIZE, NEW_FIXED_ASSET_ID, areaDraft, emptyAreaDraft, inventoryPlacement } from "./support";
import { usePropertyManagementPagePart02 } from "./part-02";
import { compareCodeUnits } from "../../textOrder";
export function usePropertyManagementPagePart03(context: ReturnType<typeof usePropertyManagementPagePart02>) {
  const { props, t, properties, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, houses, areas, fixedAssets, equipment, setSelectedAreaId, selectedArea, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, setDrawing, areaForm, setAreaForm, setRedoVertices, setCoordinateInput, setCoordinateError, setNewHouseName, setAreaDestinationPropertyId, setEquipmentDestination, setEditingProperty, setPropertyName, setPropertyDescription, setFeedback, setEditingEquipmentId, setEquipmentName, setEquipmentKind, setEquipmentManufacturer, setEquipmentModel, setEquipmentSerialNumber, setEquipmentStatus, setEquipmentNotes, setEquipmentLatitude, setEquipmentLongitude, setEquipmentPinMapOpen, inventoryQuery, inventoryStatus, inventoryLocation, setMapItemLimit, mapItemSelection, setMapItemSelection, setInventoryFormOpen, setTrackedEquipment, setTrackingCapabilities, setTrackingSnapshot, setTrackingEndpoints, setTrackingConnection, selectedEquipmentId, setEquipmentAttachments, setEquipmentLinks, setEquipmentResourcesState, equipmentResourcesRefresh, setEquipmentResourcesFeedback, setEquipmentLinkLabel, setEquipmentLinkUrl, setSelectedEndpointId, setNoteText, setNoteKind, setNoteTarget, setEditingNoteId, setMaintenanceTitle, setMaintenanceHouseId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingByEquipmentId, selectedEquipmentResourceId, matchingMapCatalogItems, visibleMapCatalogItems } = context;
  const remainingMapCatalogItems = Math.max(0, matchingMapCatalogItems.length - visibleMapCatalogItems.length);
  const inventoryLocationCount = useMemo(() => new Set(equipment.flatMap((item) => {
      if (item.areaId) return [`area:${item.areaId}`];
      if (item.houseId) return [`house:${item.houseId}`];
      if (item.location) return [`pin:${item.location.latitude}:${item.location.longitude}`];
      return [];
    })).size, [equipment]);
  const inventoryEquipmentVersion = useMemo(
      () => equipment.map((item) => `${item.id}:${item.updatedAt}`).sort(compareCodeUnits).join("|"),
      [equipment],
    );
  const visibleInventory = useMemo(() => {
      const query = inventoryQuery.trim().toLocaleLowerCase();
      return equipment.filter((item) => {
        if (inventoryStatus !== "all" && item.status !== inventoryStatus) return false;
        if (inventoryLocation !== "all" && inventoryPlacement(item) !== inventoryLocation) return false;
        if (!query) return true;
        const areaName = areas.find((area) => area.id === item.areaId)?.name ?? "";
        const houseName = houses.find((house) => house.id === item.houseId)?.name ?? "";
        return [
          item.name,
          item.kind,
          item.manufacturer,
          item.model,
          item.serialNumber,
          item.notes,
          areaName,
          houseName,
        ].some((value) => value?.toLocaleLowerCase().includes(query));
      }).sort((left, right) => left.name.localeCompare(right.name));
    }, [areas, equipment, houses, inventoryLocation, inventoryQuery, inventoryStatus]);
  const inventoryAttentionCount = useMemo(() => equipment.filter((item) => {
      if (item.status === "out-of-service") return true;
      const tracked = trackingByEquipmentId.get(item.id);
      const batteryPercent = tracked?.endpoint.telemetry.batteryPercent;
      return Boolean(
        tracked
        && ((typeof batteryPercent === "number" && batteryPercent <= 20)
          || ["stale", "unknown"].includes(tracked.position?.freshness ?? "unknown")),
      );
    }).length, [equipment, trackingByEquipmentId]);
  const placementAsset = areas.find((area) => area.id === placementAssetId);
  const editingFixedAsset = isNewFixedAsset || Boolean(selectedArea && selectedArea.polygon.length === 0);
  const assetLatitude = Number(assetLatitudeInput);
  const assetLongitude = Number(assetLongitudeInput);
  const assetCoordinateInputsValid = assetLatitudeInput.trim() !== "" && assetLongitudeInput.trim() !== ""
      && Number.isFinite(assetLatitude) && assetLatitude >= -90 && assetLatitude <= 90
      && Number.isFinite(assetLongitude) && assetLongitude >= -180 && assetLongitude <= 180;
  const updateFixedAssetCoordinate = (axis: "latitude" | "longitude", value: string) => {
      const latitudeText = axis === "latitude" ? value : assetLatitudeInput;
      const longitudeText = axis === "longitude" ? value : assetLongitudeInput;
      if (axis === "latitude") setAssetLatitudeInput(value);
      else setAssetLongitudeInput(value);
      const latitude = Number(latitudeText);
      const longitude = Number(longitudeText);
      if (!latitudeText.trim() || !longitudeText.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
      const location = { latitude, longitude };
      setAreaForm((current) => ({ ...current, location }));
      setAssetDraftLocation(location);
      setAssetPlacementEditing(true);
    };
  const mapAreas = useMemo(() => {
      const positioned = areas.map((area) => area.id === placementAsset?.id && assetPlacementEditing
        ? { ...area, ...(assetDraftLocation ? { location: assetDraftLocation } : {}) }
        : area);
      if (!isNewArea || !isNewFixedAsset || !property) return positioned;
      const draft: PropertyArea = {
        id: NEW_FIXED_ASSET_ID,
        propertyId: property.id,
        name: areaForm.name.trim() || t("properties.newFixedAsset"),
        kind: areaForm.kind,
        description: areaForm.description.trim() || null,
        ...(areaForm.location ? { location: areaForm.location } : {}),
        polygon: [],
        createdAt: "",
        updatedAt: "",
      };
      return [...positioned, draft];
    }, [areaForm, areas, assetDraftLocation, assetPlacementEditing, isNewArea, isNewFixedAsset, placementAsset?.id, property, t]);
  useEffect(() => {
      if (!selectedEquipmentResourceId) {
        setEquipmentAttachments([]);
        setEquipmentLinks([]);
        setEquipmentResourcesState("idle");
        setEquipmentResourcesFeedback(null);
        setEquipmentLinkLabel("");
        setEquipmentLinkUrl("");
        return;
      }
      let active = true;
      setEquipmentResourcesState("loading");
      setEquipmentResourcesFeedback(null);
      Promise.all([
        api.equipmentAttachments(selectedEquipmentResourceId),
        api.equipmentLinks(selectedEquipmentResourceId),
      ]).then(([attachments, links]) => {
        if (!active) return;
        setEquipmentAttachments(attachments);
        setEquipmentLinks(links);
        setEquipmentResourcesState("ready");
      }).catch(() => {
        if (!active) return;
        setEquipmentAttachments([]);
        setEquipmentLinks([]);
        setEquipmentResourcesState("error");
      });
      return () => { active = false; };
    }, [equipmentResourcesRefresh, selectedEquipmentResourceId]);
  useEffect(() => {
      if (!properties.some((candidate) => candidate.id === propertyId)) setPropertyId(properties[0]?.id ?? "");
    }, [properties, propertyId]);
  useEffect(() => {
      if (controlledPropertyAvailable && props.propertyId !== internalPropertyId) {
        setInternalPropertyId(props.propertyId!);
      }
    }, [controlledPropertyAvailable, internalPropertyId, props.propertyId]);
  useEffect(() => {
      const initialPropertyChanged = lastInitialPropertyIdRef.current !== props.initialPropertyId;
      lastInitialPropertyIdRef.current = props.initialPropertyId;
      if (!props.initialPropertyId
        || !properties.some((candidate) => candidate.id === props.initialPropertyId)
        || (!initialPropertyChanged && appliedInitialPropertyIdRef.current === props.initialPropertyId)) return;
      appliedInitialPropertyIdRef.current = props.initialPropertyId;
      setPropertyId(props.initialPropertyId);
    }, [props.initialPropertyId, properties]);
  useEffect(() => {
      setSelectedAreaId(null);
      setIsNewArea(false);
      setIsNewFixedAsset(false);
      setDrawing(false);
      setAreaForm(emptyAreaDraft());
      setRedoVertices([]);
      setCoordinateInput("");
      setCoordinateError(false);
      setEditingProperty(false);
      setEditingEquipmentId(null);
      setEquipmentName("");
      setEquipmentKind("");
      setEquipmentManufacturer("");
      setEquipmentModel("");
      setEquipmentSerialNumber("");
      setEquipmentStatus("active");
      setEquipmentNotes("");
      setEquipmentDestination("unassigned");
      setEquipmentLatitude("");
      setEquipmentLongitude("");
      setEquipmentPinMapOpen(false);
      setMapItemLimit(MAP_ITEM_BATCH_SIZE);
      setInventoryFormOpen(false);
      setTrackedEquipment([]);
      setTrackingCapabilities(null);
      setTrackingSnapshot(null);
      setTrackingEndpoints([]);
      setTrackingConnection("off");
      setSelectedEndpointId("");
      setEditingNoteId(null);
      setNoteText("");
      setNoteKind("note");
      setNoteTarget("property:");
      setFeedback(null);
      setPropertyName(property?.name ?? "");
      setPropertyDescription(property?.description ?? "");
      setMaintenanceTitle("");
      setMaintenanceHouseId("");
      setMaintenanceEquipmentId("");
      setPlacementEditing(false);
      setPlacementAssetId("");
      setAssetPlacementEditing(false);
      setAssetDraftLocation(null);
      setAssetLatitudeInput("");
      setAssetLongitudeInput("");
      setNewHouseName("");
      setAreaDestinationPropertyId(property?.id ?? "");
    }, [property?.id]);
  useEffect(() => {
      setMaintenanceHouseId((current) => houses.some((house) => house.id === current) ? current : "");
      setPlacementHouseId((current) => {
        const next = houses.some((house) => house.id === current) ? current : houses[0]?.id ?? "";
        if (next !== current) setPlacementEditing(false);
        return next;
      });
      setMapItemSelection((current) => current?.kind === "home" && !houses.some((house) => house.id === current.id)
        ? houses[0] ? { kind: "home", id: houses[0].id } : null
        : current);
    }, [houses]);
  useEffect(() => {
      if (mapItemSelection?.kind === "home") {
        setPlacementHouseId(mapItemSelection.id);
        return;
      }
      if (mapItemSelection?.kind !== "asset") return;
      const asset = fixedAssets.find((candidate) => candidate.id === mapItemSelection.id);
      if (!asset) return;
      setPlacementAssetId(asset.id);
      setSelectedAreaId(asset.id);
      setAreaForm(areaDraft(asset));
      setAssetDraftLocation(asset.location ? { ...asset.location } : null);
      setAssetLatitudeInput(asset.location ? String(asset.location.latitude) : "");
      setAssetLongitudeInput(asset.location ? String(asset.location.longitude) : "");
    }, [fixedAssets, mapItemSelection?.id, mapItemSelection?.kind]);
  useEffect(() => {
      setSelectedEndpointId("");
    }, [selectedEquipmentId]);
  const placementHouse = houses.find((house) => house.id === placementHouseId) ?? houses[0];
  useEffect(() => {
      if (!placementHouse || placementEditing) return;
      const source = placementHouse.mapPlacement ?? placementHouse.location;
      const floor = placementHouse.floors.find((candidate) => candidate.id === placementHouse.mapPlacement?.footprintFloorId)
        ?? placementHouse.floors.find((candidate) => candidate.type === "ground")
        ?? placementHouse.floors[0];
      setPlacementLatitude(source ? String(source.latitude) : "");
      setPlacementLongitude(source ? String(source.longitude) : "");
      const horizontalScale = floor ? floorMetersPerPlanUnit(floor, placementHouse) : null;
      setPlacementWidth(horizontalScale !== null && floor
        ? String(Number((horizontalScale * Math.max(1, floor.width)).toFixed(2)))
        : "12");
      setPlacementOrientation(placementHouse.orientationDegrees === undefined ? "" : String(placementHouse.orientationDegrees));
    }, [placementEditing, placementHouse?.id, placementHouse?.floors, placementHouse?.mapPlacement, placementHouse?.location, placementHouse?.orientationDegrees]);
  const mapHouses = useMemo(() => {
      if (!placementEditing || !placementHouse) return houses;
      const latitude = Number(placementLatitude);
      const longitude = Number(placementLongitude);
      const width = Number(placementWidth);
      const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
      if (!floor || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
        || !Number.isFinite(width) || width < 1 || width > 500) return houses;
      return houses.map((candidate) => candidate.id === placementHouse.id ? {
        ...candidate,
        mapPlacement: {
          latitude,
          longitude,
          metersPerPlanUnit: width / Math.max(1, floor.width),
          footprintFloorId: floor.id,
        },
      } : candidate);
    }, [houses, placementEditing, placementHouse, placementLatitude, placementLongitude, placementWidth]);
  return Object.assign(context, { remainingMapCatalogItems, inventoryLocationCount, inventoryEquipmentVersion, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetLatitude, assetLongitude, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, mapHouses });
}
