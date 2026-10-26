import { Activity, BarChart3, Calculator } from "lucide-react";
import type { HomeEnergyProjection, HomeEnergySummary, Sensor } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { buildConsumerInsights } from "./energyAnalysis";
import "./EnergyPlanningPanel.css";

interface EnergyPlanningPanelProps {
  sensors: Sensor[];
  projection: HomeEnergyProjection | null;
  rollingSummary: HomeEnergySummary | null;
}

export function EnergyPlanningPanel(props: Readonly<EnergyPlanningPanelProps>) {
  const { locale, t } = useI18n();
  const projection = props.projection;
  const consumers = buildConsumerInsights(props.rollingSummary, props.sensors).slice(0, 5);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  const energyUnit = t("energy.unit.kwh");
  const backtest = projection?.backtest;
  const method = !projection || !backtest || backtest.origins === 0 || backtest.meanAbsolutePercentError === null
    ? t("energy.outlook.methodUntested")
    : projection.method === "weather-regression"
      ? t("energy.outlook.methodRegression", {
          origins: backtest.origins,
          error: percent.format(backtest.meanAbsolutePercentError),
          baseline: percent.format(backtest.baselineMeanAbsolutePercentError ?? backtest.meanAbsolutePercentError),
        })
      : t("energy.outlook.methodRecent", {
          origins: backtest.origins,
          error: percent.format(backtest.meanAbsolutePercentError),
        });

  if (!projection && !consumers.length) return null;
  return <section className="panel energy-planning" aria-labelledby="energy-planning-heading">
    <div className="panel-header">
      <div><span className="eyebrow"><Calculator size={14} aria-hidden="true" />{t("energy.outlook.eyebrow")}</span><h2 id="energy-planning-heading">{t("energy.outlook.title")}</h2></div>
      {projection && <span className={`status-badge energy-confidence ${projection.confidence}`}>{t(`energy.outlook.confidence.${projection.confidence}`)}</span>}
    </div>
    {projection && <>
      <dl className="energy-outlook-values">
        <div><dt>{t("energy.outlook.next30Days")}</dt><dd>{t("energy.outlook.energyValue", { value: number.format(projection.next30DaysKwh) })}</dd><dd className="energy-outlook-detail"><small>{t("energy.outlook.range", { low: number.format(projection.lowKwh), high: number.format(projection.highKwh), unit: energyUnit })}</small></dd></div>
        <div><dt>{t("energy.outlook.estimatedCost")}</dt><dd>{projection.estimatedCostEur === null ? "—" : currency.format(projection.estimatedCostEur)}</dd><dd className="energy-outlook-detail"><small>{projection.lowCostEur === null || projection.highCostEur === null
          ? t("energy.outlook.priceMissing")
          : t("energy.outlook.range", { low: currency.format(projection.lowCostEur), high: currency.format(projection.highCostEur), unit: "" })}</small></dd></div>
        <div><dt>{t("energy.outlook.dailyPace")}</dt><dd>{t("energy.outlook.energyValue", { value: number.format(projection.dailyKwh) })}</dd><dd className="energy-outlook-detail"><small>{t("energy.outlook.observedDays", { days: projection.observedDays })}</small></dd></div>
      </dl>
      <p className="energy-outlook-method"><Activity size={16} aria-hidden="true" />{method}</p>
    </>}

    {consumers.length > 0 && <div className="energy-consumers">
      <div className="energy-consumers-heading"><span><BarChart3 size={17} aria-hidden="true" /><strong>{t("energy.consumer.title")}</strong></span><small>{t("energy.consumer.period")}</small></div>
      <ol>{consumers.map((consumer) => <li key={consumer.sensor.id}>
        <div className="energy-consumer-name"><strong>{consumer.sensor.name}</strong><span>{t("energy.consumer.usage", { usage: number.format(consumer.consumptionKwh), share: number.format(consumer.sharePercent) })}</span></div>
        <span className="energy-consumer-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, consumer.sharePercent)}%` }} /></span>
      </li>)}</ol>
      <p className="energy-consumer-note">{t("energy.consumer.scopeNote")}</p>
    </div>}
  </section>;
}
