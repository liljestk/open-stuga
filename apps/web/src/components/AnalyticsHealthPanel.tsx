import { useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { AnalyticsDiagnostics, House, MeasurementDefinition } from "@climate-twin/contracts";
import { api } from "../api";
import { queryClient } from "../data/queryClient";
import { queryKeys } from "../data/queryKeys";
import { useCancelInactiveQuery } from "../data/useCancelInactiveQuery";
import { useI18n } from "../i18n";
import { measurementLabel } from "../measurements";

interface AnalyticsHealthPanelProps {
  house: House;
  definitions: readonly MeasurementDefinition[];
}

function verdict(value: boolean | null): "met" | "missed" | "pending" {
  return value === null ? "pending" : value ? "met" : "missed";
}

/** Appliance-collected evidence of how the analytics performed; loaded only while open. */
export function AnalyticsHealthPanel(props: Readonly<AnalyticsHealthPanelProps>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const queryKey = queryKeys.analyticsDiagnostics(props.house.id);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.analyticsDiagnostics(props.house.id, signal),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  }, queryClient);
  useCancelInactiveQuery(queryKey, open);
  const diagnostics: AnalyticsDiagnostics | undefined = query.data;
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const badge = (value: boolean | null) => <span className={`status-badge analytics-health-${verdict(value)}`}>{t(`analytics.health.${verdict(value)}`)}</span>;
  const metricName = (metric: string) => {
    const definition = props.definitions.find((item) => item.id === metric);
    return definition ? measurementLabel(definition, locale) : metric;
  };

  return <details className="panel analytics-health" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><ShieldCheck size={17} aria-hidden="true" />{t("analytics.health.title")}</span>
      <ChevronDown size={17} aria-hidden="true" />
    </summary>
    {open && <div className="analytics-health-body">
      {query.isLoading && <output aria-live="polite">{t("analytics.health.loading")}</output>}
      {query.error && <p className="inline-error" role="alert">{t("analytics.health.failed")}</p>}
      {diagnostics && <>
        <p>{t("analytics.health.description", { days: diagnostics.windowDays })}</p>
        <h3>{t("analytics.health.latencyTitle")}</h3>
        <ul>{diagnostics.latency.map((item) => <li key={item.operation}>
          <strong>{t(`analytics.health.operation_${item.operation}`)}</strong>
          <span>{item.p95Ms === null
            ? t("analytics.health.latencyNone")
            : t("analytics.health.latencyRow", { requests: number(item.requests), p95: number(item.p95Ms), target: number(item.targetP95Ms) })}</span>
          {badge(item.meetsTarget)}
        </li>)}</ul>

        <h3>{t("analytics.health.forecastTitle")}</h3>
        {diagnostics.forecasts.length === 0 ? <p>{t("analytics.health.forecastNone")}</p> : <ul>{diagnostics.forecasts.map((item) => <li key={item.metric}>
          <strong>{metricName(item.metric)}</strong>
          <span>{t("analytics.health.forecastRow", {
            skill6h: item.medianSkill6h === null ? "—" : number(item.medianSkill6h, 2),
            skill24h: item.medianSkill24h === null ? "—" : number(item.medianSkill24h, 2),
            coverage: item.medianCoverage90 === null ? "—" : number(item.medianCoverage90 * 100),
            evaluations: number(item.evaluations),
          })}</span>
          {badge(item.meetsTarget)}
        </li>)}</ul>}

        <h3>{t("analytics.health.billsTitle")}</h3>
        <p>{diagnostics.bills.invoices === 0
          ? t("analytics.health.billsNone")
          : t("analytics.health.billsRow", {
              reconciled: number(diagnostics.bills.reconciled),
              invoices: number(diagnostics.bills.invoices),
              tolerance: number(diagnostics.bills.tolerancePercent, 1),
              error: diagnostics.bills.medianAbsoluteErrorPercent === null ? "—" : number(diagnostics.bills.medianAbsoluteErrorPercent, 1),
            })} {badge(diagnostics.bills.meetsTarget)}</p>

        <h3>{t("analytics.health.projectionTitle")}</h3>
        <p>{!diagnostics.projection || diagnostics.projection.meanAbsolutePercentError === null
          ? t("analytics.health.projectionNone")
          : t("analytics.health.projectionRow", {
              error: number(diagnostics.projection.meanAbsolutePercentError, 1),
              origins: number(diagnostics.projection.origins),
              baseline: diagnostics.projection.baselineMeanAbsolutePercentError === null
                ? "—" : number(diagnostics.projection.baselineMeanAbsolutePercentError, 1),
            })} {badge(diagnostics.projection?.meetsTarget ?? null)}</p>

        <h3>{t("analytics.health.findingsTitle")}</h3>
        <p>{!diagnostics.findings
          ? t("analytics.health.findingsNone")
          : t("analytics.health.findingsRow", {
              findings: number(diagnostics.findings.findings),
              series: diagnostics.findings.seriesTested === null ? "—" : number(diagnostics.findings.seriesTested),
              date: diagnostics.findings.evaluatedThrough,
              rate: diagnostics.findings.falseDiscoveryRate === null ? "—" : number(diagnostics.findings.falseDiscoveryRate * 100),
            })}</p>
      </>}
    </div>}
  </details>;
}
