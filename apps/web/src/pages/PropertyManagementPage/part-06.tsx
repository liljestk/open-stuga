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
import { usePropertyManagementPagePart05 } from "./part-05";
export function usePropertyManagementPagePart06(context: ReturnType<typeof usePropertyManagementPagePart05>) {
  const { props, state, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, inventoryStatus, setInventoryStatus, inventoryLocation, setInventoryLocation, structureQuery, setStructureQuery, mapItemQuery, setMapItemQuery, mapItemFilter, setMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, mapLayers, setMapLayers, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingTags, setTrackingTags, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, newTagSerial, setNewTagSerial, newTagModel, setNewTagModel, selectedTagId, setSelectedTagId, provisionedTag, setProvisionedTag, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedTagIds, availableTrackingTags, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems, remainingMapCatalogItems, inventoryLocationCount, inventoryEquipmentVersion, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetLatitude, assetLongitude, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, mapHouses, visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, chooseTabFromKeyboard, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex, moveVertex, insertVertex, undoVertex, redoVertex, applyCoordinates, saveArea, removeArea, createProperty, saveProperty, createHouse, removeProperty, clearEquipmentDraft, beginEquipmentEdit, saveEquipment } = context;
  const moveHouse = async (houseId: string, nextPropertyId: string) => {
      if (!property || readOnly || pending || nextPropertyId === property.id) return;
      const movingHouse = houses.find((house) => house.id === houseId);
      if (!movingHouse || houseReadOnly(movingHouse)) return;
      if (movingHouse && !window.confirm(t("properties.moveHouseConfirm", { name: movingHouse.name }))) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onUpdateHouse(houseId, { propertyId: nextPropertyId });
        setFeedback({ kind: "success", text: t("properties.houseMoved") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.houseMoveFailed") });
      } finally {
        setPending(false);
      }
    };
  const removeEquipment = async (id: string) => {
      const item = equipment.find((candidate) => candidate.id === id);
      if (readOnly || pending || !item || !window.confirm(t("properties.deleteEquipmentConfirm", { name: item.name }))) return;
      setPending(true);
      try { await props.onDeleteEquipment(id); setFeedback({ kind: "success", text: t("properties.equipmentDeleted") }); }
      catch { setFeedback({ kind: "error", text: t("properties.equipmentDeleteFailed") }); }
      finally { setPending(false); }
    };
  const uploadEquipmentAttachments = async (
      event: ChangeEvent<HTMLInputElement>,
      kind: EquipmentAttachmentKind,
    ) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (!selectedEquipment || readOnly || equipmentResourcesBusy || files.length === 0) return;
      const invalidSize = files.find((file) => file.size < 1 || file.size > MAX_EQUIPMENT_ATTACHMENT_BYTES);
      if (invalidSize) {
        setEquipmentResourcesFeedback({
          kind: "error",
          text: t("properties.inventoryAttachmentTooLarge", { name: invalidSize.name }),
        });
        return;
      }
      const typedFiles = files.map((file) => ({ file, mimeType: equipmentAttachmentMimeType(file, kind) }));
      const invalidType = typedFiles.find((item) => !item.mimeType);
      if (invalidType) {
        setEquipmentResourcesFeedback({
          kind: "error",
          text: t("properties.inventoryAttachmentUnsupported", { name: invalidType.file.name }),
        });
        return;
      }
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        for (const { file, mimeType } of typedFiles) {
          const attachment = await api.uploadEquipmentAttachment(selectedEquipment.id, {
            kind,
            name: file.name,
            mimeType: mimeType!,
            data: await fileDataUrl(file, mimeType!),
          });
          setEquipmentAttachments((current) => [attachment, ...current]);
        }
        setEquipmentResourcesState("ready");
        setEquipmentResourcesFeedback({
          kind: "success",
          text: t("properties.inventoryAttachmentsUploaded", { count: files.length }),
        });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentUploadFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const removeEquipmentAttachment = async (attachment: EquipmentAttachment) => {
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !window.confirm(t("properties.inventoryAttachmentDeleteConfirm", { name: attachment.name }))) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        await api.deleteEquipmentAttachment(selectedEquipment.id, attachment.id);
        setEquipmentAttachments((current) => current.filter((item) => item.id !== attachment.id));
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryAttachmentDeleted") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentDeleteFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const addEquipmentLink = async (event: FormEvent) => {
      event.preventDefault();
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !equipmentLinkLabel.trim() || !equipmentLinkUrl.trim()) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        const link = await api.createEquipmentLink(selectedEquipment.id, {
          label: equipmentLinkLabel.trim(),
          url: equipmentLinkUrl.trim(),
        });
        setEquipmentLinks((current) => [...current, link].sort((left, right) => left.label.localeCompare(right.label)));
        setEquipmentLinkLabel("");
        setEquipmentLinkUrl("");
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkAdded") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkAddFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const removeEquipmentLink = async (link: EquipmentLink) => {
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !window.confirm(t("properties.inventoryLinkDeleteConfirm", { label: link.label }))) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        await api.deleteEquipmentLink(selectedEquipment.id, link.id);
        setEquipmentLinks((current) => current.filter((item) => item.id !== link.id));
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkDeleted") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkDeleteFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const refreshInventoryTracking = async () => {
      if (!property || !trackingEnabled) return;
      const [assets, tags] = await Promise.all([
        api.trackedAssets(property.id),
        canManageAccess ? api.trackingTags(property.id) : Promise.resolve([]),
      ]);
      setTrackedEquipment(assets);
      if (canManageAccess) setTrackingTags(tags);
    };
  const assignTag = async (tagId: string) => {
      if (!selectedEquipment || !canManageAccess || pending) return;
      setPending(true);
      setFeedback(null);
      try {
        await api.assignTrackingTag(tagId, selectedEquipment.id);
        await refreshInventoryTracking();
        setFeedback({ kind: "success", text: t("properties.trackingTagAssigned") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingTagAssignFailed") });
      } finally {
        setPending(false);
      }
    };
  const unassignTag = async () => {
      const tagId = selectedTracking?.tag?.id;
      if (!tagId || !canManageAccess || pending) return;
      setPending(true);
      setFeedback(null);
      try {
        await api.unassignTrackingTag(tagId);
        await refreshInventoryTracking();
        setFeedback({ kind: "success", text: t("properties.trackingTagUnassigned") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingTagUnassignFailed") });
      } finally {
        setPending(false);
      }
    };
  const claimTag = async (tagId: string) => {
      if (!canManageAccess || pending) return;
      setPending(true);
      try {
        await api.claimTrackingTag(tagId);
        await refreshInventoryTracking();
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingTagClaimFailed") });
      } finally {
        setPending(false);
      }
    };
  const createTag = async (event: FormEvent) => {
      event.preventDefault();
      if (!property || !canManageAccess || pending || !newTagSerial.trim() || !newTagModel.trim()) return;
      setPending(true);
      setProvisionedTag(null);
      try {
        const result = await api.createTrackingTag({
          propertyId: property.id,
          serialNumber: newTagSerial.trim(),
          hardwareModel: newTagModel.trim(),
        });
        setProvisionedTag(result);
        setNewTagSerial("");
        setNewTagModel("");
        setTrackingTags((current) => [...current.filter((tag) => tag.id !== result.tag.id), result.tag]);
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingTagCreateFailed") });
      } finally {
        setPending(false);
      }
    };
  const showEquipmentOnMap = (equipmentId: string) => {
      setSelectedEquipmentId(equipmentId);
      setMapItemSelection({ kind: "equipment", id: equipmentId });
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      setDrawing(false);
      setMapLoaded(true);
      setTab("map");
    };
  const removeNote = async (id: string) => {
      if (readOnly || pending || !window.confirm(t("properties.deleteNoteConfirm"))) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onDeleteNote(id);
        if (editingNoteId === id) {
          setEditingNoteId(null);
          setNoteText("");
        }
        setFeedback({ kind: "success", text: t("properties.noteDeleted") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.noteDeleteFailed") });
      } finally {
        setPending(false);
      }
    };
  const noteTargetParts = () => {
      const separator = noteTarget.indexOf(":");
      if (separator < 0) return null;
      const target = { kind: noteTarget.slice(0, separator), id: noteTarget.slice(separator + 1) };
      if (target.kind === "property") return target.id ? null : target;
      if (target.kind === "house") return houses.some((house) => house.id === target.id) ? target : null;
      if (target.kind === "area") return areas.some((area) => area.id === target.id) ? target : null;
      if (target.kind === "equipment") return equipment.some((item) => item.id === target.id) ? target : null;
      return null;
    };
  return Object.assign(context, { moveHouse, removeEquipment, uploadEquipmentAttachments, removeEquipmentAttachment, addEquipmentLink, removeEquipmentLink, refreshInventoryTracking, assignTag, unassignTag, claimTag, createTag, showEquipmentOnMap, removeNote, noteTargetParts });
}