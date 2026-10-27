import { SYSTEM_UPDATE_REPLACEABLE_WORKFLOW_PHASES } from "@climate-twin/contracts";
import type { HostUpdateReadyToRestart, SystemUpdateDay, SystemUpdateOperation, SystemUpdateSettings, SystemUpdateStatus } from "@climate-twin/contracts";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  Save,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeToSystemUpdateEvents, type SystemUpdateLiveStatus } from "../api";
import { formatInTimeZone, twentyFourHourInputLocale } from "../dateTime";
import { confirmAction } from "../components/ConfirmationProvider";
import { useI18n } from "../i18n";
import { BugReportRelayPanel } from "./BugReportRelayPanel";
import { HostSystemPanel } from "./HostSystemPanel";
import { SystemStoragePanel } from "./SystemStoragePanel";
import { SystemUpdateOverview, systemUpdateIsActive, type SystemUpdateStreamState } from "./SystemUpdateOverview";
import "./SystemUpdatesPage.css";

const days: SystemUpdateDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const intervals = [6, 12, 24, 168] as const;
const activePhases = new Set(["queued", "preparing", "backup", "pulling", "applying", "verifying", "rolling-back"]);
const progressSteps = [
  { phase: "preparing", label: "updates.step.preparing", help: "updates.step.preparingHelp" },
  { phase: "backup", label: "updates.step.backup", help: "updates.step.backupHelp" },
  { phase: "pulling", label: "updates.step.pulling", help: "updates.step.pullingHelp" },
  { phase: "applying", label: "updates.step.applying", help: "updates.step.applyingHelp" },
  { phase: "verifying", label: "updates.step.verifying", help: "updates.step.verifyingHelp" },
] as const;
type ProgressPhase = typeof progressSteps[number]["phase"];
type StreamState = SystemUpdateStreamState;


function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function dateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  return formatInTimeZone(value, locale, undefined, { dateStyle: "medium", timeStyle: "short" });
}

function operationTone(phase: NonNullable<SystemUpdateStatus["operation"]>["phase"]): "ready" | "warning" | "error" {
  if (phase === "complete") return "ready";
  if (phase === "failed") return "error";
  return "warning";
}

function time(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return formatInTimeZone(date, locale, undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsedTime(startedAt: string, now: number): string {
  const parsed = Date.parse(startedAt);
  const seconds = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1_000)) : 0;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function lastProgressIndex(operation: SystemUpdateOperation): number {
  const current = progressSteps.findIndex((step) => step.phase === operation.phase);
  if (current >= 0) return current;
  const activity = operation.activity ?? [];
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const found = progressSteps.findIndex((step) => step.phase === activity[index]?.phase);
    if (found >= 0) return found;
  }
  return -1;
}

function progressStepState(
  operation: SystemUpdateOperation,
  step: ProgressPhase,
): "complete" | "current" | "pending" | "error" {
  if (operation.phase === "complete") return "complete";
  const stepIndex = progressSteps.findIndex((candidate) => candidate.phase === step);
  const currentIndex = lastProgressIndex(operation);
  if (operation.phase === step) return "current";
  if (operation.phase === "failed" || operation.phase === "rolling-back") {
    const stoppedIndex = Math.max(0, currentIndex);
    if (stepIndex < stoppedIndex) return "complete";
    if (stepIndex === stoppedIndex) return "error";
    return "pending";
  }
  return stepIndex < currentIndex ? "complete" : "pending";
}

