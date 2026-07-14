import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, FlaskConical, Play, RotateCcw } from "lucide-react";
import type { Sensor, ThermalSimulationPoint, UnitSystem } from "@climate-twin/contracts";
import type { TimeRange } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { useThermalSimulation } from "../useThermalSimulation";

interface ThermalSimulationPanelProps {
  houseId: string;
  sensor: Sensor | null;
  range: TimeRange;
  units: UnitSystem;
  timeZone: string;
  currentOutdoorTemperatureC?: number | undefined;
  cursorTimestamp?: number | undefined;
}

const width = 900;
const height = 390;
const margin = { top: 24, right: 24, bottom: 34, left: 62 };
const upperBottom = 242;
const residualTop = 292;
const residualBottom = 354;

export function temperatureForDisplay(valueC: number, units: UnitSystem): number {
  return units === "imperial" ? valueC * 9 / 5 + 32 : valueC;
}

export function temperatureFromDisplay(value: number, units: UnitSystem): number {
  return units === "imperial" ? (value - 32) * 5 / 9 : value;
}

export function temperatureDeltaForDisplay(valueC: number, units: UnitSystem): number {
  return units === "imperial" ? valueC * 9 / 5 : valueC;
}

export function formatSignedTemperatureDelta(valueC: number, units: UnitSystem): string {
  const value = temperatureDeltaForDisplay(valueC, units);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)} ${units === "imperial" ? "°F" : "°C"}`;
}

function warningKey(code: string): TranslationKey {
  const keys: Record<string, TranslationKey> = {
    INSUFFICIENT_OVERLAP: "simulation.warning.insufficientOverlap",
    CALIBRATION_WINDOW_TOO_SHORT: "simulation.warning.shortWindow",
    SYNTHETIC_OUTDOOR_BOUNDARY: "simulation.warning.syntheticBoundary",
    SHORT_CALIBRATION_WINDOW: "simulation.warning.shortWindow",
    LOW_THERMAL_DRIVE_VARIATION: "simulation.warning.lowVariation",
    WEAK_PARAMETER_IDENTIFICATION: "simulation.warning.weakIdentification",
    HIGH_VALIDATION_BIAS: "simulation.warning.highBias",
    MODEL_WORSE_THAN_PERSISTENCE: "simulation.warning.persistenceBetter",
    NEGATIVE_EFFECTIVE_EQUILIBRIUM_LIFT: "simulation.warning.negativeLift",
    SCENARIO_OUTSIDE_CALIBRATION_RANGE: "simulation.warning.outsideRange",
    LONG_SCENARIO_HORIZON: "simulation.warning.longHorizon",
    MODEL_NOT_IDENTIFIABLE: "simulation.warning.weakIdentification",
    STALE_SCENARIO_ANCHOR: "simulation.warning.staleAnchor",
  };
  return keys[code] ?? "simulation.warning.other";
}

function rangeHours(range: TimeRange): number {
  return range === "6h" ? 6 : range === "24h" ? 24 : 168;
}

function path(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function formatHouseTime(value: number, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(value);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(value);
  }
}

export function ThermalSimulationPanel({
  houseId,
  sensor,
  range,
  units,
  timeZone,
  currentOutdoorTemperatureC,
  cursorTimestamp,
}: ThermalSimulationPanelProps) {
  const { locale, t } = useI18n();
  const simulation = useThermalSimulation(houseId, sensor?.id ?? null);
  const [horizonHours, setHorizonHours] = useState(12);
  const [scenarioOutdoor, setScenarioOutdoor] = useState(
    currentOutdoorTemperatureC === undefined ? "" : String(Math.round(temperatureForDisplay(currentOutdoorTemperatureC, units))),
  );

  useEffect(() => {
    setScenarioOutdoor(currentOutdoorTemperatureC === undefined
      ? ""
      : String(Math.round(temperatureForDisplay(currentOutdoorTemperatureC, units))));
  }, [houseId, currentOutdoorTemperatureC, units]);

  useEffect(() => {
    simulation.reset();
  }, [range, cursorTimestamp, horizonHours, scenarioOutdoor, simulation.reset]);

  const run = () => {
    if (!sensor) return;
    const toMs = cursorTimestamp ?? Date.now();
    const scenarioDisplay = scenarioOutdoor.trim() === "" ? undefined : Number(scenarioOutdoor);
    if (scenarioDisplay !== undefined && !Number.isFinite(scenarioDisplay)) return;
    const scenario = scenarioDisplay === undefined ? undefined : temperatureFromDisplay(scenarioDisplay, units);
    const calibrationHours = Math.max(7 * 24, rangeHours(range));
    void simulation.run({
      from: new Date(toMs - calibrationHours * 3_600_000).toISOString(),
      to: new Date(toMs).toISOString(),
      horizonHours,
      ...(scenario === undefined ? {} : { scenarioOutdoorTemperatureC: scenario }),
    });
  };

  const result = simulation.result;
  const model = result?.calibration.model;
  return (
    <section className="panel thermal-panel" aria-labelledby="thermal-simulation-title">
      <div className="panel-header thermal-heading">
        <div>
          <span className="eyebrow"><FlaskConical size={14} aria-hidden="true" />{t("simulation.eyebrow")}</span>
          <h2 id="thermal-simulation-title">{t("simulation.title")}</h2>
          <p>{t("simulation.description")}</p>
        </div>
        {result && <span className={`simulation-status ${result.calibration.status}`}>
          {t(`simulation.status.${result.calibration.status}`)}
        </span>}
      </div>

      <div className="thermal-controls">
        <label className="field">
          <span>{t("simulation.sensor")}</span>
          <strong>{sensor?.name ?? t("twin.selectSensor")}</strong>
        </label>
        <label className="field">
          <span>{t("simulation.outdoorScenario")}</span>
          <div className="input-with-unit"><input inputMode="decimal" value={scenarioOutdoor} onChange={(event) => setScenarioOutdoor(event.target.value)} placeholder={t("simulation.latestBoundary")} /><span>{units === "imperial" ? "°F" : "°C"}</span></div>
        </label>
        <label className="field">
          <span>{t("simulation.horizon")}</span>
          <select value={horizonHours} onChange={(event) => setHorizonHours(Number(event.target.value))}>
            {[0, 6, 12, 24, 48, 72].map((hours) => <option key={hours} value={hours}>{hours === 0 ? t("simulation.fitOnly") : t("simulation.hours", { count: hours })}</option>)}
          </select>
        </label>
        <button type="button" className="primary-button" disabled={!sensor || simulation.loading} onClick={run}>
          {simulation.loading ? <RotateCcw className="spin" size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {simulation.loading ? t("simulation.running") : t("simulation.run")}
        </button>
      </div>

      {simulation.error && <div className="simulation-message error" role="alert"><AlertCircle size={18} aria-hidden="true" /><span><strong>{t("simulation.error")}</strong><small>{t("simulation.errorHelp")}</small></span></div>}
      {!result && !simulation.error && <div className="simulation-empty"><Activity size={24} aria-hidden="true" /><span><strong>{t("simulation.empty")}</strong><small>{t("simulation.emptyHelp")}</small></span></div>}
      {result?.calibration.status === "insufficient-data" && (
        <div className="simulation-message collecting" role="status">
          <Activity size={19} aria-hidden="true" />
          <span><strong>{t("simulation.collecting")}</strong><small>{t("simulation.collectingHelp", {
            indoor: result.calibration.quality.indoorSamples,
            outdoor: result.calibration.quality.outdoorSamples,
            overlap: result.calibration.quality.transitionsUsed,
          })}</small></span>
        </div>
      )}
      {result && model && (
        <>
          <div className="simulation-metrics" aria-label={t("simulation.calibrationMetrics")}>
            <Metric label={t("simulation.timeConstant")} value={t("simulation.hours", { count: model.parameters.timeConstantHours })} />
            <Metric label={t("simulation.effectiveLift")} value={formatSignedTemperatureDelta(model.parameters.effectiveEquilibriumLiftC, units)} />
            <Metric label={t("simulation.mae")} value={result.calibration.quality.validationMaeC === null ? "—" : formatSignedlessDelta(result.calibration.quality.validationMaeC, units)} />
            <Metric label={t("simulation.rmse")} value={result.calibration.quality.validationRmseC === null ? "—" : formatSignedlessDelta(result.calibration.quality.validationRmseC, units)} />
            <Metric label={t("simulation.samples")} value={String(result.calibration.quality.transitionsUsed)} />
            <Metric label={t("simulation.scenarioAnchor")} value={result.scenarioAnchorTimestamp === null
              ? "—"
              : formatHouseTime(Date.parse(result.scenarioAnchorTimestamp), locale, timeZone, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} />
          </div>
          <ThermalChart points={result.points} units={units} locale={locale} timeZone={timeZone} cursorTimestamp={cursorTimestamp} />
        </>
      )}
      {result && result.calibration.warnings.length > 0 && (
        <div className="simulation-warnings">
          <strong>{t("simulation.limitations")}</strong>
          <ul>{[...new Set(result.calibration.warnings.filter((warning) => !warning.startsWith("REQUIRES_")))].map((warning) => <li key={warning}>{t(warningKey(warning))}</li>)}</ul>
        </div>
      )}
      <p className="simulation-provenance">{t("simulation.provenance", { model: model?.method ?? "first-order-lumped-v1", version: model?.version ?? "1.0.0" })}</p>
    </section>
  );
}

function formatSignedlessDelta(valueC: number, units: UnitSystem): string {
  return `${temperatureDeltaForDisplay(valueC, units).toFixed(2)} ${units === "imperial" ? "°F" : "°C"}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><strong>{value}</strong></div>;
}

