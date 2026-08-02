import {
  ArchiveRestore,
  CheckCircle2,
  CircleAlert,
  Database,
  HardDrive,
  LoaderCircle,
  Save,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiRequestError,
  type SystemStorageLocation,
  type SystemStorageLocationKind,
  type SystemStorageSettings,
  type SystemStorageStatus,
} from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { useI18n, type TranslationKey } from "../i18n";
import "./SystemStoragePanel.css";

const activePhases = new Set([
  "queued", "validating", "backing-up", "quiescing", "copying", "applying", "verifying", "rolling-back",
]);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError || error instanceof Error ? error.message : fallback;
}

function cloneSettings(settings: SystemStorageSettings): SystemStorageSettings {
  return { timeseries: { ...settings.timeseries }, backups: { ...settings.backups } };
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
  disabled,
  onChange,
}: Readonly<{
  purpose: "timeseries" | "backups";
  value: SystemStorageLocation;
  disabled: boolean;
  onChange: (value: SystemStorageLocation) => void;
}>) {
  const { t } = useI18n();
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
        placeholder={purpose === "timeseries" ? "/mnt/stugu/telemetry" : "/mnt/stugu/backups"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <small>{value.kind === "nas-path" ? t("storage.nasPathHelp") : t("storage.pathHelp")}</small>
    </label>}
  </fieldset>;
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
        return !current || active || next.operation?.phase === "complete" ? cloneSettings(next.settings) : current;
      });
      setError(null);
    } catch (loadError) {
      if (!quiet) setError(errorMessage(loadError, t("storage.error")));
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

  const save = async () => {
    if (!status || !draft || !changed) return;
    const movesTimeseries = JSON.stringify(status.settings.timeseries) !== JSON.stringify(draft.timeseries);
    const confirmation = movesTimeseries ? "MOVE_STORAGE" : "APPLY_STORAGE";
    const prompt = movesTimeseries ? t("storage.confirmMove") : t("storage.confirmBackup");
    if (!await confirmAction(prompt, t("storage.confirmAction"), true)) return;
    setBusy("save");
    setError(null);
    try {
      const next = await api.updateSystemStorage({ settings: draft, expectedRevision: status.revision, confirmation });
      setStatus(next);
      setDraft(cloneSettings(next.settings));
    } catch (saveError) {
      setError(errorMessage(saveError, t("storage.error")));
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
      <span><strong>{t(`storage.phase.${status.operation.phase}` as TranslationKey)}</strong>{status.operation.detail && <small>{status.operation.detail}</small>}</span>
    </div>}

    <details className="storage-settings">
      <summary>{t("storage.configure")}</summary>
      <div className="storage-settings-content">
        <LocationEditor
          purpose="timeseries"
          value={draft.timeseries}
          disabled={operationActive || !status.capability.available}
          onChange={(timeseries) => setDraft({ ...draft, timeseries })}
        />
        <LocationEditor
          purpose="backups"
          value={draft.backups}
          disabled={operationActive || !status.capability.available}
          onChange={(backups) => setDraft({ ...draft, backups })}
        />
        <div className="storage-safety-note">
          <strong>{t("storage.safetyTitle")}</strong>
          <p>{t("storage.safetyBody")}</p>
          {status.allowedRoots.length > 0 && <p>{t("storage.allowedRoots")} <code>{status.allowedRoots.join(", ")}</code></p>}
        </div>
        <button type="button" className="secondary-button" disabled={!changed || busy !== null || operationActive || !status.capability.available} onClick={() => void save()}>
          <Save size={15} aria-hidden="true" />{busy === "save" ? t("common.saving") : t("storage.save")}
        </button>
      </div>
    </details>
  </section>;
}
