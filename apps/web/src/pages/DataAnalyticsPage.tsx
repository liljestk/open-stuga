import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartLine, CloudSun, Database, Download, FileJson, FileSpreadsheet, RefreshCw, Table2, TriangleAlert } from "lucide-react";
import type {
  AnalyticsAggregation,
  AnalyticsQueryResponse,
  AnalyticsResolution,
  AnalyticsSampleQuality,
  House,
  HomeElectricityPricePoint,
  Metric,
  MeasurementDefinition,
  OutdoorTemperatureSample,
  SensorDataGap,
  UnitSystem,
} from "@climate-twin/contracts";
import { timeRangeHours, type ClimateState, type TimeRange } from "../domain";
import { api } from "../api";
import { SensorAnalyticsChart } from "../components/SensorAnalyticsChart";
import { chartGapThresholdMs, detectSeriesGaps } from "../chartGaps";
import { formatInTimeZone } from "../dateTime";
import { useHouseWeather } from "../useHouseWeather";
import { useI18n } from "../i18n";
import { formatMeasurement, measurementLabel } from "../measurements";
import { useNow } from "../useNow";

interface DataAnalyticsPageProps {
  state: ClimateState;
  house: House;
  units: UnitSystem;
  dataMode: "demo" | "real" | "unknown";
  onLoadSeries: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
}

interface ContinuityRow {
  id: string;
  source: string;
  metric: string;
  startedAt: number;
  endedAt: number;
  state: SensorDataGap["recoveryState"] | "visible";
  recoveredPoints: number;
  detail: string | null;
}

type QualityPreset = "good" | "reliable" | "all";

const ANALYTICS_RESOLUTIONS: AnalyticsResolution[] = ["auto", "raw", "1m", "5m", "15m", "1h", "1d"];

function aggregationOptions(definition: MeasurementDefinition | undefined): AnalyticsAggregation[] {
  const kind = definition?.kind ?? "gauge";
  if (kind === "rate") return ["default", "time_weighted_mean", "mean", "last", "min", "max"];
  if (kind === "increment") return ["default", "sum", "last", "min", "max"];
  if (kind === "cumulative_counter") return ["default", "delta", "last", "min", "max"];
  if (kind === "binary_state") return ["default", "last", "mean"];
  if (kind === "categorical_state") return ["default", "last"];
  return ["default", "mean", "last", "min", "max"];
}

function qualitiesForPreset(preset: QualityPreset): AnalyticsSampleQuality[] {
  if (preset === "good") return ["good"];
  if (preset === "reliable") return ["good", "estimated"];
  return ["good", "estimated", "stale"];
}

function analyticsPointBudget(range: TimeRange): number {
  if (range === "30d") return 1_000;
  if (range === "90d") return 2_500;
  if (range === "1y") return 1_000;
  return 500;
}

function durationLabel(milliseconds: number, locale: string): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes);
  const hours = minutes / 60;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: hours < 10 ? 1 : 0, style: "unit", unit: "hour", unitDisplay: "short" }).format(hours);
}

