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
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_CHILD_DISCOVERY_ATTEMPTS, TP_LINK_CHILD_DISCOVERY_INTERVAL_MS, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, waitForChildDiscoveryAttempt, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart03 } from "./part-03";
export function useIntegrationsPagePart04(context: ReturnType<typeof useIntegrationsPagePart03>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery, tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment, disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, updateTpLinkCanaryTargets, loadTpLinkCanaryTargets, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob } = context;
  const scanIntegrations = async (options: { automatic?: boolean } = {}) => {
      const targetHouseId = house.id;
      automaticallyScannedHouseId.current = targetHouseId;
      const generation = ++discoveryGeneration.current;
      setDiscovering(true);
      setDiscovery(null);
      setDiscoveryOutcome("idle");
      try {
        const draftCredentials = tpLinkUsername.trim() && tpLinkPassword
          ? { username: tpLinkUsername.trim(), password: tpLinkPassword }
          : null;
        const result = draftCredentials
          ? await api.discoverIntegrations(targetHouseId, draftCredentials)
          : await api.discoverIntegrations(targetHouseId);
        if (activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
        setDiscovery(result);
        const count = result.tpLink.length + result.homeAssistant.length;
        setDiscoveryOutcome(count > 0 ? "found" : result.warnings.length > 0 ? "error" : "empty");
        if (result.tpLink.length === 1 && !tpLinkHostDraft.current.trim()
          && (!options.automatic || !integration.tpLink.configured)) {
          changeTpLinkDraft("host", result.tpLink[0]!.host);
          setTpLinkSettingsOpen(true);
        }
        if (result.tpLink.length === 0 && !integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
      } catch {
        if (activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
        setDiscovery(null);
        setDiscoveryOutcome("error");
        if (!integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
      } finally {
        if (activeSetupHouseId.current === targetHouseId && discoveryGeneration.current === generation) {
          setDiscovering(false);
        }
      }
    };
  useEffect(() => {
      if (activeSection !== "connections" || !integration.tpLink.configured
        || automaticallyScannedHouseId.current === house.id) return;
      void scanIntegrations({ automatic: true });
    }, [activeSection, house.id, integration.tpLink.configured]);
  useEffect(() => {
      if (activeSection !== "connections" || !integration.tpLink.configured) return;
      void loadTpLinkExportJobs();
    }, [activeSection, integration.tpLink.configured]);
  const settleTpLinkChildren = async (hubModel: "H100" | "H200" | null) => {
      stopTpLinkChildDiscovery();
      const targetHouseId = house.id;
      const controller = new AbortController();
      tpLinkChildDiscoveryAbort.current = controller;
      tpLinkChildDiscoveryKey.current = hubModel ?? "unknown";
      tpLinkChildDiscoveryRunning.current = true;
      let receivedResponse = false;
      let receivedDeviceInventory = false;
      let latestStatus: IntegrationStatus["tpLink"] | null = null;
      const isCurrentHouse = () => !controller.signal.aborted
        && activeSetupHouseId.current === targetHouseId
        && tpLinkChildDiscoveryAbort.current === controller;

      try {
        for (let attempt = 1; attempt <= TP_LINK_CHILD_DISCOVERY_ATTEMPTS; attempt += 1) {
          if (attempt > 1 && !await waitForChildDiscoveryAttempt(controller.signal)) return;
          if (!isCurrentHouse()) return;
          setTpLinkChildDiscovery({ phase: "settling", attempt, hubModel });
          const [devicesResult, statusResult] = await Promise.allSettled([
            onRefreshTpLinkDevices ? onRefreshTpLinkDevices(targetHouseId) : api.tpLinkDevices(targetHouseId),
            api.integrations(targetHouseId),
          ]);
          if (!isCurrentHouse()) return;

          const devices = devicesResult.status === "fulfilled" ? devicesResult.value : [];
          if (devicesResult.status === "fulfilled") updateTpLinkCanaryTargets(devices);
          if (devicesResult.status === "fulfilled") {
            receivedResponse = true;
            receivedDeviceInventory = true;
          }
          if (statusResult.status === "fulfilled") {
            receivedResponse = true;
            latestStatus = statusResult.value.tpLink;
          }
          const discoveredDevices = Math.max(devices.length, latestStatus?.discoveredDevices ?? 0);
          if (discoveredDevices > 0) {
            setTpLinkChildDiscovery({ phase: "found", count: discoveredDevices, hubModel: latestStatus?.hubModel ?? hubModel });
            return;
          }
        }

        if (!isCurrentHouse()) return;
        setTpLinkChildDiscovery({
          phase: !receivedResponse || !receivedDeviceInventory || Boolean(latestStatus?.error) ? "error" : "empty",
          hubModel: latestStatus?.hubModel ?? hubModel,
        });
      } finally {
        if (tpLinkChildDiscoveryAbort.current === controller) {
          tpLinkChildDiscoveryAbort.current = null;
          tpLinkChildDiscoveryKey.current = null;
          tpLinkChildDiscoveryRunning.current = false;
        }
      }
    };
  useEffect(() => {
      const hubModel = integration.tpLink.hubModel;
      const eligible = activeSection === "connections"
        && integration.tpLink.configured
        && integration.tpLink.connected
        && integration.tpLink.discoveredDevices === 0
        && Boolean(hubModel);
      const configuredHubDiscoveryRunning = activeSection === "connections"
        && integration.tpLink.configured
        && integration.tpLink.discoveredDevices === 0
        && tpLinkChildDiscoveryRunning.current;
      if (!eligible && !configuredHubDiscoveryRunning) {
        stopTpLinkChildDiscovery(integration.tpLink.discoveredDevices === 0);
      }
    }, [
      activeSection,
      integration.tpLink.configured,
      integration.tpLink.connected,
      integration.tpLink.discoveredDevices,
      integration.tpLink.hubModel,
    ]);
  useEffect(() => {
      const hubModel = integration.tpLink.hubModel;
      const eligible = activeSection === "connections"
        && integration.tpLink.configured
        && integration.tpLink.connected
        && integration.tpLink.discoveredDevices === 0
        && Boolean(hubModel);
      if (!eligible || !hubModel) return;
      const expectedKey = hubModel;
      if (tpLinkChildDiscoveryRunning.current) {
        if (tpLinkChildDiscoveryKey.current !== expectedKey) void settleTpLinkChildren(hubModel);
        return;
      }
      const displayedHubModel = tpLinkChildDiscovery.phase === "idle" ? null : tpLinkChildDiscovery.hubModel;
      if (tpLinkChildDiscovery.phase === "idle" || displayedHubModel !== hubModel) void settleTpLinkChildren(hubModel);
    }, [
      activeSection,
      integration.tpLink.configured,
      integration.tpLink.connected,
      integration.tpLink.discoveredDevices,
      integration.tpLink.hubModel,
      tpLinkChildDiscovery.phase,
    ]);
  const saveTpLink = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (validatedTpLinkDraft !== tpLinkDraftKey) {
        setTpLinkFeedback({ kind: "error", message: t("setup.validationRequired") });
        return;
      }
      if (!window.confirm(t("setup.activationConfirm"))) return;
      setSavingTpLink(true);
      setTpLinkFeedback(null);
      const requestHouseId = house.id;
      try {
        const configured = await api.configureTpLink({
          houseId: requestHouseId,
          host: tpLinkHost,
          username: tpLinkUsername,
          password: tpLinkPassword,
        });
        if (activeSetupHouseId.current !== requestHouseId) return;
        onIntegrationChange(configured.integration);
        setTpLinkPassword("");
        setValidatedTpLinkDraft(null);
        setShowTpLinkPassword(false);
        setTpLinkFeedback({ kind: "success", message: t("setup.credentialsSaved") });
        const selectedSource = discovery?.tpLink.find((candidate) => candidate.host === tpLinkHost);
        const discoveredHubModel = selectedSource?.sourceType !== "energy-device"
          && (selectedSource?.model === "H100" || selectedSource?.model === "H200")
          ? selectedSource.model
          : null;
        const hubModel = configured.integration.tpLink.hubModel ?? discoveredHubModel;
        if (hubModel) void settleTpLinkChildren(hubModel);
        else {
          stopTpLinkChildDiscovery();
          setTpLinkChildDiscovery({ phase: "idle" });
        }
      } catch {
        if (activeSetupHouseId.current === requestHouseId) setTpLinkFeedback({ kind: "error", message: t("setup.credentialsError") });
      } finally {
        if (activeSetupHouseId.current === requestHouseId) setSavingTpLink(false);
      }
    };
  const saveHomeAssistant = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (validatedHomeAssistantDraft !== homeAssistantDraftKey) {
        setHomeAssistantFeedback({ kind: "error", message: t("setup.validationRequired") });
        return;
      }
      if (!window.confirm(t("setup.activationConfirm"))) return;
      setSavingHomeAssistant(true);
      setHomeAssistantFeedback(null);
      const requestHouseId = house.id;
      try {
        const configured = await api.configureHomeAssistant({ houseId: requestHouseId, url: haUrl, token: haToken });
        if (activeSetupHouseId.current !== requestHouseId) return;
        onIntegrationChange(configured.integration);
        setHaToken("");
        setValidatedHomeAssistantDraft(null);
        setShowHaToken(false);
        setHomeAssistantFeedback({ kind: "success", message: t("setup.credentialsSaved") });
      } catch {
        if (activeSetupHouseId.current === requestHouseId) setHomeAssistantFeedback({ kind: "error", message: t("setup.credentialsError") });
      } finally {
        if (activeSetupHouseId.current === requestHouseId) setSavingHomeAssistant(false);
      }
    };
  const saveLocation = async () => {
      setLocationValidationAttempted(true);
      if (!draftLocation || !validTimeZone(timezone)) {
        setLocationFeedback(null);
        return;
      }
      const request = beginLocationRequest();
      const nextLocation = draftLocation;
      const nextTimezone = timezone.trim();
      setSavingLocation(true);
      setLocationFeedback(null);
      try {
        await onHouseUpdate(request.houseId, {
          location: {
            ...nextLocation,
            source: "manual",
            confidence: "high",
            discoveredAt: new Date().toISOString(),
            userOverridden: true,
          },
          timezone: nextTimezone,
        });
        if (!isCurrentLocationRequest(request)) return;
        setLocationValidationAttempted(false);
        setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
      } catch {
        if (!isCurrentLocationRequest(request)) return;
        setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  const removeLocation = async () => {
      const request = beginLocationRequest();
      setSavingLocation(true);
      setLocationFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, { location: null });
        if (!isCurrentLocationRequest(request)) return;
        setLatitude("");
        setLongitude("");
        setLocationLabel("");
        setLocationFeedback({ kind: "success", message: t("weather.locationRemoved") });
      } catch {
        if (!isCurrentLocationRequest(request)) return;
        setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  return Object.assign(context, { scanIntegrations, settleTpLinkChildren, saveTpLink, saveHomeAssistant, saveLocation, removeLocation });
}