import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CloudSun, DoorOpen, Sparkles, Zap, type LucideIcon } from "lucide-react";
import type {
  AnalyticsFinding,
  DailyAnalyticsFindingsResponse,
  House,
  MeasurementDefinition,
  UnitSystem,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { formatInTimeZone } from "../../dateTime";
import { useI18n } from "../../i18n";
import { definitionFor, displayUnit, toDisplayValue } from "../../measurements";
import { RefreshButton } from "../../components/RefreshButton";
import { Notice } from "../../components/Notice";

const PRIMARY_FINDING_COUNT = 4;

interface DailyAnalyticsFindingsProps {
  house: House;
  definitions: MeasurementDefinition[];
  units: UnitSystem;
  refreshRevision?: number;
}

function findingDefinition(finding: AnalyticsFinding, definitions: MeasurementDefinition[]): MeasurementDefinition | null {
  if (finding.category === "opening") return null;
  return definitionFor(definitions, finding.metric === "outdoor_temperature" ? "temperature" : finding.metric);
}

function iconFor(category: AnalyticsFinding["category"]): LucideIcon {
  if (category === "outdoor-weather") return CloudSun;
  if (category === "electricity") return Zap;
  if (category === "opening") return DoorOpen;
  return Activity;
}

function formatDateOnly(
  date: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`));
}

export function DailyAnalyticsFindings(props: Readonly<DailyAnalyticsFindingsProps>) {
  const { locale, t } = useI18n();
  const [response, setResponse] = useState<DailyAnalyticsFindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const shownHouseId = useRef(props.house.id);

  useEffect(() => {
    const controller = new AbortController();
    // A poll or refresh keeps the findings already shown; only another Home clears them.
    if (shownHouseId.current !== props.house.id) {
      shownHouseId.current = props.house.id;
      setResponse(null);
    }
    setLoading(true);
    setError(null);
    void api.analyticsFindings(props.house.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setResponse(result);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("analytics.findingsLoadFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [props.house.id, props.refreshRevision, retryRevision, t]);

  useEffect(() => {
    if (!["pending", "stale-algorithm"].includes(response?.status.state ?? "")) return;
    const timer = setTimeout(() => setRetryRevision((value) => value + 1), 15_000);
    return () => clearTimeout(timer);
  }, [response?.status.state, retryRevision]);

  const staleAlgorithm = response?.status.state === "stale-algorithm";
  const snapshot = staleAlgorithm ? null : response?.snapshot ?? null;
  const primaryFindings = snapshot?.findings.slice(0, PRIMARY_FINDING_COUNT) ?? [];
  const remainingFindings = snapshot?.findings.slice(PRIMARY_FINDING_COUNT) ?? [];
  const periodName = useMemo(() => snapshot
    ? snapshot.findings[0]
      ? formatInTimeZone(snapshot.findings[0].current.start, locale, props.house.timezone, { month: "long" })
      : formatDateOnly(snapshot.evaluatedThrough, locale, { month: "long" })
    : "", [locale, props.house.timezone, snapshot]);

  const formatRegisteredValue = (value: number, definition: MeasurementDefinition, difference = false): string => {
    const converted = difference && definition.id === "temperature" && props.units === "imperial"
      ? Math.abs(value) * 9 / 5
      : toDisplayValue(value, definition, props.units);
    const unit = displayUnit(definition, props.units);
    const separator = unit && unit !== "%" && !unit.startsWith("°") ? " " : "";
    const number = new Intl.NumberFormat(locale, {
      maximumFractionDigits: Math.min(definition.precision, 2),
    }).format(difference ? Math.abs(converted) : converted);
    return `${number}${separator}${unit}`;
  };

  const formatValue = (finding: AnalyticsFinding, value: number): string => {
    if (finding.category === "opening") return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
    const definition = findingDefinition(finding, props.definitions);
    return definition ? formatRegisteredValue(value, definition) : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)} ${finding.unit}`.trim();
  };

  const subjectLabel = (finding: AnalyticsFinding): string => finding.category === "outdoor-weather"
    ? t("analytics.findingsOutdoorWeather")
    : finding.subjectLabel;

  const formatDifference = (finding: AnalyticsFinding): string => {
    if (finding.category === "opening") return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(finding.absoluteDifference);
    const definition = findingDefinition(finding, props.definitions);
    return definition
      ? formatRegisteredValue(finding.absoluteDifference, definition, true)
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(finding.absoluteDifference)} ${finding.unit}`.trim();
  };

  const statement = (finding: AnalyticsFinding): string => {
    const parameters = {
      subject: subjectLabel(finding),
      current: formatValue(finding, finding.current.value),
      baseline: formatValue(finding, finding.baselineMedian),
      difference: formatDifference(finding),
      count: finding.baseline.length,
      period: periodName,
    };
    if (finding.category === "opening") {
      return t(finding.direction === "higher" ? "analytics.findingsOpeningHigher" : "analytics.findingsOpeningLower", parameters);
    }
    if (finding.metric.includes("temperature")) {
      return t(finding.direction === "higher" ? "analytics.findingsTemperatureHigher" : "analytics.findingsTemperatureLower", parameters);
    }
    if (finding.statistic === "sum" || finding.statistic === "delta") {
      return t(finding.direction === "higher" ? "analytics.findingsTotalHigher" : "analytics.findingsTotalLower", parameters);
    }
    return t(finding.direction === "higher" ? "analytics.findingsMeanHigher" : "analytics.findingsMeanLower", parameters);
  };

  const findingArticle = (finding: AnalyticsFinding) => {
    const Icon = iconFor(finding.category);
    const evidenceLabel = t("analytics.findingsEvidenceCaption", { subject: subjectLabel(finding) });
    return <article key={finding.id} className={`daily-finding-card ${finding.strength}`}>
      <header>
        <span className={`daily-finding-icon ${finding.category}`}><Icon size={17} aria-hidden="true" /></span>
        <div><h3>{subjectLabel(finding)}</h3><small>{t(`analytics.findingsCategory_${finding.category}`)}</small></div>
        <span className={`status-badge ${finding.strength === "strong" ? "warning" : ""}`}>{t(`analytics.findingsStrength_${finding.strength}`)}</span>
      </header>
      <p>{statement(finding)}</p>
      <details>
        <summary>{t("analytics.findingsEvidence", { count: finding.baseline.length + 1 })}</summary>
        <div className="table-scroll" role="region" aria-label={evidenceLabel} tabIndex={0}><table>
          <caption className="sr-only">{evidenceLabel}</caption>
          <thead><tr><th scope="col">{t("analytics.findingsPeriod")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.findingsObservations")}</th></tr></thead>
          <tbody>{[finding.current, ...finding.baseline].map((period, index) => <tr key={period.key}>
            <th scope="row">{index === 0 ? t("analytics.findingsCurrent", { year: period.year }) : String(period.year)}</th>
            <td>{period.unscaledValue === undefined
              ? formatValue(finding, period.value)
              : t("analytics.findingsScaled", { value: formatValue(finding, period.value), raw: formatValue(finding, period.unscaledValue) })}</td>
            <td>{period.coverage === null ? "—" : `${Math.round(period.coverage * 100)}%`}</td>
            <td>{new Intl.NumberFormat(locale).format(period.sampleCount)}</td>
          </tr>)}</tbody>
        </table></div>
        <small className="daily-findings-method">{t("analytics.findingsMethod", { baseline: formatValue(finding, finding.baselineMedian) })}</small>
        {finding.weatherAdjustment && <small className="daily-findings-method">{t(
          finding.weatherAdjustment.driver === "heating-degree-hours" ? "analytics.findingsWeatherDegreeHours" : "analytics.findingsWeatherOutdoor",
          {
            current: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(finding.weatherAdjustment.currentDriver),
            baseline: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(finding.weatherAdjustment.baselineDriverMedian),
            base: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(finding.weatherAdjustment.baseTemperatureC ?? 17),
            unadjusted: formatValue(finding, finding.weatherAdjustment.unadjustedBaselineMedian),
          },
        )}</small>}
        {finding.zScore !== undefined && finding.qValue !== undefined && finding.spreadBasis && <small className="daily-findings-method">{t("analytics.findingsSignificance", {
          z: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(finding.zScore)),
          basis: t(`analytics.findingsSpread_${finding.spreadBasis}`),
          q: new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 }).format(finding.qValue),
        })}</small>}
      </details>
    </article>;
  };

  const warnings = snapshot ? [
    snapshot.warnings.includes("archive-incomplete") ? t("analytics.findingsArchiveWarning") : null,
    snapshot.warnings.includes("source-truncated") ? t("analytics.findingsTruncatedWarning") : null,
    snapshot.warnings.includes("scope-limited") ? t("analytics.findingsScopeWarning") : null,
  ].filter((warning): warning is string => warning !== null) : [];

  return <section className="panel daily-findings" aria-labelledby="daily-findings-title">
    <header className="panel-header daily-findings-header">
      <div>
        <span className="eyebrow"><Sparkles size={13} aria-hidden="true" />{t("analytics.findingsEyebrow")}</span>
        <h2 id="daily-findings-title">{t("analytics.findingsTitle")}</h2>
        <p>{t("analytics.findingsDescription")}</p>
      </div>
    </header>

    {error && <div className="inline-error daily-findings-error" role="alert">
      <span><strong>{t("analytics.findingsLoadFailed")}</strong><small>{error}</small></span>
      <RefreshButton onClick={() => setRetryRevision((value) => value + 1)} busy={loading} />
    </div>}
    {!error && loading && !response && <output className="daily-findings-state" aria-live="polite"><span className="spinner" aria-hidden="true" />{t("analytics.findingsLoading")}</output>}
    {!error && response?.status.state === "pending" && !snapshot && <div className="daily-findings-state" role="status" aria-live="polite" aria-atomic="true">
      <strong>{t("analytics.findingsPendingTitle")}</strong><span>{t("analytics.findingsPendingBody")}</span>
    </div>}
    {response?.status.state === "failed" && <Notice
      tone="warning"
      title={t("analytics.findingsRunFailed")}
      dismissKey={`daily-findings:${props.house.id}`}
      fingerprint={`failed:${snapshot?.evaluatedThrough ?? ""}`}
    >{t("analytics.findingsRunFailedHelp")}</Notice>}
    {staleAlgorithm && <Notice tone="progress" title={t("analytics.findingsUpdatingTitle")}>{t("analytics.findingsUpdatingBody")}</Notice>}

    {snapshot && <>
      <div className="daily-findings-meta">
        <span>{t("analytics.findingsThrough", {
          date: formatDateOnly(snapshot.evaluatedThrough, locale, { dateStyle: "long" }),
        })}</span>
        <span>{t("analytics.findingsCount", { count: snapshot.findings.length })}</span>
        {snapshot.seriesTested !== undefined && <span>{t("analytics.findingsTested", { count: snapshot.seriesTested })}</span>}
      </div>
      {warnings.length > 0 && <div className="inline-warning" role="status"><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      {snapshot.findings.length === 0 ? <div className="daily-findings-state" role="status">
        <strong>{t("analytics.findingsNoneTitle")}</strong><span>{t("analytics.findingsNoneBody")}</span>
      </div> : <>
        <div className="daily-findings-list">{primaryFindings.map(findingArticle)}</div>
        {remainingFindings.length > 0 && <details className="daily-findings-more">
          <summary>{t("analytics.findingsShowMore", { count: remainingFindings.length })}</summary>
          <div className="daily-findings-list">{remainingFindings.map(findingArticle)}</div>
        </details>}
      </>}
      <p className="daily-findings-disclaimer">{t("analytics.findingsDisclaimer")}</p>
    </>}
  </section>;
}
