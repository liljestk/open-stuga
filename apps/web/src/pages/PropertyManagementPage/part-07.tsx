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
import { usePropertyManagementPagePart06 } from "./part-06";
export function usePropertyManagementPagePart07(context: ReturnType<typeof usePropertyManagementPagePart06>) {
  const { props, state, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, inventoryStatus, setInventoryStatus, inventoryLocation, setInventoryLocation, structureQuery, setStructureQuery, mapItemQuery, setMapItemQuery, mapItemFilter, setMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, mapLayers, setMapLayers, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingTags, setTrackingTags, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, newTagSerial, setNewTagSerial, newTagModel, setNewTagModel, selectedTagId, setSelectedTagId, provisionedTag, setProvisionedTag, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedTagIds, availableTrackingTags, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems, remainingMapCatalogItems, inventoryLocationCount, inventoryEquipmentVersion, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetLatitude, assetLongitude, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, mapHouses, visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, chooseTabFromKeyboard, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex, moveVertex, insertVertex, undoVertex, redoVertex, applyCoordinates, saveArea, removeArea, createProperty, saveProperty, createHouse, removeProperty, clearEquipmentDraft, beginEquipmentEdit, saveEquipment, moveHouse, removeEquipment, uploadEquipmentAttachments, removeEquipmentAttachment, addEquipmentLink, removeEquipmentLink, refreshInventoryTracking, assignTag, unassignTag, claimTag, createTag, showEquipmentOnMap, removeNote, noteTargetParts } = context;
  const saveNote = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || readOnly || pending || !noteText.trim()) return;
      const target = noteTargetParts();
      if (!target) {
        setNoteTarget("property:");
        setFeedback({ kind: "error", text: t("properties.noteSaveFailed") });
        return;
      }
      const common = {
        kind: noteKind,
        text: noteText.trim(),
        houseId: target.kind === "house" ? target.id : null,
        areaId: target.kind === "area" ? target.id : null,
        equipmentId: target.kind === "equipment" ? target.id : null,
      };
      setPending(true);
      try {
        if (editingNoteId) await props.onUpdateNote(editingNoteId, common);
        else await props.onCreateNote({ propertyId: property.id, ...common });
        setNoteText(""); setEditingNoteId(null);
        setFeedback({ kind: "success", text: t("properties.noteSaved") });
      } catch { setFeedback({ kind: "error", text: t("properties.noteSaveFailed") }); }
      finally { setPending(false); }
    };
  const planMaintenance = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || !selectedArea || readOnly || pending || !maintenanceTitle.trim()) return;
      if ((maintenanceHouseId && !houses.some((house) => house.id === maintenanceHouseId))
        || (maintenanceEquipmentId && !equipment.some((item) => item.id === maintenanceEquipmentId && item.areaId === selectedArea.id))) {
        setMaintenanceHouseId("");
        setMaintenanceEquipmentId("");
        setFeedback({ kind: "error", text: t("properties.maintenanceSaveFailed") });
        return;
      }
      setPending(true);
      try {
        await props.onCreateMaintenanceTask({
          propertyId: property.id,
          houseId: maintenanceHouseId || null,
          title: maintenanceTitle.trim(),
          basis: "scheduled",
          areaId: selectedArea.id,
          equipmentId: maintenanceEquipmentId || null,
        });
        setMaintenanceTitle("");
        setFeedback({ kind: "success", text: t("properties.maintenanceSaved") });
      } catch { setFeedback({ kind: "error", text: t("properties.maintenanceSaveFailed") }); }
      finally { setPending(false); }
    };
  const selectMapArea = (areaId: string) => {
      setMapItemSelection(null);
      setSelectedAreaId(areaId);
    };
  const selectMapEquipment = (equipmentId: string) => {
      if (!equipment.some((item) => item.id === equipmentId)) return;
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      setDrawing(false);
      setSelectedEquipmentId(equipmentId);
      setMapItemSelection({ kind: "equipment", id: equipmentId });
      setFeedback(null);
    };
  const selectPlacementHouse = (houseId: string) => {
      if (!houses.some((house) => house.id === houseId)) return;
      setAssetPlacementEditing(false);
      setPlacementEditing(false);
      setPlacementHouseId(houseId);
      setMapItemSelection({ kind: "home", id: houseId });
      setFeedback(null);
    };
  const updatePlacementFromMap = useCallback((houseId: string, point: GeoCoordinate) => {
      const house = houses.find((candidate) => candidate.id === houseId);
      if (!house || houseReadOnly(house) || pending || !props.onSetHouseGeoreference) return;
      setPlacementHouseId(houseId);
      setMapItemSelection({ kind: "home", id: houseId });
      setAssetPlacementEditing(false);
      setPlacementLatitude(String(point.latitude));
      setPlacementLongitude(String(point.longitude));
      setPlacementEditing(true);
      setMapLoaded(true);
      setFeedback(null);
    }, [houseReadOnly, houses, pending, props.onSetHouseGeoreference]);
  const selectPlacementAsset = (assetId: string) => {
      if (assetId === NEW_FIXED_ASSET_ID) return;
      const asset = areas.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      setPlacementAssetId(asset.id);
      setMapItemSelection({ kind: "asset", id: asset.id });
      setAssetDraftLocation(asset.location ? { ...asset.location } : null);
      setAssetLatitudeInput(asset.location ? String(asset.location.latitude) : "");
      setAssetLongitudeInput(asset.location ? String(asset.location.longitude) : "");
      setAreaForm(areaDraft(asset));
      setSelectedAreaId(asset.id);
      setFeedback(null);
    };
  const updateAssetPlacementFromMap = useCallback((assetId: string, point: GeoCoordinate) => {
      if (readOnly || pending) return;
      setPlacementEditing(false);
      setDrawing(false);
      setMapLoaded(true);
      if (assetId === NEW_FIXED_ASSET_ID && isNewArea && isNewFixedAsset) {
        setMapItemSelection({ kind: "asset", id: NEW_FIXED_ASSET_ID });
        setAreaForm((current) => ({ ...current, location: point }));
        setAssetDraftLocation(point);
        setAssetLatitudeInput(String(point.latitude));
        setAssetLongitudeInput(String(point.longitude));
        setAssetPlacementEditing(true);
        setFeedback(null);
        return;
      }
      const asset = areas.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      setSelectedAreaId(asset.id);
      setPlacementAssetId(asset.id);
      setMapItemSelection({ kind: "asset", id: asset.id });
      setAssetDraftLocation(point);
      setAssetLatitudeInput(String(point.latitude));
      setAssetLongitudeInput(String(point.longitude));
      setAreaForm({ ...areaDraft(asset), location: point });
      setAssetPlacementEditing(true);
      setFeedback(null);
    }, [areas, isNewArea, isNewFixedAsset, pending, readOnly]);
  const saveAssetPlacement = async () => {
      if (!placementAsset || !assetDraftLocation || readOnly || pending) return;
      setPending(true);
      setFeedback(null);
      try {
        const saved = await props.onUpdateArea(placementAsset.id, { location: assetDraftLocation });
        setSelectedAreaId(saved.id);
        setAreaForm(areaDraft(saved));
        setAssetDraftLocation(saved.location ? { ...saved.location } : null);
        setAssetLatitudeInput(saved.location ? String(saved.location.latitude) : "");
        setAssetLongitudeInput(saved.location ? String(saved.location.longitude) : "");
        setAssetPlacementEditing(false);
        setFeedback({ kind: "success", text: t("properties.assetPlacementSaved") });
      } catch { setFeedback({ kind: "error", text: t("properties.assetPlacementFailed") }); }
      finally { setPending(false); }
    };
  const removeAssetPlacement = async () => {
      if (!placementAsset?.location || readOnly || pending
        || !window.confirm(t("properties.removeAssetPlacementConfirm", { name: placementAsset.name }))) return;
      setPending(true);
      setFeedback(null);
      try {
        const saved = await props.onUpdateArea(placementAsset.id, { location: null });
        setAreaForm(areaDraft(saved));
        setAssetDraftLocation(null);
        setAssetLatitudeInput("");
        setAssetLongitudeInput("");
        setAssetPlacementEditing(false);
        setFeedback({ kind: "success", text: t("properties.assetPlacementRemoved") });
      } catch { setFeedback({ kind: "error", text: t("properties.assetPlacementFailed") }); }
      finally { setPending(false); }
    };
  const saveHousePlacement = async (event: FormEvent) => {
      event.preventDefault();
      if (!placementHouse || !props.onSetHouseGeoreference || houseReadOnly(placementHouse) || pending) return;
      const latitude = Number(placementLatitude);
      const longitude = Number(placementLongitude);
      const width = Number(placementWidth);
      const orientation = placementOrientation.trim() ? Number(placementOrientation) : null;
      const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
      if (!floor || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(width) || width < 1 || width > 500 || (orientation !== null && (!Number.isFinite(orientation) || orientation < 0 || orientation >= 360))) {
        setFeedback({ kind: "error", text: t("placement.saveError") });
        return;
      }
      setPending(true);
      setFeedback(null);
      try {
        await props.onSetHouseGeoreference(placementHouse.id, {
          mapPlacement: {
            latitude,
            longitude,
            metersPerPlanUnit: width / Math.max(1, floor.width),
            footprintFloorId: floor.id,
          },
          orientationDegrees: orientation,
        });
        setMapLoaded(true);
        setPlacementEditing(false);
        setFeedback({ kind: "success", text: t("placement.saved") });
      } catch { setFeedback({ kind: "error", text: t("placement.saveError") }); }
      finally { setPending(false); }
    };
  const removeHousePlacement = async () => {
      if (!placementHouse?.mapPlacement || !props.onSetHouseGeoreference || houseReadOnly(placementHouse) || pending || !window.confirm(t("properties.removePlacementConfirm", { name: placementHouse.name }))) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onSetHouseGeoreference(placementHouse.id, { mapPlacement: null, orientationDegrees: null });
        setPlacementEditing(false);
        setFeedback({ kind: "success", text: t("placement.removed") });
      } catch { setFeedback({ kind: "error", text: t("placement.saveError") }); }
      finally { setPending(false); }
    };
  const propertyShareLabel = (item: Property) => {
      if (!item.stuguby) return null;
      if (item.stuguby.syncState === "detached") return t("properties.stuguby.detached");
      if (item.stuguby.syncState === "conflict") return t("properties.stuguby.conflict");
      if (item.stuguby.syncState === "offline") return t("properties.stuguby.offline");
      if (item.stuguby.pendingChangeCount > 0) return t("properties.stuguby.pending", { count: item.stuguby.pendingChangeCount });
      if (item.stuguby.isAuthority) return t("properties.stuguby.authority");
      return item.stuguby.editPolicy === "read-only"
        ? t("properties.stuguby.inheritedReadOnly")
        : t("properties.stuguby.inheritedEditable");
    };
  const houseShareLabel = (house: ClimateState["houses"][number]) => {
      if (!house.stuguby) return null;
      if (house.stuguby.syncState === "detached") return t("properties.stuguby.localAfterDisconnect");
      if (house.stuguby.syncState === "conflict") return t("properties.stuguby.conflict");
      if (house.stuguby.syncState === "offline") return t("properties.stuguby.offline");
      if (house.stuguby.pendingChangeCount > 0) return t("properties.stuguby.pending", { count: house.stuguby.pendingChangeCount });
      if (house.stuguby.ownership === "local") return t("properties.stuguby.ownedHouse");
      return house.stuguby.editPolicy === "read-only"
        ? t("properties.stuguby.sharedHouseReadOnly")
        : t("properties.stuguby.sharedHouseEditable");
    };
  return Object.assign(context, { saveNote, planMaintenance, selectMapArea, selectMapEquipment, selectPlacementHouse, updatePlacementFromMap, selectPlacementAsset, updateAssetPlacementFromMap, saveAssetPlacement, removeAssetPlacement, saveHousePlacement, removeHousePlacement, propertyShareLabel, houseShareLabel });
}