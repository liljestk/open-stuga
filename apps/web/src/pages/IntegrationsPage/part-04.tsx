import { UserFacingError } from "../../api/support/request-error";
import { errorText } from "../../errorText";
import { useEffect,useRef,type FormEvent } from "react";
import type { IntegrationDiscoveryResult, IntegrationStatus, TpLinkConnectionStatus, TpLinkDiscoveredSource } from "@climate-twin/contracts";
import { api } from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import { type TranslationKey } from "../../i18n";
import { forgetIntegrationDiscovery, rememberIntegrationDiscovery, rememberedIntegrationDiscovery, validTimeZone } from "./setupModel";
import type { DiscoveryOutcome } from "./setupModel";
import { useIntegrationsPagePart03 } from "./part-03";

type ConfiguredTpLink = Awaited<ReturnType<typeof api.configureTpLink>>;
type TpLinkHubModel = "H100" | "H200" | "H500";

interface CompletedTpLinkSave {
  configured: ConfiguredTpLink;
  confirmedIntegration: IntegrationStatus;
  confirmedConnection: TpLinkConnectionStatus | undefined;
  editingConnection: TpLinkConnectionStatus | undefined;
  selectedSource: TpLinkDiscoveredSource | undefined;
  submittedHost: string;
  requestHouseId: string;
}

// Discovered sources the Home does not already use; a resumed scan also hides hosts saved since it started.
function addableDiscoveryResults(
  result: IntegrationDiscoveryResult,
  aggregateIntegration: IntegrationStatus,
  integration: IntegrationStatus,
  resumed: boolean,
) {
  const configuredTpLinkHosts = new Set((aggregateIntegration.tpLink.connections ?? [])
    .flatMap((connection) => connection.host ? [connection.host] : []));
  if (integration.tpLink.host) configuredTpLinkHosts.add(integration.tpLink.host);
  const tpLink = result.tpLink.filter((source) => (
    !source.configuredConnectionId
    && (!resumed || !configuredTpLinkHosts.has(source.host))
  ));
  const homeAssistant = resumed && integration.homeAssistant.configured
    ? []
    : result.homeAssistant;
  const configuredGreeMacs = new Set((aggregateIntegration.gree?.connections ?? [])
    .map((connection) => connection.mac));
  const gree = (result.gree ?? []).filter((device) => (
    !device.configuredConnectionId && !configuredGreeMacs.has(device.mac)
  ));
  return { tpLink, homeAssistant, gree };
}

function discoveryOutcomeFor(addableCount: number, warningCount: number): DiscoveryOutcome {
  if (addableCount > 0) return "found";
  return warningCount > 0 ? "error" : "empty";
}

// Forgets a failed scan's job unless the server reports it is still running.
async function forgetSettledDiscovery(houseId: string, jobId: string): Promise<void> {
  try {
    const latestJob = await api.latestIntegrationDiscovery(houseId);
    if (!latestJob || latestJob.id !== jobId || latestJob.status !== "running") {
      forgetIntegrationDiscovery(houseId, jobId);
    }
  } catch {
    // Preserve the id while offline so this server-owned job can be resumed later.
  }
}

function tpLinkHubModel(model: string | null | undefined): TpLinkHubModel | null {
  return model === "H100" || model === "H200" || model === "H500" ? model : null;
}

function discoveredTpLinkHubModel(source: TpLinkDiscoveredSource | undefined): TpLinkHubModel | null {
  return source?.sourceType !== "energy-device" ? tpLinkHubModel(source?.model) : null;
}

function configuredTpLinkHubModel(configured: ConfiguredTpLink): TpLinkHubModel | null {
  return configured.sourceType === "hub" ? tpLinkHubModel(configured.sourceModel) : null;
}

function tpLinkSavedMessageKey(editing: boolean, created: boolean): TranslationKey {
  if (editing) return "setup.tpLinkConnectionUpdated";
  return created ? "setup.tpLinkConnectionAdded" : "setup.tpLinkConnectionAlreadySaved";
}

