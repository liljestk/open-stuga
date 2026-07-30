import { ArrowRight, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import type { HostSystemHealth } from "@climate-twin/contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import { HostSystemAlertList } from "./HostSystemPanel";
import "./HostSystemAlertsPanel.css";

export function HostSystemAlertsPanel({ onOpenSystem }: { onOpenSystem?: () => void }) {
  const { t } = useI18n();
  const [health, setHealth] = useState<HostSystemHealth | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api.hostSystemHealth();
        if (active) setHealth(next);
      } catch {
        // The Alerts page remains useful when host metrics are unavailable.
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!health?.alerts.length) return null;
  return <section className="panel alerts-host-system" aria-labelledby="alerts-host-system-title">
    <div className="panel-header">
      <div>
        <span className="eyebrow"><ServerCog size={14} aria-hidden="true" />{t("systemHealth.eyebrow")}</span>
        <h2 id="alerts-host-system-title">{t("systemHealth.alertsPageTitle")}</h2>
        <p>{t("systemHealth.alertsPageDescription")}</p>
      </div>
      <span className="alerts-open-count" aria-label={t("systemHealth.alertCount", { count: health.alerts.length })}>{health.alerts.length}</span>
    </div>
    <div className="alerts-host-system-list"><HostSystemAlertList health={health} /></div>
    {onOpenSystem && <button type="button" className="secondary-button" onClick={onOpenSystem}>
      {t("systemHealth.openSystem")}<ArrowRight size={15} aria-hidden="true" />
    </button>}
  </section>;
}
