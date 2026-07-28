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
import { useIntegrationsPagePart02 } from "./part-02";
export function useIntegrationsPagePart03(context: ReturnType<typeof useIntegrationsPagePart02>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery, tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment } = context;
  const disconnectTpLinkAssignment = async (connectionId: string, houseId: string) => {
      const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
      if (!window.confirm(t("setup.disconnectTpLinkConfirm", { home: assignedHouse?.name ?? houseId }))) return;
      const assignmentKey = `tp:${connectionId}`;
      setBusyAssignment(assignmentKey);
      setAssignmentFeedback(null);
      try {
        const result = await (onDisconnectTpLink
          ? onDisconnectTpLink(connectionId)
          : api.disconnectTpLink(connectionId));
        onIntegrationChange(result.integration);
        setAssignmentFeedback({
          kind: "success",
          message: result.detachedSensorIds.length > 0
            ? t("setup.tpLinkDisconnectedWithSensors", { count: result.detachedSensorIds.length })
            : t("setup.connectionDisconnected"),
        });
      } catch (error) {
        setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionDisconnectFailed")) });
      } finally {
        setBusyAssignment((current) => current === assignmentKey ? null : current);
      }
    };
  const moveHomeAssistantAssignment = async (fromHouseId: string, targetHouseId: string) => {
      if (fromHouseId === targetHouseId) return;
      const fromHome = connectionHouses.find((candidate) => candidate.id === fromHouseId)?.name ?? fromHouseId;
      const targetHome = connectionHouses.find((candidate) => candidate.id === targetHouseId)?.name ?? targetHouseId;
      if (!window.confirm(t("setup.moveHomeAssistantConfirm", { from: fromHome, to: targetHome }))) return;
      const assignmentKey = `ha:${fromHouseId}`;
      setBusyAssignment(assignmentKey);
      setAssignmentFeedback(null);
      try {
        const result = await (onMoveHomeAssistant
          ? onMoveHomeAssistant(fromHouseId, targetHouseId)
          : api.moveHomeAssistant(fromHouseId, targetHouseId));
        onIntegrationChange(result.integration);
        setAssignmentHouseDrafts((current) => {
          const next = { ...current };
          delete next[assignmentKey];
          return next;
        });
        setAssignmentFeedback({ kind: "success", message: t("setup.connectionMoved", { home: targetHome }) });
      } catch (error) {
        setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionMoveFailed")) });
      } finally {
        setBusyAssignment((current) => current === assignmentKey ? null : current);
      }
    };
  const moveTpLinkAssignment = async (connectionId: string, fromHouseId: string, targetHouseId: string) => {
      if (fromHouseId === targetHouseId) return;
      const fromHome = connectionHouses.find((candidate) => candidate.id === fromHouseId)?.name ?? fromHouseId;
      const targetHome = connectionHouses.find((candidate) => candidate.id === targetHouseId)?.name ?? targetHouseId;
      if (!window.confirm(t("setup.moveTpLinkConfirm", { from: fromHome, to: targetHome }))) return;
      const assignmentKey = `tp:${connectionId}`;
      setBusyAssignment(assignmentKey);
      setAssignmentFeedback(null);
      try {
        const result = await (onMoveTpLink
          ? onMoveTpLink(connectionId, targetHouseId)
          : api.moveTpLink(connectionId, targetHouseId));
        onIntegrationChange(result.integration);
        setAssignmentHouseDrafts((current) => {
          const next = { ...current };
          delete next[assignmentKey];
          return next;
        });
        setAssignmentFeedback({
          kind: "success",
          message: result.detachedSensorIds.length > 0
            ? t("setup.tpLinkMovedWithSensors", { home: targetHome, count: result.detachedSensorIds.length })
            : t("setup.connectionMoved", { home: targetHome }),
        });
      } catch (error) {
        setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionMoveFailed")) });
      } finally {
        setBusyAssignment((current) => current === assignmentKey ? null : current);
      }
    };
  const testConnection = async () => {
      const generation = ++homeAssistantTestGeneration.current;
      const testedDraftKey = homeAssistantDraftKey;
      setTesting(true);
      setResult(null);
      try {
        const response = await api.testHomeAssistantDraft({ url: haUrl.trim(), token: haToken });
        if (homeAssistantTestGeneration.current !== generation) return;
        const successful = response.ok;
        setValidatedHomeAssistantDraft(successful ? testedDraftKey : null);
        setResult(successful ? "success" : "failure");
      } catch {
        if (homeAssistantTestGeneration.current !== generation) return;
        setValidatedHomeAssistantDraft(null);
        setResult("failure");
      } finally {
        if (homeAssistantTestGeneration.current === generation) setTesting(false);
      }
    };
  const testDirectConnection = async () => {
      const generation = ++tpLinkTestGeneration.current;
      const testedDraftKey = tpLinkDraftKey;
      setTestingDirect(true);
      setDirectResult(null);
      try {
        const hasCompleteDraft = Boolean(tpLinkHost.trim() && tpLinkUsername.trim() && tpLinkPassword);
        const hasAnyDraft = Boolean(tpLinkHost.trim() || tpLinkUsername.trim() || tpLinkPassword);
        if (!hasAnyDraft && integration.tpLink.configured) {
          const response = await api.testTpLink(house.id);
          if (tpLinkTestGeneration.current !== generation) return;
          setDirectResult(response.ok ? "success" : "failure");
          return;
        }
        if (!hasCompleteDraft) {
          if (tpLinkTestGeneration.current !== generation) return;
          setValidatedTpLinkDraft(null);
          setDirectResult("failure");
          return;
        }
        const response = await api.testTpLinkDraft({
          host: tpLinkHost.trim(), username: tpLinkUsername.trim(), password: tpLinkPassword,
        });
        if (tpLinkTestGeneration.current !== generation) return;
        const successful = response.ok;
        setValidatedTpLinkDraft(successful ? testedDraftKey : null);
        setDirectResult(successful ? "success" : "failure");
      } catch {
        if (tpLinkTestGeneration.current !== generation) return;
        setValidatedTpLinkDraft(null);
        setDirectResult("failure");
      } finally {
        if (tpLinkTestGeneration.current === generation) setTestingDirect(false);
      }
    };
  const updateTpLinkCanaryTargets = (devices: Awaited<ReturnType<typeof api.tpLinkDevices>>) => {
      const bySensor = new Map<string, string>();
      for (const device of devices) {
        if (!device.mappedSensorId) continue;
        bySensor.set(device.mappedSensorId, device.alias?.trim() || `${device.model} · ${device.deviceId}`);
      }
      const targets = [...bySensor].map(([sensorId, label]) => ({ sensorId, label }));
      setTpLinkCanaryTargets(targets);
      setTpLinkCanarySensorId((current) => targets.some((target) => target.sensorId === current)
        ? current
        : targets[0]?.sensorId ?? "");
    };
  const loadTpLinkCanaryTargets = async () => {
      try {
        updateTpLinkCanaryTargets(await api.tpLinkDevices(house.id));
      } catch {
        setTpLinkCanaryTargets([]);
        setTpLinkCanarySensorId("");
      }
    };
  const refreshTpLinkInventory = async () => {
      const targetHouseId = house.id;
      const generation = ++inventoryRefreshGeneration.current;
      setRefreshingTpLinkInventory(true);
      setTpLinkInventoryRefreshFailed(false);
      try {
        const devices = await (onRefreshTpLinkDevices ? onRefreshTpLinkDevices(targetHouseId) : api.tpLinkDevices(targetHouseId));
        if (activeSetupHouseId.current === targetHouseId) updateTpLinkCanaryTargets(devices);
      } catch {
        if (activeSetupHouseId.current === targetHouseId && inventoryRefreshGeneration.current === generation) {
          setTpLinkInventoryRefreshFailed(true);
        }
      } finally {
        if (activeSetupHouseId.current === targetHouseId && inventoryRefreshGeneration.current === generation) {
          setRefreshingTpLinkInventory(false);
        }
      }
    };
  const loadTpLinkExportJobs = async () => {
      const generation = ++historyExportRequestGeneration.current;
      setTpLinkExportJobsLoading(true);
      setTpLinkExportJobsError(null);
      try {
        const result = await api.tpLinkHistoryExportJobs();
        if (historyExportRequestGeneration.current !== generation) return;
        setTpLinkExportEnabled(result.enabled);
        setTpLinkExportAutomation(result.automation);
        setTpLinkExportJobs(result.jobs);
        if (result.enabled) void loadTpLinkCanaryTargets();
      } catch (error) {
        if (historyExportRequestGeneration.current !== generation) return;
        setTpLinkExportJobsError(connectionError(error, t("setup.tpLinkHistoryLoadFailed")));
      } finally {
        if (historyExportRequestGeneration.current === generation) setTpLinkExportJobsLoading(false);
      }
    };
  const runTpLinkCanary = async () => {
      if (!tpLinkCanarySensorId) return;
      setTpLinkCanaryRunning(true);
      setTpLinkExportJobsError(null);
      try {
        const to = new Date(Date.now() - 5 * 60_000);
        const intervalMinutes = tpLinkExportAutomation?.exportIntervalMinutes ?? 15;
        const canarySpanMs = Math.max(7 * 24 * 60 * 60_000, 8 * intervalMinutes * 60_000);
        const from = new Date(to.getTime() - canarySpanMs);
        await api.createTpLinkHistoryExportCanary({
          sensorId: tpLinkCanarySensorId,
          metric: tpLinkCanaryMetric,
          from: from.toISOString(),
          to: to.toISOString(),
        });
        await loadTpLinkExportJobs();
      } catch (error) {
        setTpLinkExportJobsError(connectionError(error, t("setup.tpLinkHistoryCanaryQueueFailed")));
      } finally {
        setTpLinkCanaryRunning(false);
      }
    };
  const retryTpLinkExportJob = async (job: TpLinkHistoryExportJob) => {
      setBusyTpLinkExportJobId(job.id);
      setTpLinkExportJobsError(null);
      try {
        await api.retryTpLinkHistoryExportJob(job.id);
        await loadTpLinkExportJobs();
      } catch (error) {
        setTpLinkExportJobsError(connectionError(error, t("setup.tpLinkHistoryRetryFailed")));
      } finally {
        setBusyTpLinkExportJobId((current) => current === job.id ? null : current);
      }
    };
  const cancelTpLinkExportJob = async (job: TpLinkHistoryExportJob) => {
      if (!window.confirm(t("setup.tpLinkHistoryCancelConfirm", { device: job.deviceName || job.deviceId }))) return;
      setBusyTpLinkExportJobId(job.id);
      setTpLinkExportJobsError(null);
      try {
        await api.cancelTpLinkHistoryExportJob(job.id);
        await loadTpLinkExportJobs();
      } catch (error) {
        setTpLinkExportJobsError(connectionError(error, t("setup.tpLinkHistoryCancelFailed")));
      } finally {
        setBusyTpLinkExportJobId((current) => current === job.id ? null : current);
      }
    };
  return Object.assign(context, { disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, updateTpLinkCanaryTargets, loadTpLinkCanaryTargets, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob });
}
