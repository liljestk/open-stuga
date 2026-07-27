import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Building2,
  Battery,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardList,
  ExternalLink,
  FileText,
  HardHat,
  KeyRound,
  Link as LinkIcon,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Move,
  NotebookPen,
  Plus,
  QrCode,
  Radio,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
  Upload,
  Users,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AreaEquipmentStatus,
  EquipmentAttachment,
  EquipmentAttachmentKind,
  EquipmentLink,
  GeoCoordinate,
  GuestAccessGrant,
  HouseCreateInput,
  MaintenanceTask,
  MaintenanceTaskInput,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaKind,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  TenantMemberSummary,
  TrackingCapabilities,
  TrackingMapSnapshot,
  TrackingTag,
  TrackingTagProvisioningResult,
  TrackedEquipmentState,
} from "@climate-twin/contracts";
import { api, ApiRequestError, subscribeToTrackingEvents, type HouseGeoreferencePatch } from "../../api";
import { EquipmentQrLabel } from "../../components/EquipmentQrLabel";
import { StugubyMark } from "../../components/StugubyMark";
import type { ClimateState } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { derivePropertyTrafficLights, type PropertyTrafficLight } from "../../propertyStatus";
import { useNow } from "../../useNow";
import "../PropertyManagementPage.css";
import { AccessPanel, EQUIPMENT_DOCUMENT_ACCEPT, EQUIPMENT_DRAFT_MAP_ID, EQUIPMENT_PHOTO_ACCEPT, MAP_ITEM_BATCH_SIZE, MAX_EQUIPMENT_ATTACHMENT_BYTES, MAX_GUEST_ACCESS_GRANTS, NEW_FIXED_ASSET_ID, PropertyAreaMap, PropertyStatusLights, TRACKED_ASSETS_REFRESH_MS, areaDraft, areaKinds, attachmentSize, coordinateText, emptyAreaDraft, equipmentAttachmentMimeType, equipmentAttachmentMimeTypes, equipmentPlacement, fileDataUrl, firstHouseFloor, fixedAssetKinds, guestActivationUrl, inventoryPlacement, isForeignSharedHouse, mapCoordinateInput, normalizeGuestGrants, parseCoordinateText, placementInput, targetLabel, toggledGuestGrants } from "./support";
import type { AreaDraft, EquipmentPlacement, Feedback, InventoryLocationFilter, MapCatalogEntry, MapItemFilter, MapItemKind, MapItemSelection, MapLayerVisibility, PropertyManagementPageProps, WorkspaceTab } from "./support";
import { usePropertyManagementPagePart02 } from "./part-02";
export function usePropertyManagementPagePart03(context: ReturnType<typeof usePropertyManagementPagePart02>) {
  const { props, state, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, inventoryStatus, setInventoryStatus, inventoryLocation, setInventoryLocation, structureQuery, setStructureQuery, mapItemQuery, setMapItemQuery, mapItemFilter, setMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, mapLayers, setMapLayers, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingTags, setTrackingTags, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, newTagSerial, setNewTagSerial, newTagModel, setNewTagModel, selectedTagId, setSelectedTagId, provisionedTag, setProvisionedTag, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedTagIds, availableTrackingTags, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems } = context;
  const remainingMapCatalogItems = Math.max(0, matchingMapCatalogItems.length - visibleMapCatalogItems.length);
  const inventoryLocationCount = useMemo(() => new Set(equipment.flatMap((item) => {
      if (item.areaId) return [`area:${item.areaId}`];
      if (item.houseId) return [`house:${item.houseId}`];
      if (item.location) return [`pin:${item.location.latitude}:${item.location.longitude}`];
      return [];
    })).size, [equipment]);
  const inventoryEquipmentVersion = useMemo(
      () => equipment.map((item) => `${item.id}:${item.updatedAt}`).sort().join("|"),
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
      return Boolean(
        tracked
        && ((tracked.tag?.batteryPercent ?? 101) <= 20
          || ["stale", "unknown"].includes(tracked.position?.freshnessState ?? "unknown")),
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
      setInventoryQuery("");
      setInventoryStatus("all");
      setInventoryLocation("all");
      setStructureQuery("");
      setMapItemQuery("");
      setMapItemFilter("all");
      setMapItemLimit(MAP_ITEM_BATCH_SIZE);
      setMapItemSelection(houses[0] ? { kind: "home", id: houses[0].id } : null);
      setMapLayers({ home: true, asset: true, equipment: true, person: true });
      setInventoryFormOpen(false);
      setTrackedEquipment([]);
      setTrackingCapabilities(null);
      setTrackingSnapshot(null);
      setTrackingTags([]);
      setTrackingConnection("off");
      setSelectedEquipmentId(null);
      setNewTagSerial("");
      setNewTagModel("");
      setSelectedTagId("");
      setProvisionedTag(null);
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
      setSelectedTagId("");
      setProvisionedTag(null);
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