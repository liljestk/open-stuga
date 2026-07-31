import { useEffect, useState } from "react";
import { Check, LoaderCircle, RadioTower, TriangleAlert } from "lucide-react";
import type { House, Nexus433Status } from "@climate-twin/contracts";
import { api } from "../../api";
import { useI18n } from "../../i18n";

interface Nexus433SetupPanelProps {
  house: House;
  onOpenSensors: (() => void) | undefined;
}

export function Nexus433SetupPanel({ house, onOpenSensors }: Nexus433SetupPanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Nexus433Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    const load = async () => {
      try {
        const next = await api.nexus433Status(house.id, controller.signal);
        setStatus(next);
        setError(null);
        if (next.capability.available && (next.enabled || next.operation?.phase === "queued" || next.operation?.phase === "applying")) {
          timer = window.setTimeout(() => void load(), 2_000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("nexus433.requestFailed"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [house.id, t]);

  if (loading || !status?.capability.available) return null;

  const connected = status.runtime === "connected" && status.receiverOnline !== false;
  const phase = status.operation?.phase;
  const busy = saving || phase === "queued" || phase === "applying";
  const statusLabel = !status.enabled
    ? t("nexus433.statusDisabled")
    : connected ? t("nexus433.statusListening")
      : status.runtime === "error" || phase === "failed"
        ? t("nexus433.statusNeedsAttention")
        : t("nexus433.statusStarting");

  const configure = async () => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await api.configureNexus433({
        houseId: house.id,
        enabled: !status.enabled,
        expectedRevision: status.revision,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("nexus433.requestFailed"));
    } finally {
      setSaving(false);
    }
  };

  return <section className="panel connection-card connection-provider nexus433-setup" aria-labelledby="nexus433-setup-title">
    <div className="panel-header">
      <div>
        <span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{t("nexus433.eyebrow")}</span>
        <h2 id="nexus433-setup-title">{t("nexus433.setupTitle")}</h2>
        <p>{t("nexus433.setupBody")}</p>
      </div>
      <span className={`source-health-pill ${connected ? "connected" : status.enabled ? "warning" : ""}`} role="status" aria-live="polite">
        {connected ? <Check size={14} aria-hidden="true" /> : <RadioTower size={14} aria-hidden="true" />}{statusLabel}
      </span>
    </div>
    {status.enabled && <p className="configured-note">{t("nexus433.enabledBody", { home: house.name })}</p>}
    {(error || status.error || phase === "failed") && <p className="field-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{error ?? status.error ?? status.operation?.detail}</p>}
    <div className="panel-actions">
      <button type="button" className={status.enabled ? "secondary-button" : "primary-button"} disabled={busy} onClick={() => void configure()}>
        {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
        {status.enabled ? t("nexus433.disable") : t("nexus433.enable")}
      </button>
      {status.enabled && onOpenSensors && <button type="button" className="secondary-button" onClick={onOpenSensors}>{t("nexus433.manageSenders")}</button>}
    </div>
    <details>
      <summary>{t("nexus433.hardwareDetails")}</summary>
      <p>{t("nexus433.hardwareBody", { chip: status.capability.gpioChip ?? "–", line: status.capability.gpioLine ?? "–" })}</p>
    </details>
  </section>;
}
