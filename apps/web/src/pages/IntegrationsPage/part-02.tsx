import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  CircleDot,
  CloudSun,
  Compass,
  ExternalLink,
  Home,
  LocateFixed,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Maximize2,
  Move,
  RadioTower,
  RefreshCw,
  Router,
  Ruler,
  ShieldCheck,
  ThermometerSun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  ConnectionState,
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  api,
  type HouseGeoreferencePatch,
  type HousePatch,
  type IntegrationDiscoveryResult,
  type TpLinkHistoryExportJob,
  type TpLinkHistoryExportJobsResponse,
  type TpLinkHistoryExportJobStatus,
} from "../../api";
import type { HouseLocationMapItem, MapLocation } from "../../components/HouseLocationMap";
import { confirmAction } from "../../components/ConfirmationProvider";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { integrationForHouse } from "../../integrationScope";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart01 } from "./part-01";
export function useIntegrationsPagePart02(context: ReturnType<typeof useIntegrationsPagePart01>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, reuseSavedTpLinkAccount, setReuseSavedTpLinkAccount, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery } = context;
  useEffect(() => {
      const restoreSection = () => setActiveSection(setupSectionFromPath());
      window.addEventListener("popstate", restoreSection);
      writeSetupSection(setupSectionFromPath(), true);
      return () => window.removeEventListener("popstate", restoreSection);
    }, []);
  useEffect(() => () => {
      historyExportRequestGeneration.current += 1;
      tpLinkChildDiscoveryAbort.current?.abort();
      tpLinkChildDiscoveryAbort.current = null;
      tpLinkChildDiscoveryKey.current = null;
      tpLinkChildDiscoveryRunning.current = false;
    }, []);
  useEffect(() => {
      setLatitude(house.location ? String(house.location.latitude) : "");
      setLongitude(house.location ? String(house.location.longitude) : "");
      setLocationLabel(house.location?.label ?? "");
      setTimezone(house.timezone);
    }, [house.id, house.location?.label, house.location?.latitude, house.location?.longitude, house.timezone]);
  useEffect(() => {
      const form = placementForm(house);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setPlacementEditing(!house.mapPlacement);
      setPlacementFeedback(null);
      setMapViewport(houses.some((candidate) => candidate.id !== house.id && (candidate.mapPlacement || candidate.location)) ? "all" : "selected");
    }, [house, houses]);
  useEffect(() => {
      setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
    }, [house.id, house.orientationDegrees]);
  useEffect(() => {
      locationRequestGeneration.current += 1;
      placementRequestGeneration.current += 1;
      tpLinkTestGeneration.current += 1;
      homeAssistantTestGeneration.current += 1;
      discoveryGeneration.current += 1;
      inventoryRefreshGeneration.current += 1;
      stopTpLinkChildDiscovery(true);
      setDiscovering(false);
      setDiscovery(null);
      setDiscoveryOutcome("idle");
      setRefreshingTpLinkInventory(false);
      setTpLinkInventoryRefreshFailed(false);
      setSavingLocation(false);
      setSavingPlacement(false);
      setSavingTpLink(false);
      setSavingHomeAssistant(false);
      setLocationFeedback(null);
      setPlacementFeedback(null);
      setLocationValidationAttempted(false);
      tpLinkHostDraft.current = "";
      context.tpLinkEditingConnectionId.current = null;
      setTpLinkHost("");
      setTpLinkUsername("");
      setTpLinkPassword("");
      setReuseSavedTpLinkAccount(true);
      setShowTpLinkPassword(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
      setTpLinkFeedback(null);
      setHaUrl("");
      setHaToken("");
      setShowHaToken(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
      setHomeAssistantFeedback(null);
    }, [house.id]);
  const tpLinkDraftKey = `${tpLinkHost.trim()}\u0000${tpLinkUsername.trim()}\u0000${tpLinkPassword}`;
  const homeAssistantDraftKey = `${haUrl.trim()}\u0000${haToken}`;
  useEffect(() => {
      tpLinkTestGeneration.current += 1;
      setTestingDirect(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
    }, [tpLinkHost, tpLinkUsername, tpLinkPassword]);
  useEffect(() => {
      homeAssistantTestGeneration.current += 1;
      setTesting(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
    }, [haUrl, haToken]);
  const changeTpLinkDraft = (field: "host" | "username" | "password", value: string) => {
      // Invalidate synchronously in the input event. A passive effect alone can
      // lose a race to a connection test promise that settles in the same turn.
      tpLinkTestGeneration.current += 1;
      setTestingDirect(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
      if (field === "host") {
        tpLinkHostDraft.current = value;
        setTpLinkHost(value);
        setReuseSavedTpLinkAccount(true);
      }
      else if (field === "username") setTpLinkUsername(value);
      else setTpLinkPassword(value);
    };
  const changeHomeAssistantDraft = (field: "url" | "token", value: string) => {
      homeAssistantTestGeneration.current += 1;
      setTesting(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
      if (field === "url") setHaUrl(value);
      else setHaToken(value);
    };
  const draftLocation = useMemo<HouseLocation | null>(() => {
      if (!latitude.trim() || !longitude.trim()) return null;
      const parsedLatitude = Number(latitude);
      const parsedLongitude = Number(longitude);
      if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)
        || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
      const label = locationLabel.trim();
      return { latitude: parsedLatitude, longitude: parsedLongitude, ...(label ? { label } : {}) };
    }, [latitude, locationLabel, longitude]);
  const coordinateValidationVisible = !draftLocation
      && (locationValidationAttempted || Boolean(latitude.trim() || longitude.trim()));
  const timezoneValidationVisible = !validTimeZone(timezone)
      && (locationValidationAttempted || Boolean(timezone.trim()));
  const selectedFootprintFloor = useMemo(
      () => house.floors.find((floor) => floor.id === footprintFloorId) ?? footprintFloorFor(house),
      [footprintFloorId, house],
    );
  const selectedPlanSize = useMemo(() => floorPlanSize(selectedFootprintFloor), [selectedFootprintFloor]);
  const draftMapLocation = useMemo(
      () => mapLocation(placementLatitude, placementLongitude),
      [placementLatitude, placementLongitude],
    );
  const draftPlacement = useMemo<HouseMapPlacement | null>(() => {
      if (!draftMapLocation) return null;
      const physicalWidth = Number(footprintWidthMeters);
      if (!Number.isFinite(physicalWidth) || physicalWidth < 1 || physicalWidth > 500) return null;
      const metersPerPlanUnit = physicalWidth / selectedPlanSize.width;
      if (!Number.isFinite(metersPerPlanUnit) || metersPerPlanUnit <= 0) return null;
      return {
        ...draftMapLocation,
        metersPerPlanUnit,
        ...(selectedFootprintFloor ? { footprintFloorId: selectedFootprintFloor.id } : {}),
      };
    }, [draftMapLocation, footprintWidthMeters, selectedFootprintFloor, selectedPlanSize.width]);
  const draftOrientation = useMemo<number | null>(() => {
      if (!orientation.trim()) return null;
      const parsed = Number(orientation);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 359 ? parsed : null;
    }, [orientation]);
  const footprintDepthMeters = useMemo(() => {
      const physicalWidth = Number(footprintWidthMeters);
      return Number.isFinite(physicalWidth) && selectedPlanSize.width > 0
        ? physicalWidth * selectedPlanSize.depth / selectedPlanSize.width
        : null;
    }, [footprintWidthMeters, selectedPlanSize]);
  const mapItems = useMemo<HouseLocationMapItem[]>(() => houses.map((candidate) => {
      const selected = candidate.id === house.id;
      const placement = selected ? draftPlacement : candidate.mapPlacement;
      const fallback = selected ? draftMapLocation : candidate.mapPlacement ?? candidate.location ?? null;
      const floor = selected
        ? selectedFootprintFloor
        : candidate.floors.find((item) => item.id === candidate.mapPlacement?.footprintFloorId) ?? footprintFloorFor(candidate);
      const resolvedScale = selected
        ? placement?.metersPerPlanUnit
        : floor ? floorMetersPerPlanUnit(floor, candidate) : null;
      const candidateOrientation = selected ? draftOrientation : candidate.orientationDegrees;
      return {
        id: candidate.id,
        label: t("weather.markerLabel", { house: candidate.name }),
        location: fallback ? { latitude: fallback.latitude, longitude: fallback.longitude } : null,
        ...(candidateOrientation !== null && candidateOrientation !== undefined ? { orientationDegrees: candidateOrientation } : {}),
        ...(resolvedScale !== null && resolvedScale !== undefined ? { metersPerPlanUnit: resolvedScale } : {}),
        ...(floor ? { floor } : {}),
      };
    }), [draftMapLocation, draftOrientation, draftPlacement, house.id, houses, selectedFootprintFloor, t]);
  const orientationDirection = draftOrientation === null
      ? null
      : [t("orientation.north"), t("orientation.east"), t("orientation.south"), t("orientation.west")][Math.round(draftOrientation / 90) % 4];
  const orientationExplanation = draftOrientation === null
      ? t("orientation.unknownExplanation")
      : t("orientation.knownExplanation", { degrees: draftOrientation, direction: orientationDirection ?? "" });
  const selectSetupHouse = (houseId: string) => {
      if (houseId !== house.id) {
        locationRequestGeneration.current += 1;
        placementRequestGeneration.current += 1;
        discoveryGeneration.current += 1;
        inventoryRefreshGeneration.current += 1;
        stopTpLinkChildDiscovery(true);
        setSavingLocation(false);
        setSavingPlacement(false);
        setDiscovering(false);
        setRefreshingTpLinkInventory(false);
      }
      setSetupHouseId(houseId);
      onHouse(houseId);
    };
  const disconnectHomeAssistantAssignment = async (houseId: string) => {
      const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
      if (!await confirmAction(t("setup.disconnectHomeAssistantConfirm", { home: assignedHouse?.name ?? houseId }), t("confirmation.disconnect"))) return;
      const assignmentKey = `ha:${houseId}`;
      setBusyAssignment(assignmentKey);
      setAssignmentFeedback(null);
      try {
        const result = await (onDisconnectHomeAssistant
          ? onDisconnectHomeAssistant(houseId)
          : api.disconnectHomeAssistant(houseId));
        onIntegrationChange(result.integration);
        setAssignmentFeedback({ kind: "success", message: t("setup.connectionDisconnected") });
      } catch (error) {
        setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionDisconnectFailed")) });
      } finally {
        setBusyAssignment((current) => current === assignmentKey ? null : current);
      }
    };
  return Object.assign(context, { tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment });
}
