import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BellRing, Bolt, ChevronDown, CircleGauge, Clock3, Euro, Lightbulb, RadioTower, TriangleAlert } from "lucide-react";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  type DataMode,
  type ElectricityCostBreakdown,
  type House,
  type Metric,
  type Sensor,
  type UnitSystem,
} from "@climate-twin/contracts";
import { ANALYTICS_TIME_RANGES, type ClimateState, type TimeRange } from "../domain";
import { definitionFor, formatMeasurement, measurementLabel } from "../measurements";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { api, ApiRequestError } from "../api";
import { useHomeEnergySummaryQuery } from "../data/energy/homeEnergySummaryQuery";
import { historyIsPreparing } from "../data/energy/historyPreparation";
import { useHouseElectricityPriceQuery } from "../data/energy/houseElectricityPriceQuery";
import { currentElectricityPrice, propertyElectricityKey, useEnergyOptimizationQuery, usePriceHistoryQuery, usePropertyElectricityQuery } from "../data/energy/electricityQueries";
import { queryClient } from "../data/queryClient";
import { useNow } from "../useNow";
import type { SeriesLoadState } from "../useClimateData";
import { ElectricityHistory } from "./ElectricityHistory";
import { ELECTRICITY_METRICS, type ElectricityMetric } from "./energyTelemetry";
import { EnergyPlanningPanel } from "./EnergyPlanningPanel";
import { useHomeEnergyProjectionQuery } from "../data/energy/homeEnergyProjectionQuery";
import { ElectricityBillCheckPanel } from "./ElectricityBillCheckPanel";
import { ElectricityTariffPanel } from "./ElectricityTariffPanel";
import { energySummaryState } from "./energySummaryState";
import { PropertyEnergyOverview } from "./PropertyEnergyOverview";
import {
  freshElectricitySample,
  freshSourcesForMetric,
  metricSources,
  sensorsForHomeTotal,
  sensorsForMetric,
  supportsMetric,
} from "./energyTelemetry";
import "./EnergyPage.css";
import { CardHeader } from "../components/CardHeader";


const COST_INTERVALS = [
  { id: "1h", durationMs: 3_600_000, refreshMs: 60_000, labelKey: "energy.costInterval.1h" },
  { id: "24h", durationMs: 24 * 3_600_000, refreshMs: 60_000, labelKey: "energy.costInterval.24h" },
  { id: "7d", durationMs: 7 * 24 * 3_600_000, refreshMs: 5 * 60_000, labelKey: "energy.costInterval.7d" },
  { id: "month", durationMs: 30 * 24 * 3_600_000, refreshMs: 5 * 60_000, labelKey: "energy.costInterval.month" },
  { id: "year", durationMs: 365 * 24 * 3_600_000, refreshMs: 15 * 60_000, labelKey: "energy.costInterval.year" },
] as const;
type CostInterval = typeof COST_INTERVALS[number]["id"];
interface EnergyLocationState {
  range: TimeRange;
  metric: ElectricityMetric;
  costInterval: CostInterval;
}

const DEFAULT_ENERGY_STATE = {
  range: "24h",
  metric: "power",
  costInterval: "month",
} as const satisfies EnergyLocationState;

function energyStateFromLocation(): EnergyLocationState {
  if (typeof window === "undefined") return DEFAULT_ENERGY_STATE;
  const params = new URLSearchParams(window.location.search);
  const requestedRange = params.get("range");
  const requestedMetric = params.get("metric");
  const requestedCost = params.get("cost");
  return {
    range: ANALYTICS_TIME_RANGES.includes(requestedRange as TimeRange)
      ? requestedRange as TimeRange
      : DEFAULT_ENERGY_STATE.range,
    metric: ELECTRICITY_METRICS.includes(requestedMetric as ElectricityMetric)
      ? requestedMetric as ElectricityMetric
      : DEFAULT_ENERGY_STATE.metric,
    costInterval: COST_INTERVALS.some((candidate) => candidate.id === requestedCost)
      ? requestedCost as CostInterval
      : DEFAULT_ENERGY_STATE.costInterval,
  };
}

function writeEnergyStateToLocation(state: EnergyLocationState, mode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const write = (key: string, value: string, defaultValue: string) => {
    if (value === defaultValue) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };
  write("range", state.range, DEFAULT_ENERGY_STATE.range);
  write("metric", state.metric, DEFAULT_ENERGY_STATE.metric);
  write("cost", state.costInterval, DEFAULT_ENERGY_STATE.costInterval);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}

