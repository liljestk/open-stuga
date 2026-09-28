import { Activity, BarChart3, Calculator } from "lucide-react";
import type { HomeEnergySummary, Sensor } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { buildConsumerInsights, buildEnergyProjection } from "./energyAnalysis";
import "./EnergyPlanningPanel.css";

interface EnergyPlanningPanelProps {
  sensors: Sensor[];
  recentSummary: HomeEnergySummary | null;
  rollingSummary: HomeEnergySummary | null;
  currentPriceEurPerKwh: number | null;
}

export function EnergyPlanningPanel(props: Readonly<EnergyPlanningPanelProps>) {
  const { locale, t } = useI18n();
  const projection = buildEnergyProjection(props.recentSummary, props.rollingSummary, props.currentPriceEurPerKwh);
  const consumers = buildConsumerInsights(props.rollingSummary, props.sensors).slice(0, 5);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  const energyUnit = t("energy.unit.kwh");
  const observedPeriod = projection && projection.observedDays < 1
    ? t("energy.outlook.observedHours", { hours: Math.max(1, Math.round(projection.observedDays * 24)) })
    : t("energy.outlook.observedDays", { days: Math.max(1, Math.round(projection?.observedDays ?? 0)) });

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
        <div><dt>{t("energy.outlook.dailyPace")}</dt><dd>{t("energy.outlook.energyValue", { value: number.format(projection.dailyKwh) })}</dd><dd className="energy-outlook-detail"><small>{observedPeriod}</small></dd></div>
      </dl>
      <p className="energy-outlook-method"><Activity size={16} aria-hidden="true" />{t("energy.outlook.method")}</p>
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
