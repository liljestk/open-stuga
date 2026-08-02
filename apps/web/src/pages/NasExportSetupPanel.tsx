import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, HardDrive, LoaderCircle, Save } from "lucide-react";
import { api, type SystemStorageStatus } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { useI18n } from "../i18n";

const activePhases = new Set(["queued", "validating", "backing-up", "quiescing", "copying", "applying", "verifying", "rolling-back"]);

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function NasExportSetupPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SystemStorageStatus | null>(null);
  const [path, setPath] = useState("/mnt/stugu/nas-storage");
  const [busy, setBusy] = useState<"load" | "save" | null>("load");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("load");
    try {
      const next = await api.systemStorageStatus();
      setStatus(next);
      if (next.settings.backups.kind === "nas-path" && next.settings.backups.path) setPath(next.settings.backups.path);
      setError(null);
    } catch (loadError) {
      if (!quiet) setError(message(loadError, t("dataExport.nasSetupError")));
    } finally {
      if (!quiet) setBusy(null);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!status?.operation || !activePhases.has(status.operation.phase)) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [load, status?.operation]);

  const connected = status?.settings.backups.kind === "nas-path";
  const operationActive = Boolean(status?.operation && activePhases.has(status.operation.phase));

  const save = async () => {
    if (!status || !path.trim() || !status.capability.available || operationActive) return;
    if (!await confirmAction(t("dataExport.nasSetupConfirm"), t("dataExport.nasSetupSave"), true)) return;
    setBusy("save");
    setError(null);
    try {
      const next = await api.updateSystemStorage({
        settings: {
          timeseries: { ...status.settings.timeseries },
          backups: { kind: "nas-path", path: path.trim() },
        },
        expectedRevision: status.revision,
        confirmation: "APPLY_STORAGE",
      });
      setStatus(next);
    } catch (saveError) {
      setError(message(saveError, t("dataExport.nasSetupError")));
    } finally {
      setBusy(null);
    }
  };

  return <section id="nas-export-setup" className="panel nas-export-setup-panel" aria-labelledby="nas-export-setup-title">
    <div className="panel-header"><div><span className="eyebrow"><HardDrive size={14} aria-hidden="true" /> {t("dataExport.nasSetupEyebrow")}</span><h2 id="nas-export-setup-title">{t("dataExport.nasSetupTitle")}</h2></div>{status && <span className={`nas-setup-state ${connected ? "connected" : "missing"}`}>{connected ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}{connected ? t("dataExport.nasSetupConnected") : t("dataExport.nasSetupNotConnected")}</span>}</div>
    <p>{t("dataExport.nasSetupDescription")}</p>
    <p className="nas-setup-shared">{t("dataExport.nasSetupShared")}</p>
    {busy === "load" && <p role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> {t("dataExport.nasSetupLoading")}</p>}
    {status && !status.capability.available && <p className="nas-setup-warning"><CircleAlert size={15} aria-hidden="true" />{status.capability.detail ?? t("dataExport.nasSetupAgentUnavailable")}</p>}
    {status?.operation && <p className="nas-setup-operation" role="status">{operationActive && <LoaderCircle className="spin" size={15} aria-hidden="true" />}<strong>{status.operation.phase.replaceAll("-", " ")}</strong>{status.operation.detail && <span>{status.operation.detail}</span>}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {status && <details className="nas-setup-config" open={!connected}>
      <summary>{connected ? t("dataExport.nasSetupChange") : t("dataExport.nasSetupConfigure")}</summary>
      <div>
        <label className="field"><span>{t("dataExport.nasSetupPath")}</span><input value={path} placeholder="/mnt/stugu/nas-storage" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setPath(event.target.value)} /><small>{t("dataExport.nasSetupPathHelp")}</small></label>
        {status.allowedRoots.length > 0 && <small>{t("dataExport.nasSetupAllowedRoots")}: <code>{status.allowedRoots.join(", ")}</code></small>}
        <button type="button" className="primary-button" disabled={!path.trim() || busy !== null || operationActive || !status.capability.available || (connected && path.trim() === status.settings.backups.path)} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}{busy === "save" ? t("dataExport.nasSetupSaving") : t("dataExport.nasSetupSave")}</button>
      </div>
    </details>}
  </section>;
}
