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
import { propertyFilterStateFromLocation, writePropertyFilterStateToLocation, type PropertyFilterUrlState } from "./urlState";
export function usePropertyManagementPagePart01(context: { props: Readonly<PropertyManagementPageProps> }) {
  const { props } = context;
  const { state } = props;
  const { locale, t } = useI18n();
  const now = useNow();
  const propertySummary = (homeCount: number, areaCount: number) => `${t(homeCount === 1 ? "properties.homeCountOne" : "properties.homeCountMany", { count: homeCount })} · ${t(areaCount === 1 ? "properties.areaCountOne" : "properties.areaCountMany", { count: areaCount })}`;
  const workspaceReadOnly = state.session.readOnly;
  const canManageAccess = !workspaceReadOnly && (state.session.tenant.role === "owner" || state.session.tenant.role === "admin");
  const requestedInitialTab = props.initialTab ?? "map";
  const availableInitialTab = requestedInitialTab === "access" && !canManageAccess
    ? "overview"
    : requestedInitialTab;
  const [tab, setTabState] = useState<WorkspaceTab>(() => availableInitialTab);
  const setTab = useCallback((next: WorkspaceTab) => {
      if (next === tab) return;
      const previousSearch = typeof window === "undefined" ? "" : window.location.search;
      const previousHash = typeof window === "undefined" ? "" : window.location.hash;
      setTabState(next);
      props.onTab?.(next);
      if (typeof window !== "undefined" && (window.location.search !== previousSearch || window.location.hash !== previousHash)) {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${previousSearch}${previousHash}`,
        );
      }
    }, [props.onTab, tab]);
  useEffect(() => {
      setTabState(availableInitialTab);
    }, [availableInitialTab, props.propertyId]);
  const properties = state.properties;
  const initialPropertyAvailable = Boolean(props.initialPropertyId
      && properties.some((candidate) => candidate.id === props.initialPropertyId));
  const appliedInitialPropertyIdRef = useRef<string | null>(initialPropertyAvailable ? props.initialPropertyId ?? null : null);
  const lastInitialPropertyIdRef = useRef(props.initialPropertyId);
  const [internalPropertyId, setInternalPropertyId] = useState(() => initialPropertyAvailable
      ? props.initialPropertyId ?? ""
      : properties[0]?.id ?? "");
  const controlledPropertyAvailable = Boolean(props.propertyId
      && properties.some((candidate) => candidate.id === props.propertyId));
  const propertyId = controlledPropertyAvailable ? props.propertyId! : internalPropertyId;
  const setPropertyId = useCallback((nextPropertyId: string) => {
      setInternalPropertyId(nextPropertyId);
      props.onProperty?.(nextPropertyId);
    }, [props.onProperty]);
  const property = useMemo(() => properties.find((item) => item.id === propertyId) ?? properties[0], [properties, propertyId]);
  const readOnly = workspaceReadOnly || Boolean(
      property?.stuguby
      && !property.stuguby.isAuthority
      && property.stuguby.syncState !== "detached"
      && property.stuguby.editPolicy === "read-only",
    );
  const houses = useMemo(() => state.houses.filter((house) => house.propertyId === property?.id), [property?.id, state.houses]);
  const houseReadOnly = useCallback((house: ClimateState["houses"][number]) => (
      readOnly
      || Boolean(house.stuguby
        && house.stuguby.ownership === "shared"
        && house.stuguby.syncState !== "detached"
        && house.stuguby.editPolicy === "read-only")
    ), [readOnly]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const areas = useMemo(() => state.propertyAreas.filter((area) => area.propertyId === property?.id), [property?.id, state.propertyAreas]);
  const fixedAssets = useMemo(() => areas.filter((area) => area.location || area.polygon.length === 0 || fixedAssetKinds.has(area.kind)), [areas]);
  const equipment = useMemo(() => state.areaEquipment.filter((item) => item.propertyId === property?.id), [property?.id, state.areaEquipment]);
  const propertyFilterScope = useMemo(() => ({
      houseIds: new Set(houses.map((house) => house.id)),
      areaIds: new Set(areas.map((area) => area.id)),
      assetIds: new Set(fixedAssets.map((asset) => asset.id)),
      equipmentIds: new Set(equipment.map((item) => item.id)),
      defaultMapItem: houses[0] ? { kind: "home" as const, id: houses[0].id } : null,
    }), [areas, equipment, fixedAssets, houses]);
  const [initialPropertyFilterState] = useState<PropertyFilterUrlState>(() => (
      propertyFilterStateFromLocation(propertyFilterScope)
    ));
  const propertyTrafficLights = useMemo(
    () => derivePropertyTrafficLights(
      state,
      property?.id ?? "",
      props.monitoring?.houses ?? [],
    ),
    [property?.id, props.monitoring?.houses, state],
  );
  const notes = useMemo(() => state.propertyNotes.filter((note) => note.propertyId === property?.id), [property?.id, state.propertyNotes]);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const selectedArea = areas.find((area) => area.id === selectedAreaId);
  const selectedAreaEquipmentIds = useMemo(() => new Set(selectedArea
      ? equipment.filter((item) => item.areaId === selectedArea.id).map((item) => item.id)
      : []), [equipment, selectedArea]);
  const selectedAreaTasks = useMemo(() => selectedArea
      ? state.maintenanceTasks.filter((task) => task.propertyId === property?.id
        && (task.areaId === selectedArea.id || Boolean(task.equipmentId && selectedAreaEquipmentIds.has(task.equipmentId))))
        .sort((left, right) => (left.dueBy ?? left.plannedFor ?? left.createdAt).localeCompare(right.dueBy ?? right.plannedFor ?? right.createdAt))
      : [], [property?.id, selectedArea, selectedAreaEquipmentIds, state.maintenanceTasks]);
  const [isNewArea, setIsNewArea] = useState(false);
  const [isNewFixedAsset, setIsNewFixedAsset] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [areaForm, setAreaForm] = useState<AreaDraft>(emptyAreaDraft);
  const [redoVertices, setRedoVertices] = useState<GeoCoordinate[]>([]);
  const [coordinateInput, setCoordinateInput] = useState("");
  const [coordinateError, setCoordinateError] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [newHouseName, setNewHouseName] = useState("");
  const [areaDestinationPropertyId, setAreaDestinationPropertyId] = useState("");
  const [equipmentDestination, setEquipmentDestination] = useState<EquipmentPlacement>("unassigned");
  const [editingProperty, setEditingProperty] = useState(false);
  const propertyEditButtonRef = useRef<HTMLButtonElement>(null);
  const propertyNameInputRef = useRef<HTMLInputElement>(null);
  const [propertyName, setPropertyName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null>(null);
  const [equipmentName, setEquipmentName] = useState("");
  const [equipmentKind, setEquipmentKind] = useState("");
  const [equipmentManufacturer, setEquipmentManufacturer] = useState("");
  const [equipmentModel, setEquipmentModel] = useState("");
  const [equipmentSerialNumber, setEquipmentSerialNumber] = useState("");
  const [equipmentStatus, setEquipmentStatus] = useState<AreaEquipmentStatus>("active");
  const [equipmentNotes, setEquipmentNotes] = useState("");
  const [equipmentLatitude, setEquipmentLatitude] = useState("");
  const [equipmentLongitude, setEquipmentLongitude] = useState("");
  const [equipmentPinMapOpen, setEquipmentPinMapOpen] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState(initialPropertyFilterState.inventorySearch);
  const [inventoryStatus, setInventoryStatus] = useState<"all" | AreaEquipmentStatus>(initialPropertyFilterState.inventoryStatus);
  const [inventoryLocation, setInventoryLocation] = useState<InventoryLocationFilter>(initialPropertyFilterState.inventoryLocation);
  const [structureQuery, setStructureQuery] = useState(initialPropertyFilterState.structureSearch);
  const [mapItemQuery, setMapItemQuery] = useState(initialPropertyFilterState.mapSearch);
  const [mapItemFilter, setMapItemFilter] = useState<MapItemFilter>(initialPropertyFilterState.mapType);
  const [mapItemLimit, setMapItemLimit] = useState(MAP_ITEM_BATCH_SIZE);
  const [mapItemSelection, setMapItemSelection] = useState<MapItemSelection>(initialPropertyFilterState.mapItem);
  const [mapLayers, setMapLayers] = useState<MapLayerVisibility>(initialPropertyFilterState.mapLayers);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string | null>(initialPropertyFilterState.inventoryItem);
  const currentPropertyFilterState = (overrides: Partial<PropertyFilterUrlState> = {}): PropertyFilterUrlState => ({
      structureSearch: structureQuery,
      mapSearch: mapItemQuery,
      mapType: mapItemFilter,
      mapLayers,
      mapItem: mapItemSelection,
      inventorySearch: inventoryQuery,
      inventoryStatus,
      inventoryLocation,
      inventoryItem: selectedEquipmentId,
      ...overrides,
    });
  const writePropertyFilters = (next: PropertyFilterUrlState, mode: "push" | "replace") => (
      writePropertyFilterStateToLocation(next, mode, propertyFilterScope.defaultMapItem)
    );
  const changeStructureQuery = (next: string) => {
      setStructureQuery(next);
      writePropertyFilters(currentPropertyFilterState({ structureSearch: next }), "replace");
    };
  const changeMapItemQuery = (next: string) => {
      setMapItemQuery(next);
      setMapItemLimit(MAP_ITEM_BATCH_SIZE);
      writePropertyFilters(currentPropertyFilterState({ mapSearch: next }), "replace");
    };
  const changeMapItemFilter = (next: MapItemFilter) => {
      setMapItemFilter(next);
      setMapItemLimit(MAP_ITEM_BATCH_SIZE);
      writePropertyFilters(currentPropertyFilterState({ mapType: next }), "replace");
    };
  const changeMapLayer = (kind: MapItemKind, visible: boolean) => {
      const next = { ...mapLayers, [kind]: visible };
      setMapLayers(next);
      writePropertyFilters(currentPropertyFilterState({ mapLayers: next }), "replace");
    };
  const changeMapItemSelection = (next: MapItemSelection) => {
      setMapItemSelection(next);
      writePropertyFilters(currentPropertyFilterState({ mapItem: next }), "push");
    };
  const changeMapEquipmentSelection = (equipmentId: string) => {
      const next: MapItemSelection = { kind: "equipment", id: equipmentId };
      setMapItemSelection(next);
      writePropertyFilters(currentPropertyFilterState({ mapItem: next }), "push");
    };
  const changeMapAndInventoryEquipmentSelection = (equipmentId: string) => {
      const next: MapItemSelection = { kind: "equipment", id: equipmentId };
      setSelectedEquipmentId(equipmentId);
      setMapItemSelection(next);
      writePropertyFilters(currentPropertyFilterState({ mapItem: next, inventoryItem: equipmentId }), "push");
    };
  const changeInventoryQuery = (next: string) => {
      setInventoryQuery(next);
      writePropertyFilters(currentPropertyFilterState({ inventorySearch: next }), "replace");
    };
  const changeInventoryStatus = (next: "all" | AreaEquipmentStatus) => {
      setInventoryStatus(next);
      writePropertyFilters(currentPropertyFilterState({ inventoryStatus: next }), "replace");
    };
  const changeInventoryLocation = (next: InventoryLocationFilter) => {
      setInventoryLocation(next);
      writePropertyFilters(currentPropertyFilterState({ inventoryLocation: next }), "replace");
    };
  const changeSelectedEquipmentId = (next: string | null) => {
      setSelectedEquipmentId(next);
      writePropertyFilters(currentPropertyFilterState({ inventoryItem: next }), "push");
    };
  useEffect(() => {
      const propertyPath = `/properties/${encodeURIComponent(property?.id ?? "")}`;
      const propertyWorkspacePaths = new Set([
        propertyPath,
        ...["map", "inventory", "notes", "access"]
          .map((segment) => `${propertyPath}/${segment}`),
      ]);
      const restorePropertyFilters = () => {
        if (!propertyWorkspacePaths.has(window.location.pathname)) return;
        if (isNewFixedAsset) return;
        const next = propertyFilterStateFromLocation(propertyFilterScope);
        setStructureQuery(next.structureSearch);
        setMapItemQuery(next.mapSearch);
        setMapItemFilter(next.mapType);
        setMapItemLimit(MAP_ITEM_BATCH_SIZE);
        setMapLayers(next.mapLayers);
        setMapItemSelection(next.mapItem);
        setInventoryQuery(next.inventorySearch);
        setInventoryStatus(next.inventoryStatus);
        setInventoryLocation(next.inventoryLocation);
        setSelectedEquipmentId(next.inventoryItem);
        writePropertyFilters(next, "replace");
      };
      restorePropertyFilters();
      window.addEventListener("popstate", restorePropertyFilters);
      return () => window.removeEventListener("popstate", restorePropertyFilters);
    }, [isNewFixedAsset, property?.id, propertyFilterScope]);
  const [inventoryFormOpen, setInventoryFormOpen] = useState(false);
  const [trackedEquipment, setTrackedEquipment] = useState<TrackedEquipmentState[]>([]);
  const [trackingCapabilities, setTrackingCapabilities] = useState<TrackingCapabilities | null>(null);
  const [trackingSnapshot, setTrackingSnapshot] = useState<TrackingMapSnapshot | null>(null);
  const [trackingEndpoints, setTrackingEndpoints] = useState<TrackingEndpoint[]>([]);
  const [trackingConnection, setTrackingConnection] = useState<"off" | "live" | "reconnecting">("off");
  const [equipmentAttachments, setEquipmentAttachments] = useState<EquipmentAttachment[]>([]);
  const [equipmentLinks, setEquipmentLinks] = useState<EquipmentLink[]>([]);
  const [equipmentResourcesState, setEquipmentResourcesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [equipmentResourcesBusy, setEquipmentResourcesBusy] = useState(false);
  const [equipmentResourcesRefresh, setEquipmentResourcesRefresh] = useState(0);
  const [equipmentResourcesFeedback, setEquipmentResourcesFeedback] = useState<Feedback>(null);
  const [equipmentLinkLabel, setEquipmentLinkLabel] = useState("");
  const [equipmentLinkUrl, setEquipmentLinkUrl] = useState("");
  const equipmentPhotoInputRef = useRef<HTMLInputElement>(null);
  return Object.assign(context, { state, locale, t, now, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, initialPropertyAvailable, appliedInitialPropertyIdRef, lastInitialPropertyIdRef, internalPropertyId, setInternalPropertyId, controlledPropertyAvailable, propertyId, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, setSelectedAreaId, selectedArea, selectedAreaEquipmentIds, selectedAreaTasks, isNewArea, setIsNewArea, isNewFixedAsset, setIsNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, setPending, feedback, setFeedback, editingEquipmentId, setEditingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, setInventoryQuery, changeInventoryQuery, inventoryStatus, setInventoryStatus, changeInventoryStatus, inventoryLocation, setInventoryLocation, changeInventoryLocation, structureQuery, setStructureQuery, changeStructureQuery, mapItemQuery, setMapItemQuery, changeMapItemQuery, mapItemFilter, setMapItemFilter, changeMapItemFilter, mapItemLimit, setMapItemLimit, mapItemSelection, setMapItemSelection, changeMapItemSelection, changeMapEquipmentSelection, changeMapAndInventoryEquipmentSelection, mapLayers, setMapLayers, changeMapLayer, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, setTrackedEquipment, trackingCapabilities, setTrackingCapabilities, trackingSnapshot, setTrackingSnapshot, trackingEndpoints, setTrackingEndpoints, trackingConnection, setTrackingConnection, selectedEquipmentId, setSelectedEquipmentId, changeSelectedEquipmentId, equipmentAttachments, setEquipmentAttachments, equipmentLinks, setEquipmentLinks, equipmentResourcesState, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, equipmentResourcesRefresh, setEquipmentResourcesRefresh, equipmentResourcesFeedback, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef });
}
