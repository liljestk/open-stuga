import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Eye, EyeOff, Gauge, RadioTower, Sparkles } from "lucide-react";
import type { AlertEvent, AlertRule, House, HouseWeather, Sensor } from "@climate-twin/contracts";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
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
  onOpenSetup?: () => void;
}

const hiddenPulseStoragePrefix = "stuga-home-pulse-hidden:v1";

function hiddenPulseStorageKey(houseId: string): string {
  return `${hiddenPulseStoragePrefix}:${houseId}`;
}

function insightHideFingerprint(insight: HomeInsight): string {
  return `${insight.id}:${insight.severity}`;
}

function readHiddenInsights(houseId: string): string[] {
  try {
    const stored = localStorage.getItem(hiddenPulseStorageKey(houseId));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function persistHiddenInsights(houseId: string, fingerprints: string[]): void {
  try {
    const key = hiddenPulseStorageKey(houseId);
    if (fingerprints.length) localStorage.setItem(key, JSON.stringify(fingerprints));
    else localStorage.removeItem(key);
  } catch {
    // Hiding an insight remains useful for the current session even when storage is unavailable.
  }
}

function PulseIcon({ status }: { status: HomePulseStatus }) {
  if (status === "critical" || status === "attention") return <AlertTriangle size={23} aria-hidden="true" />;
  if (status === "steady") return <CheckCircle2 size={23} aria-hidden="true" />;
  if (status === "unknown") return <RadioTower size={23} aria-hidden="true" />;
  return <Gauge size={23} aria-hidden="true" />;
}

function formatEvidenceValue(value: number | string, locale: Locale): string {
  if (typeof value === "number") return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const count = /^(\d+) of (\d+)$/.exec(value);
  if (!count) return value;
  if (locale === "fi") return `${count[1]} / ${count[2]}`;
  if (locale === "sv") return `${count[1]} av ${count[2]}`;
  return value;
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

function InsightCard({ insight, onOpen, onHide, summaryRef, allowOpen = true }: { insight: HomeInsight; onOpen: () => void; onHide: () => void; summaryRef?: Ref<HTMLElement>; allowOpen?: boolean }) {
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(insight.severity === "critical");
  const openable = allowOpen && Boolean(insight.target.floorId && insight.target.sensorId);
  const display = displayHomeInsight(insight, locale, t);
  return (
    <div className={`pulse-insight-shell ${insight.severity}`}>
      <details className={`pulse-insight ${insight.severity}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary ref={summaryRef}>
          <span className="pulse-insight-summary-copy">
            <span className="pulse-insight-top"><span className={`pulse-severity ${insight.severity}`}>{t(`decision.severity.${insight.severity}`)}</span><span>{t("decision.confidence", { level: t(`decision.confidence.${insight.confidence.level}`) })}</span></span>
            <strong>{display.title}</strong>
            <span className="pulse-insight-interpretation">{display.summary}</span>
          </span>
          <span className="pulse-disclosure-icon"><span className="sr-only">{t("home.detailLabel")}</span><ChevronDown size={16} aria-hidden="true" /></span>
        </summary>
        <div className="pulse-insight-details">
          <span className="pulse-action"><Sparkles size={13} aria-hidden="true" /><span><b>{t("decision.suggestedAction")}</b>{display.action}</span></span>
          <span className="pulse-evidence">{display.evidence.slice(0, 3).map((item) => <span key={`${item.label}:${item.value}`}><small>{item.label}</small><b>{formatEvidenceValue(item.value, locale)}{item.unit ? ` ${item.unit}` : ""}</b></span>)}</span>
          {openable && <button type="button" className="text-button pulse-open" onClick={onOpen}>{t("decision.inspectRoom")}<ArrowRight size={13} aria-hidden="true" /></button>}
        </div>
      </details>
      <div className="pulse-insight-actions">
        <button type="button" className="text-button pulse-hide" aria-label={t("decision.hideInsightLabel", { title: display.title })} onClick={onHide}><EyeOff size={13} aria-hidden="true" />{t("decision.hideInsight")}</button>
      </div>
    </div>
  );
}

export function HomePulsePanel(props: HomePulsePanelProps) {
  const { locale, t } = useI18n();
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
    maxInsights: 8,
  }), [props.house, props.sensors, props.latestMeasurements, props.measurementHistory, props.alerts, props.alertRules, props.weather, props.referenceTime]);
  const [hiddenInsightFingerprints, setHiddenInsightFingerprints] = useState(() => readHiddenInsights(props.house.id));
  const [focusTarget, setFocusTarget] = useState<{ kind: "hidden" } | { kind: "insight"; fingerprint: string } | null>(null);
  const hiddenSummaryRef = useRef<HTMLElement>(null);
  const insightSummaryRefs = useRef(new Map<string, HTMLElement>());
  const currentFingerprints = useMemo(() => new Set(pulse.insights.map(insightHideFingerprint)), [pulse.insights]);
  const hiddenInsights = pulse.insights.filter((insight) => hiddenInsightFingerprints.includes(insightHideFingerprint(insight)));
  const visibleInsights = pulse.insights.filter((insight) => !hiddenInsightFingerprints.includes(insightHideFingerprint(insight))).slice(0, 3);
  const hiddenInsightCount = hiddenInsights.length;

  useEffect(() => {
    setHiddenInsightFingerprints((current) => {
      const active = current.filter((fingerprint) => currentFingerprints.has(fingerprint));
      return active.length === current.length && active.every((fingerprint, index) => fingerprint === current[index]) ? current : active;
    });
  }, [currentFingerprints]);

  useEffect(() => {
    persistHiddenInsights(props.house.id, hiddenInsightFingerprints);
  }, [hiddenInsightFingerprints, props.house.id]);

  useEffect(() => {
    if (focusTarget?.kind === "hidden" && hiddenInsightCount > 0) hiddenSummaryRef.current?.focus();
    if (focusTarget?.kind === "insight" && visibleInsights.length > 0) {
      const fallback = insightSummaryRefs.current.get(insightHideFingerprint(visibleInsights[0]!));
      (insightSummaryRefs.current.get(focusTarget.fingerprint) ?? fallback)?.focus();
    }
    if (focusTarget) setFocusTarget(null);
  }, [focusTarget, hiddenInsightCount, visibleInsights.length]);

  const hideInsight = (insight: HomeInsight) => {
    const fingerprint = insightHideFingerprint(insight);
    setHiddenInsightFingerprints((current) => current.includes(fingerprint) ? current : [...current, fingerprint]);
    setFocusTarget({ kind: "hidden" });
  };

  const restoreInsight = (insight: HomeInsight) => {
    const fingerprint = insightHideFingerprint(insight);
    setHiddenInsightFingerprints((current) => current.filter((candidate) => candidate !== fingerprint));
    setFocusTarget({ kind: "insight", fingerprint });
  };

  const restoreAllInsights = () => {
    const fingerprint = pulse.insights[0] ? insightHideFingerprint(pulse.insights[0]) : "";
    setHiddenInsightFingerprints([]);
    if (fingerprint) setFocusTarget({ kind: "insight", fingerprint });
  };

  const hiddenInsightLabel = t(hiddenInsightCount === 1 ? "decision.hiddenInsightOne" : "decision.hiddenInsightMany", { count: hiddenInsightCount });
  const monitoringUnavailable = pulse.coverage.enabledSensors === 0
    || pulse.coverage.freshSensors + pulse.coverage.estimatedSensors === 0;
  const showVisibleAdvisory = pulse.insights.some((insight) => insight.severity === "critical" || insight.severity === "warning");

  return (
    <section className={`panel home-pulse ${pulse.status}`} aria-labelledby="home-pulse-heading">
      <div className="home-pulse-header">
        <span className="home-pulse-icon"><PulseIcon status={pulse.status} /></span>
        <div><span className="eyebrow">{t("decision.pulseEyebrow")}</span><h2 id="home-pulse-heading">{t(`decision.pulse.${pulse.status}.title`)}</h2><p>{t(`decision.pulse.${pulse.status}.body`)}</p></div>
        <span className={`pulse-status ${pulse.status}`}>{t(`decision.pulse.${pulse.status}.label`)}</span>
      </div>
      {visibleInsights.length ? <div className="pulse-insights">{visibleInsights.map((insight) => {
        const fingerprint = insightHideFingerprint(insight);
        return <InsightCard key={insight.id} insight={insight} summaryRef={(node) => { if (node) insightSummaryRefs.current.set(fingerprint, node); else insightSummaryRefs.current.delete(fingerprint); }} allowOpen={!monitoringUnavailable || !props.onOpenSetup} onHide={() => hideInsight(insight)} onOpen={() => {
        if (insight.target.floorId && insight.target.sensorId) props.onOpenTarget(insight.target.floorId, insight.target.sensorId);
        }} />;
      })}</div> : pulse.insights.length === 0 ? <div className="pulse-calm"><CheckCircle2 size={20} aria-hidden="true" /><span><strong>{t("decision.pulseCalmTitle")}</strong>{t("decision.pulseCalmBody")}</span></div> : null}
      {hiddenInsightCount > 0 && <>
        <span className="sr-only" role="status">{hiddenInsightLabel}</span>
        <details className="pulse-hidden-disclosure">
          <summary ref={hiddenSummaryRef}><EyeOff size={16} aria-hidden="true" /><span>{hiddenInsightLabel}</span><ChevronDown size={15} aria-hidden="true" /></summary>
          <div className="pulse-hidden-content">
            <p>{t("decision.hiddenInsightBody")}</p>
            <ul>{hiddenInsights.map((insight) => {
              const display = displayHomeInsight(insight, locale, t);
              return <li key={insightHideFingerprint(insight)}><span><small>{t(`decision.severity.${insight.severity}`)}</small><strong>{display.title}</strong></span><button type="button" className="text-button" aria-label={t("decision.restoreInsightLabel", { title: display.title })} onClick={() => restoreInsight(insight)}><Eye size={13} aria-hidden="true" />{t("decision.restoreInsight")}</button></li>;
            })}</ul>
            {hiddenInsightCount > 1 && <button type="button" className="secondary-button" onClick={restoreAllInsights}><Eye size={14} aria-hidden="true" />{t("decision.restoreAllInsights")}</button>}
          </div>
        </details>
      </>}
      {monitoringUnavailable && props.onOpenSetup && <button type="button" className="secondary-button home-pulse-remediation" data-remediation="sensors" onClick={props.onOpenSetup}>{t("overview.finishSetup")}<ArrowRight size={15} aria-hidden="true" /></button>}
      {showVisibleAdvisory && <small className="decision-caveat home-pulse-advisory">{t("decision.pulseAdvisory")}</small>}
      <details className="pulse-context">
        <summary>{t("home.whyStatus")}<ChevronDown size={15} aria-hidden="true" /></summary>
        <div className="pulse-coverage" aria-label={t("decision.coverageLabel")}>
          <span><b>{pulse.coverage.freshSensors}</b>{t("decision.freshOf", { total: pulse.coverage.enabledSensors })}</span>
          <span><b>{pulse.coverage.estimatedSensors}</b>{t("decision.estimatedSensors")}</span>
          <span><b>{pulse.coverage.agingSensors + pulse.coverage.staleSensors}</b>{t("decision.agingSensors")}</span>
          <span><b>{pulse.coverage.sensorsWithoutData}</b>{t("decision.missingSensors")}</span>
        </div>
        {!showVisibleAdvisory && <small className="decision-caveat home-pulse-advisory">{t("decision.pulseAdvisory")}</small>}
      </details>
    </section>
  );
}
