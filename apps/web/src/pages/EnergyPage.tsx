import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BellRing, Bolt, CircleGauge, Clock3, Euro, Lightbulb, RadioTower, TriangleAlert } from "lucide-react";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  type ElectricityContractType,
  type EnergyOptimizationReport,
  type House,
  type HomeElectricityPricePoint,
  type MeasurementSample,
  type Metric,
  type PropertyElectricityConfig,
  type PropertyElectricityPricePoint,
  type Sensor,
  type UnitSystem,
} from "@climate-twin/contracts";
import type { ClimateState, TimeRange } from "../domain";
import { TrendChart } from "../components/TrendChart";
import { definitionFor, formatMeasurement, measurementLabel } from "../measurements";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { api } from "../api";
import { useNow } from "../useNow";
import { seriesStateKey, type SeriesLoadState } from "../useClimateData";
import "./EnergyPage.css";

export const ELECTRICITY_METRICS = ["power", "energy", "electricity_price"] as const;
export type ElectricityMetric = typeof ELECTRICITY_METRICS[number];

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

interface MetricSource {
  sensor: Sensor;
  sample: MeasurementSample | null;
}

function sampleTime(sample: MeasurementSample | null): number {
  if (!sample) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(sample.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function boundToMetric(sensor: Sensor, metric: ElectricityMetric): boolean {
  return Boolean(sensor.measurementEntityIds?.[metric]);
}

function sourceForMetric(state: ClimateState, sensors: Sensor[], metric: ElectricityMetric, now: number): MetricSource | null {
  const candidates = sensors.flatMap((sensor): MetricSource[] => {
    const sample = state.latestMeasurements[sensor.id]?.[metric] ?? null;
    const hasHistory = (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0;
    return sample || hasHistory || boundToMetric(sensor, metric) ? [{ sensor, sample }] : [];
  });
  return candidates.sort((left, right) => {
    const freshLeft = freshElectricitySample(left.sample, metric, now);
    const freshRight = freshElectricitySample(right.sample, metric, now);
    if (Boolean(freshLeft) !== Boolean(freshRight)) return freshRight ? 1 : -1;
    const byFreshness = sampleTime(freshRight ?? right.sample) - sampleTime(freshLeft ?? left.sample);
    if (byFreshness) return byFreshness;
    return left.sensor.name.localeCompare(right.sensor.name);
  })[0] ?? null;
}

/**
 * Computes usage from a cumulative counter and tolerates a daily/monthly reset.
 * A reset contributes the new counter value instead of a negative delta.
 */
export function counterConsumption(samples: MeasurementSample[]): number | null {
  const usable = samples.filter((sample) => sample.metric === "energy"
    && sample.quality !== "stale"
    && Number.isFinite(sample.value)
    && Number.isFinite(Date.parse(sample.timestamp)));
  const ordered = [...new Map(usable.map((sample) => [sample.timestamp, sample])).values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (ordered.length < 2) return null;
  let total = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.value;
    const current = ordered[index]!.value;
    total += current >= previous ? current - previous : Math.max(0, current);
  }
  return total;
}

function metricSources(state: ClimateState, sensors: Sensor[], now: number): Record<ElectricityMetric, MetricSource | null> {
  return {
    power: sourceForMetric(state, sensors, "power", now),
    energy: sourceForMetric(state, sensors, "energy", now),
    electricity_price: sourceForMetric(state, sensors, "electricity_price", now),
  };
}

const ELECTRICITY_FRESHNESS_MS: Record<ElectricityMetric, number> = {
  power: 15 * 60_000,
  energy: 2 * 60 * 60_000,
  electricity_price: 2 * 60 * 60_000,
};
const MAX_ELECTRICITY_CLOCK_SKEW_MS = 5 * 60_000;
const RUNNING_COST_ALIGNMENT_MS = 90 * 60_000;

export function freshElectricitySample(
  sample: MeasurementSample | null | undefined,
  metric: ElectricityMetric,
  now: number,
): MeasurementSample | null {
  if (!sample || sample.quality === "stale") return null;
  const timestamp = Date.parse(sample.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now + MAX_ELECTRICITY_CLOCK_SKEW_MS
    || now - timestamp > ELECTRICITY_FRESHNESS_MS[metric]) return null;
  return sample;
}

export function currentRunningCost(power: MeasurementSample | null, price: MeasurementSample | null): number | null {
  if (!power || !price) return null;
  if (Math.abs(Date.parse(power.timestamp) - Date.parse(price.timestamp)) > RUNNING_COST_ALIGNMENT_MS) return null;
  return power.value / 1_000 * price.value;
}

export function EnergyPage({ state, house = null, propertyId: requestedPropertyId, units, onLoadSeries, onOpenSensors, onOpenAlerts, seriesStates, readOnly = false }: EnergyPageProps) {
  const { locale, t } = useI18n();
  const propertyId = requestedPropertyId ?? house?.propertyId ?? state.properties[0]?.id ?? "";
  const property = state.properties.find((candidate) => candidate.id === propertyId);
  const [metric, setMetric] = useState<ElectricityMetric>("power");
  const [range, setRange] = useState<TimeRange>("24h");
  const [consumptionWindow, setConsumptionWindow] = useState<MeasurementSample[]>([]);
  const [propertyPrice, setPropertyPrice] = useState<{ config: PropertyElectricityConfig; current: PropertyElectricityPricePoint | null } | null>(null);
  const [homePrice, setHomePrice] = useState<HomeElectricityPricePoint | null>(null);
  const [priceDraft, setPriceDraft] = useState<ElectricityPriceDraft>(emptyPriceDraft);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceFeedback, setPriceFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [optimization, setOptimization] = useState<EnergyOptimizationReport | null>(null);
  const [optimizationError, setOptimizationError] = useState(false);
  const priceContextGeneration = useRef(0);
  const now = useNow();
  const houseSensors = useMemo(
    () => house ? state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled) : [],
    [house?.id, state.sensors],
  );
  const sources = useMemo(() => metricSources(state, houseSensors, now), [houseSensors, now, state]);
  const electricitySensors = useMemo(() => houseSensors.filter((sensor) => ELECTRICITY_METRICS.some((candidate) => (
    boundToMetric(sensor, candidate)
      || Boolean(state.latestMeasurements[sensor.id]?.[candidate])
      || (state.measurementHistory[sensor.id]?.[candidate]?.length ?? 0) > 0
  ))), [houseSensors, state.latestMeasurements, state.measurementHistory]);
  const [sensorId, setSensorId] = useState("");
  const metricSensors = useMemo(() => electricitySensors.filter((sensor) => (
    boundToMetric(sensor, metric)
      || Boolean(state.latestMeasurements[sensor.id]?.[metric])
      || (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0
  )), [electricitySensors, metric, state.latestMeasurements, state.measurementHistory]);
  const selectedSensor = metricSensors.find((sensor) => sensor.id === sensorId)
    ?? sources[metric]?.sensor
    ?? metricSensors[0]
    ?? null;
  const definition = definitionFor(state.measurementDefinitions, metric);
  const history = selectedSensor ? state.measurementHistory[selectedSensor.id]?.[metric] ?? [] : [];
  const forecast = selectedSensor ? state.measurementForecasts[selectedSensor.id]?.[metric] ?? [] : [];
  const seriesState = selectedSensor ? seriesStates?.[seriesStateKey(selectedSensor.id, metric)] : undefined;

  useEffect(() => {
    const generation = ++priceContextGeneration.current;
    setPropertyPrice(null);
    setHomePrice(null);
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

  useEffect(() => {
    if (selectedSensor && selectedSensor.id !== sensorId) setSensorId(selectedSensor.id);
  }, [selectedSensor, sensorId]);

  useEffect(() => {
    if (!selectedSensor) return;
    onLoadSeries?.(selectedSensor.id, metric, range, false);
  }, [metric, onLoadSeries, range, selectedSensor?.id]);

  useEffect(() => {
    const consumptionSourceId = sources.energy?.sensor.id;
    if (!consumptionSourceId) {
      setConsumptionWindow([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 3_600_000);
    setConsumptionWindow([]);
    void api.measurementHistory(consumptionSourceId, "energy", from.toISOString(), to.toISOString(), 50_000, controller.signal)
      .then((samples) => {
        if (!active) return;
        setConsumptionWindow((current) => {
          const unique = new Map([...samples, ...current].map((sample) => [sample.timestamp, sample]));
          return [...unique.values()].filter((sample) => Date.parse(sample.timestamp) >= from.getTime());
        });
      })
      .catch(() => undefined);
    return () => { active = false; controller.abort(); };
  }, [sources.energy?.sensor.id]);

  useEffect(() => {
    const latest = sources.energy?.sample;
    const cutoff = now - 24 * 3_600_000;
    setConsumptionWindow((current) => {
      const unique = new Map((latest ? [...current, latest] : current).map((sample) => [sample.timestamp, sample]));
      return [...unique.values()].filter((sample) => Date.parse(sample.timestamp) >= cutoff);
    });
  }, [now, sources.energy?.sample]);

  const used24Hours = counterConsumption(consumptionWindow);
  const powerSample = freshElectricitySample(sources.power?.sample, "power", now);
  const energySample = freshElectricitySample(sources.energy?.sample, "energy", now);
  const telemetryPriceSample = freshElectricitySample(sources.electricity_price?.sample, "electricity_price", now);
  const effectivePrice = house
    ? homePrice?.effectivePriceEurPerKwh ?? telemetryPriceSample?.value ?? null
    : propertyPrice?.current?.effectivePriceEurPerKwh ?? telemetryPriceSample?.value ?? null;
  const runningCost = powerSample && effectivePrice !== null ? powerSample.value / 1_000 * effectivePrice : null;
  const anyData = Boolean(powerSample || energySample || effectivePrice !== null);

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
    source: MetricSource | null,
    Icon: typeof Bolt,
  ) => (
    <article className={`energy-summary-card ${kind}`}>
      <span className="energy-summary-icon" aria-hidden="true"><Icon size={20} /></span>
      <span><small>{title}</small><strong>{value}</strong></span>
      <small>{source?.sensor.name ?? t("energy.waitingForSource")}</small>
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
        <div><span className="eyebrow">{t("energy.sourceOptions")}</span><h2 id="energy-onboarding-heading">{t("energy.connectTitle")}</h2><p>{t("energy.connectBody")}</p></div>
        {onOpenSensors && <button type="button" className="primary-button" onClick={onOpenSensors}>{t("energy.openSensors")}</button>}
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

      {house && (electricitySensors.length > 0 || effectivePrice !== null) && <>
      <section className="energy-summary-grid" aria-label={t("energy.summary") }>
        {card("power", t("energy.currentPower"), powerSample ? formatMeasurement(powerSample.value, definitionFor(state.measurementDefinitions, "power"), units) : "—", sources.power, CircleGauge)}
        {card("energy", used24Hours === null ? t("energy.consumptionReading") : t("energy.consumption24h"), used24Hours !== null
          ? formatMeasurement(used24Hours, definitionFor(state.measurementDefinitions, "energy"), units)
          : energySample ? formatMeasurement(energySample.value, definitionFor(state.measurementDefinitions, "energy"), units) : "—", sources.energy, Bolt)}
        {card("electricity_price", t("energy.spotPrice"), effectivePrice !== null ? formatMeasurement(effectivePrice, definitionFor(state.measurementDefinitions, "electricity_price"), units) : "—", sources.electricity_price, Euro)}
        {card("running_cost", t("energy.runningCost"), runningCost === null ? "—" : `${runningCost.toFixed(2)} €/h`, sources.power ?? sources.electricity_price, Euro)}
      </section>

      {!anyData && electricitySensors.length > 0 && <p className="energy-waiting" role="status"><TriangleAlert size={17} aria-hidden="true" />{t("energy.waitingForReadings")}</p>}

      <section className="panel energy-history-controls" aria-labelledby="energy-history-heading">
        <div className="panel-header"><div><span className="eyebrow">{t("chart.history")}</span><h2 id="energy-history-heading">{t("energy.historyTitle")}</h2></div></div>
        <div className="energy-source-controls">
          <div className="segmented" role="group" aria-label={t("common.metric")}>{ELECTRICITY_METRICS.map((candidate) => {
            const candidateDefinition = definitionFor(state.measurementDefinitions, candidate);
            return <button key={candidate} type="button" aria-pressed={metric === candidate} onClick={() => setMetric(candidate)}>{measurementLabel(candidateDefinition, locale)}</button>;
          })}</div>
          <label className="field"><span>{t("energy.dataSource")}</span><select value={selectedSensor?.id ?? ""} disabled={!metricSensors.length} onChange={(event) => setSensorId(event.target.value)}><option value="">{t("energy.noSource")}</option>{metricSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></label>
        </div>
      </section>

      <TrendChart sensor={selectedSensor} history={history} forecast={forecast} definition={definition} units={units} range={range} onRange={setRange} timeZone={house.timezone} {...(seriesState ? { loadState: seriesState } : {})} />

      <section className="panel energy-source-list" aria-labelledby="energy-sources-heading">
        <div className="panel-header"><div><span className="eyebrow">{electricitySensors.length}</span><h2 id="energy-sources-heading">{t("energy.sourcesTitle")}</h2></div>{onOpenSensors && <button type="button" className="secondary-button" onClick={onOpenSensors}>{t("energy.editSources")}</button>}</div>
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
  const options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) };
  const formatter = new Intl.DateTimeFormat(locale, options);
  return `${formatter.format(new Date(startAt))}–${formatter.format(new Date(endAt))}`;
}
