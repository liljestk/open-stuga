import { UserFacingError } from "../api/support/request-error";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AnalyticsAggregation,
  AnalyticsResolution,
  House,
  MeasurementDefinition,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import { Check, ChevronDown, Download, Eye, FileSpreadsheet, LoaderCircle, Table2 } from "lucide-react";
import { api } from "../api";
import type { ClimateState } from "../domain";
import { useI18n } from "../i18n";
import { measurementLabel } from "../measurements";
import { houseLocalDateTimeCandidates, localObservationDateTime } from "../observationTime";
import {
  buildSensorExportTable,
  mergeAnalyticsResponses,
  sensorExportCsv,
  sensorExportXlsx,
  type SensorExportTable,
} from "../sensorDataExport";
import { twentyFourHourInputLocale } from "../dateTime";
import { hasBrowserCapability } from "../accessPolicy";
import { ScheduledDataExportsPanel } from "./ScheduledDataExportsPanel";
import "./DataExportPanel.css";
import { compareCodeUnits } from "../textOrder";

type ExportPeriod = "24h" | "7d" | "30d" | "90d" | "custom";
type ExportGranularity = "raw" | "1m" | "5m" | "15m" | "30m" | "1h" | "custom";
type ExportAggregation = Exclude<AnalyticsAggregation, "default">;

const MAX_MEASUREMENTS = 8;
const MAX_POINTS_PER_SERIES = 5_000;
// Browser exports intentionally stay interactive. Lossless raw history is
// retained server-side and retrieved in bounded pages, never as a million-row
// React/XLSX object graph.
const MAX_CLIENT_EXPORT_ROWS = 50_000;
const AGGREGATION_ORDER: ExportAggregation[] = ["mean", "time_weighted_mean", "min", "max", "last", "sum", "delta"];

interface DataExportPanelProps {
  state: ClimateState;
  house: House;
  units: UnitSystem;
  dataMode: "demo" | "real" | "unknown";
}

interface ExportRange {
  start: string;
  end: string;
}

function defaultMetrics(definitions: readonly MeasurementDefinition[]): string[] {
  const preferred = ["temperature", "humidity"].filter((id) => definitions.some((definition) => definition.id === id));
  return preferred.length > 0 ? preferred : definitions.slice(0, 2).map((definition) => definition.id);
}

function allowedAggregations(definition: MeasurementDefinition): ReadonlySet<ExportAggregation> {
  switch (definition.kind ?? "gauge") {
    case "rate": return new Set(["mean", "time_weighted_mean", "min", "max", "last"]);
    case "increment": return new Set(["sum", "min", "max", "last"]);
    case "cumulative_counter": return new Set(["delta", "min", "max", "last"]);
    case "binary_state": return new Set(["mean", "last"]);
    case "categorical_state": return new Set(["last"]);
    default: return new Set(["mean", "min", "max", "last"]);
  }
}

function commonAggregations(definitions: readonly MeasurementDefinition[]): ExportAggregation[] {
  if (definitions.length === 0) return [];
  return AGGREGATION_ORDER.filter((aggregation) => definitions.every((definition) => allowedAggregations(definition).has(aggregation)));
}

function sensorSupportsMetric(state: ClimateState, sensor: Sensor, metric: string): boolean {
  return Boolean(state.latestMeasurements[sensor.id]?.[metric])
    || (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0
    || Boolean(sensor.measurementEntityIds?.[metric])
    || Boolean(sensor.recordedMeasurementIds?.includes(metric))
    || (metric === "temperature" && Boolean(sensor.temperatureEntityId))
    || (metric === "humidity" && Boolean(sensor.humidityEntityId));
}

function resolutionFor(choice: ExportGranularity, customMinutes: string): AnalyticsResolution | null {
  if (choice !== "custom") return choice;
  const minutes = Number(customMinutes);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) return null;
  if (minutes === 60) return "1h";
  if (minutes === 1_440) return "1d";
  return `${minutes}m`;
}

function resolutionMilliseconds(resolution: AnalyticsResolution): number | null {
  if (resolution === "raw" || resolution === "auto") return null;
  if (resolution === "1h") return 3_600_000;
  if (resolution === "1d") return 86_400_000;
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes * 60_000 : null;
}

function presetMilliseconds(period: Exclude<ExportPeriod, "custom">): number {
  if (period === "24h") return 24 * 3_600_000;
  if (period === "7d") return 7 * 86_400_000;
  if (period === "30d") return 30 * 86_400_000;
  return 90 * 86_400_000;
}