function mergeSystemUpdateStatus(
  current: SystemUpdateStatus | null,
  next: SystemUpdateStatus,
): SystemUpdateStatus {
  if (!current) return next;
  const currentWorkflow = current.workflow ?? null;
  const nextWorkflow = next.workflow ?? null;
  if (currentWorkflow) {
    if (nextWorkflow?.id === currentWorkflow.id) {
      if (currentWorkflow.revision > nextWorkflow.revision
        || (current.revision !== undefined && next.revision !== undefined && current.revision > next.revision)) {
        return current;
      }
    } else {
      const currentCanBeReplaced = SYSTEM_UPDATE_REPLACEABLE_WORKFLOW_PHASES.has(currentWorkflow.phase)
        && currentWorkflow.recoveryRequired !== true
        && currentWorkflow.reason !== "recovery-required";
      const currentRequestedAt = Date.parse(currentWorkflow.requestedAt);
      const nextRequestedAt = Date.parse(nextWorkflow?.requestedAt ?? "");
      const nextIsKnownOlder = Number.isFinite(currentRequestedAt)
        && Number.isFinite(nextRequestedAt)
        && nextRequestedAt < currentRequestedAt;
      if (!currentCanBeReplaced || nextIsKnownOlder) return current;
    }
  }
  const base: SystemUpdateStatus = next;
  if (!current.operation || !next.operation || current.operation.id !== next.operation.id) return base;
  const activity = [];
  const seen = new Set<string>();
  for (const entry of [...(current.operation.activity ?? []), ...(next.operation.activity ?? [])]) {
    const key = `${entry.at}\u0000${entry.phase}\u0000${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    activity.push(entry);
  }
  return {
    ...base,
    operation: { ...next.operation, activity: activity.slice(-50) },
  };
}

function applyPendingLiveStatus(
  status: SystemUpdateStatus,
  live: SystemUpdateLiveStatus | null,
): SystemUpdateStatus {
  if (!live) return status;
  const next = { ...status, ...live };
  if (live.workflow !== undefined) return mergeSystemUpdateStatus(status, next);
  if (!live.operation) return next;
  const statusUpdatedAt = Date.parse(status.operation?.updatedAt ?? "");
  const liveUpdatedAt = Date.parse(live.operation.updatedAt);
  if (Number.isFinite(statusUpdatedAt) && (!Number.isFinite(liveUpdatedAt) || statusUpdatedAt > liveUpdatedAt)) {
    return status;
  }
  return mergeSystemUpdateStatus(status, next);
}

export function SystemUpdatesPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [draft, setDraft] = useState<SystemUpdateSettings | null>(null);
  const [busy, setBusy] = useState<"load" | "check" | "save" | "install" | "update-everything" | "activate-host" | "cancel-host" | "retry-application" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === "undefined" || !document.hidden
  ));
  const [now, setNow] = useState(() => Date.now());
  const pendingLiveStatus = useRef<SystemUpdateLiveStatus | null>(null);
  const statusRef = useRef<SystemUpdateStatus | null>(null);
  const draftDirty = useRef(false);
  const updateStreamWasHidden = useRef(!pageVisible);
  statusRef.current = status;
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const updateActive = systemUpdateIsActive(status);
  const reconnectPollingNeeded = status === null || updateActive;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("load");
    try {
      const next = await api.systemUpdateStatus();
      const live = pendingLiveStatus.current;
      pendingLiveStatus.current = null;
      setStatus((current) => mergeSystemUpdateStatus(current, applyPendingLiveStatus(next, live)));
      setDraft((current) => draftDirty.current && current
        ? current
        : { ...next.settings, updateDays: [...next.settings.updateDays] });
      setError(null);
    } catch (loadError) {
      if (!quiet) setError(message(loadError, t("updates.error")));
    } finally {
      if (!quiet) setBusy(null);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (!pageVisible) {
      updateStreamWasHidden.current = true;
      setStreamState("reconnecting");
      return undefined;
    }
    if (updateStreamWasHidden.current) {
      updateStreamWasHidden.current = false;
      void load(true);
    }
    if (typeof EventSource === "undefined") {
      setStreamState("polling");
      return;
    }
    return subscribeToSystemUpdateEvents((next) => {
      pendingLiveStatus.current = next;
      if (!statusRef.current) {
        void load(true);
        return;
      }
      setStatus((current) => current
        ? mergeSystemUpdateStatus(current, { ...current, ...next })
        : current);
      setError(null);
    }, setStreamState);
  }, [load, pageVisible]);

  useEffect(() => {
    if (streamState !== "polling") return;
    const timer = window.setInterval(() => void load(true), updateActive ? 2_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [updateActive, streamState, load]);

  useEffect(() => {
    if (
      streamState !== "reconnecting"
      || !reconnectPollingNeeded
    ) return;
    let cancelled = false;
    let attempt = 0;
    let timer: number | null = null;
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "hidden") await load(true);
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [reconnectPollingNeeded, streamState, load]);

  useEffect(() => {
    if (!status?.operation || !activePhases.has(status.operation.phase)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.id, status?.operation?.phase]);

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      const next = await api.checkSystemUpdates();
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (checkError) {
      setError(message(checkError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const next = await api.updateSystemUpdateSettings(draft);
      setStatus((current) => mergeSystemUpdateStatus(current, next));
      draftDirty.current = false;
      setDraft({ ...next.settings, updateDays: [...next.settings.updateDays] });
    } catch (saveError) {
      setError(message(saveError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!status?.latestVersion || !await confirmAction(t("updates.confirm", { version: status.latestVersion }), t("confirmation.install"), false)) return;
    setBusy("install");
    setError(null);
    try {
      const next = await api.installLatestSystemUpdate();
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (installError) {
      setError(message(installError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const updateEverything = async () => {
    if (!status) return;
    const applicationUpdateAvailable = status.application?.updateAvailable ?? status.updateAvailable;
    const hostUpdateAvailable = status.host?.updateAvailable === true;
    if (applicationUpdateAvailable && !hostUpdateAvailable) {
      await install();
      return;
    }
    const supportsWorkflow = status.revision !== undefined
      || status.application !== undefined
      || status.host !== undefined
      || status.workflow !== undefined;
    if (!supportsWorkflow) {
      await install();
      return;
    }
    if (status.revision === undefined) {
      setError(t("updates.block.statusStale"));
      return;
    }
    setBusy("update-everything");
    setError(null);
    try {
      const next = await api.operateSystemUpdate({
        action: "update-everything",
        expectedRevision: status.revision,
      });
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (operationError) {
      setError(message(operationError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const activateHost = async (binding: HostUpdateReadyToRestart) => {
    const workflow = status?.workflow;
    if (!workflow
      || status.revision === undefined
      || status.revision !== workflow.revision
      || workflow.phase !== "awaiting-restart"
      || workflow.hostOperationId !== binding.operationId
      || workflow.targets.hostVersion !== binding.targetVersion
      || workflow.targets.hostGeneration !== binding.targetGeneration
      || workflow.targets.hostDigest !== binding.targetDigest) {
      setError(t("updates.block.statusStale"));
      return;
    }
    setBusy("activate-host");
    setError(null);
    try {
      const next = await api.operateSystemUpdate({
        action: "activate-host",
        workflowId: workflow.id,
        expectedRevision: status.revision,
        hostOperationId: binding.operationId,
        targetVersion: binding.targetVersion,
        targetGeneration: binding.targetGeneration,
        targetDigest: binding.targetDigest,
        confirmation: "RESTART_AND_INSTALL",
      });
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (operationError) {
      setError(message(operationError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const cancelHost = async (binding: HostUpdateReadyToRestart) => {
    const workflow = status?.workflow;
    if (!workflow
      || status.revision === undefined
      || status.revision !== workflow.revision
      || workflow.phase !== "awaiting-restart"
      || workflow.hostOperationId !== binding.operationId
      || workflow.targets.hostVersion !== binding.targetVersion
      || workflow.targets.hostGeneration !== binding.targetGeneration
      || workflow.targets.hostDigest !== binding.targetDigest) {
      setError(t("updates.block.statusStale"));
      return;
    }
    setBusy("cancel-host");
    setError(null);
    try {
      const next = await api.operateSystemUpdate({
        action: "cancel-host",
        workflowId: workflow.id,
        expectedRevision: status.revision,
        hostOperationId: binding.operationId,
        targetVersion: binding.targetVersion,
        targetGeneration: binding.targetGeneration,
        targetDigest: binding.targetDigest,
      });
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (operationError) {
      setError(message(operationError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const retryApplication = async () => {
    const workflow = status?.workflow;
    if (!workflow
      || workflow.phase !== "application-failed"
      || !workflow.targets.applicationVersion
      || status?.revision === undefined
      || status.revision !== workflow.revision) {
      setError(t("updates.block.statusStale"));
      return;
    }
    setBusy("retry-application");
    setError(null);
    try {
      const next = await api.operateSystemUpdate({
        action: "retry-application",
        workflowId: workflow.id,
        expectedRevision: status.revision,
      });
      setStatus((current) => mergeSystemUpdateStatus(current, next));
    } catch (operationError) {
      setError(message(operationError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const toggleDay = (day: SystemUpdateDay) => {
    if (!draft) return;
    const selected = draft.updateDays.includes(day);
    if (selected && draft.updateDays.length === 1) return;
    draftDirty.current = true;
    setDraft({
      ...draft,
      updateDays: selected ? draft.updateDays.filter((candidate) => candidate !== day) : [...draft.updateDays, day],
    });
  };

  const systemHeading = <>
    <header className="page-heading updates-heading">
      <div>
        <span className="eyebrow"><ServerCog size={14} aria-hidden="true" />{t("system.eyebrow")}</span>
        <h1>{t("system.title")}</h1>
        <p>{t("system.description")}</p>
      </div>
    </header>
    <HostSystemPanel />
    <SystemStoragePanel />
    <BugReportRelayPanel />
  </>;
  if (!status || !draft) {
    return <>{systemHeading}<section className="route-recovery" aria-live="polite">
      {busy === "load"
        ? <><LoaderCircle className="spin" size={22} aria-hidden="true" /><div><h2>{t("updates.loading")}</h2></div></>
        : <><CircleAlert size={22} aria-hidden="true" /><div><h2>{t("updates.loadFailed")}</h2><p>{error}</p></div><button type="button" className="secondary-button" onClick={() => void load()}><RotateCcw size={15} />{t("route.reload")}</button></>}
    </section></>;
  }

  const operationActive = Boolean(status.operation && activePhases.has(status.operation.phase));
  const settingsChanged = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const operation = status.operation;
  const showOperation = Boolean(operation && !status.workflow && operation.phase !== "complete");
  const progressIndex = operation ? lastProgressIndex(operation) : -1;
  const progressValue = operation?.phase === "complete"
    ? progressSteps.length
    : Math.max(0, progressIndex);
  const progressText = !operation
    ? ""
    : operation.phase === "queued"
      ? t("updates.progressQueued")
      : operation.phase === "complete"
        ? t("updates.progressComplete", { total: progressSteps.length })
        : operation.phase === "rolling-back"
          ? t("updates.progressRollback")
          : operation.phase === "failed"
            ? t("updates.progressFailed", { current: Math.max(1, progressIndex + 1), total: progressSteps.length })
            : t("updates.progressStep", { current: progressIndex + 1, total: progressSteps.length });
  const operationActivity = operation
    ? operation.activity?.length
      ? operation.activity
      : [{
        phase: operation.phase,
        at: operation.phaseStartedAt ?? operation.startedAt ?? operation.requestedAt,
        detail: operation.detail ?? t(`updates.phase.${operation.phase}`, { version: operation.version }),
      }]
    : [];
  return <>
    {systemHeading}

    {error && <div className="exception-banner" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}

    <SystemUpdateOverview
      status={status}
      busy={busy}
      streamState={streamState}
      onCheck={() => void check()}
      onUpdateEverything={() => void updateEverything()}
      onActivateHost={(binding) => void activateHost(binding)}
      onCancelHost={(binding) => void cancelHost(binding)}
      onRetryApplication={() => void retryApplication()}
    />

    {showOperation && operation && <section
      className={`panel updates-operation ${operationTone(operation.phase)}`}
      aria-labelledby="update-operation-title"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {t(`updates.phase.${operation.phase}`, { version: operation.version })}
        {operation.detail ? ` ${operation.detail}` : ""}
        {operationActive ? ` ${t(`updates.stream.${streamState}`)}` : ""}
      </p>
      <div className="updates-operation-summary">
        {operation.phase === "complete"
          ? <CheckCircle2 size={23} aria-hidden="true" />
          : operation.phase === "failed"
            ? <CircleAlert size={23} aria-hidden="true" />
            : <LoaderCircle className="spin" size={23} aria-hidden="true" />}
        <div>
          <div className="updates-operation-kicker">
            <span className="eyebrow">{t("updates.operation")}</span>
            {operationActive && <span className={`updates-stream-state ${streamState}`}>
              <span aria-hidden="true" />
              {t(`updates.stream.${streamState}`)}
            </span>}
          </div>
          <h2 id="update-operation-title">{t(`updates.phase.${operation.phase}`, { version: operation.version })}</h2>
          {operation.detail && <small>{operation.detail}</small>}
        </div>
      </div>

      <div className="updates-progress-meta">
        <strong>{progressText}</strong>
        {operationActive && <span>{t("updates.elapsed", {
          time: elapsedTime(operation.phaseStartedAt ?? operation.startedAt ?? operation.requestedAt, now),
        })}</span>}
      </div>
      <progress
        className="updates-progress-bar"
        max={progressSteps.length}
        value={progressValue}
        aria-label={progressText}
      />

      <ol className="updates-progress-steps">
        {progressSteps.map((step) => {
          const state = progressStepState(operation, step.phase);
          return <li key={step.phase} className={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="updates-step-marker" aria-hidden="true">
              {state === "complete"
                ? <CheckCircle2 size={17} />
                : state === "current"
                  ? <LoaderCircle className="spin" size={17} />
                  : state === "error"
                    ? <CircleAlert size={17} />
                    : <span />}
            </span>
            <div>
              <strong>{t(step.label)}</strong>
              <small>{t(step.help)}</small>
              <span className="sr-only">{t(`updates.stepState.${state}`)}</span>
            </div>
          </li>;
        })}
      </ol>

      <div className="updates-activity">
        <h3>{t("updates.activity")}</h3>
        <ol>
          {operationActivity.map((entry, index) => <li key={`${entry.at}-${entry.phase}-${index}`}>
            <time dateTime={entry.at}>{time(entry.at, locale)}</time>
            <span>{entry.detail}</span>
          </li>)}
        </ol>
      </div>
    </section>}

    <div className="updates-layout">
      <details className="panel updates-disclosure updates-release">
        <summary>
          <ShieldCheck size={18} aria-hidden="true" />
          <span className="updates-disclosure-copy">
            <span className="eyebrow">{t(status.latestRelease?.prerelease
              ? "updates.releaseEyebrowPreview"
              : "updates.releaseEyebrowStable")}</span>
            <strong id="latest-release-title" role="heading" aria-level={3}>{status.latestRelease?.name ?? t("updates.noRelease")}</strong>
            {status.latestRelease && <small>{t("updates.published", { date: dateTime(status.latestRelease.publishedAt, locale) })}</small>}
          </span>
          <ChevronDown className="updates-disclosure-chevron" size={18} aria-hidden="true" />
        </summary>
        <div className="updates-disclosure-content">
          {status.latestRelease && <div className="updates-release-toolbar">
            <a className="secondary-button" href={status.latestRelease.url} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />{t("updates.openGithub")}</a>
          </div>}
          <div className="release-notes" role="region" aria-labelledby="latest-release-title" tabIndex={0}>
            {status.latestRelease?.notes || t("updates.noNotes")}
          </div>
        </div>
      </details>

      <details className="panel updates-disclosure updates-settings">
        <summary>
          <CalendarClock size={18} aria-hidden="true" />
          <span className="updates-disclosure-copy">
            <span className="eyebrow">{t("updates.scheduleEyebrow")}</span>
            <strong id="update-settings-title" role="heading" aria-level={3}>{t("updates.scheduleTitle")}</strong>
            <small>{draft.mode === "automatic" ? t("updates.automatic") : t("updates.manual")}</small>
          </span>
          <ChevronDown className="updates-disclosure-chevron" size={18} aria-hidden="true" />
        </summary>
        <div className="updates-disclosure-content">
        <div className="updates-mode" role="radiogroup" aria-label={t("updates.mode")}>
          <label><input type="radio" name="update-mode" checked={draft.mode === "manual"} onChange={() => { draftDirty.current = true; setDraft({ ...draft, mode: "manual" }); }} /><span><strong>{t("updates.manual")}</strong><small>{t("updates.manualHelp")}</small></span></label>
          <label><input type="radio" name="update-mode" checked={draft.mode === "automatic"} onChange={() => { draftDirty.current = true; setDraft({ ...draft, mode: "automatic" }); }} /><span><strong>{t("updates.automatic")}</strong><small>{t("updates.automaticHelp")}</small></span></label>
        </div>
        <div className="updates-form-grid">
          <label className="field"><span>{t("updates.checkInterval")}</span><select value={draft.checkIntervalHours} onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, checkIntervalHours: Number(event.target.value) as SystemUpdateSettings["checkIntervalHours"] }); }}>
            {intervals.map((hours) => <option key={hours} value={hours}>{t(`updates.interval.${hours}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("updates.updateTime")}</span><input type="time" lang={twentyFourHourInputLocale(locale)} value={draft.updateTime} onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, updateTime: event.target.value }); }} /></label>
          <label className="field"><span>{t("updates.timezone")}</span><input value={draft.timezone} onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, timezone: event.target.value }); }} /><button className="text-button" type="button" onClick={() => { draftDirty.current = true; setDraft({ ...draft, timezone }); }}>{t("updates.useBrowserTimezone")}</button></label>
        </div>
        <fieldset className="updates-days"><legend>{t("updates.days")}</legend><div>
          {days.map((day) => <label key={day}><input type="checkbox" checked={draft.updateDays.includes(day)} onChange={() => toggleDay(day)} /><span>{t(`updates.day.${day}`)}</span></label>)}
        </div></fieldset>
        <label className="check-field"><input type="checkbox" checked={draft.includePrereleases} onChange={(event) => { draftDirty.current = true; setDraft({ ...draft, includePrereleases: event.target.checked }); }} /><span>{t("updates.prereleases")}</span></label>
        {status.nextUpdateWindowAt && <p className="updates-next-window">{t("updates.nextWindow", { date: dateTime(status.nextUpdateWindowAt, locale) })}</p>}
        <button type="button" className="secondary-button" disabled={!settingsChanged || busy !== null} onClick={() => void save()}><Save size={15} aria-hidden="true" />{busy === "save" ? t("common.saving") : t("updates.save")}</button>
        </div>
      </details>
    </div>
  </>;
}
