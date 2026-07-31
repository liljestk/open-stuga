import { useMemo, type CSSProperties } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bolt, Building2, CircleGauge, Euro, House as HouseIcon } from "lucide-react";
import type { HomeEnergySummary, UnitSystem } from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import { definitionFor, formatMeasurement } from "../measurements";
import { useI18n } from "../i18n";
import { homeEnergySummaryQueryOptions } from "../data/energy/homeEnergySummaryQuery";
import { queryClient } from "../data/queryClient";
import { ELECTRICITY_METRICS } from "./ElectricityHistory";
import {
  freshSourcesForMetric,
  sensorsForHomeTotal,
  sensorsForMetric,
  supportsMetric,
} from "./energyTelemetry";
import "./PropertyEnergyOverview.css";

const DAY_MS = 24 * 3_600_000;

interface PropertyEnergyOverviewProps {
  state: ClimateState;
  propertyId: string;
  propertyName: string;
  units: UnitSystem;
  now: number;
}

interface PropertyHomeEnergy {
  houseId: string;
  name: string;
  hasUsageSource: boolean;
  currentPower: number | null;
}

function formatCost(value: number): string {
  const decimals = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `${value.toFixed(decimals)} €`;
}

function sumPresent(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

export function PropertyEnergyOverview({ state, propertyId, propertyName, units, now }: PropertyEnergyOverviewProps) {
  const { t } = useI18n();
  const homes = useMemo(() => state.houses
    .filter((candidate) => candidate.propertyId === propertyId)
    .sort((left, right) => left.name.localeCompare(right.name)), [propertyId, state.houses]);
  const homeEnergy = useMemo<PropertyHomeEnergy[]>(() => homes.map((home) => {
    const homeSensors = state.sensors.filter((sensor) => sensor.houseId === home.id && sensor.enabled);
    const electricitySensors = homeSensors.filter((sensor) => ELECTRICITY_METRICS.some((metric) => (
      supportsMetric(state, sensor, metric)
    )));
    const usageSensors = electricitySensors.filter((sensor) => (
      supportsMetric(state, sensor, "power") || supportsMetric(state, sensor, "energy")
    ));
    const totalSensors = sensorsForHomeTotal(usageSensors);
    const powerSensors = sensorsForMetric(state, totalSensors, "power");
    const powerSources = freshSourcesForMetric(state, powerSensors, "power", now);
    return {
      houseId: home.id,
      name: home.name,
      hasUsageSource: usageSensors.length > 0,
      currentPower: powerSources.length
        ? powerSources.reduce((sum, source) => sum + (source.sample?.value ?? 0), 0)
        : null,
    };
  }), [homes, now, state]);
  const summaryQueries = useQueries({
    queries: homeEnergy.map((home) => homeEnergySummaryQueryOptions(
      home.houseId, "24h", DAY_MS, home.hasUsageSource, 60_000,
    )),
  }, queryClient);
  const rows = homeEnergy.map((home, index) => ({
    ...home,
    query: summaryQueries[index],
    summary: summaryQueries[index]?.data ?? null,
  }));
  const consumptionRows = rows.filter((row) => row.summary?.consumptionKwh !== null && row.summary?.consumptionKwh !== undefined);
  const costRows = rows.filter((row) => row.summary?.costEur !== null && row.summary?.costEur !== undefined);
  const powerRows = rows.filter((row) => row.currentPower !== null);
  const totalConsumption = sumPresent(rows.map((row) => row.summary?.consumptionKwh ?? null));
  const totalCost = sumPresent(rows.map((row) => row.summary?.costEur ?? null));
  const totalPower = sumPresent(rows.map((row) => row.currentPower));
  const formatPower = (value: number | null) => value === null
    ? "—"
    : formatMeasurement(value, definitionFor(state.measurementDefinitions, "power"), units);
  const formatEnergy = (value: number | null) => value === null
    ? "—"
    : formatMeasurement(value, definitionFor(state.measurementDefinitions, "energy"), units);
  const summaryCard = (
    kind: string,
    title: string,
    value: string,
    context: string,
    Icon: typeof Bolt,
  ) => <article className={`energy-summary-card ${kind}`}>
    <span className="energy-summary-icon" aria-hidden="true"><Icon size={20} /></span>
    <span><small>{title}</small><strong>{value}</strong></span>
    <small>{context}</small>
  </article>;

  return <section className="property-energy-overview" aria-labelledby="property-energy-overview-heading">
    <div className="property-energy-overview-heading">
      <div>
        <span className="eyebrow"><Building2 size={14} aria-hidden="true" /> {t("energy.propertyOverviewEyebrow")}</span>
        <h2 id="property-energy-overview-heading">{t("energy.propertyOverviewTitle")}</h2>
      </div>
      <p>{t("energy.propertyOverviewDescription", { property: propertyName })}</p>
    </div>

    {homes.length === 0 ? <section className="panel property-energy-empty" aria-labelledby="property-energy-empty-heading">
      <span className="energy-onboarding-icon" aria-hidden="true"><HouseIcon size={24} /></span>
      <div><h3 id="property-energy-empty-heading">{t("energy.propertyNoHomesTitle")}</h3><p>{t("energy.propertyNoHomesBody")}</p></div>
    </section> : <>
      <div className="energy-summary-grid property-energy-summary" aria-label={t("energy.propertySummary")}>
        {summaryCard("power", t("energy.currentPower"), formatPower(totalPower), t("energy.propertyPowerCoverage", { count: powerRows.length, total: rows.length }), CircleGauge)}
        {summaryCard("energy", t("energy.consumption24h"), formatEnergy(totalConsumption), t("energy.propertyConsumptionCoverage", { count: consumptionRows.length, total: rows.length }), Bolt)}
        {summaryCard("running_cost", t("energy.runningCost", { interval: t("energy.costInterval.24h") }), totalCost === null ? "—" : formatCost(totalCost), t("energy.propertyCostCoverage", { count: costRows.length, total: rows.length }), Euro)}
        {summaryCard("homes", t("energy.propertyHomesReporting"), `${consumptionRows.length} / ${rows.length}`, t("energy.propertyReportingContext"), HouseIcon)}
      </div>

      <section className="panel property-energy-homes" aria-labelledby="property-energy-homes-heading">
        <div className="panel-header">
          <div><span className="eyebrow">{homes.length}</span><h3 id="property-energy-homes-heading">{t("energy.propertyHomesTitle")}</h3></div>
          <p>{t("energy.propertyHomesDescription")}</p>
        </div>
        <div className="property-energy-home-list">{rows.map((row) => {
          const summary = row.summary as HomeEnergySummary | null;
          const consumption = summary?.consumptionKwh ?? null;
          const share = totalConsumption !== null && totalConsumption > 0 && consumption !== null
            ? Math.max(0, Math.min(100, consumption / totalConsumption * 100))
            : 0;
          const status = !row.hasUsageSource
            ? t("energy.propertyNoSource")
            : row.query?.isPending
              ? t("energy.propertyCalculating")
              : row.query?.isError
                ? t("energy.propertyUnavailable")
                : !summary || consumption === null
                  ? t("common.noData")
                  : summary.complete
                    ? t("energy.propertyComplete")
                    : t("energy.propertyPartial");
          return <article className="property-energy-home" key={row.houseId}>
            <div className="property-energy-home-heading">
              <span className="property-energy-home-icon" aria-hidden="true"><HouseIcon size={18} /></span>
              <div><h4>{row.name}</h4><span>{status}</span></div>
              <strong>{formatEnergy(consumption)}</strong>
            </div>
            <span className="property-energy-share" aria-hidden="true"><i style={{ "--property-energy-share": `${share}%` } as CSSProperties} /></span>
            <dl>
              <div><dt>{t("energy.currentPower")}</dt><dd>{formatPower(row.currentPower)}</dd></div>
              <div><dt>{t("energy.runningCost", { interval: t("energy.costInterval.24h") })}</dt><dd>{summary?.costEur === null || summary?.costEur === undefined ? "—" : formatCost(summary.costEur)}</dd></div>
            </dl>
          </article>;
        })}</div>
      </section>
    </>}
  </section>;
}