interface EnergyPageProps {
  state: ClimateState;
  dataMode?: DataMode;
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

/** Price source and contract identity; the rates live in the dated tariff. */
interface ElectricityPriceDraft {
  enabled: boolean;
  retailer: string;
  contractName: string;
  endpointUrl: string;
}

function emptyPriceDraft(): ElectricityPriceDraft {
  return {
    enabled: true,
    retailer: "",
    contractName: "",
    endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  };
}

function formatCost(value: number): string {
  const decimals = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `${value.toFixed(decimals)} €`;
}

export function EnergyPage({ state, dataMode = "live", house = null, propertyId: requestedPropertyId, units, onLoadSeries, onOpenSensors, onOpenAlerts, seriesStates, readOnly = false, localAuthority = true }: EnergyPageProps) {
  const { locale, t } = useI18n();
  const propertyId = requestedPropertyId ?? house?.propertyId ?? state.properties[0]?.id ?? "";
  const property = state.properties.find((candidate) => candidate.id === propertyId);
  const canConfigureSources = !readOnly && localAuthority;
  const initialLocationState = useMemo(energyStateFromLocation, []);
  const [metric, setMetric] = useState<ElectricityMetric>(initialLocationState.metric);
  const [range, setRange] = useState<TimeRange>(initialLocationState.range);
  const [costInterval, setCostInterval] = useState<CostInterval>(initialLocationState.costInterval);
  const [priceDraft, setPriceDraft] = useState<ElectricityPriceDraft>(emptyPriceDraft);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceFeedback, setPriceFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [optimizationOpen, setOptimizationOpen] = useState(false);
  const draftInitialized = useRef(false);
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
  const totalElectricitySensors = useMemo(() => sensorsForHomeTotal(electricitySensors), [electricitySensors]);
  const powerSensors = useMemo(
    () => sensorsForMetric(state, totalElectricitySensors, "power"),
    [totalElectricitySensors, state.latestMeasurements, state.measurementHistory],
  );
  const summariesEnabled = Boolean(house && electricitySensors.length);
  const dailySummaryQuery = useHomeEnergySummaryQuery(
    house?.id ?? "", "24h", 24 * 3_600_000, summariesEnabled, 60_000,
  );
  const energyCostQuery = useHomeEnergySummaryQuery(
    house?.id ?? "", costInterval, selectedCostInterval.durationMs, summariesEnabled, selectedCostInterval.refreshMs,
  );
  const rollingSummaryQuery = useHomeEnergySummaryQuery(
    house?.id ?? "", "month", 30 * 24 * 3_600_000, summariesEnabled, 5 * 60_000,
  );
  const projectionQuery = useHomeEnergyProjectionQuery(house?.id ?? "", summariesEnabled);
  const homePriceQuery = useHouseElectricityPriceQuery(house?.id ?? "", Boolean(house));
  const homePrice = house ? currentElectricityPrice(homePriceQuery.data, now) : null;
  const propertyPriceQuery = usePropertyElectricityQuery(propertyId, !house && !priceBusy);
  const propertyPrice = house ? null : propertyPriceQuery.data ?? null;
  const currentPropertyPrice = currentElectricityPrice(propertyPrice?.current, now);
  const priceHistoryQuery = usePriceHistoryQuery(house?.id ?? "", range, Boolean(house) && metric === "electricity_price");
  const priceHistory = priceHistoryQuery.data ?? [];
  const priceHistoryBusy = priceHistoryQuery.isFetching;
  const priceHistoryError = priceHistoryQuery.isError;
  const optimizationQuery = useEnergyOptimizationQuery(propertyId, optimizationOpen);
  const optimization = optimizationQuery.isError ? null : optimizationQuery.data ?? null;
  const optimizationError = optimizationQuery.isError;
  const priceUnavailable = house
    ? homePriceQuery.isError || Boolean(homePriceQuery.data && !homePrice)
    : propertyPriceQuery.isError || Boolean(propertyPrice?.current && !currentPropertyPrice);
  const priceRequestError = house ? homePriceQuery.error : propertyPriceQuery.error;
  const priceAccessDenied = priceRequestError instanceof ApiRequestError && priceRequestError.status === 403;
  const dailySummary = dailySummaryQuery.data ?? null;
  const energyCost = energyCostQuery.data ?? null;
  const rollingSummary = rollingSummaryQuery.data ?? null;
  const dailyPreparing = historyIsPreparing(dailySummaryQuery.error);
  const costPreparing = historyIsPreparing(energyCostQuery.error);
  const energyCostBusy = summariesEnabled && (energyCostQuery.isPending || costPreparing);
  const energyCostError = energyCostQuery.isError && !costPreparing;
  const summariesPreparing = summariesEnabled
    && (dailySummaryQuery.isPending || energyCostQuery.isPending || dailyPreparing || costPreparing);

  useEffect(() => {
    const expectedPathname = window.location.pathname;
    const restoreState = () => {
      if (window.location.pathname !== expectedPathname) return;
      const next = energyStateFromLocation();
      setRange(next.range);
      setMetric(next.metric);
      setCostInterval(next.costInterval);
      writeEnergyStateToLocation(next, "replace");
    };
    restoreState();
    window.addEventListener("popstate", restoreState);
    return () => window.removeEventListener("popstate", restoreState);
  }, [house?.id, propertyId]);

  const selectRange = (next: TimeRange) => {
    setRange(next);
    writeEnergyStateToLocation({ range: next, metric, costInterval }, "push");
  };
  const selectMetric = (next: ElectricityMetric) => {
    setMetric(next);
    writeEnergyStateToLocation({ range, metric: next, costInterval }, "push");
  };
  const selectCostInterval = (next: CostInterval) => {
    setCostInterval(next);
    writeEnergyStateToLocation({ range, metric, costInterval: next }, "push");
  };

  useEffect(() => {
    ++priceContextGeneration.current;
    draftInitialized.current = false;
    setPriceDraft(emptyPriceDraft());
    setPriceBusy(false);
    setPriceFeedback(null);
    setOptimizationOpen(false);
  }, [house?.id, propertyId]);

  useEffect(() => {
    if (!propertyPrice || draftInitialized.current) return;
    draftInitialized.current = true;
    const { config } = propertyPrice;
    setPriceDraft({
      enabled: config.enabled,
      retailer: config.retailer ?? "",
      contractName: config.contractName ?? "",
      endpointUrl: config.endpointUrl,
    });
  }, [propertyPrice]);

  const used24Hours = dailySummary?.consumptionKwh ?? null;
  const powerSources = freshSourcesForMetric(state, powerSensors, "power", now);
  const combinedPower = powerSources.length
    ? powerSources.reduce((sum, source) => sum + (source.sample?.value ?? 0), 0)
    : null;
  const telemetryPriceSample = freshElectricitySample(sources.electricity_price?.sample, "electricity_price", now);
  const effectivePrice = house
    ? homePrice?.effectivePriceEurPerKwh ?? (homePriceQuery.data ? null : telemetryPriceSample?.value ?? null)
    : currentPropertyPrice?.effectivePriceEurPerKwh ?? telemetryPriceSample?.value ?? null;
  const anyData = combinedPower !== null || used24Hours !== null || effectivePrice !== null;
  const combinedSourceLabel = (sensors: Sensor[], reporting: number) => !sensors.length
    ? t("energy.waitingForSource")
    : sensors.length === 1
      ? sensors[0]!.name
      : t("energy.combinedSources", { count: reporting, total: sensors.length });
  const powerSourceLabel = combinedSourceLabel(powerSensors, powerSources.length);
  const dailyState = energySummaryState(dailySummary,
    (dailySummaryQuery.isPending || dailyPreparing) && summariesEnabled,
    dailySummaryQuery.isError && !dailyPreparing);
  const energySourceLabel = dailyState === "loading" ? t("energy.costLoading")
    : dailyState === "unavailable" ? t("energy.summaryUnavailable")
    : dailyState === "empty" ? t("energy.costUsageUnavailable")
    : `${combinedSourceLabel(totalElectricitySensors, dailySummary?.sourceCount ?? 0)}${dailyState === "partial" ? ` · ${t("energy.propertyPartial")}` : ""}`;
  const priceSourceLabel = homePrice?.effectivePriceEurPerKwh !== undefined && homePrice?.effectivePriceEurPerKwh !== null
    ? t("energy.propertyPriceForHome")
    : sources.electricity_price?.sensor.name ?? t("energy.waitingForSource");
  const energyCostBasis = (() => {
    if (energyCostBusy) return t("energy.costLoading");
    if (energyCostError || (energyCost?.failedSourceCount ?? 0) > 0) return t("energy.summaryUnavailable");
    if (!energyCost || energyCost.totalSources === 0 || energyCost.consumptionKwh === null) {
      return t("energy.costUsageUnavailable");
    }
    if (energyCost.costEur === null) {
      return energyCost.costBreakdown?.energyPriceMissing ? t("energy.costEnergyPriceMissing") : t("energy.costPriceUnavailable");
    }
    const selectedSourceCount = Math.max(0, energyCost.totalSources - energyCost.excludedSourceCount);
    if (energyCost.archiveState === "pending") {
      if (selectedSourceCount > 1) {
        return t("energy.costCombinedArchivePending", {
          count: energyCost.sourceCount,
          total: selectedSourceCount,
          coverage: energyCost.priceCoveragePercent.toFixed(0),
        });
      }
      return t("energy.costArchivePending", { coverage: energyCost.priceCoveragePercent.toFixed(0) });
    }
    if (energyCost.aggregationMode === "submeters_only") return t("energy.costSubmetersOnly");
    if (energyCost.complete && energyCost.excludedSourceCount > 0) {
      return t("energy.costWholeHomeBasis", { count: energyCost.excludedSourceCount });
    }
    if (energyCost.complete && energyCost.quality === "estimated") return t("energy.costEstimated");
    if (energyCost.complete) {
      return energyCost.sourceCount <= 1
        ? t("energy.costBasis")
        : t("energy.costCombinedBasis", { count: energyCost.sourceCount });
    }
    return selectedSourceCount <= 1
      ? t("energy.costPartial", { coverage: energyCost.priceCoveragePercent.toFixed(0) })
      : t("energy.costCombinedPartial", {
        count: energyCost.sourceCount,
        total: selectedSourceCount,
        coverage: energyCost.priceCoveragePercent.toFixed(0),
      });
  })();
  // Monthly fees are part of what the period costs, so the card shows the total.
  const shownEnergyCost = energyCost?.totalCostEur ?? null;
  const formattedEnergyCost = shownEnergyCost === null
    ? "—"
    : energyCost!.complete
      ? formatCost(shownEnergyCost)
      : t("energy.costPricedSoFar", { amount: formatCost(shownEnergyCost) });
  const costBreakdownText = costBreakdownLine(energyCost?.costEur === null ? null : energyCost?.costBreakdown ?? null, t);

  const savePriceConfiguration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const generation = priceContextGeneration.current;
    const targetPropertyId = propertyId;
    setPriceBusy(true);
    setPriceFeedback(null);
    try {
      if (!targetPropertyId) return;
      await queryClient.cancelQueries({ queryKey: propertyElectricityKey(targetPropertyId) });
      const saved = await api.configurePropertyElectricity(targetPropertyId, {
        provider: priceDraft.endpointUrl === DEFAULT_ELECTRICITY_PRICE_ENDPOINT ? "porssisahko" : "custom",
        endpointUrl: priceDraft.endpointUrl,
        enabled: priceDraft.enabled,
        contractName: priceDraft.contractName.trim() || null,
        retailer: priceDraft.retailer.trim() || null,
      });
      const result = priceDraft.enabled
        ? await api.refreshPropertyElectricity(targetPropertyId)
        : { config: saved.config, current: null, prices: [] };
      if (priceContextGeneration.current !== generation) return;
      queryClient.setQueryData(propertyElectricityKey(targetPropertyId), result);
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

      {!house && <PropertyEnergyOverview
        state={state}
        propertyId={propertyId}
        propertyName={property?.name ?? propertyId}
        units={units}
        now={now}
      />}

      {!house && <section className="panel energy-price-config" aria-labelledby="energy-price-config-heading">
        <CardHeader title={t("energy.contractTitle")} eyebrow={t("energy.priceSource")} titleId="energy-price-config-heading" />
        <p>{t("energy.contractDescription")}</p>
        {currentPropertyPrice && <p><strong>{t("energy.priceSummary", {
          effective: currentPropertyPrice.effectivePriceCentsPerKwh.toFixed(3),
          raw: currentPropertyPrice.rawPriceCentsPerKwh.toFixed(3),
          provider: propertyPrice?.config.provider === "porssisahko" ? "Pörssisähkö.net" : t("energy.priceApi"),
        })}</strong></p>}
        {propertyPriceQuery.isPending && <p role="status">{t("energy.priceLoading")}</p>}
        {!readOnly && propertyPrice && <details className="energy-contract-editor" open={!propertyPrice?.current}>
          <summary><span>{t(propertyPrice?.current ? "energy.editContract" : "energy.contractTitle")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <form onSubmit={savePriceConfiguration} className="energy-source-controls">
            <label className="field"><span>{t("energy.priceApi")}</span><input type="url" required value={priceDraft.endpointUrl} onChange={(event) => setPriceDraft((current) => ({ ...current, endpointUrl: event.target.value }))} /></label>
            <label className="field"><span>{t("energy.retailer")}</span><input value={priceDraft.retailer} onChange={(event) => setPriceDraft((current) => ({ ...current, retailer: event.target.value }))} /></label>
            <label className="field"><span>{t("energy.contractName")}</span><input value={priceDraft.contractName} onChange={(event) => setPriceDraft((current) => ({ ...current, contractName: event.target.value }))} /></label>
            <label className="field checkbox-field"><input type="checkbox" checked={priceDraft.enabled} onChange={(event) => setPriceDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span>{t("energy.priceEnabled")}</span></label>
            <button type="submit" className="primary-button" disabled={priceBusy}>{priceBusy ? t("energy.updatingPrice") : t("energy.saveAndRefresh")}</button>
          </form>
        </details>}
        {priceFeedback && <p role={priceFeedback.kind === "error" ? "alert" : "status"}>{priceFeedback.text}</p>}
      </section>}

      {!house && propertyId && <ElectricityTariffPanel propertyId={propertyId} readOnly={readOnly} />}
      {!house && propertyId && <ElectricityBillCheckPanel
        propertyId={propertyId}
        houses={state.houses.filter((candidate) => candidate.propertyId === propertyId)}
        readOnly={readOnly}
      />}

      {priceUnavailable && <p className="energy-waiting" role="status">
        {t(priceAccessDenied ? "energy.accessDenied" : "energy.priceLoadError")} <button type="button" className="secondary-button" onClick={() => { void (house ? homePriceQuery.refetch() : propertyPriceQuery.refetch()); }}>{t("common.retry")}</button>
      </p>}

      {house && !electricitySensors.length && <section className="panel energy-onboarding" aria-labelledby="energy-onboarding-heading">
        <span className="energy-onboarding-icon" aria-hidden="true"><RadioTower size={26} /></span>
        <div><span className="eyebrow">{t(canConfigureSources ? "energy.sourceOptions" : "energy.ownerManagedSource")}</span><h2 id="energy-onboarding-heading">{t(canConfigureSources ? "energy.connectTitle" : "energy.noSharedDataTitle")}</h2><p>{t(canConfigureSources ? "energy.connectBody" : "energy.noSharedDataBody")}</p></div>
        {canConfigureSources && onOpenSensors && <button type="button" className="primary-button" onClick={onOpenSensors}>{t("energy.openSensors")}</button>}
      </section>}

      {house && (electricitySensors.length > 0 || effectivePrice !== null || priceHistory.length > 0 || priceHistoryBusy) && <>
      <section className="energy-summary-grid" aria-label={t("energy.summary") }>
        {card("power", t("energy.currentPower"), combinedPower !== null ? formatMeasurement(combinedPower, definitionFor(state.measurementDefinitions, "power"), units) : "—", powerSourceLabel, CircleGauge)}
        {card("energy", t("energy.consumption24h"), used24Hours !== null
          ? formatMeasurement(used24Hours, definitionFor(state.measurementDefinitions, "energy"), units)
          : "—", energySourceLabel, Bolt)}
        {card("electricity_price", t("energy.spotPrice"), effectivePrice !== null ? formatMeasurement(effectivePrice, definitionFor(state.measurementDefinitions, "electricity_price"), units) : "—", priceSourceLabel, Euro)}
        <article className="energy-summary-card running_cost">
          <span className="energy-summary-icon" aria-hidden="true"><Euro size={20} /></span>
          <span><small>{t("energy.runningCost", { interval: t(selectedCostInterval.labelKey) })}</small><strong>{formattedEnergyCost}</strong></span>
          <label className="energy-cost-interval">
            <span>{t("energy.costInterval")}</span>
            <select value={costInterval} onChange={(event) => selectCostInterval(event.target.value as CostInterval)}>
              {COST_INTERVALS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.labelKey)}</option>)}
            </select>
          </label>
          <small className="energy-cost-basis">{energyCostBasis}</small>
          {costBreakdownText && <small className="energy-cost-breakdown">{costBreakdownText}</small>}
        </article>
      </section>

      {summariesPreparing && <p className="energy-waiting" role="status">{t("energy.costLoading")}</p>}
      {(dailyState === "unavailable" || energyCostError || (energyCost?.failedSourceCount ?? 0) > 0) && <p className="energy-waiting" role="status">
        {t("energy.summaryUnavailable")} <button type="button" className="secondary-button" onClick={() => { void dailySummaryQuery.refetch(); void energyCostQuery.refetch(); }}>{t("common.retry")}</button>
      </p>}

      {!anyData && electricitySensors.length > 0 && <p className="energy-waiting" role="status"><TriangleAlert size={17} aria-hidden="true" />{t("energy.waitingForReadings")}</p>}

      <EnergyPlanningPanel
        sensors={electricitySensors}
        projection={projectionQuery.data ?? null}
        rollingSummary={rollingSummary}
      />

      <ElectricityHistory
        state={state}
        dataMode={dataMode}
        sensors={electricitySensors}
        metric={metric}
        onMetric={selectMetric}
        units={units}
        range={range}
        onRange={selectRange}
        timeZone={house.timezone}
        electricityPrices={priceHistory}
        priceLoading={priceHistoryBusy}
        priceError={priceHistoryError}
        priceAccessDenied={priceHistoryQuery.error instanceof ApiRequestError && priceHistoryQuery.error.status === 403}
        onPriceRetry={() => { void priceHistoryQuery.refetch(); }}
        {...(onLoadSeries ? { onLoadSeries } : {})}
        {...(seriesStates ? { seriesStates } : {})}
      />

      <details className="panel energy-source-list" aria-labelledby="energy-sources-heading">
        <summary><span><span className="eyebrow">{electricitySensors.length}</span><strong id="energy-sources-heading" role="heading" aria-level={2}>{t("energy.sourcesTitle")}</strong></span><ChevronDown size={17} aria-hidden="true" /></summary>
        <div className="energy-source-list-content">
          {canConfigureSources && onOpenSensors && <div className="energy-source-list-actions"><button type="button" className="secondary-button" onClick={onOpenSensors}>{t("energy.editSources")}</button></div>}
          <div className="energy-table-scroll" role="region" aria-labelledby="energy-sources-heading" tabIndex={0}><table><thead><tr><th scope="col">{t("sensors.name")}</th><th scope="col">{t("sensors.energyMeterRole")}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "power"), locale)}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "energy"), locale)}</th><th scope="col">{measurementLabel(definitionFor(state.measurementDefinitions, "electricity_price"), locale)}</th><th scope="col">{t("energy.updated")}</th></tr></thead><tbody>{electricitySensors.map((sensor) => {
          const latest = state.latestMeasurements[sensor.id] ?? {};
          const newest = ELECTRICITY_METRICS.flatMap((candidate) => latest[candidate] ? [latest[candidate]!] : []).sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
          const roleLabel = sensor.energyMeterRole === "whole_home"
            ? t("sensors.energyMeterRole.whole_home")
            : sensor.energyMeterRole === "submeter"
              ? t("sensors.energyMeterRole.submeter")
              : t("sensors.energyMeterRole.standalone");
          return <tr key={sensor.id}><th scope="row">{sensor.name}<small>{sensor.room}</small></th><td>{roleLabel}</td>{ELECTRICITY_METRICS.map((candidate) => <td key={candidate}>{latest[candidate] ? formatMeasurement(latest[candidate]!.value, definitionFor(state.measurementDefinitions, candidate), units) : "—"}</td>)}<td>{newest ? formatInTimeZone(newest.timestamp, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }) : t("common.noData")}</td></tr>;
          })}</tbody></table></div>
        </div>
      </details>
      </>}

      <details className="panel energy-optimizer" aria-labelledby="energy-optimizer-heading" open={optimizationOpen} onToggle={(event) => setOptimizationOpen(event.currentTarget.open)}>
        <summary>
          <span><span className="eyebrow"><Lightbulb size={14} aria-hidden="true" />{t("energy.optimizer.eyebrow")}</span><strong id="energy-optimizer-heading" role="heading" aria-level={2}>{t("energy.optimizer.title")}</strong><small>{optimization?.suggestedWindows[0] ? formatOptimizationWindow(optimization.suggestedWindows[0].startAt, optimization.suggestedWindows[0].endAt, locale, house?.timezone) : t("energy.optimizer.description")}</small></span>
          <span className="energy-optimizer-badges"><span className="status-badge energy-optimizer-scope">{t("energy.optimizer.propertyScope", { property: property?.name ?? propertyId })}</span><span className="status-badge">{t("energy.optimizer.readOnly")}</span></span>
          <ChevronDown size={17} aria-hidden="true" />
        </summary>
        <div className="energy-optimizer-content">
          <p>{t("energy.optimizer.description")}</p>
          {optimizationQuery.isFetching && <p role="status">{t("energy.optimizer.loading")}</p>}
          {optimizationError && <p className="energy-waiting" role="status"><TriangleAlert size={17} aria-hidden="true" /> {t("energy.optimizer.unavailable")} <button type="button" className="secondary-button" onClick={() => { void optimizationQuery.refetch(); }}>{t("common.retry")}</button></p>}
          {optimization && <>
            <div className="energy-optimizer-windows">{optimization.suggestedWindows.slice(0, 3).map((window) => <article key={window.startAt} className={window.rank}><Clock3 size={18} aria-hidden="true" /><span><strong>{formatOptimizationWindow(window.startAt, window.endAt, locale, house?.timezone)}</strong><small>{t("energy.optimizer.priceComparison", { price: window.averagePriceCentsPerKwh.toFixed(2), percent: Math.abs(window.relativeToAveragePercent).toFixed(0), comparison: window.relativeToAveragePercent <= 0 ? t("energy.optimizer.below") : t("energy.optimizer.above") })}</small></span></article>)}</div>
            <dl className="energy-optimizer-baseline"><div><dt>{t("energy.optimizer.consumption24h")}</dt><dd>{optimization.recentDailyConsumptionKwh === null ? t("energy.optimizer.notEnoughData") : `${optimization.recentDailyConsumptionKwh.toFixed(2)} kWh`}</dd></div><div><dt>{t("energy.optimizer.baseload")}</dt><dd>{optimization.baselinePowerWatts === null ? t("energy.optimizer.notEnoughData") : `${optimization.baselinePowerWatts.toFixed(0)} W`}</dd></div><div><dt>{t("energy.optimizer.peak")}</dt><dd>{optimization.peakPowerWatts === null ? t("energy.optimizer.notEnoughData") : `${optimization.peakPowerWatts.toFixed(0)} W`}</dd></div></dl>
            {optimization.insights.length > 0 && <ul className="energy-optimizer-insights">{optimization.insights.map((insight) => <li key={insight.id} className={insight.severity}><strong>{insight.title}</strong><span>{insight.explanation}</span>{insight.estimatedSavingsEur !== null && <small>{t("energy.optimizer.estimatedOpportunity", { amount: new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(insight.estimatedSavingsEur) })}</small>}</li>)}</ul>}
            {optimization.limitations.length > 0 && <details><summary>{t("energy.optimizer.limitations")}</summary><ul>{optimization.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details>}
          </>}
        </div>
      </details>
    </>
  );
}

function costBreakdownLine(
  breakdown: ElectricityCostBreakdown | null,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  if (!breakdown || breakdown.included.length < 2) return null;
  const amounts = { energy: breakdown.energyEur, network: breakdown.networkEur, tax: breakdown.taxEur, fees: breakdown.feesEur };
  return breakdown.included.flatMap((component) => {
    const value = amounts[component];
    return value === null ? [] : [t(`energy.costComponent.${component}`, { amount: formatCost(value) })];
  }).join(" · ");
}

function formatOptimizationWindow(startAt: string, endAt: string, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit" };
  return `${formatInTimeZone(startAt, locale, timeZone, options)}–${formatInTimeZone(endAt, locale, timeZone, options)}`;
}