function csvCell(value: string | number): string {
  const text = String(value);
  const formulaSafe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

export function analyticsCsv(result: AnalyticsQueryResponse): string {
  const rows: Array<Array<string | number>> = [[
    "api_version", "data_mode", "request_id", "timezone", "range_start", "range_end", "generated_at",
    "series", "entity_id", "measurement", "timestamp", "value", "unit", "truth_class", "aggregation",
    "resolution", "quality_filter", "excluded_source_samples", "coverage", "sample_count", "quality_flags", "algorithm", "algorithm_version",
  ]];
  for (const series of result.series) {
    for (const point of series.points) {
      rows.push([
        result.apiVersion, result.dataMode, result.requestId, result.resolvedRange.timezone, result.resolvedRange.start,
        result.resolvedRange.end, result.generatedAt, series.entityLabel, series.entityId, series.measurementId, point.timestamp,
        point.value ?? "", series.canonicalUnit, series.truthClass, series.aggregation, series.resolution,
        result.quality.includedQualities.join("|"), result.quality.excludedSampleCount,
        point.coverage, point.sampleCount, point.qualityFlags.join("|"),
        series.provenance.algorithmKey, series.provenance.algorithmVersion,
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataAnalyticsPage(props: Readonly<DataAnalyticsPageProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const [metric, setMetric] = useState<Metric>("temperature");
  const [selectedSensorIds, setSelectedSensorIds] = useState<string[] | null>(null);
  const [weatherObservationsVisible, setWeatherObservationsVisible] = useState(true);
  const [weatherForecastVisible, setWeatherForecastVisible] = useState(true);
  const [range, setRange] = useState<TimeRange>("24h");
  const [resolution, setResolution] = useState<AnalyticsResolution>("auto");
  const [aggregation, setAggregation] = useState<AnalyticsAggregation>("default");
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("reliable");
  const [outdoorHistory, setOutdoorHistory] = useState<OutdoorTemperatureSample[]>([]);
  const [electricityPrices, setElectricityPrices] = useState<HomeElectricityPricePoint[]>([]);
  const [sensorGaps, setSensorGaps] = useState<SensorDataGap[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsQueryResponse | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const weather = useHouseWeather(props.house);
  const sensors = useMemo(
    () => props.state.sensors.filter((sensor) => sensor.houseId === props.house.id && sensor.enabled),
    [props.house.id, props.state.sensors],
  );
  const definitions = useMemo(() => props.state.measurementDefinitions.filter((definition) => definition.enabled), [props.state.measurementDefinitions]);
  const selectedDefinition = definitions.find((definition) => definition.id === metric) ?? definitions[0];
  const availableAggregations = useMemo(() => aggregationOptions(selectedDefinition), [selectedDefinition]);
  const metricSensors = useMemo(() => sensors.filter((sensor) => (
    Boolean(props.state.latestMeasurements[sensor.id]?.[metric])
      || (props.state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0
      || Boolean(sensor.measurementEntityIds?.[metric])
      || (metric === "temperature" && Boolean(sensor.temperatureEntityId))
      || (metric === "humidity" && Boolean(sensor.humidityEntityId))
      || sensorGaps.some((gap) => gap.sensorId === sensor.id && gap.metric === metric)
  )), [metric, props.state.latestMeasurements, props.state.measurementHistory, sensorGaps, sensors]);
  const selectedSensors = useMemo(() => selectedSensorIds === null
    ? metricSensors
    : metricSensors.filter((sensor) => selectedSensorIds.includes(sensor.id)), [metricSensors, selectedSensorIds]);

  useEffect(() => {
    if (selectedDefinition && selectedDefinition.id !== metric) setMetric(selectedDefinition.id);
  }, [metric, selectedDefinition]);

  useEffect(() => {
    if (!availableAggregations.includes(aggregation)) setAggregation("default");
  }, [aggregation, availableAggregations]);

  useEffect(() => {
    if (selectedSensorIds === null) return;
    const available = new Set(metricSensors.map((sensor) => sensor.id));
    const valid = selectedSensorIds.filter((sensorId) => available.has(sensorId));
    if (valid.length !== selectedSensorIds.length) setSelectedSensorIds(valid);
  }, [metricSensors, selectedSensorIds]);

  useEffect(() => {
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - timeRangeHours(range) * 3_600_000);
    setLoading(true);
    setHistoryError(null);
    Promise.all([
      api.outdoorTemperatureHistory(props.house.id, from.toISOString(), to.toISOString(), 100_000, controller.signal),
      api.sensorDataGaps(props.house.id, 500),
      api.houseElectricityPrice(props.house.id, from.toISOString(), new Date(to.getTime() + 48 * 3_600_000).toISOString(), controller.signal),
    ]).then(([outdoor, gaps, prices]) => {
      if (controller.signal.aborted) return;
      setOutdoorHistory(outdoor.samples);
      setSensorGaps(gaps);
      setElectricityPrices(prices.prices ?? (prices.current ? [prices.current] : []));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setHistoryError(error instanceof Error ? error.message : t("analytics.loadFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [props.house.id, range, refreshRevision, t]);

  const refresh = useCallback(() => {
    setRefreshRevision((value) => value + 1);
    void weather.refresh();
  }, [weather.refresh]);

  const fromMs = now - timeRangeHours(range) * 3_600_000;
  const selectedSensorKey = selectedSensors.map((sensor) => sensor.id).sort().join("\u0000");
  useEffect(() => {
    if (props.dataMode === "unknown" || !selectedDefinition || selectedSensors.length === 0) {
      setAnalytics(null);
      setAnalyticsError(null);
      setAnalyticsLoading(false);
      return;
    }
    const controller = new AbortController();
    const end = new Date();
    const start = new Date(end.getTime() - timeRangeHours(range) * 3_600_000);
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    void api.analyticsQuery({
      apiVersion: "1.0",
      dataMode: props.dataMode === "real" ? "live" : "demo",
      scope: { kind: "house", id: props.house.id, entityIds: selectedSensors.map((sensor) => sensor.id) },
      measurementIds: [metric],
      range: { start: start.toISOString(), end: end.toISOString(), timezone: props.house.timezone },
      resolution,
      aggregation: resolution === "raw" ? "default" : aggregation,
      qualityFilter: { include: qualitiesForPreset(qualityPreset) },
      include: ["series", "summary", "quality", "provenance"],
      maxPointsPerSeries: analyticsPointBudget(range),
      requestId: `explorer-${props.house.id}-${metric}-${range}-${resolution}-${aggregation}-${qualityPreset}-${refreshRevision}`,
    }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setAnalytics(result);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setAnalytics(null);
      setAnalyticsError(error instanceof Error ? error.message : t("analytics.queryFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setAnalyticsLoading(false);
    });
    return () => controller.abort();
  }, [aggregation, metric, props.dataMode, props.house.id, props.house.timezone, qualityPreset, range, refreshRevision, resolution, selectedDefinition, selectedSensorKey, t]);
  const thresholdMs = chartGapThresholdMs(range);
  const visibleSensorGaps = useMemo(() => selectedSensors.flatMap((sensor) => {
    const points = (props.state.measurementHistory[sensor.id]?.[metric] ?? [])
      .flatMap((sample) => {
        const timestamp = Date.parse(sample.timestamp);
        return sample.quality === "stale" || !Number.isFinite(timestamp) || timestamp < fromMs
          ? []
          : [{ timestamp }];
      })
      .sort((left, right) => left.timestamp - right.timestamp);
    return detectSeriesGaps(points, thresholdMs).map((gap) => ({ sensor, gap }));
  }), [fromMs, metric, props.state.measurementHistory, selectedSensors, thresholdMs]);
  const visibleOutdoorGaps = useMemo(() => detectSeriesGaps(
    outdoorHistory.flatMap((sample) => {
      const timestamp = Date.parse(sample.timestamp);
      return Number.isFinite(timestamp) && timestamp >= fromMs ? [{ timestamp }] : [];
    }).sort((left, right) => left.timestamp - right.timestamp),
    thresholdMs,
  ), [fromMs, outdoorHistory, thresholdMs]);
  const relevantOutdoorGaps = metric === "temperature" && weatherObservationsVisible ? visibleOutdoorGaps : [];

  const continuityRows = useMemo<ContinuityRow[]>(() => {
    const durable = sensorGaps.flatMap((gap) => {
      if (gap.metric !== metric) return [];
      const startedAt = Date.parse(gap.startedAt);
      const endedAt = Date.parse(gap.endedAt ?? new Date(now).toISOString());
      const sensor = selectedSensors.find((candidate) => candidate.id === gap.sensorId);
      if (!sensor || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < fromMs) return [];
      return [{
        id: `sensor-gap-${gap.id}`,
        source: sensor.name,
        metric: selectedDefinition ? measurementLabel(selectedDefinition, locale) : gap.metric,
        startedAt,
        endedAt,
        state: gap.recoveryState,
        recoveredPoints: gap.recoveredPoints,
        detail: gap.recoveryError,
      }];
    });
    const visibleSensors = visibleSensorGaps.flatMap(({ sensor, gap }, index) => {
      const recorded = sensorGaps.some((candidate) => candidate.sensorId === sensor.id
        && candidate.metric === metric
        && Math.abs(Date.parse(candidate.startedAt) - gap.startedAt) < 1_000
        && Math.abs(Date.parse(candidate.endedAt ?? "") - gap.endedAt) < 1_000);
      return recorded ? [] : [{
        id: `visible-sensor-gap-${sensor.id}-${gap.startedAt}-${index}`,
        source: sensor.name,
        metric: selectedDefinition ? measurementLabel(selectedDefinition, locale) : metric,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        state: "visible" as const,
        recoveredPoints: 0,
        detail: null,
      }];
    });
    const outdoor = relevantOutdoorGaps.map((gap, index) => ({
      id: `outdoor-gap-${gap.startedAt}-${index}`,
      source: t("decision.outdoor"),
      metric: t("analytics.weatherObservation"),
      startedAt: gap.startedAt,
      endedAt: gap.endedAt,
      state: "visible" as const,
      recoveredPoints: 0,
      detail: null,
    }));
    return [...durable, ...visibleSensors, ...outdoor].sort((left, right) => right.startedAt - left.startedAt);
  }, [fromMs, locale, metric, now, relevantOutdoorGaps, selectedDefinition, selectedSensors, sensorGaps, t, visibleSensorGaps]);
  const showTpLinkImportHelp = useMemo(() => sensorGaps.some((gap) => {
    if (gap.source !== "tp-link" || gap.metric !== metric || gap.recoveryState !== "not-supported") return false;
    const endedAt = Date.parse(gap.endedAt ?? new Date(now).toISOString());
    return selectedSensors.some((sensor) => sensor.id === gap.sensorId) && Number.isFinite(endedAt) && endedAt >= fromMs;
  }), [fromMs, metric, now, selectedSensors, sensorGaps]);
  const visibleGapCount = visibleSensorGaps.length + relevantOutdoorGaps.length;

  return (
    <>
      <header className="page-heading analytics-page-heading">
        <div><span className="eyebrow"><ChartLine size={14} aria-hidden="true" />{t("analytics.eyebrow")}</span><h1>{t("analytics.title")}</h1><p>{t("analytics.description")}</p></div>
        <button type="button" className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} aria-hidden="true" />{t("common.refresh")}</button>
      </header>

      {definitions.length > 0 && sensors.length > 0 ? <SensorAnalyticsChart
        sensors={metricSensors}
        history={props.state.measurementHistory}
        forecasts={props.state.measurementForecasts}
        latestMeasurements={props.state.latestMeasurements}
        definitions={definitions}
        outdoorHistory={outdoorHistory}
        weather={weather.weather}
        electricityPrices={electricityPrices}
        metric={metric}
        units={props.units}
        range={range}
        timeZone={props.house.timezone}
        selectedSensorIds={selectedSensorIds}
        weatherObservationsVisible={weatherObservationsVisible}
        weatherForecastVisible={weatherForecastVisible}
        onMetric={setMetric}
        onRange={setRange}
        onSensors={setSelectedSensorIds}
        onWeatherObservationsVisible={setWeatherObservationsVisible}
        onWeatherForecastVisible={setWeatherForecastVisible}
        onLoadSeries={props.onLoadSeries}
      /> : <div className="empty-state">{t("common.noData")}</div>}

      <section className="panel analytics-evidence-panel" aria-labelledby="analytics-evidence-title">
        <header className="panel-header">
          <div><span className="eyebrow"><Table2 size={13} aria-hidden="true" />{t("analytics.evidenceEyebrow")}</span><h2 id="analytics-evidence-title">{t("analytics.evidenceTitle")}</h2><p>{t("analytics.evidenceDescription")}</p></div>
          {analytics && <div className="analytics-export-actions">
            <span className={`analytics-coverage ${analytics.quality.coverage < 0.75 ? "warning" : "healthy"}`}>{t("analytics.coverage", { percent: Math.round(analytics.quality.coverage * 100) })}</span>
            <button type="button" className="secondary-button" onClick={() => downloadText(
              `stuga-${metric}-${range}.csv`, analyticsCsv(analytics), "text/csv;charset=utf-8",
            )}><Download size={14} aria-hidden="true" />{t("analytics.exportCsv")}</button>
            <button type="button" className="secondary-button" onClick={() => downloadText(
              `stuga-${metric}-${range}.json`, JSON.stringify(analytics, null, 2), "application/json;charset=utf-8",
            )}><FileJson size={14} aria-hidden="true" />{t("analytics.exportJson")}</button>
          </div>}
        </header>
        <div className="analytics-query-controls" role="group" aria-label={t("analytics.queryControls")}>
          <label className="field"><span>{t("analytics.resolution")}</span><select value={resolution} onChange={(event) => setResolution(event.target.value as AnalyticsResolution)}>
            {ANALYTICS_RESOLUTIONS.map((option) => <option key={option} value={option}>{t(`analytics.resolution_${option}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("analytics.aggregation")}</span><select value={resolution === "raw" ? "default" : aggregation} disabled={resolution === "raw"} onChange={(event) => setAggregation(event.target.value as AnalyticsAggregation)}>
            {availableAggregations.map((option) => <option key={option} value={option}>{t(`analytics.aggregation_${option}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("analytics.qualityFilter")}</span><select value={qualityPreset} onChange={(event) => setQualityPreset(event.target.value as QualityPreset)}>
            <option value="good">{t("analytics.quality_good")}</option>
            <option value="reliable">{t("analytics.quality_reliable")}</option>
            <option value="all">{t("analytics.quality_all")}</option>
          </select></label>
        </div>
        {analyticsLoading && <output className="analytics-query-status">{t("analytics.calculating")}</output>}
        {analyticsError && <p className="inline-error" role="status">{analyticsError}</p>}
        {analytics && selectedDefinition && <>
          {analytics.warnings.length > 0 && <ul className="analytics-query-warnings">{analytics.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>}
          <div className="analytics-summary-grid">{analytics.summaries.map((summary) => {
            const matchingSeries = analytics.series.find((series) => series.entityId === summary.entityId && series.measurementId === summary.measurementId);
            const label = matchingSeries?.entityLabel ?? summary.entityId;
            return <article key={`${summary.entityId}-${summary.measurementId}`} className="analytics-summary-card">
              <div className="analytics-summary-title"><strong>{label}</strong>{matchingSeries && <span className={`analytics-truth-class ${matchingSeries.truthClass}`}>{t(`analytics.truth_${matchingSeries.truthClass}`)}</span>}</div>
              <dl>
                <div><dt>{t("analytics.median")}</dt><dd>{summary.median === null ? "—" : formatMeasurement(summary.median, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.minimum")}</dt><dd>{summary.minimum === null ? "—" : formatMeasurement(summary.minimum, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.maximum")}</dt><dd>{summary.maximum === null ? "—" : formatMeasurement(summary.maximum, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.coverageLabel")}</dt><dd>{Math.round(summary.coverage * 100)}%</dd></div>
              </dl>
              <small>{t("analytics.sampleCount", { count: summary.count })}</small>
            </article>;
          })}</div>
          <details className="analytics-data-details">
            <summary>{t("analytics.showDataTable", { count: analytics.series.reduce((sum, series) => sum + series.points.length, 0) })}</summary>
            <div className="analytics-data-table-wrap" role="region" aria-label={t("analytics.dataTable")} tabIndex={0}><table className="analytics-data-table">
              <thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("analytics.timestamp")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.quality")}</th></tr></thead>
              <tbody>{analytics.series.flatMap((series) => series.points.map((point) => <tr key={`${series.entityId}-${series.measurementId}-${point.timestamp}`}>
                <th scope="row">{series.entityLabel}</th>
                <td><time dateTime={point.timestamp}>{formatInTimeZone(point.timestamp, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" })}</time></td>
                <td>{point.value === null ? "—" : formatMeasurement(point.value, selectedDefinition, props.units)}</td>
                <td>{Math.round(point.coverage * 100)}%</td>
                <td>{point.qualityFlags.length > 0 ? point.qualityFlags.map((flag) => flag.replaceAll("_", " ")).join(", ") : t("analytics.qualityGood")}</td>
              </tr>))}</tbody>
            </table></div>
          </details>
          <p className="analytics-provenance-note">{t("analytics.provenance", {
            resolution: analytics.resolution,
            aggregation: analytics.series[0]?.aggregation ?? "—",
            version: analytics.provenance[0]?.algorithmVersion ?? "—",
          })}</p>
        </>}
        {!analyticsLoading && !analytics && !analyticsError && <p className="analytics-no-gaps">{t("analytics.noEvidence")}</p>}
      </section>

      <section className="panel analytics-continuity-panel" aria-labelledby="analytics-continuity-title">
        <header className="panel-header">
          <div><span className="eyebrow"><Database size={13} aria-hidden="true" />{t("analytics.continuityEyebrow")}</span><h2 id="analytics-continuity-title">{t("analytics.continuityTitle")}</h2><p>{t("analytics.continuityDescription")}</p></div>
          <span className={`analytics-gap-count ${visibleGapCount > 0 ? "warning" : "healthy"}`}><TriangleAlert size={14} aria-hidden="true" />{t("analytics.visibleGapCount", { count: visibleGapCount })}</span>
        </header>
        {historyError && <p className="inline-error" role="alert">{historyError}</p>}
        {showTpLinkImportHelp && <aside className="analytics-gap-import-help">
          <FileSpreadsheet size={17} aria-hidden="true" />
          <p><strong>{t("analytics.tpLinkImportTitle")}</strong>{t("analytics.tpLinkImportHelp")}</p>
        </aside>}
        {continuityRows.length > 0 ? <details className="analytics-gap-details"><summary>{t("analytics.showGapDetails", { count: continuityRows.length })}</summary><div className="analytics-gap-table-wrap"><table className="analytics-gap-table">
          <thead><tr><th>{t("analytics.series")}</th><th>{t("sensors.analyticsMetric")}</th><th>{t("analytics.interval")}</th><th>{t("analytics.duration")}</th><th>{t("analytics.recovery")}</th></tr></thead>
          <tbody>{continuityRows.map((row) => <tr key={row.id}>
            <td>{row.source === t("decision.outdoor") && <CloudSun size={13} aria-hidden="true" />}{row.source}</td>
            <td>{row.metric}</td>
            <td><time>{formatInTimeZone(row.startedAt, locale, props.house.timezone, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time><span aria-hidden="true"> → </span><time>{formatInTimeZone(row.endedAt, locale, props.house.timezone, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time></td>
            <td>{durationLabel(row.endedAt - row.startedAt, locale)}</td>
            <td><span className={`analytics-recovery-state ${row.state}`}>{t(`analytics.recovery_${row.state}`)}</span>{row.recoveredPoints > 0 && <small>{t("analytics.recoveredPoints", { count: row.recoveredPoints })}</small>}{row.detail && <small>{row.detail}</small>}</td>
          </tr>)}</tbody>
        </table></div></details> : <p className="analytics-no-gaps">{t("analytics.noRecordedGaps")}</p>}
      </section>
    </>
  );
}
