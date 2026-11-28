import type { AnalyticsSeries, MeasurementDefinition, UnitSystem } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import { displayUnit, formatMeasurement, toDisplayValue } from "../../measurements";

export function AnalyticsDistributions(props: { series: readonly AnalyticsSeries[]; definition: MeasurementDefinition; units: UnitSystem }) {
  const { t, locale } = useI18n();
  const boundary = (value: number | null) => value === null ? "—" : `${new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format(toDisplayValue(value, props.definition, props.units))} ${displayUnit(props.definition, props.units)}`;
  const format = (value: number | null) => value === null ? "—" : formatMeasurement(value, props.definition, props.units);
  const count = new Intl.NumberFormat(locale);
  return <section className="analytics-distributions" aria-label={t("analyticsViews.distributions")}>
    <h3>{t("analyticsViews.distributions")}</h3>
    {props.series.map((series) => {
      const distribution = series.distribution;
      if (!distribution) return <p key={series.entityId}>{t("analyticsViews.unavailable", { name: series.entityLabel })}</p>;
      const maxCount = distribution.bins.reduce((maximum, bin) => Math.max(maximum, bin.count), 1);
      return <article key={series.entityId}>
        <h4>{series.entityLabel}</h4>
        <p>{t(distribution.basis === "raw-observations" ? "analyticsViews.rawBasis" : "analyticsViews.bucketBasis")}</p>
        <p>{t("analyticsViews.counts", { count: distribution.count, excluded: distribution.excludedCount })}</p>
        {distribution.count === 0 ? <p>{t("analyticsViews.empty")}</p> : <>
          <p>{t("analyticsViews.quartiles", { lower: format(distribution.p25), median: format(distribution.median), upper: format(distribution.p75) })}</p>
          <svg className="analytics-distribution-chart" viewBox="0 0 600 140" role="img" aria-label={t("analyticsViews.histogram", { name: series.entityLabel })}>
            <title>{t("analyticsViews.histogram", { name: series.entityLabel })}</title>
            <desc>{t("analyticsViews.tableHint")}</desc>
            {distribution.bins.map((bin, index) => <rect key={index} x={index * 600 / distribution.bins.length + 1} y={130 - bin.count / maxCount * 120}
              width={Math.max(1, 600 / distribution.bins.length - 2)} height={bin.count / maxCount * 120} />)}
          </svg>
          <div className="analytics-view-axis" aria-hidden="true"><span>{format(distribution.minimum)}</span><span>{format(distribution.maximum)}</span></div>
          <details><summary>{t("analyticsViews.table")}</summary>
            <p>{t("analyticsViews.binHint")}</p>
            <div className="analytics-data-table-wrap" role="region" tabIndex={0} aria-label={t("analyticsViews.table")}><table className="analytics-data-table"><caption>{t("analyticsViews.histogram", { name: series.entityLabel })}</caption>
              <thead><tr><th scope="col">{t("analyticsViews.lower")}</th><th scope="col">{t("analyticsViews.upper")}</th><th scope="col">{t("analyticsViews.frequency")}</th></tr></thead>
              <tbody>{distribution.bins.map((bin, index) => <tr key={index}><td>{boundary(bin.lower)}</td><td>{boundary(bin.upper)}</td><td>{count.format(bin.count)}</td></tr>)}</tbody>
            </table></div>
          </details>
        </>}
      </article>;
    })}
  </section>;
}
