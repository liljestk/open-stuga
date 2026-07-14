import { AlertTriangle, ArrowRight, CheckCircle2, Gauge, RadioTower, Sparkles } from "lucide-react";
import type { AlertEvent, AlertRule, House, HouseWeather, Sensor } from "@climate-twin/contracts";
import { useMemo } from "react";
import { deriveHomePulse, type HomeInsight, type HomePulseStatus } from "../homeInsights";
import { useI18n, type Locale, type TranslationKey } from "../i18n";
import type { LatestMeasurements, MeasurementHistory } from "../measurements";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type DisplayInsight = Pick<HomeInsight, "title" | "summary" | "action" | "evidence">;

interface HomePulsePanelProps {
  house: House;
  sensors: Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementHistory: MeasurementHistory;
  alerts: AlertEvent[];
  alertRules: AlertRule[];
  weather: HouseWeather | null;
  referenceTime: number;
  onOpenTarget: (floorId: string, sensorId: string) => void;
}

function PulseIcon({ status }: { status: HomePulseStatus }) {
  if (status === "critical" || status === "attention") return <AlertTriangle size={23} aria-hidden="true" />;
  if (status === "steady") return <CheckCircle2 size={23} aria-hidden="true" />;
  if (status === "unknown") return <RadioTower size={23} aria-hidden="true" />;
  return <Gauge size={23} aria-hidden="true" />;
}

function formatEvidenceValue(value: number | string, locale: Locale): string {
  if (typeof value === "number") return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const count = locale === "fi" ? /^(\d+) of (\d+)$/.exec(value) : null;
  return count ? `${count[1]} / ${count[2]}` : value;
}

function evidenceValue(insight: HomeInsight, label: string, locale: Locale): string {
  const evidence = insight.evidence.find((item) => item.label === label);
  if (!evidence) return "\u2014";
  return `${formatEvidenceValue(evidence.value, locale)}${evidence.unit ? ` ${evidence.unit}` : ""}`;
}

function localizedEvidenceLabel(label: string, t: Translate): string {
  const keys: Record<string, TranslationKey> = {
    "Latest reading": "decision.evidence.latestReading",
    "Alert value": "decision.evidence.alertValue",
    "Trigger threshold": "decision.evidence.triggerThreshold",
    "Latest humidity": "decision.evidence.latestHumidity",
    "Elevated readings": "decision.evidence.elevatedReadings",
    "Latest CO2": "decision.evidence.latestCo2",
    "Latest temperature": "decision.evidence.latestTemperature",
    "Outdoor temperature": "decision.evidence.outdoorTemperature",
    "Fresh sensors": "decision.evidence.freshSensors",
    "Sensors needing data": "decision.evidence.sensorsNeedData",
    "Oldest affected reading": "decision.evidence.oldestAffectedReading",
    "Outdoor dew point": "decision.evidence.outdoorDewPoint",
    "Indoor dew point": "decision.evidence.indoorDewPoint",
    "Outdoor wind": "decision.evidence.outdoorWind",
  };
  const key = keys[label];
  if (key) return t(key);
  if (label.endsWith(" temperature")) return t("decision.evidence.roomTemperature", { room: label.slice(0, -" temperature".length) });
  return label;
}

export function displayHomeInsight(insight: HomeInsight, locale: Locale, t: Translate): DisplayInsight {
  if (locale !== "fi") return insight;
  const room = insight.target.room || insight.target.sensorName || t("decision.thisHome");
  const evidence = insight.evidence.map((item) => ({
    ...item,
    label: localizedEvidenceLabel(item.label, t),
    value: typeof item.value === "string" ? formatEvidenceValue(item.value, locale) : item.value,
  }));
  const translated = (title: string, summary: string, action: string): DisplayInsight => ({ title, summary, action, evidence });

  if (insight.kind === "active-alert") {
    return translated(
      t("decision.insight.alert.title", { severity: t(`decision.severity.${insight.severity}`), room }),
      t(insight.summary.includes("acknowledged") ? "decision.insight.alert.summaryAcknowledged" : "decision.insight.alert.summaryOpen"),
      t("decision.insight.alert.action", { room }),
    );
  }
  if (insight.kind === "humidity") {
    return translated(
      t("decision.insight.humidity.title", { room }),
      t("decision.insight.humidity.summary", { value: evidenceValue(insight, "Latest humidity", locale) }),
      t("decision.insight.humidity.action"),
    );
  }
  if (insight.kind === "indoor-air") {
    return translated(
      t("decision.insight.co2.title", { room }),
      t("decision.insight.co2.summary", { value: evidenceValue(insight, "Latest CO2", locale) }),
      t("decision.insight.co2.action"),
    );
  }
  if (insight.kind === "temperature") {
    const temperature = Number(insight.evidence.find((item) => item.label === "Latest temperature")?.value);
    const titleKey = temperature <= 8
      ? "decision.insight.temperature.veryLowTitle"
      : temperature <= 12
        ? "decision.insight.temperature.lowTitle"
        : temperature >= 35
          ? "decision.insight.temperature.veryHighTitle"
          : "decision.insight.temperature.highTitle";
    return translated(
      t(titleKey, { room }),
      t("decision.insight.temperature.summary", { value: evidenceValue(insight, "Latest temperature", locale) }),
      t(temperature <= 12 ? "decision.insight.temperature.coldAction" : "decision.insight.temperature.hotAction"),
    );
  }
  if (insight.kind === "temperature-balance") {
    const temperatures = insight.evidence.filter((item) => item.label.endsWith(" temperature")).slice(0, 2);
    const first = temperatures[0];
    const second = temperatures[1];
    const firstNumber = typeof first?.value === "number" ? first.value : Number.NaN;
    const secondNumber = typeof second?.value === "number" ? second.value : Number.NaN;
    const difference = Number.isFinite(firstNumber) && Number.isFinite(secondNumber)
      ? `${formatEvidenceValue(Math.abs(secondNumber - firstNumber), locale)} \u00b0C`
      : "\u2014";
    return translated(
      t("decision.insight.balance.title", { difference }),
      t("decision.insight.balance.summary", {
        firstRoom: first?.label.replace(/ temperature$/, "") ?? t("decision.thisHome"),
        firstValue: first ? `${formatEvidenceValue(first.value, locale)}${first.unit ? ` ${first.unit}` : ""}` : "\u2014",
        secondRoom: second?.label.replace(/ temperature$/, "") ?? t("decision.thisHome"),
        secondValue: second ? `${formatEvidenceValue(second.value, locale)}${second.unit ? ` ${second.unit}` : ""}` : "\u2014",
      }),
      t("decision.insight.balance.action"),
    );
  }
  if (insight.kind === "sensor-coverage") {
    const fresh = Number(insight.evidence.find((item) => item.label === "Fresh sensors")?.value ?? 0);
    const affected = Number(insight.evidence.find((item) => item.label === "Sensors needing data")?.value ?? 0);
    return translated(
      t(affected === 1 ? "decision.insight.coverage.oneTitle" : "decision.insight.coverage.manyTitle", { count: affected }),
      t("decision.insight.coverage.summary", { fresh, affected }),
      t("decision.insight.coverage.action"),
    );
  }
  return translated(
    t("decision.insight.setup.title"),
    t("decision.insight.setup.summary"),
    t("decision.insight.setup.action"),
  );
}

