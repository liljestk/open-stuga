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
import { confirmAction } from "../../components/ConfirmationProvider";
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
  TrackingEndpoint,
  TrackingMapSnapshot,
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
import { usePropertyManagementPagePart04 } from "./part-04";
export function usePropertyManagementPagePart05(context: ReturnType<typeof usePropertyManagementPagePart04>) {
  const { props, state, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, inventoryStatus, setInventoryStatus, inventoryLocation, setInventoryLocation, structureQuery, setStructureQuery, mapItemQuery, setMapItemQuery, mapItemFilter, setMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, mapLayers, setMapLayers, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingEndpoints, setTrackingEndpoints, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, selectedEndpointId, setSelectedEndpointId, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedEndpointIds, availableTrackingEndpoints, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems, remainingMapCatalogItems, inventoryLocationCount, inventoryEquipmentVersion, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetLatitude, assetLongitude, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, mapHouses, visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, chooseTabFromKeyboard, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex } = context;
  const moveVertex = (index: number, point: GeoCoordinate) => {
      setAreaForm((current) => {
        const polygon = current.polygon.map((candidate, candidateIndex) => candidateIndex === index ? point : candidate);
        setCoordinateInput(coordinateText(polygon));
        return { ...current, polygon };
      });
      setRedoVertices([]);
    };
  const insertVertex = (index: number, point: GeoCoordinate) => {
      setAreaForm((current) => {
        const polygon = [...current.polygon.slice(0, index), point, ...current.polygon.slice(index)];
        setCoordinateInput(coordinateText(polygon));
        return { ...current, polygon };
      });
      setRedoVertices([]);
    };
  const undoVertex = () => setAreaForm((current) => {
      const removed = current.polygon.at(-1);
      if (!removed) return current;
      const polygon = current.polygon.slice(0, -1);
      setRedoVertices((redo) => [...redo, removed]);
      setCoordinateInput(coordinateText(polygon));
      return { ...current, polygon };
    });
  const redoVertex = () => setRedoVertices((redo) => {
      const restored = redo.at(-1);
      if (!restored) return redo;
      setAreaForm((current) => {
        const polygon = [...current.polygon, restored];
        setCoordinateInput(coordinateText(polygon));
        return { ...current, polygon };
      });
      return redo.slice(0, -1);
    });
  const applyCoordinates = () => {
      const parsed = parseCoordinateText(coordinateInput);
      if (!parsed) { setCoordinateError(true); return; }
      setCoordinateError(false);
      setAreaForm((current) => ({ ...current, polygon: parsed }));
      setRedoVertices([]);
    };
  useEffect(() => {
      if (!drawing || readOnly) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
        if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); setDrawing(false); return; }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redoVertex() : undoVertex(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redoVertex(); }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [drawing, readOnly]);
  const saveArea = async () => {
      if (!property || readOnly || pending || !areaForm.name.trim()
        || (editingFixedAsset ? !areaForm.location || !assetCoordinateInputsValid : areaForm.polygon.length < 3)) return;
      setPending(true);
      setFeedback(null);
      try {
        const common = {
          name: areaForm.name.trim(),
          kind: areaForm.kind,
          description: areaForm.description.trim() || null,
          polygon: areaForm.polygon,
          ...(areaForm.location ? { location: areaForm.location } : {}),
        };
        const destinationPropertyId = areaDestinationPropertyId || property.id;
        if (selectedArea && destinationPropertyId !== selectedArea.propertyId
          && !await confirmAction(t("properties.moveAreaConfirm", { name: selectedArea.name }), t("confirmation.move"), false)) return;
        const saved = isNewArea
          ? await props.onCreateArea({ propertyId: property.id, ...common })
          : selectedArea ? await props.onUpdateArea(selectedArea.id, { ...common, propertyId: destinationPropertyId }) : null;
        if (saved) {
          setPropertyId(saved.propertyId);
          setSelectedAreaId(saved.id);
          setIsNewArea(false);
          setIsNewFixedAsset(false);
          setDrawing(false);
          setPlacementAssetId(saved.id);
          context.changeMapItemSelection(editingFixedAsset ? { kind: "asset", id: saved.id } : null);
          setAssetPlacementEditing(false);
          setAssetDraftLocation(saved.location ? { ...saved.location } : null);
          setFeedback({ kind: "success", text: t("properties.areaSaved") });
        }
      } catch { setFeedback({ kind: "error", text: t("properties.areaSaveFailed") }); }
      finally { setPending(false); }
    };
  const removeArea = async () => {
      if (!selectedArea || readOnly || pending || !await confirmAction(t("properties.deleteAreaConfirm", { name: selectedArea.name }), t("confirmation.delete"))) return;
      setPending(true);
      try {
        await props.onDeleteArea(selectedArea.id);
        setSelectedAreaId(null);
        setPlacementAssetId("");
        context.changeMapItemSelection(null);
        setAssetPlacementEditing(false);
        setAreaForm(emptyAreaDraft());
        setCoordinateInput("");
        setFeedback({ kind: "success", text: t("properties.areaDeleted") });
      } catch { setFeedback({ kind: "error", text: t("properties.areaDeleteFailed") }); }
      finally { setPending(false); }
    };
  const createProperty = async (event: FormEvent) => {
      event.preventDefault();
      if (workspaceReadOnly || pending || !newPropertyName.trim()) return;
      setPending(true);
      try {
        const saved = await props.onCreateProperty({ name: newPropertyName.trim() });
        setPropertyId(saved.id);
        setNewPropertyName("");
      } catch { setFeedback({ kind: "error", text: t("properties.propertySaveFailed") }); }
      finally { setPending(false); }
    };
  const saveProperty = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || readOnly || pending || !propertyName.trim()) return;
      setPending(true);
      try {
        await props.onUpdateProperty(property.id, { name: propertyName.trim(), description: propertyDescription.trim() || null });
        setEditingProperty(false);
        window.requestAnimationFrame(() => propertyEditButtonRef.current?.focus());
        setFeedback({ kind: "success", text: t("properties.propertySaved") });
      } catch { setFeedback({ kind: "error", text: t("properties.propertySaveFailed") }); }
      finally { setPending(false); }
    };
  const setDefaultHouse = async (houseId: string) => {
      if (!property || readOnly || pending || property.defaultHouseId === houseId
        || !houses.some((house) => house.id === houseId)) return;
      setPending(true);
      setFeedback(null);
      try {
        const house = houses.find((candidate) => candidate.id === houseId)!;
        await props.onUpdateProperty(property.id, { defaultHouseId: houseId });
        setFeedback({ kind: "success", text: t("properties.defaultHomeSaved", { home: house.name }) });
      } catch { setFeedback({ kind: "error", text: t("properties.defaultHomeSaveFailed") }); }
      finally { setPending(false); }
    };
  const createHouse = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || readOnly || pending || !newHouseName.trim()) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onCreateHouse({
          propertyId: property.id,
          name: newHouseName.trim(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          floors: [firstHouseFloor(t("bootstrap.groundFloor"))],
        });
        setNewHouseName("");
        setFeedback({ kind: "success", text: t("properties.houseAdded") });
      } catch { setFeedback({ kind: "error", text: t("properties.houseAddFailed") }); }
      finally { setPending(false); }
    };
  const removeProperty = async () => {
      if (!property || (property.stuguby && property.stuguby.syncState !== "detached")
        || readOnly || pending || !await confirmAction(t("properties.deletePropertyConfirm", { name: property.name }), t("confirmation.delete"))) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onDeleteProperty(property.id);
        setPropertyId(properties.find((candidate) => candidate.id !== property.id)?.id ?? "");
      } catch { setFeedback({ kind: "error", text: t("properties.propertyDeleteFailed") }); }
      finally { setPending(false); }
    };
  const clearEquipmentDraft = (placement: EquipmentPlacement = "unassigned") => {
      setEditingEquipmentId(null);
      setEquipmentName("");
      setEquipmentKind("");
      setEquipmentManufacturer("");
      setEquipmentModel("");
      setEquipmentSerialNumber("");
      setEquipmentStatus("active");
      setEquipmentNotes("");
      setEquipmentDestination(placement);
      setEquipmentLatitude("");
      setEquipmentLongitude("");
      setEquipmentPinMapOpen(false);
    };
  const beginEquipmentEdit = (item: AreaEquipment) => {
      setEditingEquipmentId(item.id);
      setEquipmentName(item.name);
      setEquipmentKind(item.kind);
      setEquipmentManufacturer(item.manufacturer ?? "");
      setEquipmentModel(item.model ?? "");
      setEquipmentSerialNumber(item.serialNumber ?? "");
      setEquipmentStatus(item.status);
      setEquipmentNotes(item.notes ?? "");
      setEquipmentDestination(equipmentPlacement(item));
      setEquipmentLatitude(item.location ? String(item.location.latitude) : "");
      setEquipmentLongitude(item.location ? String(item.location.longitude) : "");
      setEquipmentPinMapOpen(false);
      context.changeSelectedEquipmentId(item.id);
      setInventoryFormOpen(true);
      setTab("inventory");
    };
  const saveEquipment = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || readOnly || pending || !equipmentName.trim() || !equipmentKind.trim() || !equipmentPinValid) return;
      if (editingEquipmentId && !equipment.some((item) => item.id === editingEquipmentId)) {
        clearEquipmentDraft();
        setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") });
        return;
      }
      setPending(true);
      setFeedback(null);
      try {
        const placement = placementInput(equipmentDestination);
        const location = equipmentPinEmpty
          ? null
          : { latitude: equipmentLatitudeValue, longitude: equipmentLongitudeValue };
        const common = {
          ...placement,
          location,
          name: equipmentName.trim(),
          kind: equipmentKind.trim(),
          manufacturer: equipmentManufacturer.trim() || null,
          model: equipmentModel.trim() || null,
          serialNumber: equipmentSerialNumber.trim() || null,
          status: equipmentStatus,
          notes: equipmentNotes.trim() || null,
        };
        if (editingEquipmentId) {
          const currentEquipment = state.areaEquipment.find((item) => item.id === editingEquipmentId);
          if (currentEquipment && equipmentPlacement(currentEquipment) !== equipmentDestination
            && !await confirmAction(t("properties.moveEquipmentConfirm", { name: currentEquipment.name }), t("confirmation.move"), false)) return;
          const saved = await props.onUpdateEquipment(editingEquipmentId, common);
          context.changeSelectedEquipmentId(editingEquipmentId);
          if (saved.propertyId !== property.id) setPropertyId(saved.propertyId);
        }
        else {
          const created = await props.onCreateEquipment({
            propertyId: property.id,
            ...placement,
            ...(location ? { location } : {}),
            name: common.name,
            kind: common.kind,
            manufacturer: common.manufacturer,
            model: common.model,
            serialNumber: common.serialNumber,
            status: common.status,
            notes: common.notes,
          });
          context.changeSelectedEquipmentId(created.id);
        }
        if (equipmentDestination.startsWith("area:")) setSelectedAreaId(equipmentDestination.slice(5));
        clearEquipmentDraft(tab === "map" && selectedArea ? `area:${selectedArea.id}` : "unassigned");
        if (tab === "inventory") setInventoryFormOpen(false);
        setFeedback({ kind: "success", text: t("properties.equipmentSaved") });
      } catch { setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") }); }
      finally { setPending(false); }
    };
  return Object.assign(context, { moveVertex, insertVertex, undoVertex, redoVertex, applyCoordinates, saveArea, removeArea, createProperty, saveProperty, setDefaultHouse, createHouse, removeProperty, clearEquipmentDraft, beginEquipmentEdit, saveEquipment });
}
