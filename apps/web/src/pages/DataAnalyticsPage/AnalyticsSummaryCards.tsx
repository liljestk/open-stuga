import type { AnalyticsQueryResponse, MeasurementDefinition, UnitSystem } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import { formatMeasurement } from "../../measurements";

export function AnalyticsSummaryCards(props: { analytics: AnalyticsQueryResponse; definition: MeasurementDefinition; units: UnitSystem }) {
  const { t } = useI18n();
  return (          <div className="analytics-summary-grid">{props.analytics.summaries.map((summary) => {
            const matchingSeries = props.analytics.series.find((series) => series.entityId === summary.entityId && series.measurementId === summary.measurementId);
            const label = matchingSeries?.entityLabel ?? summary.entityId;
            return <article key={`${summary.entityId}-${summary.measurementId}`} className="analytics-summary-card">
              <div className="analytics-summary-title"><strong>{label}</strong>{matchingSeries && <span className={`analytics-truth-class ${matchingSeries.truthClass}`}>{t(`analytics.truth_${matchingSeries.truthClass}`)}</span>}</div>
              <dl>
                <div><dt>{t("analytics.median")}</dt><dd>{summary.median === null ? "—" : formatMeasurement(summary.median, props.definition, props.units)}</dd></div>
                <div><dt>{t("analytics.minimum")}</dt><dd>{summary.minimum === null ? "—" : formatMeasurement(summary.minimum, props.definition, props.units)}</dd></div>
                <div><dt>{t("analytics.maximum")}</dt><dd>{summary.maximum === null ? "—" : formatMeasurement(summary.maximum, props.definition, props.units)}</dd></div>
                <div><dt>{t("analytics.coverageLabel")}</dt><dd>{Math.round(summary.coverage * 100)}%</dd></div>
              </dl>
              <small>{t("analytics.sampleCount", { count: summary.count })}</small>
              {summary.basis && <small className="analytics-summary-basis">{summary.basis.statistics === "display-points"
                ? t("analytics.summaryBasis.display")
                : t("analytics.summaryBasis.base", { resolution: t(`analytics.resolution_${summary.basis.baseResolution}`) })}</small>}
              {summary.expectedIntervalSeconds ? <small className="analytics-summary-basis">{t("analytics.summaryBasis.expectedInterval", { seconds: summary.expectedIntervalSeconds })}</small> : null}
            </article>;
          })}</div>
);
}
