import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  CloudDownload,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  subscribeToSystemUpdateEvents,
  type SystemUpdateDay,
  type SystemUpdateLiveStatus,
  type SystemUpdateOperation,
  type SystemUpdateSettings,
  type SystemUpdateStatus,
} from "../api";
import { formatInTimeZone, twentyFourHourInputLocale } from "../dateTime";
import { useI18n } from "../i18n";
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
type StreamState = "connecting" | "live" | "reconnecting" | "polling";

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
  if (!current?.operation || !next.operation || current.operation.id !== next.operation.id) return next;
  const activity = [];
  const seen = new Set<string>();
  for (const entry of [...(current.operation.activity ?? []), ...(next.operation.activity ?? [])]) {
    const key = `${entry.at}\u0000${entry.phase}\u0000${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    activity.push(entry);
  }
  return {
    ...next,
    operation: { ...next.operation, activity: activity.slice(-50) },
  };
}

function applyPendingLiveStatus(
  status: SystemUpdateStatus,
  live: SystemUpdateLiveStatus | null,
): SystemUpdateStatus {
  if (!live?.operation) return status;
  const statusUpdatedAt = Date.parse(status.operation?.updatedAt ?? "");
  const liveUpdatedAt = Date.parse(live.operation.updatedAt);
  if (Number.isFinite(statusUpdatedAt) && (!Number.isFinite(liveUpdatedAt) || statusUpdatedAt > liveUpdatedAt)) {
    return status;
  }
  return { ...status, ...live };
}

export function SystemUpdatesPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [draft, setDraft] = useState<SystemUpdateSettings | null>(null);
  const [busy, setBusy] = useState<"load" | "check" | "save" | "install" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const pendingLiveStatus = useRef<SystemUpdateLiveStatus | null>(null);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const load = async (quiet = false) => {
    if (!quiet) setBusy("load");
    try {
      const next = await api.systemUpdateStatus();
      const live = pendingLiveStatus.current;
      setStatus((current) => mergeSystemUpdateStatus(current, applyPendingLiveStatus(next, live)));
      setDraft((current) => current ?? { ...next.settings, updateDays: [...next.settings.updateDays] });
      setError(null);
    } catch (loadError) {
      if (!quiet) setError(message(loadError, t("updates.error")));
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setStreamState("polling");
      return;
    }
    return subscribeToSystemUpdateEvents((next) => {
      pendingLiveStatus.current = next;
      setStatus((current) => current
        ? mergeSystemUpdateStatus(current, { ...current, ...next })
        : current);
      setError(null);
    }, setStreamState);
  }, []);

  useEffect(() => {
    if (streamState !== "polling") return;
    const active = Boolean(status?.operation && activePhases.has(status.operation.phase));
    const timer = window.setInterval(() => void load(true), active ? 2_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.id, status?.operation?.phase, streamState]);

  useEffect(() => {
    if (
      streamState !== "reconnecting"
      || !status?.operation
      || !activePhases.has(status.operation.phase)
    ) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.id, status?.operation?.phase, streamState]);

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
      setDraft({ ...next.settings, updateDays: [...next.settings.updateDays] });
    } catch (saveError) {
      setError(message(saveError, t("updates.error")));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!status?.latestVersion || !window.confirm(t("updates.confirm", { version: status.latestVersion }))) return;
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

  const toggleDay = (day: SystemUpdateDay) => {
    if (!draft) return;
    const selected = draft.updateDays.includes(day);
    if (selected && draft.updateDays.length === 1) return;
    setDraft({
      ...draft,
      updateDays: selected ? draft.updateDays.filter((candidate) => candidate !== day) : [...draft.updateDays, day],
    });
  };

  if (!status || !draft) {
    return <section className="route-recovery" aria-live="polite">
      {busy === "load"
        ? <><LoaderCircle className="spin" size={22} aria-hidden="true" /><div><h1>{t("updates.loading")}</h1></div></>
        : <><CircleAlert size={22} aria-hidden="true" /><div><h1>{t("updates.loadFailed")}</h1><p>{error}</p></div><button type="button" className="secondary-button" onClick={() => void load()}><RotateCcw size={15} />{t("route.reload")}</button></>}
    </section>;
  }

  const operationActive = Boolean(status.operation && activePhases.has(status.operation.phase));
  const settingsChanged = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const operation = status.operation;
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
    <header className="page-heading updates-heading">
      <div>
        <span className="eyebrow"><CloudDownload size={14} aria-hidden="true" />{t("updates.eyebrow")}</span>
        <h1>{t("updates.title")}</h1>
        <p>{t("updates.description")}</p>
      </div>
      <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void check()}>
        <RefreshCw className={busy === "check" ? "spin" : ""} size={15} aria-hidden="true" />
        {t("updates.checkNow")}
      </button>
    </header>

    {error && <div className="exception-banner" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}

    <section className="updates-version-grid" aria-label={t("updates.versionSummary")}>
      <div className="panel updates-version-card">
        <span>{t("updates.installed")}</span>
        <strong>v{status.currentVersion}</strong>
        <small>{t("updates.runningNow")}</small>
      </div>
      <div className="panel updates-version-card latest">
        <span>{t("updates.latest")}</span>
        <strong>{status.latestVersion ? `v${status.latestVersion}` : "—"}</strong>
        <small>{status.updateAvailable ? t("updates.available") : t("updates.upToDate")}</small>
      </div>
      <div className="panel updates-version-card">
        <span>{t("updates.agent")}</span>
        <strong>{status.capability.available ? t("updates.connected") : t("updates.notConnected")}</strong>
        <small>{status.capability.runtime ? t(`updates.runtime.${status.capability.runtime}`) : t("updates.agentNeeded")}</small>
      </div>
    </section>

    {operation && <section
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
      <section className="panel updates-release" aria-labelledby="latest-release-title">
        <div className="panel-header">
          <div>
            <span className="eyebrow"><ShieldCheck size={14} aria-hidden="true" />{t("updates.releaseEyebrow")}</span>
            <h2 id="latest-release-title">{status.latestRelease?.name ?? t("updates.noRelease")}</h2>
            {status.latestRelease && <p>{t("updates.published", { date: dateTime(status.latestRelease.publishedAt, locale) })}</p>}
          </div>
          {status.latestRelease && <a className="icon-button" href={status.latestRelease.url} target="_blank" rel="noreferrer" aria-label={t("updates.openGithub")}><ExternalLink size={17} /></a>}
        </div>
        <div className="release-notes" tabIndex={0}>
          {status.latestRelease?.notes || t("updates.noNotes")}
        </div>
        <div className="updates-release-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!status.updateAvailable || !status.capability.available || operationActive || busy !== null}
            onClick={() => void install()}
          >
            <CloudDownload size={16} aria-hidden="true" />
            {busy === "install" ? t("updates.requesting") : t("updates.installNow")}
          </button>
          {!status.capability.available && <small>{t("updates.agentHelp")}</small>}
          {status.lastCheckedAt && <small>{t("updates.lastChecked", { date: dateTime(status.lastCheckedAt, locale) })}</small>}
          {status.checkError && <small className="field-error">{status.checkError}</small>}
        </div>
      </section>

      <section className="panel updates-settings" aria-labelledby="update-settings-title">
        <div className="panel-header">
          <div>
            <span className="eyebrow"><CalendarClock size={14} aria-hidden="true" />{t("updates.scheduleEyebrow")}</span>
            <h2 id="update-settings-title">{t("updates.scheduleTitle")}</h2>
          </div>
        </div>
        <div className="updates-mode" role="radiogroup" aria-label={t("updates.mode")}>
          <label><input type="radio" name="update-mode" checked={draft.mode === "manual"} onChange={() => setDraft({ ...draft, mode: "manual" })} /><span><strong>{t("updates.manual")}</strong><small>{t("updates.manualHelp")}</small></span></label>
          <label><input type="radio" name="update-mode" checked={draft.mode === "automatic"} onChange={() => setDraft({ ...draft, mode: "automatic" })} /><span><strong>{t("updates.automatic")}</strong><small>{t("updates.automaticHelp")}</small></span></label>
        </div>
        <div className="updates-form-grid">
          <label className="field"><span>{t("updates.checkInterval")}</span><select value={draft.checkIntervalHours} onChange={(event) => setDraft({ ...draft, checkIntervalHours: Number(event.target.value) as SystemUpdateSettings["checkIntervalHours"] })}>
            {intervals.map((hours) => <option key={hours} value={hours}>{t(`updates.interval.${hours}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("updates.updateTime")}</span><input type="time" lang={twentyFourHourInputLocale(locale)} value={draft.updateTime} onChange={(event) => setDraft({ ...draft, updateTime: event.target.value })} /></label>
          <label className="field"><span>{t("updates.timezone")}</span><input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /><button className="text-button" type="button" onClick={() => setDraft({ ...draft, timezone })}>{t("updates.useBrowserTimezone")}</button></label>
        </div>
        <fieldset className="updates-days"><legend>{t("updates.days")}</legend><div>
          {days.map((day) => <label key={day}><input type="checkbox" checked={draft.updateDays.includes(day)} onChange={() => toggleDay(day)} /><span>{t(`updates.day.${day}`)}</span></label>)}
        </div></fieldset>
        <label className="check-field"><input type="checkbox" checked={draft.includePrereleases} onChange={(event) => setDraft({ ...draft, includePrereleases: event.target.checked })} /><span>{t("updates.prereleases")}</span></label>
        {status.nextUpdateWindowAt && <p className="updates-next-window">{t("updates.nextWindow", { date: dateTime(status.nextUpdateWindowAt, locale) })}</p>}
        <button type="button" className="secondary-button" disabled={!settingsChanged || busy !== null} onClick={() => void save()}><Save size={15} aria-hidden="true" />{busy === "save" ? t("common.saving") : t("updates.save")}</button>
      </section>
    </div>
  </>;
}
