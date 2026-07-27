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
import { usePropertyManagementPagePart03 } from "./part-03";
export function usePropertyManagementPagePart04(context: ReturnType<typeof usePropertyManagementPagePart03>) {
  const { props, state, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, inventoryStatus, setInventoryStatus, inventoryLocation, setInventoryLocation, structureQuery, setStructureQuery, mapItemQuery, setMapItemQuery, mapItemFilter, setMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, mapLayers, setMapLayers, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingTags, setTrackingTags, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, newTagSerial, setNewTagSerial, newTagModel, setNewTagModel, selectedTagId, setSelectedTagId, provisionedTag, setProvisionedTag, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementHouseId, setPlacementHouseId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, liveMapEnabled, selectedEquipment, selectedEquipmentResourceId, selectedTracking, sharedMembers, assignedTagIds, availableTrackingTags, equipmentLatitudeValue, equipmentLongitudeValue, equipmentPinEmpty, equipmentPinValid, equipmentDraftMapLocation, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, normalizedStructureQuery, sidebarHouses, sidebarAreas, mapCatalogItems, normalizedMapItemQuery, matchingMapCatalogItems, visibleMapCatalogItems, remainingMapCatalogItems, inventoryLocationCount, inventoryEquipmentVersion, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetLatitude, assetLongitude, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, mapHouses } = context;
  const visibleMapHouses = useMemo(() => mapLayers.home
      ? mapHouses
      : mapHouses.filter((house) => mapItemSelection?.kind === "home" && house.id === mapItemSelection.id), [mapHouses, mapItemSelection, mapLayers.home]);
  const visibleAssetIds = useMemo<ReadonlySet<string> | null>(() => {
      if (mapLayers.asset) return null;
      return new Set(mapItemSelection?.kind === "asset" ? [mapItemSelection.id] : []);
    }, [mapItemSelection, mapLayers.asset]);
  const visibleMapEquipment = useMemo(() => mapLayers.equipment
      ? equipment
      : equipment.filter((item) => mapItemSelection?.kind === "equipment" && item.id === mapItemSelection.id), [equipment, mapItemSelection, mapLayers.equipment]);
  const visibleMapMembers = mapLayers.person ? sharedMembers : [];
  const placementDraftIsValid = useMemo(() => {
      if (!placementHouse) return false;
      const latitude = Number(placementLatitude);
      const longitude = Number(placementLongitude);
      const width = Number(placementWidth);
      const orientation = placementOrientation.trim() ? Number(placementOrientation) : null;
      const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
      return Boolean(floor)
        && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
        && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
        && Number.isFinite(width) && width > 0 && width <= 500
        && (orientation === null || (Number.isFinite(orientation) && orientation >= 0 && orientation < 360));
    }, [placementHouse, placementLatitude, placementLongitude, placementOrientation, placementWidth]);
  useEffect(() => {
      if (!canManageAccess && tab === "access") setTab("overview");
    }, [canManageAccess, tab]);
  useEffect(() => {
      if (!property) return;
      let current = true;
      void api.trackingCapabilities()
        .then((capabilities) => {
          if (!current) return;
          setTrackingCapabilities(capabilities);
          if (!capabilities.flags["tracking.enabled"]) {
            setTrackingConnection("off");
            setTrackingSnapshot(null);
            setTrackingTags([]);
          }
        })
        .catch(() => {
          if (current) {
            setTrackingCapabilities(null);
            setTrackingConnection("off");
          }
        });
      return () => { current = false; };
    }, [property?.id]);
  useEffect(() => {
      if (tab !== "inventory" || !property) return;
      let current = true;
      let pollingEnabled = true;
      let requestInFlight = false;
      const refresh = () => {
        if (!pollingEnabled || requestInFlight) return;
        requestInFlight = true;
        void api.trackedAssets(property.id)
          .then((assets) => {
            if (current) setTrackedEquipment(assets);
          })
          .catch((error: unknown) => {
            if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
              pollingEnabled = false;
              if (current) setTrackedEquipment([]);
              return;
            }
            // Keep the last confirmed snapshot during a transient refresh failure.
          })
          .finally(() => {
            requestInFlight = false;
          });
      };
      refresh();
      const timer = window.setInterval(refresh, TRACKED_ASSETS_REFRESH_MS);
      return () => {
        current = false;
        pollingEnabled = false;
        window.clearInterval(timer);
      };
    }, [inventoryEquipmentVersion, property?.id, tab]);
  useEffect(() => {
      if (tab !== "inventory" || !property || !trackingEnabled || !canManageAccess) {
        setTrackingTags([]);
        return;
      }
      let current = true;
      void api.trackingTags(property.id)
        .then((tags) => { if (current) setTrackingTags(tags); })
        .catch(() => { if (current) setTrackingTags([]); });
      return () => { current = false; };
    }, [canManageAccess, property?.id, tab, trackingEnabled]);
  useEffect(() => {
      if (tab !== "map" || !mapLoaded || !property || !trackingEnabled) {
        if (!trackingEnabled) {
          setTrackingConnection("off");
          setTrackingSnapshot(null);
        }
        return;
      }
      let current = true;
      let inFlight = false;
      let refreshTimer: number | null = null;
      const refresh = () => {
        if (!current || inFlight) return;
        inFlight = true;
        void api.trackingMapSnapshot(property.id)
          .then((snapshot) => {
            if (!current) return;
            setTrackingSnapshot(snapshot);
            setTrackedEquipment(snapshot.assets.filter((item) => item.assignment));
            if (!liveMapEnabled) setTrackingConnection("off");
          })
          .catch((error: unknown) => {
            if (!current) return;
            if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
              setTrackingConnection("off");
              setTrackingSnapshot(null);
            } else {
              setTrackingConnection("reconnecting");
            }
          })
          .finally(() => { inFlight = false; });
      };
      const scheduleRefresh = () => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refresh, 250);
      };
      refresh();
      setTrackingConnection(liveMapEnabled ? "reconnecting" : "off");
      const dispose = liveMapEnabled && typeof EventSource !== "undefined"
        ? subscribeToTrackingEvents(property.id, scheduleRefresh, setTrackingConnection)
        : () => undefined;
      const poll = window.setInterval(refresh, TRACKED_ASSETS_REFRESH_MS);
      return () => {
        current = false;
        dispose();
        window.clearInterval(poll);
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      };
    }, [liveMapEnabled, mapLoaded, property?.id, tab, trackingEnabled]);
  useEffect(() => {
      setEditingEquipmentId(null);
      setEquipmentName("");
      setEquipmentKind("");
      setEquipmentManufacturer("");
      setEquipmentModel("");
      setEquipmentSerialNumber("");
      setEquipmentStatus("active");
      setEquipmentNotes("");
      setEquipmentDestination(selectedArea ? `area:${selectedArea.id}` : "unassigned");
      setEquipmentLatitude("");
      setEquipmentLongitude("");
      setMaintenanceTitle("");
      setMaintenanceEquipmentId("");
      if (!selectedArea) return;
      if (assetPlacementEditing && selectedArea.id === placementAssetId) return;
      const draft = areaDraft(selectedArea);
      setAreaForm(draft);
      setRedoVertices([]);
      setCoordinateInput(coordinateText(draft.polygon));
      setCoordinateError(false);
      setIsNewArea(false);
      setIsNewFixedAsset(false);
      setAreaDestinationPropertyId(selectedArea.propertyId);
      setDrawing(false);
      setPlacementAssetId(selectedArea.id);
      setAssetDraftLocation(selectedArea.location ? { ...selectedArea.location } : null);
      setAssetLatitudeInput(selectedArea.location ? String(selectedArea.location.latitude) : "");
      setAssetLongitudeInput(selectedArea.location ? String(selectedArea.location.longitude) : "");
      setAssetPlacementEditing(false);
    }, [assetPlacementEditing, placementAssetId, selectedArea?.id, selectedArea?.updatedAt]);
  const tabs: Array<{ id: WorkspaceTab; key: TranslationKey; icon: typeof MapIcon }> = [
      { id: "overview", key: "nav.overview", icon: Building2 },
      { id: "map", key: "properties.map", icon: MapIcon },
      { id: "inventory", key: "properties.inventory", icon: Boxes },
      { id: "notes", key: "properties.notes", icon: NotebookPen },
      ...(canManageAccess ? [{ id: "access" as const, key: "properties.access" as TranslationKey, icon: Users }] : []),
    ];
  const chooseTabFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      setTab(tabs[nextIndex]!.id);
      const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']");
      buttons?.[nextIndex]?.focus();
    };
  const vertexLabel = useCallback((index: number, canFinish: boolean) => canFinish
      ? t("properties.finishBoundaryPoint")
      : t("properties.moveBoundaryPoint", { number: index + 1 }), [t]);
  const midpointLabel = useCallback((index: number) => t("properties.addBoundaryPoint", { number: index + 1 }), [t]);
  const startArea = () => {
      setMapLoaded(true);
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      setMapItemSelection(null);
      setSelectedAreaId(null);
      setIsNewArea(true);
      setIsNewFixedAsset(false);
      setDrawing(true);
      setAreaForm(emptyAreaDraft());
      setAreaDestinationPropertyId(property?.id ?? "");
      setRedoVertices([]);
      setCoordinateInput("");
      setFeedback(null);
    };
  const startFixedAsset = () => {
      setMapLoaded(true);
      setPlacementEditing(false);
      setMapItemSelection({ kind: "asset", id: NEW_FIXED_ASSET_ID });
      setSelectedAreaId(null);
      setIsNewArea(true);
      setIsNewFixedAsset(true);
      setDrawing(false);
      setAreaForm(emptyAreaDraft());
      setPlacementAssetId(NEW_FIXED_ASSET_ID);
      setAssetDraftLocation(null);
      setAssetLatitudeInput("");
      setAssetLongitudeInput("");
      setAssetPlacementEditing(true);
      setAreaDestinationPropertyId(property?.id ?? "");
      setRedoVertices([]);
      setCoordinateInput("");
      setFeedback(null);
    };
  const appendVertex = (point: GeoCoordinate) => {
      if (readOnly || !drawing) return;
      setAreaForm((current) => {
        const next = { ...current, polygon: [...current.polygon, point] };
        setCoordinateInput(coordinateText(next.polygon));
        return next;
      });
      setRedoVertices([]);
    };
  return Object.assign(context, { visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, chooseTabFromKeyboard, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex });
}