function exportRange(
  period: ExportPeriod,
  customStart: string,
  customEnd: string,
  timeZone: string,
  now = Date.now(),
): ExportRange | null {
  if (period !== "custom") {
    // Minute-aligned, so a reopened preview shares the API's cached answer.
    const end = Math.floor(now / 60_000) * 60_000;
    return {
      start: new Date(end - presetMilliseconds(period)).toISOString(),
      end: new Date(end).toISOString(),
    };
  }
  const starts = houseLocalDateTimeCandidates(customStart, timeZone);
  const ends = houseLocalDateTimeCandidates(customEnd, timeZone);
  const start = starts?.[0];
  const end = ends?.at(-1);
  if (!start || !end || Date.parse(start) >= Date.parse(end) || Date.parse(end) > now + 5 * 60_000) return null;
  return { start, end };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase() || "home";
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataExportPanel(props: Readonly<DataExportPanelProps>) {
  const { locale, t } = useI18n();
  const canManageSchedules = hasBrowserCapability(props.state.session.tenant.role, "system-operations");
  const sensors = useMemo(
    () => props.state.sensors.filter((sensor) => sensor.houseId === props.house.id),
    [props.house.id, props.state.sensors],
  );
  const definitions = useMemo(() => props.state.measurementDefinitions.filter((definition) => (
    definition.enabled && definition.genericHistoryEnabled !== false && definition.genericStatsEnabled !== false
  )), [props.state.measurementDefinitions]);
  const initialMetrics = useMemo(() => defaultMetrics(definitions), [definitions]);
  const initialNow = useRef(Date.now());
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<ExportPeriod>("30d");
  const [customStart, setCustomStart] = useState(() => localObservationDateTime(new Date(initialNow.current - 30 * 86_400_000), props.house.timezone));
  const [customEnd, setCustomEnd] = useState(() => localObservationDateTime(new Date(initialNow.current), props.house.timezone));
  const [selectedSensorIds, setSelectedSensorIds] = useState(() => {
    const activeSensorIds = sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id);
    return activeSensorIds;
  });
  const [selectedMetricIds, setSelectedMetricIds] = useState(() => initialMetrics);
  const [granularity, setGranularity] = useState<ExportGranularity>("15m");
  const [customMinutes, setCustomMinutes] = useState("10");
  const [aggregation, setAggregation] = useState<ExportAggregation>("mean");
  const [preview, setPreview] = useState<SensorExportTable | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ complete: 0, total: 0 });
  const [downloading, setDownloading] = useState<"csv" | "xlsx" | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const autoPrepared = useRef(false);
  const selectableSensors = useMemo(() => sensors.filter((sensor) => (
    selectedMetricIds.length === 0
      || selectedMetricIds.some((metric) => sensorSupportsMetric(props.state, sensor, metric))
  )), [props.state.latestMeasurements, props.state.measurementHistory, selectedMetricIds, sensors]);
  const previousSelectableSensorIds = useRef(selectableSensors.map((sensor) => sensor.id));

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    const nextIds = selectableSensors.map((sensor) => sensor.id);
    const available = new Set(nextIds);
    setSelectedSensorIds((current) => {
      const previouslyAllSelected = previousSelectableSensorIds.current.every((id) => current.includes(id));
      return previouslyAllSelected ? nextIds : current.filter((id) => available.has(id));
    });
    previousSelectableSensorIds.current = nextIds;
  }, [selectableSensors]);

  useEffect(() => {
    const metricIds = new Set(definitions.map((definition) => definition.id));
    setSelectedMetricIds((current) => {
      const valid = current.filter((id) => metricIds.has(id));
      return valid.length > 0 ? valid : defaultMetrics(definitions);
    });
  }, [definitions]);

  const selectedSensors = useMemo(
    () => selectableSensors.filter((sensor) => selectedSensorIds.includes(sensor.id)),
    [selectableSensors, selectedSensorIds],
  );
  const selectedDefinitions = useMemo(
    () => definitions.filter((definition) => selectedMetricIds.includes(definition.id)),
    [definitions, selectedMetricIds],
  );
  const aggregationOptions = useMemo(() => commonAggregations(selectedDefinitions), [selectedDefinitions]);
  const includesArchivedSensors = selectedSensors.some((sensor) => !sensor.enabled);

  useEffect(() => {
    if (!aggregationOptions.includes(aggregation)) setAggregation(aggregationOptions[0] ?? "last");
  }, [aggregation, aggregationOptions]);

  const resolution = resolutionFor(granularity, customMinutes);
  const currentRange = exportRange(period, customStart, customEnd, props.house.timezone);
  const bucketMilliseconds = resolution ? resolutionMilliseconds(resolution) : null;
  const estimatedPoints = currentRange && bucketMilliseconds
    ? Math.ceil((Date.parse(currentRange.end) - Date.parse(currentRange.start)) / bucketMilliseconds) + 1
    : null;
  const estimatedRows = estimatedPoints === null ? null : estimatedPoints * selectedSensors.length;
  const validationError = (() => {
    if (props.dataMode === "unknown") return t("dataExport.errorDataMode");
    if (selectedSensors.length === 0) return t("dataExport.errorSensors");
    if (selectedDefinitions.length === 0) return t("dataExport.errorMeasurements");
    if (selectedDefinitions.length > MAX_MEASUREMENTS) return t("dataExport.errorMeasurementLimit", { count: MAX_MEASUREMENTS });
    if (!resolution) return t("dataExport.errorGranularity");
    if (!currentRange) return t("dataExport.errorRange");
    if (estimatedPoints !== null && estimatedPoints > MAX_POINTS_PER_SERIES) return t("dataExport.errorPointLimit", { count: MAX_POINTS_PER_SERIES });
    if (estimatedRows !== null && estimatedRows > MAX_CLIENT_EXPORT_ROWS) return t("dataExport.errorRowLimit");
    if (resolution !== "raw" && aggregationOptions.length === 0) return t("dataExport.errorAggregation");
    return null;
  })();
  const configurationKey = JSON.stringify({
    locale,
    units: props.units,
    period,
    customStart,
    customEnd,
    sensorIds: selectedSensors.map((sensor) => sensor.id).sort(compareCodeUnits),
    metricIds: [...selectedMetricIds].sort(compareCodeUnits),
    granularity,
    customMinutes,
    aggregation: resolution === "raw" ? "raw" : aggregation,
  });
  const previewCurrent = preview !== null && previewKey === configurationKey;

  const preparePreview = useCallback(async () => {
    const range = exportRange(period, customStart, customEnd, props.house.timezone);
    const selectedResolution = resolutionFor(granularity, customMinutes);
    if (validationError || !range || !selectedResolution) {
      setError(validationError ?? t("dataExport.errorRange"));
      return;
    }
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    setWarnings([]);
    setDownloadNotice(null);
    const duration = resolutionMilliseconds(selectedResolution);
    const pointsPerSeries = duration
      ? Math.ceil((Date.parse(range.end) - Date.parse(range.start)) / duration) + 1
      : MAX_POINTS_PER_SERIES;
    const responsePointBudget = Math.max(1, pointsPerSeries * selectedDefinitions.length);
    const batchSize = selectedResolution === "raw"
      ? 1
      : Math.max(1, Math.min(50, Math.floor(90_000 / responsePointBudget)));
    const sensorBatches = chunks(selectedSensors, batchSize);
    setProgress({ complete: 0, total: sensorBatches.length });
    try {
      const responses = [];
      let responsePointCount = 0;
      for (let index = 0; index < sensorBatches.length; index += 3) {
        const group = sensorBatches.slice(index, index + 3);
        const current = await Promise.all(group.map((sensorBatch, groupIndex) => api.analyticsQuery({
          apiVersion: "1.0",
          dataMode: props.dataMode === "real" ? "live" : "demo",
          scope: { kind: "house", id: props.house.id, entityIds: sensorBatch.map((sensor) => sensor.id) },
          measurementIds: selectedDefinitions.map((definition) => definition.id),
          range: { ...range, timezone: props.house.timezone },
          resolution: selectedResolution,
          aggregation: selectedResolution === "raw" ? "default" : aggregation,
          qualityFilter: { include: ["good", "estimated"] },
          include: ["series", "summary", "quality", "provenance"],
          maxPointsPerSeries: MAX_POINTS_PER_SERIES,
          requestId: `export-${Date.now()}-${index + groupIndex}`,
        }, controller.signal)));
        responses.push(...current);
        responsePointCount += current.reduce((total, response) => (
          total + response.series.reduce((seriesTotal, series) => seriesTotal + series.points.length, 0)
        ), 0);
        if (responsePointCount > MAX_CLIENT_EXPORT_ROWS * selectedDefinitions.length) {
          throw new UserFacingError(t("dataExport.errorRowLimit"));
        }
        setProgress({ complete: Math.min(index + group.length, sensorBatches.length), total: sensorBatches.length });
      }
      if (controller.signal.aborted) return;
      const merged = mergeAnalyticsResponses(responses, `export-${Date.now()}`);
      const table = buildSensorExportTable({
        result: merged,
        sensors: selectedSensors,
        definitions: selectedDefinitions,
        locale,
        units: props.units,
        labels: {
          localTime: t("dataExport.columnLocalTime"),
          utcTime: t("dataExport.columnUtcTime"),
          sensorName: t("dataExport.columnSensorName"),
          sensorId: t("dataExport.columnSensorId"),
        },
      });
      if (table.rows.length > MAX_CLIENT_EXPORT_ROWS) {
        setPreview(null);
        setPreviewKey(null);
        setError(t("dataExport.errorRowLimit"));
        return;
      }
      setPreview(table);
      setWarnings(merged.warnings.map((warning) => warning.message));
      setPreviewKey(configurationKey);
    } catch (cause: unknown) {
      if (controller.signal.aborted) return;
      setPreview(null);
      setPreviewKey(null);
      setError(cause instanceof Error ? cause.message : t("dataExport.errorPrepare"));
    } finally {
      if (requestController.current === controller) {
        setLoading(false);
        requestController.current = null;
      }
    }
  }, [aggregation, configurationKey, customEnd, customMinutes, customStart, granularity, locale, period, props.dataMode, props.house.id, props.house.timezone, props.units, selectedDefinitions, selectedSensors, t, validationError]);

  useEffect(() => {
    if (!open || autoPrepared.current) return;
    autoPrepared.current = true;
    void preparePreview();
  }, [open, preparePreview]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void preparePreview();
  };

  const toggleSensor = (id: string, checked: boolean) => {
    setSelectedSensorIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  };
  const toggleMetric = (id: string, checked: boolean) => {
    setSelectedMetricIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  };

  const baseFilename = preview
    ? `stugu-${slug(props.house.name)}-${preview.range.start.slice(0, 10)}-${preview.range.end.slice(0, 10)}-${preview.resolution}-${preview.aggregation}`
    : `stugu-${slug(props.house.name)}-sensor-data`;
  const startDownload = (format: "csv" | "xlsx") => {
    if (!previewCurrent || !preview) return;
    setDownloading(format);
    setDownloadNotice(null);
    setTimeout(() => {
      try {
        if (format === "csv") {
          downloadBlob(`${baseFilename}.csv`, new Blob(["\uFEFF", sensorExportCsv(preview)], { type: "text/csv;charset=utf-8" }));
          setDownloadNotice(t("dataExport.downloadedCsv"));
        } else {
          const bytes = sensorExportXlsx(preview, t("dataExport.sheetName"));
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          downloadBlob(`${baseFilename}.xlsx`, new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
          setDownloadNotice(t("dataExport.downloadedXlsx"));
        }
      } finally {
        setDownloading(null);
      }
    }, 0);
  };

  const previewRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows
      .filter((row) => preview.columns.some((column) => typeof row.values[column.id] === "number"))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 12);
  }, [preview]);
  const numberFormatters = useMemo(() => new Map(selectedDefinitions.map((definition) => [
    definition.id,
    new Intl.NumberFormat(locale, { minimumFractionDigits: definition.precision, maximumFractionDigits: definition.precision }),
  ])), [locale, selectedDefinitions]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
  };

  return <section className="data-export-section" aria-labelledby="data-export-title">
    <details open={open} onToggle={(event) => handleOpenChange(event.currentTarget.open)}>
      <summary>
        <span className="data-export-icon"><FileSpreadsheet size={19} aria-hidden="true" /></span>
        <span className="data-export-summary-copy"><span className="eyebrow">{t("dataExport.eyebrow")}</span><h2 id="data-export-title">{t("dataExport.title")}</h2><small>{t("dataExport.description")}</small></span>
        <span className="data-export-format-badge">{t("dataExport.formatBadge")}</span>
        <ChevronDown className="data-export-chevron" size={19} aria-hidden="true" />
      </summary>
      {open && <div className="data-export-content">
        <aside className="data-export-example">
          <Check size={17} aria-hidden="true" />
          <p><strong>{t("dataExport.exampleTitle")}</strong>{t("dataExport.exampleBody")}</p>
        </aside>

        <form onSubmit={submit}>
          <div className="data-export-config-grid">
            <label className="field"><span>{t("dataExport.period")}</span><select value={period} onChange={(event) => setPeriod(event.target.value as ExportPeriod)}>
              <option value="24h">{t("dataExport.period24h")}</option><option value="7d">{t("dataExport.period7d")}</option><option value="30d">{t("dataExport.period30d")}</option><option value="90d">{t("dataExport.period90d")}</option><option value="custom">{t("dataExport.periodCustom")}</option>
            </select></label>

            <div className="field data-export-picker-field"><span>{t("dataExport.sensors")}</span><details className="data-export-picker">
              <summary>{selectedSensors.length === selectableSensors.length ? t("dataExport.allSensors", { count: selectableSensors.length }) : t("dataExport.selectedSensors", { count: selectedSensors.length })}</summary>
              <div className="data-export-picker-menu">
                <div className="data-export-picker-actions"><button type="button" onClick={() => setSelectedSensorIds(selectableSensors.map((sensor) => sensor.id))}>{t("sensors.analyticsSelectAll")}</button><button type="button" onClick={() => setSelectedSensorIds([])}>{t("sensors.analyticsClear")}</button></div>
                <fieldset><legend className="sr-only">{t("dataExport.sensors")}</legend>{selectableSensors.map((sensor) => {
                  const available = selectedMetricIds.filter((metric) => sensorSupportsMetric(props.state, sensor, metric))
                    .flatMap((metric) => {
                      const definition = definitions.find((candidate) => candidate.id === metric);
                      return definition ? [measurementLabel(definition, locale)] : [];
                    });
                  return <label key={sensor.id}><input type="checkbox" checked={selectedSensorIds.includes(sensor.id)} onChange={(event) => toggleSensor(sensor.id, event.target.checked)} /><span><strong>{sensor.name}{sensor.enabled ? "" : ` · ${t("sensors.archived")}`}</strong><small>{available.length > 0 ? available.join(", ") : t("dataExport.noSelectedData")}</small></span></label>;
                })}</fieldset>
              </div>
            </details></div>

            <div className="field data-export-picker-field"><span>{t("dataExport.measurements")}</span><details className="data-export-picker">
              <summary>{t("dataExport.selectedMeasurements", { count: selectedDefinitions.length })}</summary>
              <div className="data-export-picker-menu">
                <div className="data-export-picker-actions"><button type="button" onClick={() => setSelectedMetricIds(definitions.slice(0, MAX_MEASUREMENTS).map((definition) => definition.id))}>{t("sensors.analyticsSelectAll")}</button><button type="button" onClick={() => setSelectedMetricIds([])}>{t("sensors.analyticsClear")}</button></div>
                <fieldset><legend className="sr-only">{t("dataExport.measurements")}</legend>{definitions.map((definition) => {
                  const checked = selectedMetricIds.includes(definition.id);
                  const disabled = !checked && selectedMetricIds.length >= MAX_MEASUREMENTS;
                  return <label key={definition.id}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => toggleMetric(definition.id, event.target.checked)} /><span><strong>{measurementLabel(definition, locale)}</strong><small>{definition.unit}</small></span></label>;
                })}</fieldset>
              </div>
            </details></div>

            <label className="field"><span>{t("dataExport.granularity")}</span><select value={granularity} onChange={(event) => setGranularity(event.target.value as ExportGranularity)}>
              <option value="raw">{t("analytics.resolution_raw")}</option><option value="1m">{t("analytics.resolution_1m")}</option><option value="5m">{t("analytics.resolution_5m")}</option><option value="15m">{t("analytics.resolution_15m")}</option><option value="30m">{t("analytics.resolution_30m")}</option><option value="1h">{t("analytics.resolution_1h")}</option><option value="custom">{t("dataExport.granularityCustom")}</option>
            </select></label>

            <label className="field"><span>{t("dataExport.combine")}</span><select value={resolution === "raw" ? "raw" : aggregation} disabled={resolution === "raw"} onChange={(event) => setAggregation(event.target.value as ExportAggregation)}>
              {resolution === "raw" && <option value="raw">{t("dataExport.noCombination")}</option>}
              {resolution !== "raw" && aggregationOptions.map((option) => <option key={option} value={option}>{t(`dataExport.aggregation_${option}`)}</option>)}
            </select><small>{resolution === "raw" ? t("dataExport.rawHelp") : t("dataExport.combineHelp")}</small></label>

            {granularity === "custom" && <label className="field"><span>{t("dataExport.customMinutes")}</span><input type="number" min="1" max="1440" step="1" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value)} /><small>{t("dataExport.customMinutesHelp")}</small></label>}
          </div>

          {period === "custom" && <div className="data-export-custom-range">
            <label className="field"><span>{t("dataExport.start")}</span><input type="datetime-local" lang={twentyFourHourInputLocale(locale)} step="60" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label>
            <label className="field"><span>{t("dataExport.end")}</span><input type="datetime-local" lang={twentyFourHourInputLocale(locale)} step="60" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label>
            <p>{t("dataExport.timeZoneHelp", { zone: props.house.timezone })}</p>
          </div>}

          <div className="data-export-form-footer">
            <p>{t("dataExport.qualityHelp")}</p>
            <button type="submit" className="primary-button" disabled={loading || Boolean(validationError)}>{loading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{loading ? t("dataExport.preparing") : preview ? t("dataExport.updatePreview") : t("dataExport.previewAction")}</button>
          </div>
          {(validationError || error) && <p className="inline-error data-export-error" role="alert">{validationError ?? error}</p>}
          {loading && <output className="data-export-progress">{t("dataExport.progress", { complete: progress.complete, total: progress.total })}</output>}
        </form>

        {canManageSchedules && <ScheduledDataExportsPanel
          house={props.house}
          period={period}
          sensorIds={selectedSensors.map((sensor) => sensor.id)}
          measurementIds={selectedMetricIds}
          resolution={resolution}
          aggregation={resolution === "raw" ? "default" : aggregation}
          configurationError={validationError ?? (includesArchivedSensors ? t("dataExport.scheduleArchivedSelection") : null)}
        />}

        {preview && <section className={`data-export-preview ${previewCurrent ? "current" : "stale"}`} aria-labelledby="data-export-preview-title">
          <header><div><span className="eyebrow">{previewCurrent ? t("dataExport.previewReady") : t("dataExport.previewStale")}</span><h3 id="data-export-preview-title">{t("dataExport.previewTitle")}</h3><p>{t("dataExport.previewSummary", { shown: previewRows.length, total: preview.rows.length })}</p></div><span className="data-export-row-count"><Table2 size={14} aria-hidden="true" />{t("dataExport.rows", { count: preview.rows.length })}</span></header>
          {warnings.length > 0 && <ul className="data-export-warnings">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {previewRows.length > 0 ? <div className="data-export-table-wrap" role="region" aria-label={t("dataExport.previewTable")} tabIndex={0}><table>
            <thead><tr><th scope="col">{preview.labels.localTime}</th><th scope="col">{preview.labels.utcTime}</th><th scope="col">{preview.labels.sensorName}</th><th scope="col">{preview.labels.sensorId}</th>{preview.columns.map((column) => <th key={column.id} scope="col">{column.label}{column.unit && <small>{column.unit}</small>}</th>)}</tr></thead>
            <tbody>{previewRows.map((row) => <tr key={`${row.sensorId}-${row.timestamp}`}><td><time dateTime={row.timestamp}>{row.localTimestamp}</time></td><td><time dateTime={row.timestamp}>{row.timestamp}</time></td><th scope="row">{row.sensorName}</th><td>{row.sensorId}</td>{preview.columns.map((column) => {
              const value = row.values[column.id];
              return <td key={column.id} className={value == null ? "missing" : undefined}>{value == null ? "—" : numberFormatters.get(column.id)?.format(value)}</td>;
            })}</tr>)}</tbody>
          </table></div> : <p className="data-export-empty">{t("dataExport.noRows")}</p>}
          <footer><p>{previewCurrent ? t("dataExport.downloadHelp") : t("dataExport.staleHelp")}</p><div className="data-export-downloads"><button type="button" className="secondary-button" disabled={!previewCurrent || downloading !== null || previewRows.length === 0} onClick={() => startDownload("csv")}><Download size={15} aria-hidden="true" />{downloading === "csv" ? t("dataExport.downloading") : t("dataExport.downloadCsv")}</button><button type="button" className="primary-button" disabled={!previewCurrent || downloading !== null || previewRows.length === 0} onClick={() => startDownload("xlsx")}><FileSpreadsheet size={15} aria-hidden="true" />{downloading === "xlsx" ? t("dataExport.downloading") : t("dataExport.downloadXlsx")}</button></div></footer>
        </section>}
        {downloadNotice && <p className="sr-only" role="status" aria-live="polite">{downloadNotice}</p>}
      </div>}
    </details>
  </section>;
}
