import { BUILTIN_MEASUREMENT_DEFINITIONS } from "@climate-twin/contracts";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import type {
  AlertEvent,
  AlertRule,
  House,
  MeasurementDefinition,
  Metric,
  Property,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  BellRing,
  Bolt,
  Building2,
  CheckCircle2,
  Droplets,
  Gauge,
  House as HouseIcon,
  Pin,
  Settings2,
  Thermometer,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import { readLocalStorage, subscribeToAccountStorageScope, writeLocalStorage } from "../browserStorage";
import {
  GLANCE_METRICS,
  mergeLatestMeasurements,
  normalizeGlanceMetrics,
  summarizeGlanceMetric,
  type GlanceMetric,
  type GlancePreference,
  type GlanceScope,
} from "../glanceOverview";
import {
  definitionFor,
  formatMeasurement,
  type LatestMeasurements,
} from "../measurements";
import { useI18n, type TranslationKey } from "../i18n";
import { useNow } from "../useNow";

export const MOBILE_GLANCE_STORAGE_KEY = "stugu-mobile-overview";

interface MobileGlanceOverviewProps {
  properties: Property[];
  houses: House[];
  sensors: Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementDefinitions: MeasurementDefinition[];
  alerts: AlertEvent[];
  alertRules: AlertRule[];
  units: UnitSystem;
  dataMode?: "demo" | "real" | "unknown";
  onOpenHome: (houseId: string) => void;
  onOpenProperty: (propertyId: string) => void;
  onOpenAlerts: () => void;
}

interface GlanceBreakdownGroup {
  id: string;
  label: string;
  sensors: Sensor[];
  alertCount: number;
  houseId?: string;
}

const metricPresentation: Record<GlanceMetric, {
  label: TranslationKey;
  icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>;
}> = {
  temperature: { label: "glance.temperature", icon: Thermometer },
  humidity: { label: "glance.humidity", icon: Droplets },
  power: { label: "glance.electricity", icon: Bolt },
  co2: { label: "glance.co2", icon: Gauge },
};

function defaultPreference(properties: Property[], houses: House[]): GlancePreference {
  const firstProperty = properties[0];
  const preferredHome = houses.find((house) => house.id === firstProperty?.defaultHouseId)
    ?? houses.find((house) => house.propertyId === firstProperty?.id)
    ?? houses[0];
  return preferredHome
    ? { scope: "home", targetId: preferredHome.id, metrics: [...GLANCE_METRICS] }
    : { scope: "property", targetId: firstProperty?.id ?? "", metrics: [...GLANCE_METRICS] };
}

function storedPreference(properties: Property[], houses: House[]): GlancePreference {
  const fallback = defaultPreference(properties, houses);
  try {
    const parsed = JSON.parse(readLocalStorage(MOBILE_GLANCE_STORAGE_KEY) ?? "null") as Partial<GlancePreference> | null;
    const scope: GlanceScope = parsed?.scope === "property" ? "property" : "home";
    const targets = scope === "home" ? houses : properties;
    const targetId = targets.some((target) => target.id === parsed?.targetId)
      ? parsed!.targetId!
      : scope === fallback.scope
        ? fallback.targetId
        : targets[0]?.id ?? fallback.targetId;
    return { scope, targetId, metrics: normalizeGlanceMetrics(parsed?.metrics) };
  } catch {
    return fallback;
  }
}

function latestFromSnapshots(
  snapshots: Array<{ sensorId: string; measurements: LatestMeasurements[string] }>,
): LatestMeasurements {
  return Object.fromEntries(snapshots.map((entry) => [entry.sensorId, entry.measurements]));
}

export function MobileGlanceOverview({
  properties,
  houses,
  sensors,
  latestMeasurements,
  measurementDefinitions,
  alerts,
  alertRules,
  units,
  dataMode,
  onOpenHome,
  onOpenProperty,
  onOpenAlerts,
}: MobileGlanceOverviewProps) {
  const { locale, t } = useI18n();
  const now = useNow();
  const targetFingerprint = `${properties.map(({ id }) => id).join("|")}::${houses.map(({ id }) => id).join("|")}`;
  const [preference, setPreference] = useState(() => storedPreference(properties, houses));
  const [configuring, setConfiguring] = useState(false);
  const [portfolioMeasurements, setPortfolioMeasurements] = useState<LatestMeasurements>({});

  useEffect(() => subscribeToAccountStorageScope(() => {
    setPreference(storedPreference(properties, houses));
    setPortfolioMeasurements({});
  }), [houses, properties]);

  useEffect(() => {
    const normalized = storedPreference(properties, houses);
    setPreference((current) => {
      const validTargets = current.scope === "home" ? houses : properties;
      return validTargets.some((target) => target.id === current.targetId) ? current : normalized;
    });
  }, [targetFingerprint]);

  useEffect(() => {
    if (dataMode !== "real" || houses.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(houses.map(async (house) => latestFromSnapshots(await api.measurementSnapshot(house.id))))
      .then((results) => {
        if (cancelled) return;
        setPortfolioMeasurements(results.reduce<LatestMeasurements>((merged, result) => (
          result.status === "fulfilled" ? mergeLatestMeasurements(merged, result.value) : merged
        ), {}));
      });
    return () => { cancelled = true; };
  }, [dataMode, targetFingerprint]);

  const updatePreference = (next: GlancePreference) => {
    setPreference(next);
    writeLocalStorage(MOBILE_GLANCE_STORAGE_KEY, JSON.stringify(next));
  };
  const selectScope = (scope: GlanceScope) => {
    const targets = scope === "home" ? houses : properties;
    const currentTargetAvailable = targets.some((target) => target.id === preference.targetId);
    updatePreference({ ...preference, scope, targetId: currentTargetAvailable ? preference.targetId : targets[0]?.id ?? "" });
  };
  const toggleMetric = (metric: GlanceMetric) => {
    const selected = new Set(preference.metrics);
    if (selected.has(metric)) {
      if (selected.size === 1) return;
      selected.delete(metric);
    } else {
      selected.add(metric);
    }
    updatePreference({ ...preference, metrics: GLANCE_METRICS.filter((candidate) => selected.has(candidate)) });
  };

  const targetHome = preference.scope === "home" ? houses.find((house) => house.id === preference.targetId) : undefined;
  const targetProperty = preference.scope === "property"
    ? properties.find((property) => property.id === preference.targetId)
    : properties.find((property) => property.id === targetHome?.propertyId);
  const targetName = targetHome?.name ?? targetProperty?.name ?? t("overview.title");
  const scopeHouses = preference.scope === "home"
    ? targetHome ? [targetHome] : []
    : houses.filter((house) => house.propertyId === targetProperty?.id);
  const scopeHouseIds = new Set(scopeHouses.map((house) => house.id));
  const scopeSensors = sensors.filter((sensor) => scopeHouseIds.has(sensor.houseId));
  const effectiveLatest = useMemo(
    () => mergeLatestMeasurements(portfolioMeasurements, latestMeasurements),
    [latestMeasurements, portfolioMeasurements],
  );
  const summaries = preference.metrics.map((metric) => summarizeGlanceMetric(scopeSensors, effectiveLatest, metric, now));
  const newestAt = summaries.flatMap((summary) => summary.latestAt ? [summary.latestAt] : [])
    .sort((left, right) => left.localeCompare(right)).at(-1);
  const scopedSensorIds = new Set(scopeSensors.map((sensor) => sensor.id));
  const activeAlerts = alerts
    .filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt && scopedSensorIds.has(alert.sensorId))
    .sort((left, right) => {
      const severity = { critical: 0, warning: 1, info: 2 } as const;
      const rank = (value: string) => severity[value as keyof typeof severity] ?? 3;
      return rank(left.severity) - rank(right.severity) || right.startedAt.localeCompare(left.startedAt);
    });
  const primaryAlert = activeAlerts[0];

  const breakdown: GlanceBreakdownGroup[] = preference.scope === "property"
    ? scopeHouses.map((house) => ({
      id: house.id,
      label: house.name,
      sensors: scopeSensors.filter((sensor) => sensor.houseId === house.id),
      alertCount: activeAlerts.filter((alert) => sensors.find((sensor) => sensor.id === alert.sensorId)?.houseId === house.id).length,
      houseId: house.id,
    }))
    : [...scopeSensors.reduce((groups, sensor) => {
      const label = sensor.room.trim() || sensor.name;
      const id = sensor.roomId?.trim() || label;
      const group = groups.get(id) ?? { id, label, sensors: [] as Sensor[], alertCount: 0 };
      group.sensors.push(sensor);
      group.alertCount += activeAlerts.filter((alert) => alert.sensorId === sensor.id).length;
      groups.set(id, group);
      return groups;
    }, new Map<string, { id: string; label: string; sensors: Sensor[]; alertCount: number }>()).values()]
      .sort((left, right) => left.label.localeCompare(right.label, locale));

  const definition = (metric: Metric) => definitionFor(
    measurementDefinitions.length ? measurementDefinitions : BUILTIN_MEASUREMENT_DEFINITIONS,
    metric,
  );

  if (!targetHome && !targetProperty) return null;

  return <section className="mobile-glance" aria-labelledby="mobile-glance-title">
    <header className="mobile-glance-heading">
      <div>
        <span className="eyebrow"><Pin size={12} aria-hidden="true" />{t("glance.pinned")}</span>
        <h1 id="mobile-glance-title" aria-label={`${t("glance.pinned")}: ${targetName}`}>{targetName}</h1>
        <p>{newestAt
          ? t("glance.updated", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(newestAt)) })
          : t("glance.noRecent")}</p>
      </div>
      <button type="button" className="glance-configure-button" aria-expanded={configuring} aria-controls="glance-configuration" onClick={() => setConfiguring((open) => !open)}>
        <Settings2 size={18} aria-hidden="true" /><span>{t("glance.configure")}</span>
      </button>
    </header>

    {configuring && <div className="glance-configuration panel" id="glance-configuration">
      <fieldset className="glance-scope-options">
        <legend>{t("glance.scope")}</legend>
        <label><input type="radio" name="glance-scope" checked={preference.scope === "home"} disabled={houses.length === 0} onChange={() => selectScope("home")} /><HouseIcon size={16} aria-hidden="true" />{t("glance.home")}</label>
        <label><input type="radio" name="glance-scope" checked={preference.scope === "property"} disabled={properties.length === 0} onChange={() => selectScope("property")} /><Building2 size={16} aria-hidden="true" />{t("glance.property")}</label>
      </fieldset>
      <label className="field glance-target-select">
        <span>{t(preference.scope === "home" ? "glance.home" : "glance.property")}</span>
        <select value={preference.targetId} onChange={(event) => updatePreference({ ...preference, targetId: event.target.value })}>
          {(preference.scope === "home" ? houses : properties).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>
      </label>
      <fieldset className="glance-metric-options">
        <legend>{t("glance.quickStats")}</legend>
        {GLANCE_METRICS.map((metric) => <label key={metric}>
          <input type="checkbox" checked={preference.metrics.includes(metric)} disabled={preference.metrics.length === 1 && preference.metrics.includes(metric)} onChange={() => toggleMetric(metric)} />
          {t(metricPresentation[metric].label)}
        </label>)}
      </fieldset>
    </div>}

    {primaryAlert ? <button type="button" className={`glance-attention ${primaryAlert.severity}`} onClick={onOpenAlerts}>
      <span aria-hidden="true"><TriangleAlert size={21} /></span>
      <span><span className="eyebrow">{t("overview.needsAttention")}</span><strong>{alertRules.find((rule) => rule.id === primaryAlert.ruleId)?.name ?? t("glance.alertNeedsReview")}</strong><small>{sensors.find((sensor) => sensor.id === primaryAlert.sensorId)?.name ?? t("overview.sensors")} · {formatMeasurement(primaryAlert.value, definition(primaryAlert.metric), units)}</small></span>
      <span className="glance-alert-count"><BellRing size={13} aria-hidden="true" />{activeAlerts.length}</span>
    </button> : dataMode === "real" || dataMode === "demo" ? <div className="glance-calm-status" role="status">
      <CheckCircle2 size={17} aria-hidden="true" /><span>{t("glance.noAlerts")}</span>
    </div> : <div className="glance-unknown-status" role="status">
      <BellRing size={17} aria-hidden="true" /><span>{t("glance.alertsUnavailable")}</span>
    </div>}

    <section className="glance-stats" aria-labelledby="glance-stats-title">
      <div className="glance-section-heading"><h2 id="glance-stats-title">{t("glance.quickStats")}</h2><span>{t(preference.scope === "home" ? "glance.homeAverage" : "glance.propertyOverview")}</span></div>
      <div className="glance-stat-grid">
        {summaries.map((summary) => {
          const presentation = metricPresentation[summary.metric];
          const Icon = presentation.icon;
          return <article className={`glance-stat glance-stat-${summary.metric}`} key={summary.metric}>
            <div><Icon size={18} aria-hidden="true" /><span>{t(presentation.label)}</span></div>
            <strong>{summary.value == null ? "—" : formatMeasurement(summary.value, definition(summary.metric), units)}</strong>
            <small>{summary.value == null
              ? t("glance.noRecent")
              : t(summary.metric === "power" ? "glance.currentSources" : "glance.averageReadings", { count: summary.sampleCount })}</small>
          </article>;
        })}
      </div>
    </section>

    {breakdown.length > 0 && <section className="glance-breakdown" aria-labelledby="glance-breakdown-title">
      <div className="glance-section-heading"><h2 id="glance-breakdown-title">{t(preference.scope === "home" ? "glance.rooms" : "glance.homes")}</h2><span>{breakdown.length}</span></div>
      <div className="glance-breakdown-list">
        {breakdown.map((group) => {
          const content = <>
            <span className="glance-breakdown-title"><strong>{group.label}</strong>{group.alertCount > 0 && <small><TriangleAlert size={12} aria-hidden="true" />{group.alertCount}</small>}</span>
            <span className="glance-breakdown-values">{preference.metrics.map((metric) => {
              const summary = summarizeGlanceMetric(group.sensors, effectiveLatest, metric, now);
              return <span key={metric}><small>{t(metricPresentation[metric].label)}</small><strong>{summary.value == null ? "—" : formatMeasurement(summary.value, definition(metric), units)}</strong></span>;
            })}</span>
          </>;
          return group.houseId
            ? <button type="button" key={group.id} onClick={() => onOpenHome(group.houseId!)}>{content}</button>
            : <article key={group.id}>{content}</article>;
        })}
      </div>
    </section>}

    <button type="button" className="secondary-button glance-open-target" onClick={() => targetHome ? onOpenHome(targetHome.id) : targetProperty && onOpenProperty(targetProperty.id)}>
      {t(targetHome ? "glance.openHome" : "glance.openProperty")}
    </button>
  </section>;
}
