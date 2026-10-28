import { errorText } from "../errorText";
import type { SystemStorageLocation, SystemStorageLocationKind, SystemStorageSettings, SystemStorageStatus } from "@climate-twin/contracts";
import {
  ArchiveRestore,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Database,
  HardDrive,
  LoaderCircle,
  RefreshCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { useI18n, type TranslationKey } from "../i18n";
import "./SystemStoragePanel.css";

const activePhases = new Set([
  "queued", "validating", "backing-up", "quiescing", "copying", "applying", "verifying", "rolling-back",
]);

function cloneSettings(settings: SystemStorageSettings): SystemStorageSettings {
  return { timeseries: { ...settings.timeseries }, backups: { ...settings.backups } };
}

function sameLocation(left: SystemStorageLocation, right: SystemStorageLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function pathWithinRoots(value: string, roots: string[]): boolean {
  const candidate = comparablePath(value);
  return roots.some((root) => candidate.startsWith(`${comparablePath(root)}/`));
}

function validHostPath(value: string): boolean {
  return value.length >= 4
    && value.length <= 500
    && value === value.trim()
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(value))
    && !/[\u0000-\u001f\u007f\s`$"'{}#=]/u.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
    && value !== "/"
    && !/^[A-Za-z]:[\\/]?$/u.test(value);
}

function storagePathError(
  location: SystemStorageLocation | undefined,
  roots: string[],
  t: (key: TranslationKey) => string,
): string | null {
  if (!location || location.kind === "managed") return null;
  if (!validHostPath(location.path ?? "")) return t("storage.pathInvalid");
  if (!pathWithinRoots(location.path ?? "", roots)) return t("storage.pathOutsideRoots");
  return null;
}

function pathsOverlap(settings: SystemStorageSettings): boolean {
  if (!settings.timeseries.path || !settings.backups.path) return false;
  const timeseries = comparablePath(settings.timeseries.path);
  const backups = comparablePath(settings.backups.path);
  return timeseries === backups
    || timeseries.startsWith(`${backups}/`)
    || backups.startsWith(`${timeseries}/`);
}

function suggestedPath(roots: string[], purpose: "timeseries" | "backups"): string {
  const root = roots[0] ?? "/mnt/stugu";
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/u, "")}${separator}${purpose === "timeseries" ? "telemetry" : "backups"}`;
}

function locationLabel(location: SystemStorageLocation, purpose: "timeseries" | "backups", t: (key: TranslationKey) => string): string {
  if (location.kind === "managed") return t("storage.kind.managed");
  if (location.kind === "nas-path") return t("storage.kind.nas");
  return purpose === "timeseries" ? t("storage.kind.localSsd") : t("storage.kind.localPath");
}

function capabilityHelp(status: SystemStorageStatus, t: (key: TranslationKey) => string): string {
  if (status.capability.detail) return status.capability.detail;
  if (status.capability.reason === "agent-upgrade-required") return t("storage.agentUpgrade");
  if (status.capability.reason === "configuration-unavailable") return t("storage.configurationUnavailable");
  if (status.capability.reason === "configuration-invalid") return t("storage.configurationInvalid");
  return t("storage.agentUnavailable");
}

function LocationEditor({
  purpose,
  value,
  allowedRoots,
  pathError,
  disabled,
  onChange,
}: Readonly<{
  purpose: "timeseries" | "backups";
  value: SystemStorageLocation;
  allowedRoots: string[];
  pathError: string | null;
  disabled: boolean;
  onChange: (value: SystemStorageLocation) => void;
}>) {
  const { t } = useI18n();
  const errorId = `storage-${purpose}-path-error`;
  const choices: Array<{ kind: SystemStorageLocationKind; label: TranslationKey; help: TranslationKey }> = purpose === "timeseries"
    ? [
      { kind: "managed", label: "storage.kind.managed", help: "storage.kind.managedTimeseriesHelp" },
      { kind: "local-path", label: "storage.kind.localSsd", help: "storage.kind.localSsdHelp" },
    ]
    : [
      { kind: "managed", label: "storage.kind.managed", help: "storage.kind.managedBackupHelp" },
      { kind: "local-path", label: "storage.kind.localPath", help: "storage.kind.localPathHelp" },
      { kind: "nas-path", label: "storage.kind.nas", help: "storage.kind.nasHelp" },
    ];
  return <fieldset className="storage-location" disabled={disabled}>
    <legend>{purpose === "timeseries" ? t("storage.primaryTitle") : t("storage.backupTitle")}</legend>
    <p>{purpose === "timeseries" ? t("storage.primaryHelp") : t("storage.backupHelp")}</p>
    <div className="storage-kind-options">
      {choices.map((choice) => <label key={choice.kind}>
        <input
          type="radio"
          name={`storage-${purpose}`}
          checked={value.kind === choice.kind}
          onChange={() => onChange({ kind: choice.kind, path: choice.kind === "managed" ? null : value.path ?? "" })}
        />
        <span><strong>{t(choice.label)}</strong><small>{t(choice.help)}</small></span>
      </label>)}
    </div>
    {value.kind !== "managed" && <label className="field storage-path-field">
      <span>{t("storage.hostPath")}</span>
      <input
        value={value.path ?? ""}
        onChange={(event) => onChange({ ...value, path: event.target.value })}
        placeholder={suggestedPath(allowedRoots, purpose)}
        aria-invalid={pathError ? true : undefined}
        aria-describedby={pathError ? errorId : undefined}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <small>{value.kind === "nas-path" ? t("storage.nasPathHelp") : t("storage.pathHelp")}</small>
      {pathError && <small className="field-error" id={errorId} role="alert">{pathError}</small>}
    </label>}
  </fieldset>;
}

function StorageChangePlan({
  current,
  target,
}: Readonly<{
  current: SystemStorageSettings;
  target: SystemStorageSettings;
}>) {
  const { t } = useI18n();
  const timeseriesChanged = !sameLocation(current.timeseries, target.timeseries);
  const backupsChanged = !sameLocation(current.backups, target.backups);
  const summary = timeseriesChanged && backupsChanged
    ? t("storage.automaticBoth")
    : timeseriesChanged
      ? t("storage.automaticTimeseries")
      : t("storage.automaticBackups");
  const rows = [
    ...(timeseriesChanged ? [{ purpose: "timeseries" as const, label: t("storage.primaryTitle") }] : []),
    ...(backupsChanged ? [{ purpose: "backups" as const, label: t("storage.backupTitle") }] : []),
  ];

  return <section className="storage-change-plan" aria-labelledby="storage-change-plan-title">
    <div className="storage-change-plan-heading">
      <ShieldCheck size={19} aria-hidden="true" />
      <div>
        <span className="storage-automatic-badge"><CheckCircle2 size={13} aria-hidden="true" />{t("storage.automatic")}</span>
        <h3 id="storage-change-plan-title">{t("storage.automaticTitle")}</h3>
        <p>{summary}</p>
      </div>
    </div>
    <div className="storage-change-routes">
      {rows.map(({ purpose, label }) => <div key={purpose}>
        <strong>{label}</strong>
        <div className="storage-change-route">
          <span><small>{t("storage.currentLabel")}</small><b>{locationLabel(current[purpose], purpose, t)}</b>{current[purpose].path && <code>{current[purpose].path}</code>}</span>
          <ArrowRight size={17} aria-hidden="true" />
          <span><small>{t("storage.newLabel")}</small><b>{locationLabel(target[purpose], purpose, t)}</b>{target[purpose].path && <code>{target[purpose].path}</code>}</span>
        </div>
      </div>)}
    </div>
    <p className="storage-change-safety">{t("storage.safetyBody")}</p>
  </section>;
}

export function SystemStoragePanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SystemStorageStatus | null>(null);
  const [draft, setDraft] = useState<SystemStorageSettings | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | null>("load");
  const [error, setError] = useState<string | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setBusy("load");
    try {
      const next = await api.systemStorageStatus();
      setStatus(next);
      setDraft((current) => {
        const active = next.operation && activePhases.has(next.operation.phase);
        const visibleSettings = active && next.operation ? next.operation.target : next.settings;
        return !current || active || next.operation?.phase === "complete" ? cloneSettings(visibleSettings) : current;
      });
      setError(null);
    } catch (loadError) {
      if (!quiet) setError(errorText(loadError, t, t("storage.error")));
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!status?.operation || !activePhases.has(status.operation.phase)) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [status?.operation?.id, status?.operation?.phase]);

  const changed = useMemo(() => Boolean(status && draft
    && JSON.stringify(status.settings) !== JSON.stringify(draft)), [draft, status]);
  const operationActive = Boolean(status?.operation && activePhases.has(status.operation.phase));
  const timeseriesPathError = storagePathError(draft?.timeseries, status?.allowedRoots ?? [], t);
  const backupsPathError = storagePathError(draft?.backups, status?.allowedRoots ?? [], t);
  const overlapError = draft && pathsOverlap(draft) ? t("storage.pathsOverlap") : null;
  const formValid = !timeseriesPathError && !backupsPathError && !overlapError;

  const save = async () => {
    if (!status || !draft || !changed || !formValid) return;
    const movesTimeseries = JSON.stringify(status.settings.timeseries) !== JSON.stringify(draft.timeseries);
    const confirmation = movesTimeseries ? "MOVE_STORAGE" : "APPLY_STORAGE";
    const prompt = movesTimeseries ? t("storage.confirmMove") : t("storage.confirmBackup");
    if (!await confirmAction(prompt, t("storage.confirmAction"), false)) return;
    setBusy("save");
    setError(null);
    try {
      const next = await api.updateSystemStorage({ settings: draft, expectedRevision: status.revision, confirmation });
      setStatus(next);
      setDraft(cloneSettings(next.operation && activePhases.has(next.operation.phase) ? next.operation.target : next.settings));
    } catch (saveError) {
      setError(errorText(saveError, t, t("storage.error")));
    } finally {
      setBusy(null);
    }
  };

  if (!status || !draft) {
    return <section className="panel system-storage-panel" aria-labelledby="system-storage-title">
      <div className="storage-panel-heading">
        <HardDrive size={19} aria-hidden="true" />
        <div><span className="eyebrow">{t("storage.eyebrow")}</span><h2 id="system-storage-title">{t("storage.title")}</h2></div>
      </div>
      <div className="storage-loading" role="status">
        {busy === "load" ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
        <span>{error ?? t("storage.loading")}</span>
      </div>
    </section>;
  }

  return <section className="panel system-storage-panel" aria-labelledby="system-storage-title">
    <div className="storage-panel-heading">
      <HardDrive size={19} aria-hidden="true" />
      <div>
        <span className="eyebrow">{t("storage.eyebrow")}</span>
        <h2 id="system-storage-title">{t("storage.title")}</h2>
        <p>{t("storage.description")}</p>
      </div>
      <span className={`storage-agent-state ${status.capability.available ? "ready" : "unavailable"}`}>
        {status.capability.available ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
        {status.capability.available ? t("storage.agentReady") : t("storage.agentNotReady")}
      </span>
    </div>

    <div className="storage-current" aria-label={t("storage.currentTitle")}>
      <div><Database size={18} aria-hidden="true" /><span><small>{t("storage.primaryTitle")}</small><strong>{locationLabel(status.settings.timeseries, "timeseries", t)}</strong>{status.settings.timeseries.path && <code>{status.settings.timeseries.path}</code>}</span></div>
      <div><ArchiveRestore size={18} aria-hidden="true" /><span><small>{t("storage.backupTitle")}</small><strong>{locationLabel(status.settings.backups, "backups", t)}</strong>{status.settings.backups.path && <code>{status.settings.backups.path}</code>}</span></div>
    </div>

    {!status.capability.available && <p className="storage-warning"><CircleAlert size={15} aria-hidden="true" />{capabilityHelp(status, t)}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}

    {status.operation && <div className={`storage-operation ${status.operation.phase}`} role="status" aria-live="polite">
      {operationActive ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : status.operation.phase === "complete" ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
      <span>
        <strong>{t(`storage.phase.${status.operation.phase}` as TranslationKey)}</strong>
        {status.operation.detail && <small>{status.operation.detail}</small>}
        {operationActive && <small>{t("storage.operationContinues")}</small>}
      </span>
    </div>}

    <details className="storage-settings">
      <summary>
        <span className="storage-settings-summary-icon"><HardDrive size={17} aria-hidden="true" /></span>
        <span><strong>{t("storage.configure")}</strong><small>{t("storage.configureHelp")}</small></span>
        <ChevronDown size={17} aria-hidden="true" />
      </summary>
      <div className="storage-settings-content">
        <div className="storage-editors">
          <LocationEditor
            purpose="timeseries"
            value={draft.timeseries}
            allowedRoots={status.allowedRoots}
            pathError={timeseriesPathError}
            disabled={operationActive || !status.capability.available}
            onChange={(timeseries) => setDraft({ ...draft, timeseries })}
          />
          <LocationEditor
            purpose="backups"
            value={draft.backups}
            allowedRoots={status.allowedRoots}
            pathError={backupsPathError}
            disabled={operationActive || !status.capability.available}
            onChange={(backups) => setDraft({ ...draft, backups })}
          />
        </div>
        {status.allowedRoots.length > 0 && <p className="storage-allowed-roots"><strong>{t("storage.allowedRoots")}</strong>{status.allowedRoots.map((root) => <code key={root}>{root}</code>)}</p>}
        {changed && <StorageChangePlan current={status.settings} target={draft} />}
        {overlapError && <p className="field-error storage-form-error" role="alert">{overlapError}</p>}
        <div className="storage-settings-actions">
          {changed && <button type="button" className="secondary-button" disabled={busy !== null || operationActive} onClick={() => { setDraft(cloneSettings(status.settings)); setError(null); }}>
            <RefreshCcw size={15} aria-hidden="true" />{t("storage.reset")}
          </button>}
          <button type="button" className="primary-button" disabled={!changed || !formValid || busy !== null || operationActive || !status.capability.available} onClick={() => void save()}>
            <Save size={15} aria-hidden="true" />{busy === "save" ? t("common.saving") : t("storage.save")}
          </button>
        </div>
      </div>
    </details>
  </section>;
}
