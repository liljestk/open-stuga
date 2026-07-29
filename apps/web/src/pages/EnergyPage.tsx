import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BellRing, Bolt, CircleGauge, Clock3, Euro, Lightbulb, RadioTower, TriangleAlert } from "lucide-react";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  type ElectricityContractType,
  type EnergyOptimizationReport,
  type House,
  type HomeElectricityPricePoint,
  type Metric,
  type PropertyElectricityConfig,
  type PropertyElectricityPricePoint,
  type Sensor,
  type UnitSystem,
} from "@climate-twin/contracts";
import { timeRangeHours, type ClimateState, type TimeRange } from "../domain";
import { definitionFor, formatMeasurement, measurementLabel } from "../measurements";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { api } from "../api";
import { useHomeEnergySummaryQuery } from "../data/energy/homeEnergySummaryQuery";
import { useNow } from "../useNow";
import type { SeriesLoadState } from "../useClimateData";
import { ElectricityHistory, ELECTRICITY_METRICS, type ElectricityMetric } from "./ElectricityHistory";
import {
  freshElectricitySample,
  freshSourcesForMetric,
  metricSources,
  sensorsForMetric,
  supportsMetric,
} from "./energyTelemetry";
import "./EnergyPage.css";

export { ELECTRICITY_METRICS, type ElectricityMetric } from "./ElectricityHistory";

const COST_INTERVALS = [
  { id: "1h", durationMs: 3_600_000, refreshMs: 60_000, labelKey: "energy.costInterval.1h" },
  { id: "24h", durationMs: 24 * 3_600_000, refreshMs: 60_000, labelKey: "energy.costInterval.24h" },
  { id: "7d", durationMs: 7 * 24 * 3_600_000, refreshMs: 5 * 60_000, labelKey: "energy.costInterval.7d" },
  { id: "month", durationMs: 30 * 24 * 3_600_000, refreshMs: 5 * 60_000, labelKey: "energy.costInterval.month" },
  { id: "year", durationMs: 365 * 24 * 3_600_000, refreshMs: 15 * 60_000, labelKey: "energy.costInterval.year" },
] as const;
type CostInterval = typeof COST_INTERVALS[number]["id"];

interface EnergyPageProps {
  state: ClimateState;
  /** Optional Home context for meter/consumption detail. */
  house?: House | null;
  /** Canonical Property owner of the contract and price source. */
  propertyId?: string;
  units: UnitSystem;
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported?: boolean) => void;
  onOpenSensors?: () => void;
  onOpenAlerts: () => void;
  seriesStates?: Record<string, SeriesLoadState>;
  readOnly?: boolean;
  /** Integration bindings remain with the authoritative Home, even when shared edits are enabled. */
  localAuthority?: boolean;
}

interface ElectricityPriceDraft {
  enabled: boolean;
  contractType: ElectricityContractType;
  margin: string;
  retailer: string;
  contractName: string;
  monthlyFee: string;
  endpointUrl: string;
}

function emptyPriceDraft(): ElectricityPriceDraft {
  return {
    enabled: true,
    contractType: "spot",
    margin: "0",
    retailer: "",
    contractName: "",
    monthlyFee: "",
    endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  };
}

function formatCost(value: number): string {
  const decimals = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `${value.toFixed(decimals)} €`;
}