function InsightCard({ insight, onOpen }: { insight: HomeInsight; onOpen: () => void }) {
  const { locale, t } = useI18n();
  const openable = Boolean(insight.target.floorId && insight.target.sensorId);
  const display = displayHomeInsight(insight, locale, t);
  const content = <>
    <span className="pulse-insight-top"><span className={`pulse-severity ${insight.severity}`}>{t(`decision.severity.${insight.severity}`)}</span><span>{t("decision.confidence", { level: t(`decision.confidence.${insight.confidence.level}`) })}</span></span>
    <strong>{display.title}</strong>
    <p>{display.summary}</p>
    <span className="pulse-action"><Sparkles size={13} aria-hidden="true" /><span><b>{t("decision.suggestedAction")}</b>{display.action}</span></span>
    <span className="pulse-evidence">{display.evidence.slice(0, 3).map((item) => <span key={`${item.label}:${item.value}`}><small>{item.label}</small><b>{formatEvidenceValue(item.value, locale)}{item.unit ? ` ${item.unit}` : ""}</b></span>)}</span>
    {openable && <span className="pulse-open">{t("decision.inspectRoom")}<ArrowRight size={13} aria-hidden="true" /></span>}
  </>;
  return openable
    ? <button type="button" className={`pulse-insight ${insight.severity}`} onClick={onOpen}>{content}</button>
    : <article className={`pulse-insight ${insight.severity}`}>{content}</article>;
}

export function HomePulsePanel(props: HomePulsePanelProps) {
  const { t } = useI18n();
  const pulse = useMemo(() => deriveHomePulse({
    house: props.house,
    sensors: props.sensors,
    latestMeasurements: props.latestMeasurements,
    measurementHistory: props.measurementHistory,
    alerts: props.alerts,
    alertRules: props.alertRules,
    outdoor: props.weather ? {
      current: props.weather.current,
      stale: props.weather.stale,
      warnings: props.weather.warnings,
    } : null,
    referenceTime: props.referenceTime,
    maxInsights: 3,
  }), [props.house, props.sensors, props.latestMeasurements, props.measurementHistory, props.alerts, props.alertRules, props.weather, props.referenceTime]);

  return (
    <section className={`panel home-pulse ${pulse.status}`} aria-labelledby="home-pulse-heading">
      <div className="home-pulse-header">
        <span className="home-pulse-icon"><PulseIcon status={pulse.status} /></span>
        <div><span className="eyebrow">{t("decision.pulseEyebrow")}</span><h2 id="home-pulse-heading">{t(`decision.pulse.${pulse.status}.title`)}</h2><p>{t(`decision.pulse.${pulse.status}.body`)}</p></div>
        <span className={`pulse-status ${pulse.status}`}>{t(`decision.pulse.${pulse.status}.label`)}</span>
      </div>
      <div className="pulse-coverage" aria-label={t("decision.coverageLabel")}>
        <span><b>{pulse.coverage.freshSensors}</b>{t("decision.freshOf", { total: pulse.coverage.enabledSensors })}</span>
        <span><b>{pulse.coverage.agingSensors + pulse.coverage.staleSensors}</b>{t("decision.agingSensors")}</span>
        <span><b>{pulse.coverage.sensorsWithoutData}</b>{t("decision.missingSensors")}</span>
      </div>
      {pulse.insights.length ? <div className="pulse-insights">{pulse.insights.map((insight) => <InsightCard key={insight.id} insight={insight} onOpen={() => {
        if (insight.target.floorId && insight.target.sensorId) props.onOpenTarget(insight.target.floorId, insight.target.sensorId);
      }} />)}</div> : <div className="pulse-calm"><CheckCircle2 size={20} aria-hidden="true" /><span><strong>{t("decision.pulseCalmTitle")}</strong>{t("decision.pulseCalmBody")}</span></div>}
      <small className="decision-caveat home-pulse-advisory">{t("decision.pulseAdvisory")}</small>
    </section>
  );
}
