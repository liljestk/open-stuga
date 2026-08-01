import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  HelpCircle,
  MemoryStick,
  RefreshCw,
  ServerCog,
  Thermometer,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  HostSystemAlert,
  HostSystemHealth,
  HostSystemState,
} from "@climate-twin/contracts";
import { api, API_BASE } from "../api";
import { useI18n } from "../i18n";
import "./HostSystemPanel.css";

function bytes(value: number | null, locale: string): string {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: amount >= 100 || unit === 0 ? 0 : 1,
  }).format(amount)} ${units[unit]}`;
}

function duration(value: number, locale: string): string {
  const days = Math.floor(value / 86_400);
  const hours = Math.floor(value % 86_400 / 3_600);
  const minutes = Math.floor(value % 3_600 / 60);
  if (days > 0) return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format([
    `${days}d`,
    `${hours}h`,
  ]);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(value)}s`;
}

function percent(value: number | null, locale: string): string {
  return value === null ? "—" : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
}

function milliseconds(value: number | null, locale: string): string {
  return value === null
    ? "—"
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ms`;
}

function StateIcon({ state }: { state: HostSystemState }) {
  if (state === "healthy") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (state === "critical") return <CircleAlert size={16} aria-hidden="true" />;
  if (state === "warning") return <TriangleAlert size={16} aria-hidden="true" />;
  return <HelpCircle size={16} aria-hidden="true" />;
}

function StateBadge({ state }: { state: HostSystemState }) {
  const { t } = useI18n();
  const label = state === "healthy"
    ? t("systemHealth.state.healthy")
    : state === "warning"
      ? t("systemHealth.state.warning")
      : state === "critical"
        ? t("systemHealth.state.critical")
        : t("systemHealth.state.unknown");
  return <span className={`host-system-state ${state}`}><StateIcon state={state} />{label}</span>;
}

function MetricCard(props: {
  icon: typeof Cpu;
  label: string;
  value: string;
  context: string;
  state: HostSystemState;
  progress?: number | null;
}) {
  const Icon = props.icon;
  return <article className={`host-system-metric ${props.state}`}>
    <div className="host-system-metric-heading">
      <span aria-hidden="true"><Icon size={18} /></span>
      <small>{props.label}</small>
    </div>
    <strong>{props.value}</strong>
    {props.progress !== undefined && props.progress !== null && <progress
      max="100"
      value={props.progress}
      aria-label={`${props.label}: ${props.value}`}
    />}
    <p>{props.context}</p>
  </article>;
}

function AlertCard({ alert, health }: { alert: HostSystemAlert; health: HostSystemHealth }) {
  const { t, locale } = useI18n();
  const title = alert.metric === "cpu"
    ? t("systemHealth.alert.cpu")
    : alert.metric === "event-loop"
      ? t("systemHealth.alert.eventLoop")
    : alert.metric === "memory"
      ? t("systemHealth.alert.memory")
      : alert.metric === "storage"
        ? t("systemHealth.alert.storage")
        : t("systemHealth.alert.temperature");
  const elapsed = duration(Math.max(0, (Date.parse(health.sampledAt) - Date.parse(alert.startedAt)) / 1_000), locale);
  const body = alert.metric === "cpu"
    ? t("systemHealth.alertBody.cpu", { value: percent(alert.value, locale), duration: elapsed })
    : alert.metric === "event-loop"
      ? t("systemHealth.alertBody.eventLoop", { value: milliseconds(alert.value, locale), duration: elapsed })
    : alert.metric === "memory"
      ? t("systemHealth.alertBody.memory", { value: percent(alert.value, locale), duration: elapsed })
      : alert.metric === "temperature"
        ? t("systemHealth.alertBody.temperature", {
          value: alert.value === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(alert.value),
          duration: elapsed,
        })
        : alert.value === null
          ? t("systemHealth.alertBody.storageUnknown")
          : t("systemHealth.alertBody.storage", { available: bytes(health.storage.availableBytes, locale) });
  const action = alert.metric === "cpu"
    ? t("systemHealth.action.cpu")
    : alert.metric === "event-loop"
      ? t("systemHealth.action.eventLoop")
    : alert.metric === "memory"
      ? t("systemHealth.action.memory")
      : alert.metric === "storage"
        ? t("systemHealth.action.storage")
        : t("systemHealth.action.temperature");
  return <article className={`host-system-alert ${alert.severity}`}>
    <span className="host-system-alert-icon" aria-hidden="true">
      {alert.severity === "critical" ? <CircleAlert size={20} /> : <TriangleAlert size={20} />}
    </span>
    <div>
      <span className="eyebrow">{t(`alerts.${alert.severity}`)}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      <small>{action}</small>
    </div>
  </article>;
}

export function HostSystemAlertList({ health }: { health: HostSystemHealth }) {
  return <>{health.alerts.map((alert) => <AlertCard key={alert.id} alert={alert} health={health} />)}</>;
}

export function HostSystemPanel() {
  const { t, locale } = useI18n();
  const [health, setHealth] = useState<HostSystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setHealth(await api.hostSystemHealth());
      setError(false);
    } catch {
      setError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!health && loading) {
    return <section className="panel host-system-panel" aria-label={t("systemHealth.title")}>
      <div className="host-system-loading" role="status">
        <RefreshCw className="spin" size={18} aria-hidden="true" />
        <span>{t("systemHealth.loading")}</span>
      </div>
    </section>;
  }
  if (!health) {
    return <section className="panel host-system-panel unavailable" aria-labelledby="host-system-title">
      <div className="panel-header">
        <div><span className="eyebrow"><ServerCog size={14} aria-hidden="true" />{t("systemHealth.eyebrow")}</span><h2 id="host-system-title">{t("systemHealth.title")}</h2></div>
      </div>
      <div className="host-system-unavailable" role="alert">
        <HelpCircle size={22} aria-hidden="true" />
        <div><strong>{t("systemHealth.unavailable")}</strong><p>{t("systemHealth.unavailableBody")}</p></div>
        <button type="button" className="secondary-button" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />{t("systemHealth.refresh")}</button>
      </div>
    </section>;
  }

  const loadText = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(health.cpu.loadAverage[0]);
  const temperatureText = health.cpu.temperatureCelsius === null
    ? ""
    : ` · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(health.cpu.temperatureCelsius)} °C`;
  const eventLoop = health.cpu.eventLoop;
  const metricsPath = `${API_BASE}/system/metrics`;
  return <section className={`panel host-system-panel ${health.state}`} aria-labelledby="host-system-title">
    <div className="panel-header host-system-header">
      <div>
        <span className="eyebrow"><ServerCog size={14} aria-hidden="true" />{t("systemHealth.eyebrow")}</span>
        <h2 id="host-system-title">{t("systemHealth.title")}</h2>
        <p>{t("systemHealth.description")}</p>
      </div>
      <div className="host-system-header-actions">
        <StateBadge state={health.state} />
        <button type="button" className="icon-button" disabled={loading} onClick={() => void load()} aria-label={t("systemHealth.refresh")} title={t("systemHealth.refresh")}>
          <RefreshCw className={loading ? "spin" : ""} size={17} aria-hidden="true" />
        </button>
      </div>
    </div>

    {error && <p className="host-system-stale" role="status"><TriangleAlert size={15} aria-hidden="true" />{t("systemHealth.stale")}</p>}

    {health.alerts.length > 0 && <section className="host-system-alerts" aria-labelledby="host-system-alerts-title">
      <h3 id="host-system-alerts-title">{t("systemHealth.needsAttention")}</h3>
      <div><HostSystemAlertList health={health} /></div>
    </section>}

    <details className="host-system-details">
      <summary>
        <Database size={16} aria-hidden="true" />
        <span><strong>{t("systemHealth.metricsTitle")}</strong><small>{t("systemHealth.metricsSummary")}</small></span>
        <ChevronDown className="host-system-details-chevron" size={17} aria-hidden="true" />
      </summary>
      <div className="host-system-details-content">
      <div className="host-system-grid">
      <MetricCard
        icon={Cpu}
        label={t("systemHealth.cpu")}
        value={health.cpu.usagePercent === null ? t("systemHealth.measuring") : percent(health.cpu.usagePercent, locale)}
        context={`${t("systemHealth.cpuContext", {
          cores: health.cpu.logicalCores,
          load: loadText,
          temperature: temperatureText,
        })}${health.cpu.processUsagePercent === null || health.cpu.processUsagePercent === undefined
          ? ""
          : ` · ${t("systemHealth.processCpuContext", {
            value: percent(health.cpu.processUsagePercent, locale),
          })}`}`}
        state={health.cpu.state}
        progress={health.cpu.usagePercent}
      />
      <MetricCard
        icon={MemoryStick}
        label={t("systemHealth.memory")}
        value={percent(health.memory.usedPercent, locale)}
        context={t("systemHealth.memoryContext", {
          used: bytes(health.memory.usedBytes, locale),
          total: bytes(health.memory.totalBytes, locale),
          scope: t(health.memory.scope === "container" ? "systemHealth.containerLimit" : "systemHealth.hostMemory"),
        })}
        state={health.memory.state}
        progress={health.memory.usedPercent}
      />
      <MetricCard
        icon={Gauge}
        label={t("systemHealth.eventLoop")}
        value={milliseconds(eventLoop?.p95Milliseconds ?? null, locale)}
        context={eventLoop?.maxMilliseconds === null || eventLoop?.maxMilliseconds === undefined
          ? t("systemHealth.eventLoopMeasuring")
          : t("systemHealth.eventLoopContext", { max: milliseconds(eventLoop.maxMilliseconds, locale) })}
        state={eventLoop?.state ?? "unknown"}
      />
      <MetricCard
        icon={HardDrive}
        label={t("systemHealth.storage")}
        value={health.storage.usedPercent === null ? t("systemHealth.unavailableShort") : percent(health.storage.usedPercent, locale)}
        context={health.storage.availableBytes === null
          ? t("systemHealth.storageUnknown")
          : t("systemHealth.storageContext", { available: bytes(health.storage.availableBytes, locale), total: bytes(health.storage.totalBytes, locale) })}
        state={health.storage.state}
        progress={health.storage.usedPercent}
      />
      <MetricCard
        icon={Clock3}
        label={t("systemHealth.uptime")}
        value={duration(health.serviceUptimeSeconds, locale)}
        context={t("systemHealth.uptimeContext", { host: duration(health.hostUptimeSeconds, locale) })}
        state="healthy"
      />
    </div>

        <p>{t("systemHealth.metricsBody")}</p>
        <a href={metricsPath} target="_blank" rel="noreferrer"><code>{metricsPath}</code></a>
        <dl>
          <div><dt><Cpu size={14} aria-hidden="true" />{t("systemHealth.cpu")}</dt><dd>{t("systemHealth.thresholdCpu", { warning: health.cpu.usageThresholds.warningPercent, critical: health.cpu.usageThresholds.criticalPercent })}</dd></div>
          {eventLoop && <div><dt><Gauge size={14} aria-hidden="true" />{t("systemHealth.eventLoop")}</dt><dd>{t("systemHealth.thresholdMilliseconds", { warning: eventLoop.thresholds.warningMilliseconds, critical: eventLoop.thresholds.criticalMilliseconds })}</dd></div>}
          <div><dt><MemoryStick size={14} aria-hidden="true" />{t("systemHealth.memory")}</dt><dd>{t("systemHealth.thresholdPercent", { warning: health.memory.thresholds.warningPercent, critical: health.memory.thresholds.criticalPercent })}</dd></div>
          <div><dt><HardDrive size={14} aria-hidden="true" />{t("systemHealth.storage")}</dt><dd>{t("systemHealth.thresholdStorage", { warning: bytes(health.storage.warningAvailableBytes, locale), critical: bytes(health.storage.criticalAvailableBytes, locale) })}</dd></div>
          <div><dt><Thermometer size={14} aria-hidden="true" />{t("systemHealth.temperature")}</dt><dd>{t("systemHealth.thresholdTemperature", { warning: health.cpu.temperatureThresholds.warningPercent, critical: health.cpu.temperatureThresholds.criticalPercent })}</dd></div>
        </dl>
        <p className="host-system-identity">{health.hostname} · {health.platform} {health.release} · {health.architecture}</p>
      </div>
    </details>
  </section>;
}
