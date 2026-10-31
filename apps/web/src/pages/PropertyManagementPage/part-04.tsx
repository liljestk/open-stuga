import { useCallback, useEffect, useMemo } from "react";
import {
  Building2,
  Boxes,
  Map as MapIcon,
  NotebookPen,
  Users,
} from "lucide-react";
import type {
  GeoCoordinate,
} from "@climate-twin/contracts";
import { api, apiErrorStatus, subscribeToTrackingEvents } from "../../api";
import { type TranslationKey } from "../../i18n";
import "../PropertyManagementPage.css";
import { NEW_FIXED_ASSET_ID, TRACKED_ASSETS_REFRESH_MS, areaDraft, coordinateText, emptyAreaDraft } from "./support";
import type { WorkspaceTab } from "./support";
import { usePropertyManagementPagePart03 } from "./part-03";
/** Tracking answers 403 when the viewer may not see it and 404 when it is turned off. */
function trackingUnavailable(error: unknown): boolean {
  const status = apiErrorStatus(error);
  return status === 403 || status === 404;
}

export function usePropertyManagementPagePart04(context: ReturnType<typeof usePropertyManagementPagePart03>) {
  const { t, canManageAccess, tab, setTab, property, readOnly, mapLoaded, setMapLoaded, equipment, setSelectedAreaId, selectedArea, setIsNewArea, setIsNewFixedAsset, drawing, setDrawing, setAreaForm, setRedoVertices, setCoordinateInput, setCoordinateError, setAreaDestinationPropertyId, setEquipmentDestination, setFeedback, setEditingEquipmentId, setEquipmentName, setEquipmentKind, setEquipmentManufacturer, setEquipmentModel, setEquipmentSerialNumber, setEquipmentStatus, setEquipmentNotes, setEquipmentLatitude, setEquipmentLongitude, mapItemSelection, setMapItemSelection, mapLayers, setTrackedEquipment, setTrackingCapabilities, setTrackingSnapshot, setTrackingEndpoints, setTrackingConnection, setMaintenanceTitle, setMaintenanceEquipmentId, placementLatitude, placementLongitude, placementWidth, placementOrientation, setPlacementEditing, placementAssetId, setPlacementAssetId, assetPlacementEditing, setAssetPlacementEditing, setAssetDraftLocation, setAssetLatitudeInput, setAssetLongitudeInput, trackingEnabled, liveMapEnabled, sharedMembers, inventoryEquipmentVersion, placementHouse, mapHouses } = context;
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
            setTrackingEndpoints([]);
          }
        })
        .catch((error: unknown) => {
          // A denied or disabled tracker is off; a transient failure keeps the last capabilities.
          if (!current || !trackingUnavailable(error)) return;
          setTrackingCapabilities(null);
          setTrackingConnection("off");
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
        void api.trackedEquipment(property.id)
          .then((assets) => {
            if (current) setTrackedEquipment(assets);
          })
          .catch((error: unknown) => {
            if (trackingUnavailable(error)) {
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
        setTrackingEndpoints([]);
        return;
      }
      let current = true;
      void api.trackingEndpoints(property.id)
        .then((tags) => { if (current) setTrackingEndpoints(tags); })
        .catch((error: unknown) => { if (current && trackingUnavailable(error)) setTrackingEndpoints([]); });
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
            setTrackedEquipment(snapshot.equipment.filter((item) => item.binding));
            if (!liveMapEnabled) setTrackingConnection("off");
          })
          .catch((error: unknown) => {
            if (!current) return;
            if (trackingUnavailable(error)) {
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
      ...(canManageAccess ? [{ id: "access" as const, key: "properties.access" as const, icon: Users }] : []),
    ];
  const vertexLabel = useCallback((index: number, canFinish: boolean) => canFinish
      ? t("properties.finishBoundaryPoint")
      : t("properties.moveBoundaryPoint", { number: index + 1 }), [t]);
  const midpointLabel = useCallback((index: number) => t("properties.addBoundaryPoint", { number: index + 1 }), [t]);
  const startArea = () => {
      setTab("map");
      setMapLoaded(true);
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      context.changeMapItemSelection(null);
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
      context.changeMapItemSelection(null);
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
  return Object.assign(context, { visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex });
}
