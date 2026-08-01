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
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { integrationForHouse } from "../../integrationScope";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart04 } from "./part-04";
export function useIntegrationsPagePart05(context: ReturnType<typeof useIntegrationsPagePart04>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery, tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment, disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, updateTpLinkCanaryTargets, loadTpLinkCanaryTargets, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob, scanIntegrations, settleTpLinkChildren, saveTpLink, saveHomeAssistant, saveLocation, removeLocation } = context;
  const resetPlacementDraft = () => {
      const form = placementForm(house);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
      setPlacementEditing(false);
      setPlacementFeedback(null);
    };
  const savePlacement = async () => {
      if (!draftPlacement) {
        setPlacementFeedback({ kind: "error", message: t("placement.invalid") });
        return;
      }
      if (orientation.trim() && draftOrientation === null) {
        setPlacementFeedback({ kind: "error", message: t("orientation.invalid") });
        return;
      }
      const patch: HouseGeoreferencePatch = {
        mapPlacement: draftPlacement,
        ...(orientation.trim()
          ? { orientationDegrees: draftOrientation as number }
          : house.orientationDegrees !== undefined ? { orientationDegrees: null } : {}),
      };
      const request = beginPlacementRequest();
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, patch);
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementEditing(false);
        setPlacementFeedback({ kind: "success", message: t("placement.saved") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const removePlacement = async () => {
      const request = beginPlacementRequest();
      const selectedHouse = house;
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, { mapPlacement: null });
        if (!isCurrentPlacementRequest(request)) return;
        const { mapPlacement: _removedPlacement, ...houseWithoutPlacement } = selectedHouse;
        const form = placementForm(houseWithoutPlacement);
        setPlacementLatitude(form.latitude);
        setPlacementLongitude(form.longitude);
        setFootprintFloorId(form.footprintFloorId);
        setFootprintWidthMeters(form.footprintWidthMeters);
        setPlacementEditing(true);
        setPlacementFeedback({ kind: "success", message: t("placement.removed") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const clearOrientation = async () => {
      const request = beginPlacementRequest();
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, { orientationDegrees: null });
        if (!isCurrentPlacementRequest(request)) return;
        setOrientation("");
        setPlacementFeedback({ kind: "success", message: t("orientation.cleared") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("orientation.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const updateFromMap = (houseId: string, location: MapLocation) => {
      if (houseId !== house.id) return;
      setPlacementLatitude(location.latitude.toFixed(7));
      setPlacementLongitude(location.longitude.toFixed(7));
      setPlacementEditing(true);
      setPlacementFeedback(null);
    };
  const usePlacementForWeather = () => {
      const source = house.mapPlacement ?? draftMapLocation;
      if (!source) return;
      setLatitude(source.latitude.toFixed(6));
      setLongitude(source.longitude.toFixed(6));
      setLocationLabel("");
      setLocationFeedback(null);
    };
  const savePlacementForWeather = async () => {
      const source = house.mapPlacement;
      if (!source) return;
      const request = beginLocationRequest();
      const discoveredAt = new Date().toISOString();
      const nextLocation: HouseLocation = {
        latitude: source.latitude,
        longitude: source.longitude,
        source: "map-placement",
        confidence: "high",
        discoveredAt,
        userOverridden: true,
      };
      setSavingLocation(true);
      setLocationFeedback(null);
      try {
        const defaults = await api.coordinateDefaults(source.latitude, source.longitude);
        await onHouseUpdate(request.houseId, { location: nextLocation, timezone: defaults.timezone });
        if (!isCurrentLocationRequest(request)) return;
        setLatitude(String(source.latitude));
        setLongitude(String(source.longitude));
        setLocationLabel("");
        setTimezone(defaults.timezone);
        setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
      } catch {
        if (!isCurrentLocationRequest(request)) return;
        setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  const applyDiscoveredDefaults = async (defaults: DiscoveredHomeDefaults) => {
      const request = beginLocationRequest();
      setSavingLocation(true);
      try {
        await onHouseUpdate(request.houseId, { location: defaults.location, timezone: defaults.timezone });
        if (!isCurrentLocationRequest(request)) return;
        setLatitude(String(defaults.location.latitude));
        setLongitude(String(defaults.location.longitude));
        setLocationLabel(defaults.location.label ?? "");
        setTimezone(defaults.timezone);
        setLocationFeedback(null);
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  const addableTpLinkSources = (discovery?.tpLink ?? []).filter((source) => !source.configuredConnectionId);
  const addableGreeDevices = (discovery?.gree ?? []).filter((device) => !device.configuredConnectionId);
  const discoveredCount = addableTpLinkSources.length + addableGreeDevices.length
      + (discovery?.homeAssistant.length ?? 0);
  const sensorHardwareDetected = addableTpLinkSources.length + (discovery?.homeAssistant.length ?? 0) > 0
      || integration.tpLink.discoveredDevices > 0
      || integration.tpLink.mappedDevices > 0
      || integration.homeAssistant.mappedEntities > 0;
  const sensorSourceConfigured = integration.tpLink.configured || integration.homeAssistant.configured;
  const sensorSourceConnected = integration.tpLink.connected || integration.homeAssistant.connected;
  const mappedSensorSources = integration.tpLink.mappedDevices > 0 || integration.homeAssistant.mappedEntities > 0;
  const tpLinkReadyDevices = Math.max(0, integration.tpLink.discoveredDevices - integration.tpLink.mappedDevices);
  const tpLinkHubName = integration.tpLink.hubModel ?? t("setup.tpLinkEnergyDevice");
  const tpLinkSourceCount = integration.tpLink.connections?.length ?? Number(integration.tpLink.configured);
  const connectedTpLinkSourceCount = integration.tpLink.connections
    ? integration.tpLink.connections.filter((connection) => connection.connected).length
    : Number(integration.tpLink.connected);
  const greeConnected = integration.gree?.connected ?? false;
  const connectedSourceCount = Number(integration.tpLink.connected)
      + Number(integration.homeAssistant.connected)
      + Number(greeConnected);
  const assignmentCount = homeAssistantAssignments.length + tpLinkAssignments.length;
  const connectedSourceLabel = connectedSourceCount > 1
      ? t("setup.sourcesConnected", { count: connectedSourceCount })
      : integration.tpLink.connected
        ? t("setup.tpLinkConnectedShort")
        : integration.homeAssistant.connected
          ? t("setup.homeAssistantConnectedShort")
          : greeConnected
            ? t("setup.greeConnectedShort")
            : t("common.notConnected");
  const streamStatusLabel = t(`setup.stream.${streamConnection}`);
  const tpLinkHealthState = integration.tpLink.error
      ? integration.tpLink.connected ? "warning" : "error"
      : integration.tpLink.connected ? "connected" : "reconnecting";
  const tpLinkHealthLabel = tpLinkHealthState === "connected"
      ? t("common.connected")
      : tpLinkHealthState === "warning"
        ? t("setup.tpLinkWarning")
        : t("common.notConnected");
  const tpLinkStatusTitle = t("setup.tpLinkSourcesStatusTitle", {
      connected: connectedTpLinkSourceCount,
      count: tpLinkSourceCount,
    });
  const connectionWorkspaceActive = activeSection === "connections"
      && (sensorSourceConfigured || Boolean(integration.gree?.configured));
  const steps = [
      { icon: Home, title: t("setup.step1"), body: t("setup.step1body"), complete: true },
      { icon: Link2, title: t("setup.step2"), body: t("setup.step2body"), complete: sensorSourceConnected },
      { icon: ThermometerSun, title: t("setup.step3"), body: t("setup.step3body"), complete: mappedSensorSources },
    ];
  const completeCount = steps.filter((step) => step.complete).length;
  const nextStepIndex = steps.findIndex((step) => !step.complete);
  const nextStep = nextStepIndex >= 0 ? steps[nextStepIndex]! : null;
  const weatherHomes = houses.filter((candidate) => candidate.location).length;
  const notesGrantCount = integration.appleNotes?.grantCount ?? 0;
  const selectedDiscoveredTpLink = addableTpLinkSources.find((candidate) => candidate.host === tpLinkHost);
  const selectedDiscoveredHomeAssistant = discovery?.homeAssistant.find((candidate) => candidate.url === haUrl);
  const setupSections: Array<{ id: SetupSection; label: string; detail: string }> = [
      { id: "overview", label: t("setup.workspaceOverview"), detail: t("setup.workspaceOverviewDetail") },
      { id: "layout", label: t("setup.workspaceLayout"), detail: t("setup.workspaceLayoutDetail", { count: house.floors.length }) },
      { id: "connections", label: t("setup.workspaceConnections"), detail: connectedSourceLabel },
      { id: "weather", label: t("setup.workspaceWeather"), detail: t("setup.workspaceWeatherDetail", { count: weatherHomes }) },
      { id: "operations", label: t("setup.workspaceOperations"), detail: t("setup.workspaceOperationsDetail") },
      { id: "automations", label: t("setup.workspaceAutomations"), detail: t("setup.workspaceAutomationsDetail", { count: notesGrantCount }) },
    ];
  const primarySetupSections = setupSections.filter((section) => section.id !== "weather" && section.id !== "operations" && section.id !== "automations");
  const advancedSetupSections = setupSections.filter((section) => section.id === "weather" || section.id === "operations" || section.id === "automations");
  const activeSectionLabel = setupSections.find((section) => section.id === activeSection)?.label ?? t("setup.workspaceOverview");
  const sectionHeading = activeSection === "overview"
      ? t("setup.title")
      : activeSection === "connections"
        ? t("setup.connectionsTitle")
        : activeSection === "weather"
          ? t("setup.advancedWeather")
        : activeSectionLabel;
  const sectionDescription = activeSection === "connections"
      ? t("setup.connectionsDescription")
      : activeSection === "weather"
        ? t("setup.advancedWeatherDescription")
        : t("setup.description");
  const activateSection = (section: SetupSection) => {
      setActiveSection(section);
      writeSetupSection(section);
    };
  return Object.assign(context, { resetPlacementDraft, savePlacement, removePlacement, clearOrientation, updateFromMap, usePlacementForWeather, savePlacementForWeather, applyDiscoveredDefaults, addableTpLinkSources, addableGreeDevices, discoveredCount, sensorHardwareDetected, sensorSourceConfigured, sensorSourceConnected, mappedSensorSources, tpLinkReadyDevices, tpLinkHubName, connectedSourceCount, assignmentCount, connectedSourceLabel, streamStatusLabel, tpLinkHealthState, tpLinkHealthLabel, tpLinkStatusTitle, connectionWorkspaceActive, steps, completeCount, nextStepIndex, nextStep, weatherHomes, notesGrantCount, selectedDiscoveredTpLink, selectedDiscoveredHomeAssistant, setupSections, primarySetupSections, advancedSetupSections, activeSectionLabel, sectionHeading, sectionDescription, activateSection });
}