export function useIntegrationsPagePart04(context: ReturnType<typeof useIntegrationsPagePart03>) {
  const { aggregateIntegration, connectionHouses, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onOpenSensors, t, house, integration, activeSection, discoveryGeneration, automaticallyScannedHouseId, setDirectResult, tpLinkTestGeneration, setValidatedTpLinkDraft, setDiscovering, discovery, setDiscovery, setDiscoveryOutcome, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, setReuseSavedTpLinkAccount, setShowTpLinkPassword, setSavingTpLink, setTpLinkFeedback, setTpLinkChildDiscovery, haUrl, haToken, setHaToken, setShowHaToken, setSavingHomeAssistant, setHomeAssistantFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, setLatitude, setLongitude, setLocationLabel, timezone, setLocationValidationAttempted, setSavingLocation, setLocationFeedback, activeSetupHouseId, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, stopTpLinkChildDiscovery, homeAssistantDraftKey, changeTpLinkDraft, draftLocation, updateTpLinkCanaryTargets, loadTpLinkExportJobs } = context;
  const pageMounted = useRef(true);
  const discoverySubscription = useRef<AbortController | null>(null);
  const isCurrentScan = (targetHouseId: string, generation: number) => (
    pageMounted.current && activeSetupHouseId.current === targetHouseId && discoveryGeneration.current === generation
  );
  const presentDiscoveredTpLinkSources = (sources: TpLinkDiscoveredSource[], hostAtStart: string) => {
      context.tpLinkEditingConnectionId.current = null;
      const currentHost = tpLinkHostDraft.current.trim();
      if (currentHost === hostAtStart) {
        const selectedSource = sources.find((source) => source.host === currentHost) ?? sources[0]!;
        if (currentHost !== selectedSource.host) changeTpLinkDraft("host", selectedSource.host);
      }
      context.setConnectionSetupOpen(true);
      setTpLinkSettingsOpen(true);
    };
  const showDiscoveryResult = (result: IntegrationDiscoveryResult, resumed: boolean, tpLinkHostAtStart: string) => {
      const addable = addableDiscoveryResults(result, aggregateIntegration, integration, resumed);
      setDiscovery({
        ...result,
        homeAssistant: addable.homeAssistant,
        tpLink: addable.tpLink,
        gree: addable.gree,
      });
      const count = addable.tpLink.length + addable.homeAssistant.length + addable.gree.length;
      setDiscoveryOutcome(discoveryOutcomeFor(count, result.warnings.length));
      if (addable.tpLink.length > 0) presentDiscoveredTpLinkSources(addable.tpLink, tpLinkHostAtStart);
      if (addable.tpLink.length === 0 && addable.gree.length === 0
        && !integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
    };
  const showDiscoveryFailure = () => {
      setDiscovery(null);
      setDiscoveryOutcome("error");
      if (!integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
    };
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
        if (!isCurrentScan(targetHouseId, generation)) return;
        showDiscoveryResult(result, Boolean(options.resumeJobId), tpLinkHostAtStart);
      } catch {
        if (subscription.signal.aborted) return;
        if (startedJobId) await forgetSettledDiscovery(targetHouseId, startedJobId);
        if (!isCurrentScan(targetHouseId, generation)) return;
        showDiscoveryFailure();
      } finally {
        if (discoverySubscription.current === subscription) discoverySubscription.current = null;
        if (isCurrentScan(targetHouseId, generation)) setDiscovering(false);
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
  const settleTpLinkChildren = async (hubModel: "H100" | "H200" | "H500" | null) => {
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
  const configureTpLinkConnection = (houseId: string, credentialSourceConnectionId?: string) => {
      const configuration = {
        houseId,
        ...(context.tpLinkEditingConnectionId.current ? { connectionId: context.tpLinkEditingConnectionId.current } : {}),
        host: tpLinkHost,
      };
      return credentialSourceConnectionId
        ? api.configureTpLink({ ...configuration, credentialSourceConnectionId })
        : api.configureTpLink({ ...configuration, username: tpLinkUsername, password: tpLinkPassword });
    };
  // The save response may predate the integration snapshot that lists the new connection.
  const confirmSavedTpLinkConnection = async (configured: ConfiguredTpLink) => {
      const savedConnection = (status: IntegrationStatus) => (
        status.tpLink.connections?.find((connection) => connection.id === configured.connectionId)
      );
      let confirmedIntegration = configured.integration;
      let confirmedConnection = configured.connectionId ? savedConnection(confirmedIntegration) : undefined;
      if (configured.connectionId && !confirmedConnection) {
        confirmedIntegration = await api.integrations();
        confirmedConnection = savedConnection(confirmedIntegration);
      }
      if (configured.connectionId && !confirmedConnection) throw new UserFacingError(t("setup.tpLinkSaveVerificationError"));
      return { confirmedIntegration, confirmedConnection };
    };
  // Drops the saved source from the discovery list and returns the next host to offer.
  const consumeDiscoveredTpLinkSource = (submittedHost: string): string => {
      const remainingSources = (discovery?.tpLink ?? []).filter((candidate) => candidate.host !== submittedHost);
      const nextSource = remainingSources.find((candidate) => !candidate.configuredConnectionId);
      if (discovery) {
        setDiscovery({ ...discovery, tpLink: remainingSources });
        setDiscoveryOutcome(remainingSources.length + discovery.homeAssistant.length > 0 ? "found" : "empty");
      }
      return nextSource?.host ?? "";
    };
  const resetTpLinkDraft = (nextHost: string) => {
      tpLinkHostDraft.current = nextHost;
      setTpLinkHost(nextHost);
      setTpLinkUsername("");
      setTpLinkPassword("");
      setReuseSavedTpLinkAccount(true);
      context.tpLinkEditingConnectionId.current = null;
      tpLinkTestGeneration.current += 1;
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
      setShowTpLinkPassword(false);
      setTpLinkSettingsOpen(false);
    };
  const openCreatedEnergyDevice = (save: CompletedTpLinkSave) => {
      const { configured, confirmedConnection, selectedSource, requestHouseId } = save;
      const placementDeviceId = configured.deviceId ?? selectedSource?.deviceId ?? null;
      const placementSourceType = configured.sourceType
        ?? confirmedConnection?.sourceType
        ?? selectedSource?.sourceType
        ?? null;
      if (placementSourceType !== "energy-device" || !placementDeviceId || !configured.connectionId || !onOpenSensors) return;
      if (onRefreshTpLinkDevices) void onRefreshTpLinkDevices(requestHouseId).catch(() => undefined);
      onOpenSensors({
        deviceId: placementDeviceId,
        connectionId: configured.connectionId,
        model: configured.sourceModel ?? selectedSource?.model ?? "TP-Link energy device",
        alias: configured.sourceAlias ?? selectedSource?.alias ?? null,
        deviceType: "energy",
      });
    };
  const finishTpLinkSave = (save: CompletedTpLinkSave) => {
      const { configured, confirmedIntegration, confirmedConnection, editingConnection, selectedSource, submittedHost } = save;
      const previouslySaved = confirmedConnection
        ? tpLinkAssignments.some((connection) => connection.id === confirmedConnection.id)
        : Boolean(editingConnection);
      const created = configured.created ?? (!editingConnection && !previouslySaved);
      const sourceName = editingConnection?.sourceAlias
        ?? editingConnection?.sourceModel
        ?? selectedSource?.alias
        ?? (selectedSource?.model ? `TP-Link ${selectedSource.model}` : submittedHost);
      const confirmedSourceName = confirmedConnection?.sourceAlias
        ?? confirmedConnection?.sourceModel
        ?? sourceName;
      const requestHomeName = connectionHouses.find((candidate) => candidate.id === save.requestHouseId)?.name ?? house.name;
      resetTpLinkDraft(consumeDiscoveredTpLinkSource(submittedHost));
      setTpLinkFeedback({
        kind: "success",
        message: `${t(tpLinkSavedMessageKey(Boolean(editingConnection), created), {
          device: confirmedSourceName,
          home: requestHomeName,
        })}${configured.warning ? ` ${configured.warning}` : ""}`,
      });
      if (created && !editingConnection) openCreatedEnergyDevice(save);
      const hubModel = confirmedIntegration.tpLink.hubModel
        ?? configuredTpLinkHubModel(configured)
        ?? discoveredTpLinkHubModel(selectedSource);
      if (hubModel) void settleTpLinkChildren(hubModel);
      else {
        stopTpLinkChildDiscovery();
        setTpLinkChildDiscovery({ phase: "idle" });
      }
    };
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
      try {
        const configured = await configureTpLinkConnection(requestHouseId, credentialSourceConnectionId);
        if (activeSetupHouseId.current !== requestViewHouseId) return;
        const { confirmedIntegration, confirmedConnection } = await confirmSavedTpLinkConnection(configured);
        onIntegrationChange(confirmedIntegration);
        finishTpLinkSave({
          configured,
          confirmedIntegration,
          confirmedConnection,
          editingConnection,
          selectedSource,
          submittedHost,
          requestHouseId,
        });
      } catch (error) {
        if (activeSetupHouseId.current === requestViewHouseId) {
          setTpLinkFeedback({ kind: "error", message: errorText(error, t, t("setup.credentialsError")) });
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
