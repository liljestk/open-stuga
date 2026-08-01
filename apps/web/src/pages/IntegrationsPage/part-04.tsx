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
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, forgetIntegrationDiscovery, mapLocation, placementForm, rememberIntegrationDiscovery, rememberedIntegrationDiscovery, setupSectionFromPath, setupSectionOrder, validTimeZone, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart03 } from "./part-03";
export function useIntegrationsPagePart04(context: ReturnType<typeof useIntegrationsPagePart03>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, reuseSavedTpLinkAccount, setReuseSavedTpLinkAccount, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery, tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment, disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, updateTpLinkCanaryTargets, loadTpLinkCanaryTargets, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob } = context;
  const pageMounted = useRef(true);
  const discoverySubscription = useRef<AbortController | null>(null);
  const scanIntegrations = async (options: { automatic?: boolean; resumeJobId?: string } = {}) => {
      const targetHouseId = house.id;
      const tpLinkHostAtStart = tpLinkHostDraft.current.trim();
      discoverySubscription.current?.abort();
      const subscription = new AbortController();
      discoverySubscription.current = subscription;
      automaticallyScannedHouseId.current = targetHouseId;
      const generation = ++discoveryGeneration.current;
      setDiscovering(true);
      setDiscovery(null);
      setDiscoveryOutcome("idle");
      setTpLinkFeedback(null);
      let startedJobId = options.resumeJobId ?? null;
      try {
        const draftCredentials = tpLinkUsername.trim() && tpLinkPassword
          ? { username: tpLinkUsername.trim(), password: tpLinkPassword }
          : null;
        const result = options.resumeJobId
          ? await api.resumeIntegrationDiscovery(options.resumeJobId, subscription.signal)
          : await api.discoverIntegrations(targetHouseId, draftCredentials ?? undefined, (job) => {
              startedJobId = job.id;
              rememberIntegrationDiscovery(targetHouseId, job.id);
              context.onDiscoveryStarted?.(job);
            }, subscription.signal);
        if (!pageMounted.current || activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
        const configuredTpLinkHosts = new Set((aggregateIntegration.tpLink.connections ?? [])
          .flatMap((connection) => connection.host ? [connection.host] : []));
        if (integration.tpLink.host) configuredTpLinkHosts.add(integration.tpLink.host);
        const addableTpLinkSources = result.tpLink.filter((source) => (
          !source.configuredConnectionId
          && (!options.resumeJobId || !configuredTpLinkHosts.has(source.host))
        ));
        const addableHomeAssistant = options.resumeJobId && integration.homeAssistant.configured
          ? []
          : result.homeAssistant;
        const configuredGreeMacs = new Set((aggregateIntegration.gree?.connections ?? [])
          .map((connection) => connection.mac));
        const addableGreeDevices = (result.gree ?? []).filter((device) => (
          !device.configuredConnectionId && !configuredGreeMacs.has(device.mac)
        ));
        setDiscovery({
          ...result,
          homeAssistant: addableHomeAssistant,
          tpLink: addableTpLinkSources,
          gree: addableGreeDevices,
        });
        const count = addableTpLinkSources.length + addableHomeAssistant.length + addableGreeDevices.length;
        setDiscoveryOutcome(count > 0 ? "found" : result.warnings.length > 0 ? "error" : "empty");
        if (addableTpLinkSources.length > 0) {
          context.tpLinkEditingConnectionId.current = null;
          const currentHost = tpLinkHostDraft.current.trim();
          if (currentHost === tpLinkHostAtStart) {
            const selectedSource = addableTpLinkSources.find(
              (source) => source.host === currentHost,
            ) ?? addableTpLinkSources[0]!;
            if (currentHost !== selectedSource.host) {
              changeTpLinkDraft("host", selectedSource.host);
            }
          }
          context.setConnectionSetupOpen(true);
          setTpLinkSettingsOpen(true);
        }
        if (addableTpLinkSources.length === 0 && addableGreeDevices.length === 0
          && !integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
      } catch {
        if (subscription.signal.aborted) return;
        if (startedJobId) {
          try {
            const latestJob = await api.latestIntegrationDiscovery(targetHouseId);
            if (!latestJob || latestJob.id !== startedJobId || latestJob.status !== "running") {
              forgetIntegrationDiscovery(targetHouseId, startedJobId);
            }
          } catch {
            // Preserve the id while offline so this server-owned job can be resumed later.
          }
        }
        if (!pageMounted.current || activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
        setDiscovery(null);
        setDiscoveryOutcome("error");
        if (!integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
      } finally {
        if (discoverySubscription.current === subscription) discoverySubscription.current = null;
        if (pageMounted.current && activeSetupHouseId.current === targetHouseId && discoveryGeneration.current === generation) {
          setDiscovering(false);
        }
      }
    };
  useEffect(() => {
      pageMounted.current = true;
      return () => {
        pageMounted.current = false;
        discoverySubscription.current?.abort();
        discoverySubscription.current = null;
      };
    }, []);
  useEffect(() => {
      let cancelled = false;
      const targetHouseId = house.id;
      const resumeJob = (jobId: string) => {
        if (cancelled || activeSetupHouseId.current !== targetHouseId) return;
        automaticallyScannedHouseId.current = targetHouseId;
        void scanIntegrations({ resumeJobId: jobId });
      };
      const jobId = rememberedIntegrationDiscovery(targetHouseId);
      if (jobId) {
        resumeJob(jobId);
        return () => { cancelled = true; };
      }
      // A completed server-owned result may predate browser persistence. Restore
      // it before deciding whether this visit needs a new network search.
      automaticallyScannedHouseId.current = targetHouseId;
      void api.latestIntegrationDiscovery(targetHouseId).then((job) => {
        if (cancelled || activeSetupHouseId.current !== targetHouseId) return;
        if (job && job.status !== "failed") {
          rememberIntegrationDiscovery(targetHouseId, job.id);
          resumeJob(job.id);
          return;
        }
        automaticallyScannedHouseId.current = null;
        if (activeSection === "connections" && integration.tpLink.configured) {
          void scanIntegrations({ automatic: true });
        }
      }).catch(() => {
        if (cancelled || activeSetupHouseId.current !== targetHouseId) return;
        automaticallyScannedHouseId.current = null;
        if (activeSection === "connections" && integration.tpLink.configured) {
          void scanIntegrations({ automatic: true });
        }
      });
      return () => { cancelled = true; };
    }, [house.id]);
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
      const targetHouseId = house.id;
      setTpLinkChildDiscovery({
        phase: "settling",
        hubModel,
        baselineLastPollAt: integration.tpLink.lastPollAt,
      });
      try {
        const [devicesResult, statusResult] = await Promise.allSettled([
          onRefreshTpLinkDevices ? onRefreshTpLinkDevices(targetHouseId) : api.tpLinkDevices(targetHouseId),
          api.integrations(targetHouseId),
        ]);
        if (activeSetupHouseId.current !== targetHouseId) return;
        const devices = devicesResult.status === "fulfilled" ? devicesResult.value : [];
        if (devicesResult.status === "fulfilled") updateTpLinkCanaryTargets(devices);
        if (statusResult.status === "fulfilled") onIntegrationChange(statusResult.value);
        const latestStatus = statusResult.status === "fulfilled" ? statusResult.value.tpLink : null;
        const discoveredDevices = Math.max(devices.length, latestStatus?.discoveredDevices ?? 0);
        if (discoveredDevices > 0) {
          setTpLinkChildDiscovery({ phase: "found", count: discoveredDevices, hubModel: latestStatus?.hubModel ?? hubModel });
        } else if (devicesResult.status === "rejected" || statusResult.status === "rejected" || latestStatus?.error) {
          setTpLinkChildDiscovery({ phase: "error", hubModel: latestStatus?.hubModel ?? hubModel });
        }
      } catch {
        if (activeSetupHouseId.current === targetHouseId) setTpLinkChildDiscovery({ phase: "error", hubModel });
      }
    };
  useEffect(() => {
      setTpLinkChildDiscovery((current) => {
        const hubModel = integration.tpLink.hubModel
          ?? (current.phase === "idle" ? null : current.hubModel);
        if (activeSection !== "connections" || !integration.tpLink.configured || !hubModel) {
          return { phase: "idle" };
        }
        if (!integration.tpLink.connected && integration.tpLink.error) {
          return current.phase === "settling" ? { phase: "error", hubModel } : { phase: "idle" };
        }
        if (integration.tpLink.discoveredDevices > 0) {
          return current.phase === "settling" || current.phase === "found"
            ? { phase: "found", count: integration.tpLink.discoveredDevices, hubModel }
            : { phase: "idle" };
        }
        if (current.phase === "found") return { phase: "idle" };
        if (current.phase !== "settling") return current;
        if (integration.tpLink.lastPollAt
          && integration.tpLink.lastPollAt !== current.baselineLastPollAt) {
          return { phase: "empty", hubModel };
        }
        return { ...current, hubModel };
      });
    }, [
      activeSection,
      integration.tpLink.configured,
      integration.tpLink.connected,
      integration.tpLink.error,
      integration.tpLink.discoveredDevices,
      integration.tpLink.hubModel,
      integration.tpLink.lastPollAt,
    ]);
  const saveTpLink = async (
      event: FormEvent<HTMLFormElement>,
      credentialSourceConnectionId?: string,
    ) => {
      event.preventDefault();
      if (!credentialSourceConnectionId && !await confirmAction(t("setup.activationConfirm"), t("confirmation.activate"), false)) return;
      setSavingTpLink(true);
      setTpLinkFeedback(null);
      const requestViewHouseId = house.id;
      const editingConnection = tpLinkAssignments.find((connection) => connection.id === context.tpLinkEditingConnectionId.current);
      const requestHouseId = editingConnection?.houseId ?? requestViewHouseId;
      const submittedHost = tpLinkHost.trim();
      const selectedSource = discovery?.tpLink.find((candidate) => candidate.host === submittedHost);
      const sourceName = editingConnection?.sourceAlias
        ?? editingConnection?.sourceModel
        ?? selectedSource?.alias
        ?? (selectedSource?.model ? `TP-Link ${selectedSource.model}` : submittedHost);
      const requestHomeName = connectionHouses.find((candidate) => candidate.id === requestHouseId)?.name ?? house.name;
      try {
        const configuration = {
          houseId: requestHouseId,
          ...(context.tpLinkEditingConnectionId.current ? { connectionId: context.tpLinkEditingConnectionId.current } : {}),
          host: tpLinkHost,
        };
        const configured = credentialSourceConnectionId
          ? await api.configureTpLink({ ...configuration, credentialSourceConnectionId })
          : await api.configureTpLink({ ...configuration, username: tpLinkUsername, password: tpLinkPassword });
        if (activeSetupHouseId.current !== requestViewHouseId) return;
        const savedConnection = (status: typeof configured.integration) => (
          status.tpLink.connections?.find((connection) => connection.id === configured.connectionId)
        );
        let confirmedIntegration = configured.integration;
        let confirmedConnection = configured.connectionId ? savedConnection(confirmedIntegration) : undefined;
        if (configured.connectionId && !confirmedConnection) {
          confirmedIntegration = await api.integrations();
          confirmedConnection = savedConnection(confirmedIntegration);
        }
        if (configured.connectionId && !confirmedConnection) throw new Error(t("setup.tpLinkSaveVerificationError"));
        onIntegrationChange(confirmedIntegration);
        const previouslySaved = confirmedConnection
          ? tpLinkAssignments.some((connection) => connection.id === confirmedConnection.id)
          : Boolean(editingConnection);
        const created = configured.created ?? (!editingConnection && !previouslySaved);
        const confirmedSourceName = confirmedConnection?.sourceAlias
          ?? confirmedConnection?.sourceModel
          ?? sourceName;
        const remainingSources = (discovery?.tpLink ?? []).filter((candidate) => candidate.host !== submittedHost);
        const nextSource = remainingSources.find((candidate) => !candidate.configuredConnectionId);
        if (discovery) {
          setDiscovery({ ...discovery, tpLink: remainingSources });
          setDiscoveryOutcome(remainingSources.length + discovery.homeAssistant.length > 0 ? "found" : "empty");
        }
        tpLinkHostDraft.current = nextSource?.host ?? "";
        setTpLinkHost(nextSource?.host ?? "");
        setTpLinkUsername("");
        setTpLinkPassword("");
        setReuseSavedTpLinkAccount(true);
        context.tpLinkEditingConnectionId.current = null;
        tpLinkTestGeneration.current += 1;
        setValidatedTpLinkDraft(null);
        setDirectResult(null);
        setShowTpLinkPassword(false);
        setTpLinkSettingsOpen(false);
        setTpLinkFeedback({
          kind: "success",
          message: t(editingConnection || created
            ? editingConnection ? "setup.tpLinkConnectionUpdated" : "setup.tpLinkConnectionAdded"
            : "setup.tpLinkConnectionAlreadySaved", {
            device: confirmedSourceName,
            home: requestHomeName,
          }),
        });
        const placementDeviceId = configured.deviceId ?? selectedSource?.deviceId ?? null;
        const placementSourceType = configured.sourceType
          ?? confirmedConnection?.sourceType
          ?? selectedSource?.sourceType
          ?? null;
        if (created && !editingConnection && placementSourceType === "energy-device"
          && placementDeviceId && configured.connectionId && onOpenSensors) {
          if (onRefreshTpLinkDevices) void onRefreshTpLinkDevices(requestHouseId).catch(() => undefined);
          onOpenSensors({
            deviceId: placementDeviceId,
            connectionId: configured.connectionId,
            model: configured.sourceModel ?? selectedSource?.model ?? "TP-Link energy device",
            alias: configured.sourceAlias ?? selectedSource?.alias ?? null,
            deviceType: "energy",
          });
        }
        const discoveredHubModel = selectedSource?.sourceType !== "energy-device"
          && (selectedSource?.model === "H100" || selectedSource?.model === "H200")
          ? selectedSource.model
          : null;
        const hubModel = confirmedIntegration.tpLink.hubModel ?? discoveredHubModel;
        if (hubModel) void settleTpLinkChildren(hubModel);
        else {
          stopTpLinkChildDiscovery();
          setTpLinkChildDiscovery({ phase: "idle" });
        }
      } catch (error) {
        if (activeSetupHouseId.current === requestViewHouseId) {
          setTpLinkFeedback({ kind: "error", message: connectionError(error, t("setup.credentialsError")) });
        }
      } finally {
        if (activeSetupHouseId.current === requestViewHouseId) setSavingTpLink(false);
      }
    };
  const saveHomeAssistant = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (validatedHomeAssistantDraft !== homeAssistantDraftKey) {
        setHomeAssistantFeedback({ kind: "error", message: t("setup.validationRequired") });
        return;
      }
      if (!await confirmAction(t("setup.activationConfirm"), t("confirmation.activate"), false)) return;
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