function ThermalChart({
  points,
  units,
  locale,
  timeZone,
  cursorTimestamp,
}: {
  points: ThermalSimulationPoint[];
  units: UnitSystem;
  locale: string;
  timeZone: string;
  cursorTimestamp?: number | undefined;
}) {
  const { t } = useI18n();
  const chart = useMemo(() => {
    if (!points.length) return null;
    const timestamps = points.map((point) => Date.parse(point.timestamp));
    const timeMin = Math.min(...timestamps);
    const timeMax = Math.max(...timestamps);
    const values = points.flatMap((point) => [point.lowC, point.highC, point.simulatedTemperatureC, ...(point.observedTemperatureC === null ? [] : [point.observedTemperatureC])]);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max(0.4, (rawMax - rawMin) * 0.08);
    const valueMin = rawMin - padding;
    const valueMax = rawMax + padding;
    const residuals = points.flatMap((point) => point.residualC === null ? [] : [point.residualC]);
    const residualLimit = Math.max(0.2, ...residuals.map(Math.abs)) * 1.12;
    const x = (timestamp: number) => margin.left + (timestamp - timeMin) / Math.max(1, timeMax - timeMin) * (width - margin.left - margin.right);
    const y = (valueC: number) => margin.top + (valueMax - valueC) / Math.max(Number.EPSILON, valueMax - valueMin) * (upperBottom - margin.top);
    const residualY = (valueC: number) => residualTop + (residualLimit - valueC) / (2 * residualLimit) * (residualBottom - residualTop);
    const observed = points.flatMap((point) => point.observedTemperatureC === null ? [] : [{ x: x(Date.parse(point.timestamp)), y: y(point.observedTemperatureC) }]);
    const simulated = points.map((point) => ({ x: x(Date.parse(point.timestamp)), y: y(point.simulatedTemperatureC) }));
    const residual = points.flatMap((point) => point.residualC === null ? [] : [{ x: x(Date.parse(point.timestamp)), y: residualY(point.residualC) }]);
    const band = [
      ...points.map((point) => `${x(Date.parse(point.timestamp)).toFixed(1)},${y(point.highC).toFixed(1)}`),
      ...[...points].reverse().map((point) => `${x(Date.parse(point.timestamp)).toFixed(1)},${y(point.lowC).toFixed(1)}`),
    ].join(" ");
    return { timeMin, timeMax, valueMin, valueMax, residualLimit, x, y, residualY, observed, simulated, residual, band };
  }, [points]);
  if (!chart) return null;
  const xTicks = Array.from({ length: 5 }, (_, index) => chart.timeMin + (chart.timeMax - chart.timeMin) * index / 4);
  const yTicks = Array.from({ length: 4 }, (_, index) => chart.valueMin + (chart.valueMax - chart.valueMin) * index / 3).reverse();
  const residualTicks = [chart.residualLimit, 0, -chart.residualLimit];
  const cursorX = cursorTimestamp === undefined ? null : chart.x(cursorTimestamp);
  return (
    <div className="thermal-chart-shell">
      <div className="thermal-legend" aria-hidden="true">
        <span><i className="thermal-key observed" />{t("simulation.observed")}</span>
        <span><i className="thermal-key simulated" />{t("simulation.simulated")}</span>
        <span><i className="thermal-key band" />{t("simulation.modelBand")}</span>
        <span><i className="thermal-key residual" />{t("simulation.residual")}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="thermal-chart" role="img" aria-label={t("simulation.chartAria")}>
        <g className="chart-grid" aria-hidden="true">
          {yTicks.map((tick) => <line key={`temperature-${tick}`} x1={margin.left} x2={width - margin.right} y1={chart.y(tick)} y2={chart.y(tick)} />)}
          <line x1={margin.left} x2={width - margin.right} y1={chart.residualY(0)} y2={chart.residualY(0)} className="residual-zero" />
        </g>
        <g className="chart-axis" aria-hidden="true">
          {yTicks.map((tick) => <text key={`temperature-label-${tick}`} x={margin.left - 10} y={chart.y(tick) + 4} textAnchor="end">{temperatureForDisplay(tick, units).toFixed(1)}</text>)}
          {residualTicks.map((tick) => <text key={`residual-label-${tick}`} x={margin.left - 10} y={chart.residualY(tick) + 4} textAnchor="end">{temperatureDeltaForDisplay(tick, units).toFixed(1)}</text>)}
          {xTicks.map((tick, index) => <text key={tick} x={chart.x(tick)} y={height - 10} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{formatHouseTime(tick, locale, timeZone, { weekday: "short", hour: "2-digit" })}</text>)}
          <text x="7" y="15">{units === "imperial" ? "°F" : "°C"}</text>
          <text x="7" y={residualTop - 7}>Δ</text>
        </g>
        <polygon points={chart.band} className="thermal-band" aria-hidden="true" />
        {chart.observed.length > 1 && <path d={path(chart.observed)} className="thermal-line observed" aria-hidden="true" />}
        {chart.simulated.length > 1 && <path d={path(chart.simulated)} className="thermal-line simulated" aria-hidden="true" />}
        {chart.residual.length > 1 && <path d={path(chart.residual)} className="thermal-line residual" aria-hidden="true" />}
        {cursorX !== null && cursorX >= margin.left && cursorX <= width - margin.right && <line className="thermal-cursor" x1={cursorX} x2={cursorX} y1={margin.top} y2={residualBottom} aria-hidden="true" />}
      </svg>
    </div>
  );
}
