import {
  api,
  type TpLinkHistoryExportJob,
} from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import { connectionError } from "./support";
import { useIntegrationsPagePart02 } from "./part-02";
export function useIntegrationsPagePart03(context: ReturnType<typeof useIntegrationsPagePart02>) {
  const { connectionHouses, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, t, house, integration, setTesting, setResult, homeAssistantTestGeneration, inventoryRefreshGeneration, historyExportRequestGeneration, setTestingDirect, setDirectResult, tpLinkTestGeneration, setValidatedTpLinkDraft, tpLinkHost, tpLinkUsername, tpLinkPassword, setRefreshingTpLinkInventory, setTpLinkInventoryRefreshFailed, setTpLinkExportEnabled, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, setTpLinkExportJobsLoading, setTpLinkExportJobsError, setBusyTpLinkExportJobId, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryRunning, haUrl, haToken, setBusyAssignment, setAssignmentHouseDrafts, setAssignmentFeedback, setValidatedHomeAssistantDraft, activeSetupHouseId, tpLinkDraftKey, homeAssistantDraftKey } = context;
  const disconnectTpLinkAssignment = async (connectionId: string, houseId: string) => {
      const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
      if (!await confirmAction(t("setup.disconnectTpLinkConfirm", { home: assignedHouse?.name ?? houseId }), t("confirmation.disconnect"))) return;
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
      if (!await confirmAction(t("setup.moveHomeAssistantConfirm", { from: fromHome, to: targetHome }), t("confirmation.move"), false)) return;
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
      if (!await confirmAction(t("setup.moveTpLinkConfirm", { from: fromHome, to: targetHome }), t("confirmation.move"), false)) return;
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
      if (!context.canManageTuya) return;
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
        if (result.enabled && context.canManageTuya) void loadTpLinkCanaryTargets();
      } catch (error) {
        if (historyExportRequestGeneration.current !== generation) return;
        setTpLinkExportJobsError(connectionError(error, t("setup.tpLinkHistoryLoadFailed")));
      } finally {
        if (historyExportRequestGeneration.current === generation) setTpLinkExportJobsLoading(false);
      }
    };
  const runTpLinkCanary = async () => {
      if (!context.canManageTuya || !tpLinkCanarySensorId) return;
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
      if (!context.canManageTuya) return;
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
      if (!context.canManageTuya) return;
      if (!await confirmAction(t("setup.tpLinkHistoryCancelConfirm", { device: job.deviceName || job.deviceId }), t("confirmation.cancelJob"), false)) return;
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
