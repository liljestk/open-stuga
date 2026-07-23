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
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type SystemUpdateDay,
  type SystemUpdateSettings,
  type SystemUpdateStatus,
} from "../api";
import { useI18n } from "../i18n";
import "./SystemUpdatesPage.css";

const days: SystemUpdateDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const intervals = [6, 12, 24, 168] as const;
const activePhases = new Set(["queued", "backup", "pulling", "applying", "verifying", "rolling-back"]);

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function dateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function operationTone(phase: NonNullable<SystemUpdateStatus["operation"]>["phase"]): "ready" | "warning" | "error" {
  if (phase === "complete") return "ready";
  if (phase === "failed") return "error";
  return "warning";
}

export function SystemUpdatesPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [draft, setDraft] = useState<SystemUpdateSettings | null>(null);
  const [busy, setBusy] = useState<"load" | "check" | "save" | "install" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const load = async (quiet = false) => {
    if (!quiet) setBusy("load");
    try {
      const next = await api.systemUpdateStatus();
      setStatus(next);
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
    if (!status?.operation || !activePhases.has(status.operation.phase)) return;
    const timer = window.setInterval(() => void load(true), 4_000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.id, status?.operation?.phase]);

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      const next = await api.checkSystemUpdates();
      setStatus(next);
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
      setStatus(next);
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
      setStatus(next);
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

    {status.operation && <section className={`panel updates-operation ${operationTone(status.operation.phase)}`} aria-live="polite">
      {status.operation.phase === "complete"
        ? <CheckCircle2 size={21} aria-hidden="true" />
        : status.operation.phase === "failed"
          ? <CircleAlert size={21} aria-hidden="true" />
          : <LoaderCircle className="spin" size={21} aria-hidden="true" />}
      <div>
        <span className="eyebrow">{t("updates.operation")}</span>
        <strong>{t(`updates.phase.${status.operation.phase}`, { version: status.operation.version })}</strong>
        {status.operation.detail && <small>{status.operation.detail}</small>}
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
          <label className="field"><span>{t("updates.updateTime")}</span><input type="time" value={draft.updateTime} onChange={(event) => setDraft({ ...draft, updateTime: event.target.value })} /></label>
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