export function EnergyPage({ state, house = null, propertyId: requestedPropertyId, units, onLoadSeries, onOpenSensors, onOpenAlerts, seriesStates, readOnly = false, localAuthority = true }: EnergyPageProps) {
  const { locale, t } = useI18n();
  const propertyId = requestedPropertyId ?? house?.propertyId ?? state.properties[0]?.id ?? "";
  const property = state.properties.find((candidate) => candidate.id === propertyId);
  const canConfigureSources = !readOnly && localAuthority;
  const [metric, setMetric] = useState<ElectricityMetric>("power");
  const [range, setRange] = useState<TimeRange>("24h");
  const [costInterval, setCostInterval] = useState<CostInterval>("month");
  const [propertyPrice, setPropertyPrice] = useState<{ config: PropertyElectricityConfig; current: PropertyElectricityPricePoint | null } | null>(null);
  const [homePrice, setHomePrice] = useState<HomeElectricityPricePoint | null>(null);
  const [priceHistory, setPriceHistory] = useState<HomeElectricityPricePoint[]>([]);
  const [priceHistoryBusy, setPriceHistoryBusy] = useState(false);
  const [priceHistoryError, setPriceHistoryError] = useState(false);
  const [priceDraft, setPriceDraft] = useState<ElectricityPriceDraft>(emptyPriceDraft);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceFeedback, setPriceFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [optimization, setOptimization] = useState<EnergyOptimizationReport | null>(null);
  const [optimizationError, setOptimizationError] = useState(false);
  const priceContextGeneration = useRef(0);
  const now = useNow();
  const selectedCostInterval = COST_INTERVALS.find((candidate) => candidate.id === costInterval) ?? COST_INTERVALS[3];
  const houseSensors = useMemo(
    () => house ? state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled) : [],
    [house?.id, state.sensors],
  );
  const sources = useMemo(() => metricSources(state, houseSensors, now), [houseSensors, now, state]);
  const electricitySensors = useMemo(() => houseSensors.filter((sensor) => ELECTRICITY_METRICS.some((candidate) => (
    supportsMetric(state, sensor, candidate)
  ))), [houseSensors, state.latestMeasurements, state.measurementHistory]);
  const powerSensors = useMemo(
    () => sensorsForMetric(state, electricitySensors, "power"),
    [electricitySensors, state.latestMeasurements, state.measurementHistory],
  );
  const energySensors = useMemo(
    () => sensorsForMetric(state, electricitySensors, "energy"),
    [electricitySensors, state.latestMeasurements, state.measurementHistory],
  );
  const summariesEnabled = Boolean(house && electricitySensors.length);
  const dailySummaryQuery = useHomeEnergySummaryQuery(
    house?.id ?? "", "24h", 24 * 3_600_000, summariesEnabled, 60_000,
  );
  const energyCostQuery = useHomeEnergySummaryQuery(
    house?.id ?? "", costInterval, selectedCostInterval.durationMs, summariesEnabled, selectedCostInterval.refreshMs,
  );
  const dailySummary = dailySummaryQuery.data ?? null;
  const energyCost = energyCostQuery.data ?? null;
  const energyCostBusy = energyCostQuery.isPending && summariesEnabled;
  const energyCostError = energyCostQuery.isError;

  useEffect(() => {
    const generation = ++priceContextGeneration.current;
    setPropertyPrice(null);
    setHomePrice(null);
    setPriceHistory([]);
    setPriceHistoryBusy(false);
    setPriceHistoryError(false);
    setPriceDraft(emptyPriceDraft());
    setPriceBusy(false);
    setPriceFeedback(null);
    if (house) {
      void api.houseElectricityPrice(house.id).then((result) => {
        if (priceContextGeneration.current === generation) setHomePrice(result.current);
      }).catch(() => {
        if (priceContextGeneration.current === generation) {
          setPriceFeedback({ kind: "error", text: t("energy.priceLoadError") });
        }
      });
      return;
    }
    if (!propertyId) return;
    void api.propertyElectricity(propertyId).then((result) => {
      if (priceContextGeneration.current !== generation) return;
      setPropertyPrice({ config: result.config, current: result.current });
      setPriceDraft({
        enabled: result.config.enabled,
        contractType: result.config.contractType,
        margin: String(result.config.marginCentsPerKwh),
        retailer: result.config.retailer ?? "",
        contractName: result.config.contractName ?? "",
        monthlyFee: result.config.monthlyFeeEur === null ? "" : String(result.config.monthlyFeeEur),
        endpointUrl: result.config.endpointUrl,
      });
    }).catch(() => {
      if (priceContextGeneration.current === generation) {
        setPriceFeedback({ kind: "error", text: t("energy.priceLoadError") });
      }
    });
  }, [house?.id, propertyId]);

  useEffect(() => {
    setPriceHistory([]);
    setPriceHistoryError(false);
    if (!house || metric !== "electricity_price") {
      setPriceHistoryBusy(false);
      return;
    }
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - timeRangeHours(range) * 3_600_000);
    setPriceHistoryBusy(true);
    void api.houseElectricityPrice(
      house.id,
      from.toISOString(),
      to.toISOString(),
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) {
        setPriceHistory(result.prices ?? (result.current ? [result.current] : []));
      }
    }).catch(() => {
      if (!controller.signal.aborted) setPriceHistoryError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setPriceHistoryBusy(false);
    });
    return () => controller.abort();
  }, [house?.id, metric, range]);

  useEffect(() => {
    let active = true;
    setOptimization(null);
    setOptimizationError(false);
    if (!propertyId) return () => { active = false; };
    void api.energyOptimization(propertyId, 2).then((report) => {
      if (active) setOptimization(report);
    }).catch(() => {
      if (active) setOptimizationError(true);
    });
    return () => { active = false; };
  }, [propertyId]);

  const used24Hours = dailySummary?.consumptionKwh ?? null;
  const powerSources = freshSourcesForMetric(state, powerSensors, "power", now);
  const energySources = freshSourcesForMetric(state, energySensors, "energy", now);
  const combinedPower = powerSources.length
    ? powerSources.reduce((sum, source) => sum + (source.sample?.value ?? 0), 0)
    : null;
  const combinedEnergyReading = energySources.length
    ? energySources.reduce((sum, source) => sum + (source.sample?.value ?? 0), 0)
    : null;
  const telemetryPriceSample = freshElectricitySample(sources.electricity_price?.sample, "electricity_price", now);
  const effectivePrice = house
    ? homePrice?.effectivePriceEurPerKwh ?? telemetryPriceSample?.value ?? null
    : propertyPrice?.current?.effectivePriceEurPerKwh ?? telemetryPriceSample?.value ?? null;
  const anyData = combinedPower !== null || used24Hours !== null || combinedEnergyReading !== null || effectivePrice !== null;
  const combinedSourceLabel = (sensors: Sensor[], reporting: number) => !sensors.length
    ? t("energy.waitingForSource")
    : sensors.length === 1
      ? sensors[0]!.name
      : t("energy.combinedSources", { count: reporting, total: sensors.length });
  const powerSourceLabel = combinedSourceLabel(powerSensors, powerSources.length);
  const energySourceLabel = combinedSourceLabel(
    used24Hours === null ? energySensors : electricitySensors,
    used24Hours === null ? energySources.length : dailySummary?.sourceCount ?? 0,
  );
  const priceSourceLabel = homePrice?.effectivePriceEurPerKwh !== undefined && homePrice?.effectivePriceEurPerKwh !== null
    ? t("energy.propertyPriceForHome")
    : sources.electricity_price?.sensor.name ?? t("energy.waitingForSource");
  const energyCostBasis = energyCostBusy
    ? t("energy.costLoading")
    : energyCostError || !energyCost || energyCost.totalSources === 0
      ? t("energy.costUnavailable")
      : energyCost.totalSources <= 1
        ? energyCost.complete
          ? t("energy.costBasis")
          : t("energy.costPartial", { coverage: energyCost.priceCoveragePercent.toFixed(0) })
        : energyCost.complete
          ? t("energy.costCombinedBasis", { count: energyCost.sourceCount })
          : t("energy.costCombinedPartial", {
            count: energyCost.sourceCount,
            total: energyCost.totalSources,
            coverage: energyCost.priceCoveragePercent.toFixed(0),
          });

  const savePriceConfiguration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const margin = Number(priceDraft.margin);
    const monthlyFee = priceDraft.monthlyFee.trim() ? Number(priceDraft.monthlyFee) : null;
    if (!Number.isFinite(margin) || (monthlyFee !== null && !Number.isFinite(monthlyFee))) {
      setPriceFeedback({ kind: "error", text: t("energy.priceInvalidNumbers") });
      return;
    }
    const generation = priceContextGeneration.current;
    const targetPropertyId = propertyId;
    setPriceBusy(true);
    setPriceFeedback(null);
    try {
      if (!targetPropertyId) return;
      const saved = await api.configurePropertyElectricity(targetPropertyId, {
        provider: priceDraft.endpointUrl === DEFAULT_ELECTRICITY_PRICE_ENDPOINT ? "porssisahko" : "custom",
        endpointUrl: priceDraft.endpointUrl,
        enabled: priceDraft.enabled,
        marginCentsPerKwh: margin,
        contractType: priceDraft.contractType,
        contractName: priceDraft.contractName.trim() || null,
        retailer: priceDraft.retailer.trim() || null,
        monthlyFeeEur: monthlyFee,
      });
      const result = priceDraft.enabled
        ? await api.refreshPropertyElectricity(targetPropertyId)
        : { config: saved.config, current: null };
      if (priceContextGeneration.current !== generation) return;
      setPropertyPrice({ config: result.config, current: result.current });
      setPriceFeedback({ kind: "success", text: t("energy.priceUpdated") });
    } catch {
      if (priceContextGeneration.current === generation) {
        setPriceFeedback({ kind: "error", text: t("energy.priceSaveError") });
      }
    } finally {
      if (priceContextGeneration.current === generation) setPriceBusy(false);
    }
  };

  const card = (
    kind: ElectricityMetric | "running_cost",
    title: string,
    value: string,
    sourceLabel: string,
    Icon: typeof Bolt,
  ) => (
    <article className={`energy-summary-card ${kind}`}>
      <span className="energy-summary-icon" aria-hidden="true"><Icon size={20} /></span>
      <span><small>{title}</small><strong>{value}</strong></span>
      <small>{sourceLabel}</small>
    </article>
  );

  return (
    <>
      <header className="page-heading energy-heading">
        <div><span className="eyebrow"><Bolt size={14} aria-hidden="true" />{house ? t("energy.homeScope", { home: house.name }) : t("energy.propertyScope", { property: property?.name ?? propertyId })}</span><h1>{t("energy.title")}</h1><p>{t("energy.description")}</p></div>
        <div className="page-heading-actions"><button type="button" className="secondary-button" onClick={onOpenAlerts}><BellRing size={16} aria-hidden="true" />{t("energy.manageAlerts")}</button></div>
      </header>

      {!house && <section className="panel energy-price-config" aria-labelledby="energy-price-config-heading">
        <div className="panel-header"><div><span className="eyebrow">{t("energy.priceSource")}</span><h2 id="energy-price-config-heading">{t("energy.contractTitle")}</h2></div></div>
        <p>{t("energy.contractDescription")}</p>
        {propertyPrice?.current && <p><strong>{t("energy.priceSummary", {
          effective: propertyPrice.current.effectivePriceCentsPerKwh.toFixed(3),
          raw: propertyPrice.current.rawPriceCentsPerKwh.toFixed(3),
          provider: propertyPrice.config.provider,
        })}</strong></p>}
        {!readOnly && <form onSubmit={savePriceConfiguration} className="energy-source-controls">
          <label className="field"><span>{t("energy.contractType")}</span><select value={priceDraft.contractType} onChange={(event) => setPriceDraft((current) => ({ ...current, contractType: event.target.value as ElectricityContractType }))}><option value="spot">{t("energy.contractType.spot")}</option><option value="fixed">{t("energy.contractType.fixed")}</option><option value="other">{t("energy.contractType.other")}</option></select></label>
          <label className="field"><span>{t("energy.priceApi")}</span><input type="url" required value={priceDraft.endpointUrl} onChange={(event) => setPriceDraft((current) => ({ ...current, endpointUrl: event.target.value }))} /></label>
          <label className="field"><span>{t("energy.margin")}</span><input type="number" step="0.001" value={priceDraft.margin} onChange={(event) => setPriceDraft((current) => ({ ...current, margin: event.target.value }))} /></label>
          <label className="field"><span>{t("energy.retailer")}</span><input value={priceDraft.retailer} onChange={(event) => setPriceDraft((current) => ({ ...current, retailer: event.target.value }))} /></label>
          <label className="field"><span>{t("energy.contractName")}</span><input value={priceDraft.contractName} onChange={(event) => setPriceDraft((current) => ({ ...current, contractName: event.target.value }))} /></label>
          <label className="field"><span>{t("energy.monthlyFee")}</span><input type="number" min="0" step="0.01" value={priceDraft.monthlyFee} onChange={(event) => setPriceDraft((current) => ({ ...current, monthlyFee: event.target.value }))} /></label>
          <label className="field checkbox-field"><input type="checkbox" checked={priceDraft.enabled} onChange={(event) => setPriceDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span>{t("energy.priceEnabled")}</span></label>
          <button type="submit" className="primary-button" disabled={priceBusy}>{priceBusy ? t("energy.updatingPrice") : t("energy.saveAndRefresh")}</button>
        </form>}
        {priceFeedback && <p role={priceFeedback.kind === "error" ? "alert" : "status"}>{priceFeedback.text}</p>}
      </section>}

      {house && !electricitySensors.length && <section className="panel energy-onboarding" aria-labelledby="energy-onboarding-heading">
        <span className="energy-onboarding-icon" aria-hidden="true"><RadioTower size={26} /></span>
        <div><span className="eyebrow">{t(canConfigureSources ? "energy.sourceOptions" : "energy.ownerManagedSource")}</span><h2 id="energy-onboarding-heading">{t(canConfigureSources ? "energy.connectTitle" : "energy.noSharedDataTitle")}</h2><p>{t(canConfigureSources ? "energy.connectBody" : "energy.noSharedDataBody")}</p></div>
        {canConfigureSources && onOpenSensors && <button type="button" className="primary-button" onClick={onOpenSensors}>{t("energy.openSensors")}</button>}
      </section>}

      <section className="panel energy-optimizer" aria-labelledby="energy-optimizer-heading">
        <div className="panel-header"><div><span className="eyebrow"><Lightbulb size={14} aria-hidden="true" /> {t("energy.optimizer.eyebrow")}</span><h2 id="energy-optimizer-heading">{t("energy.optimizer.title")}</h2></div><span className="status-badge">{t("energy.optimizer.readOnly")}</span></div>
        <p>{t("energy.optimizer.description")}</p>
        {optimizationError && <p className="energy-waiting" role="status"><TriangleAlert size={17} aria-hidden="true" /> {t("energy.optimizer.unavailable")}</p>}
        {optimization && <>
          <div className="energy-optimizer-windows">{optimization.suggestedWindows.slice(0, 3).map((window) => <article key={window.startAt} className={window.rank}><Clock3 size={18} aria-hidden="true" /><span><strong>{formatOptimizationWindow(window.startAt, window.endAt, locale, house?.timezone)}</strong><small>{t("energy.optimizer.priceComparison", { price: window.averagePriceCentsPerKwh.toFixed(2), percent: Math.abs(window.relativeToAveragePercent).toFixed(0), comparison: window.relativeToAveragePercent <= 0 ? t("energy.optimizer.below") : t("energy.optimizer.above") })}</small></span></article>)}</div>
          <dl className="energy-optimizer-baseline"><div><dt>{t("energy.optimizer.consumption24h")}</dt><dd>{optimization.recentDailyConsumptionKwh === null ? t("energy.optimizer.notEnoughData") : `${optimization.recentDailyConsumptionKwh.toFixed(2)} kWh`}</dd></div><div><dt>{t("energy.optimizer.baseload")}</dt><dd>{optimization.baselinePowerWatts === null ? t("energy.optimizer.notEnoughData") : `${optimization.baselinePowerWatts.toFixed(0)} W`}</dd></div><div><dt>{t("energy.optimizer.peak")}</dt><dd>{optimization.peakPowerWatts === null ? t("energy.optimizer.notEnoughData") : `${optimization.peakPowerWatts.toFixed(0)} W`}</dd></div></dl>
          {optimization.insights.length > 0 && <ul className="energy-optimizer-insights">{optimization.insights.map((insight) => <li key={insight.id} className={insight.severity}><strong>{insight.title}</strong><span>{insight.explanation}</span>{insight.estimatedSavingsEur !== null && <small>{t("energy.optimizer.estimatedOpportunity", { amount: new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(insight.estimatedSavingsEur) })}</small>}</li>)}</ul>}
          {optimization.limitations.length > 0 && <details><summary>{t("energy.optimizer.limitations")}</summary><ul>{optimization.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details>}
        </>}
      </section>

      {house && (electricitySensors.length > 0 || effectivePrice !== null || priceHistory.length > 0 || priceHistoryBusy) && <>
      <section className="energy-summary-grid" aria-label={t("energy.summary") }>
        {card("power", t("energy.currentPower"), combinedPower !== null ? formatMeasurement(combinedPower, definitionFor(state.measurementDefinitions, "power"), units) : "—", powerSourceLabel, CircleGauge)}
        {card("energy", used24Hours === null ? t("energy.consumptionReading") : t("energy.consumption24h"), used24Hours !== null
          ? formatMeasurement(used24Hours, definitionFor(state.measurementDefinitions, "energy"), units)
          : combinedEnergyReading !== null ? formatMeasurement(combinedEnergyReading, definitionFor(state.measurementDefinitions, "energy"), units) : "—", energySourceLabel, Bolt)}
        {card("electricity_price", t("energy.spotPrice"), effectivePrice !== null ? formatMeasurement(effectivePrice, definitionFor(state.measurementDefinitions, "electricity_price"), units) : "—", priceSourceLabel, Euro)}
        <article className="energy-summary-card running_cost">
          <span className="energy-summary-icon" aria-hidden="true"><Euro size={20} /></span>
          <span><small>{t("energy.runningCost", { interval: t(selectedCostInterval.labelKey) })}</small><strong>{energyCost?.costEur === null || energyCost?.costEur === undefined ? "—" : formatCost(energyCost.costEur)}</strong></span>
          <label className="energy-cost-interval">
            <span>{t("energy.costInterval")}</span>
            <select value={costInterval} onChange={(event) => setCostInterval(event.target.value as CostInterval)}>
              {COST_INTERVALS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.labelKey)}</option>)}
            </select>
          </label>
          <small className="energy-cost-basis">{energyCostBasis}</small>
        </article>
      </section>

      {!anyData && electricitySensors.length > 0 && <p className="energy-waiting" role="status"><TriangleAlert size={17} aria-hidden="true" />{t("energy.waitingForReadings")}</p>}

      <ElectricityHistory
        state={state}
        sensors={electricitySensors}
        metric={metric}
        onMetric={setMetric}
        units={units}
        range={range}
        onRange={setRange}
        timeZone={house.timezone}
        electricityPrices={priceHistory}
        priceLoading={priceHistoryBusy}
        priceError={priceHistoryError}
        {...(onLoadSeries ? { onLoadSeries } : {})}
        {...(seriesStates ? { seriesStates } : {})}
      />

      <section className="panel energy-source-list" aria-labelledby="energy-sources-heading">
        <div className="panel-header"><div><span className="eyebrow">{electricitySensors.length}</span><h2 id="energy-sources-heading">{t("energy.sourcesTitle")}</h2></div>{canConfigureSources && onOpenSensors && <button type="button" className="secondary-button" onClick={onOpenSensors}>{t("energy.editSources")}</button>}</div>
        <div className="energy-table-scroll" role="region" aria-labelledby="energy-sources-heading" tabIndex={0}><table><thead><tr><th scope="col">{t("sensors.name")}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "power"), locale)}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "energy"), locale)}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "electricity_price"), locale)}</th><th scope="col">{t("energy.updated")}</th></tr></thead><tbody>{electricitySensors.map((sensor) => {
          const latest = state.latestMeasurements[sensor.id] ?? {};
          const newest = ELECTRICITY_METRICS.flatMap((candidate) => latest[candidate] ? [latest[candidate]!] : []).sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
          return <tr key={sensor.id}><th scope="row">{sensor.name}<small>{sensor.room}</small></th>{ELECTRICITY_METRICS.map((candidate) => <td key={candidate}>{latest[candidate] ? formatMeasurement(latest[candidate]!.value, definitionFor(state.measurementDefinitions, candidate), units) : "—"}</td>)}<td>{newest ? formatInTimeZone(newest.timestamp, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }) : t("common.noData")}</td></tr>;
        })}</tbody></table></div>
      </section>
      </>}
    </>
  );
}

function formatOptimizationWindow(startAt: string, endAt: string, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit" };
  return `${formatInTimeZone(startAt, locale, timeZone, options)}–${formatInTimeZone(endAt, locale, timeZone, options)}`;
}
