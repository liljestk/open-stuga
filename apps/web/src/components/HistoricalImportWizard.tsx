import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  TableProperties,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import type { House, MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { HistoricalImportResult } from "../api";
import {
  buildHistoricalImport,
  columnLabels,
  createInitialMapping,
  readHistoricalFile,
  type HistoricalImportMapping,
  type ImportSheet,
  type InputUnit,
} from "../historicalImport";
import { useI18n, type TranslationKey } from "../i18n";

interface HistoricalImportWizardProps {
  open: boolean;
  house: House;
  sensors: Sensor[];
  definitions: MeasurementDefinition[];
  onClose: () => void;
  onImport: (
    samples: MeasurementSample[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<HistoricalImportResult>;
}

type WizardStep = 1 | 2 | 3 | 4;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function HistoricalImportWizard({
  open,
  house,
  sensors,
  definitions,
  onClose,
  onImport,
}: HistoricalImportWizardProps) {
  const { locale, t } = useI18n();
  const id = useId().replace(/:/g, "");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<ImportSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<HistoricalImportMapping | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [result, setResult] = useState<HistoricalImportResult | null>(null);

  const sheet = sheets[sheetIndex];
  const headers = useMemo(() => sheet && mapping ? columnLabels(sheet, mapping.headerRow) : [], [mapping, sheet]);
  const preview = useMemo(() => sheet && mapping
    ? buildHistoricalImport(sheet, mapping, sensors, definitions, house.timezone)
    : null, [definitions, house.timezone, mapping, sensors, sheet]);
  const sensorNames = useMemo(() => new Map(sensors.map((sensor) => [sensor.id, sensor.name])), [sensors]);
  const definitionNames = useMemo(() => new Map(definitions.map((definition) => [definition.id, definition.labels[locale] ?? definition.labels.en ?? definition.id])), [definitions, locale]);
  const issueRowCount = useMemo(() => new Set(preview?.issues.map((issue) => issue.row) ?? []).size, [preview]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setStep(1);
      setFileName("");
      setSheets([]);
      setSheetIndex(0);
      setMapping(null);
      setError(null);
      setImporting(false);
      setProgress({ completed: 0, total: 0 });
      setResult(null);
    }
  }, [open]);

  if (!open) return null;

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setReadingFile(true);
    setError(null);
    try {
      const loaded = await readHistoricalFile(file);
      const initial = createInitialMapping(loaded[0]!, definitions, sensors, locale);
      setFileName(file.name);
      setSheets(loaded);
      setSheetIndex(0);
      setMapping(initial);
      setStep(2);
    } catch (loadError) {
      setError(message(loadError, t("historyImport.fileError")));
    } finally {
      setReadingFile(false);
    }
  };

  const changeSheet = (nextIndex: number) => {
    const next = sheets[nextIndex];
    if (!next) return;
    setSheetIndex(nextIndex);
    setMapping(createInitialMapping(next, definitions, sensors, locale));
    setError(null);
  };

  const changeHeaderRow = (headerRow: number) => {
    if (!sheet) return;
    setMapping(createInitialMapping(sheet, definitions, sensors, locale, headerRow));
  };

  const mappedWideColumn = (column: number) => mapping?.wideColumns.find((item) => item.column === column);
  const setWideMetric = (column: number, metric: string) => {
    if (!mapping) return;
    const without = mapping.wideColumns.filter((item) => item.column !== column);
    setMapping({
      ...mapping,
      wideColumns: metric ? [...without, { column, metric, inputUnit: "canonical" }] : without,
    });
  };
  const setWideUnit = (column: number, inputUnit: InputUnit) => {
    if (!mapping) return;
    setMapping({ ...mapping, wideColumns: mapping.wideColumns.map((item) => item.column === column ? { ...item, inputUnit } : item) });
  };

  const readyToPreview = Boolean(mapping && preview && sensors.length > 0 && (mapping.mode === "wide"
    ? mapping.wideColumns.length > 0
    : mapping.longValueColumn >= 0 && (mapping.longMetricColumn !== null || mapping.longFixedMetric)));
  const startImport = async () => {
    if (!preview?.samples.length) return;
    setImporting(true);
    setError(null);
    setProgress({ completed: 0, total: preview.samples.length });
    setStep(4);
    try {
      const imported = await onImport(preview.samples, (completed, total) => setProgress({ completed, total }));
      setResult(imported);
    } catch (importError) {
      setError(message(importError, t("historyImport.importError")));
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = () => {
    const sensor = sensors[0];
    const headers = ["Date and time", "Sensor", ...definitions.slice(0, 4).map((definition) => `${definition.labels.en ?? definition.id} (${definition.unit})`)];
    const example = [
      "2026-01-15 08:00",
      sensor?.name ?? "Living room",
      ...definitions.slice(0, 4).map((definition) => definition.id === "humidity" ? "45" : definition.id === "co2" ? "650" : definition.id === "temperature" ? "21.5" : "0"),
    ];
    const blob = new Blob([[headers, example].map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "stuga-history-import-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !importing) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), [tabindex="0"]') ?? [])]
      .filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const formatDate = (timestamp: string | null) => timestamp
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: house.timezone }).format(Date.parse(timestamp))
    : "—";

  return (
    <div className="history-import-backdrop" role="presentation">
      <section ref={dialogRef} className="history-import-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={handleDialogKeyDown}>
        <header className="history-import-header">
          <div>
            <span className="eyebrow"><FileSpreadsheet size={14} aria-hidden="true" />{t("historyImport.eyebrow")}</span>
            <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1}>{t(`historyImport.step${step}Title`)}</h2>
            <p>{t(`historyImport.step${step}Description`, { house: house.name })}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={importing} aria-label={t("historyImport.close")}><X size={19} /></button>
        </header>

        <ol className="history-import-stepper" aria-label={t("historyImport.progress") }>
          {[1, 2, 3, 4].map((item) => (
            <li key={item} className={item < step ? "complete" : item === step ? "active" : ""} aria-current={item === step ? "step" : undefined}>
              <span>{item < step ? <Check size={13} aria-hidden="true" /> : item}</span>
              <small>{t(`historyImport.step${item}Short` as TranslationKey)}</small>
            </li>
          ))}
        </ol>

        <div className="history-import-body">
          {step === 1 && (
            <div className="history-import-file-step">
              <div
                className={`history-import-dropzone ${dragging ? "dragging" : ""}`}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={dropFile}
              >
                {readingFile ? <LoaderCircle className="spin" size={34} aria-hidden="true" /> : <Upload size={34} aria-hidden="true" />}
                <strong>{readingFile ? t("historyImport.reading") : t("historyImport.dropTitle")}</strong>
                <p>{t("historyImport.dropHelp")}</p>
                <input ref={inputRef} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" accept=".xlsx,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void loadFile(event.target.files?.[0])} />
                <button type="button" className="primary-button" disabled={readingFile} onClick={() => inputRef.current?.click()}>{t("historyImport.chooseFile")}</button>
                <small>{t("historyImport.fileTypes")}</small>
              </div>
              <div className="history-import-template">
                <span><TableProperties size={19} aria-hidden="true" /></span>
                <div><strong>{t("historyImport.templateTitle")}</strong><p>{t("historyImport.templateHelp")}</p></div>
                <button type="button" className="secondary-button" onClick={downloadTemplate}><Download size={15} aria-hidden="true" />{t("historyImport.downloadTemplate")}</button>
              </div>
            </div>
          )}

          {step === 2 && sheet && mapping && (
            <div className="history-import-map-step">
              <div className="history-import-file-summary"><FileSpreadsheet size={19} aria-hidden="true" /><span><strong>{fileName}</strong><small>{t("historyImport.rowsFound", { count: Math.max(0, sheet.rows.length - mapping.headerRow - 1) })}</small></span><button type="button" className="text-button" onClick={() => setStep(1)}>{t("historyImport.changeFile")}</button></div>

              <div className="history-import-basic-grid">
                {sheets.length > 1 && <label><span>{t("historyImport.sheet")}</span><select value={sheetIndex} onChange={(event) => changeSheet(Number(event.target.value))}>{sheets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</select></label>}
                <label><span>{t("historyImport.headerRow")}</span><select value={mapping.headerRow} onChange={(event) => changeHeaderRow(Number(event.target.value))}>{sheet.rows.slice(0, 10).map((row, index) => <option key={index} value={index}>{t("historyImport.rowNumber", { number: index + 1 })}: {row.filter(Boolean).slice(0, 3).join(" · ")}</option>)}</select></label>
                <label><span>{t("historyImport.dateColumn")}</span><select value={mapping.timestampColumn} onChange={(event) => setMapping({ ...mapping, timestampColumn: Number(event.target.value) })}>{headers.map((header, column) => <option key={column} value={column}>{header}</option>)}</select></label>
                <label><span>{t("historyImport.dateFormat")}</span><select value={mapping.dateOrder} onChange={(event) => setMapping({ ...mapping, dateOrder: event.target.value as HistoricalImportMapping["dateOrder"] })}><option value="auto">{t("historyImport.dateAuto")}</option><option value="ymd">{t("historyImport.dateYmd")}</option><option value="dmy">{t("historyImport.dateDmy")}</option><option value="mdy">{t("historyImport.dateMdy")}</option></select><small>{t("historyImport.timezoneHelp", { timezone: house.timezone })}</small></label>
              </div>

              <fieldset className="history-import-sensor-map">
                <legend>{t("historyImport.sensorQuestion")}</legend>
                <label><span>{t("historyImport.sensorSource")}</span><select value={mapping.sensorColumn === null ? "fixed" : String(mapping.sensorColumn)} onChange={(event) => setMapping({ ...mapping, sensorColumn: event.target.value === "fixed" ? null : Number(event.target.value) })}><option value="fixed">{t("historyImport.oneSensor")}</option>{headers.map((header, column) => <option key={column} value={column}>{t("historyImport.columnNamed", { name: header })}</option>)}</select></label>
                {mapping.sensorColumn === null && <label><span>{t("historyImport.chooseSensor")}</span><select value={mapping.fallbackSensorId} onChange={(event) => setMapping({ ...mapping, fallbackSensorId: event.target.value })}>{sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}{sensor.enabled ? "" : ` (${t("sensors.archived")})`}</option>)}</select></label>}
                {mapping.sensorColumn !== null && <p>{t("historyImport.sensorMatchingHelp")}</p>}
              </fieldset>

              <fieldset className="history-import-layout-choice">
                <legend>{t("historyImport.layoutQuestion")}</legend>
                <label className={mapping.mode === "wide" ? "selected" : ""}><input type="radio" checked={mapping.mode === "wide"} onChange={() => setMapping({ ...mapping, mode: "wide" })} /><span><strong>{t("historyImport.columnsLayout")}</strong><small>{t("historyImport.columnsLayoutHelp")}</small></span></label>
                <label className={mapping.mode === "long" ? "selected" : ""}><input type="radio" checked={mapping.mode === "long"} onChange={() => setMapping({ ...mapping, mode: "long" })} /><span><strong>{t("historyImport.rowsLayout")}</strong><small>{t("historyImport.rowsLayoutHelp")}</small></span></label>
              </fieldset>

              {mapping.mode === "wide" ? (
                <section className="history-import-column-map" aria-labelledby={`${id}-measurements-title`}>
                  <div><h3 id={`${id}-measurements-title`}>{t("historyImport.measurementColumns")}</h3><p>{t("historyImport.measurementColumnsHelp")}</p></div>
                  <div className="history-import-map-list">
                    {headers.map((header, column) => {
                      if (column === mapping.timestampColumn || column === mapping.sensorColumn) return null;
                      const selected = mappedWideColumn(column);
                      return <div key={column}><strong>{header}</strong><ArrowRight size={15} aria-hidden="true" /><label><span className="sr-only">{t("historyImport.mapColumn", { name: header })}</span><select value={selected?.metric ?? ""} onChange={(event) => setWideMetric(column, event.target.value)}><option value="">{t("historyImport.doNotImport")}</option>{definitions.map((definition) => <option key={definition.id} value={definition.id}>{definitionNames.get(definition.id)} ({definition.unit})</option>)}</select></label>{selected?.metric === "temperature" && <label><span className="sr-only">{t("historyImport.unitFor", { name: header })}</span><select value={selected.inputUnit} onChange={(event) => setWideUnit(column, event.target.value as InputUnit)}><option value="canonical">°C</option><option value="fahrenheit">°F</option><option value="kelvin">K</option></select></label>}</div>;
                    })}
                  </div>
                </section>
              ) : (
                <section className="history-import-long-map">
                  <label><span>{t("historyImport.metricSource")}</span><select value={mapping.longMetricColumn === null ? "fixed" : String(mapping.longMetricColumn)} onChange={(event) => setMapping({ ...mapping, longMetricColumn: event.target.value === "fixed" ? null : Number(event.target.value) })}><option value="fixed">{t("historyImport.oneMeasurement")}</option>{headers.map((header, column) => <option key={column} value={column}>{header}</option>)}</select></label>
                  {mapping.longMetricColumn === null && <label><span>{t("common.metric")}</span><select value={mapping.longFixedMetric} onChange={(event) => setMapping({ ...mapping, longFixedMetric: event.target.value })}>{definitions.map((definition) => <option key={definition.id} value={definition.id}>{definitionNames.get(definition.id)} ({definition.unit})</option>)}</select></label>}
                  <label><span>{t("historyImport.valueColumn")}</span><select value={mapping.longValueColumn} onChange={(event) => setMapping({ ...mapping, longValueColumn: Number(event.target.value) })}>{headers.map((header, column) => <option key={column} value={column}>{header}</option>)}</select></label>
                  <label><span>{t("historyImport.unitColumn")}</span><select value={mapping.longUnitColumn === null ? "none" : String(mapping.longUnitColumn)} onChange={(event) => setMapping({ ...mapping, longUnitColumn: event.target.value === "none" ? null : Number(event.target.value) })}><option value="none">{t("historyImport.useSavedUnit")}</option>{headers.map((header, column) => <option key={column} value={column}>{header}</option>)}</select></label>
                </section>
              )}
              {!readyToPreview && <p className="history-import-error-message" role="status"><TriangleAlert size={16} aria-hidden="true" />{sensors.length ? t("historyImport.chooseMeasurementHelp") : t("historyImport.noSensors")}</p>}
            </div>
          )}

          {step === 3 && preview && (
            <div className="history-import-review-step">
              <div className="history-import-review-stats">
                <div><strong>{preview.samples.length.toLocaleString(locale)}</strong><span>{t("historyImport.measurementsReady")}</span></div>
                <div><strong>{preview.sensorIds.length}</strong><span>{t("historyImport.sensorsMatched")}</span></div>
                <div><strong>{preview.metricIds.length}</strong><span>{t("historyImport.typesMatched")}</span></div>
                <div className={issueRowCount ? "warning" : "good"}><strong>{issueRowCount}</strong><span>{t("historyImport.rowsNeedAttention")}</span></div>
              </div>
              <div className="history-import-range"><CalendarClock size={20} aria-hidden="true" /><span><strong>{t("historyImport.dateRange")}</strong><small>{formatDate(preview.firstTimestamp)} — {formatDate(preview.lastTimestamp)}</small></span></div>
              {preview.issues.length > 0 && <section className="history-import-issues" aria-labelledby={`${id}-issues-title`}><div><TriangleAlert size={18} aria-hidden="true" /><span><h3 id={`${id}-issues-title`}>{t("historyImport.issueTitle", { count: issueRowCount })}</h3><p>{t("historyImport.issueHelp")}</p></span></div><div className="table-scroll"><table><thead><tr><th>{t("historyImport.row")}</th><th>{t("historyImport.problem")}</th></tr></thead><tbody>{preview.issues.slice(0, 25).map((issue, index) => <tr key={`${issue.row}-${index}`}><td>{issue.row}</td><td>{issue.message}</td></tr>)}</tbody></table></div>{preview.issues.length > 25 && <small>{t("historyImport.moreIssues", { count: preview.issues.length - 25 })}</small>}</section>}
              <section className="history-import-preview" aria-labelledby={`${id}-preview-title`}><div><h3 id={`${id}-preview-title`}>{t("historyImport.previewTitle")}</h3><p>{t("historyImport.previewHelp")}</p></div><div className="table-scroll"><table><thead><tr><th>{t("historyImport.dateTime")}</th><th>{t("historyImport.sensor")}</th><th>{t("common.metric")}</th><th>{t("historyImport.value")}</th></tr></thead><tbody>{preview.samples.slice(0, 8).map((sample, index) => <tr key={`${sample.sensorId}-${sample.metric}-${sample.timestamp}-${index}`}><td>{formatDate(sample.timestamp)}</td><td>{sensorNames.get(sample.sensorId) ?? sample.sensorId}</td><td>{definitionNames.get(sample.metric) ?? sample.metric}</td><td>{sample.value} {sample.canonicalUnit}</td></tr>)}</tbody></table></div></section>
              <p className="history-import-safe-note"><CheckCircle2 size={17} aria-hidden="true" />{t("historyImport.safeNote")}</p>
            </div>
          )}

          {step === 4 && (
            <div className="history-import-finish-step">
              {importing ? <><LoaderCircle className="spin" size={45} aria-hidden="true" /><h3>{t("historyImport.importing")}</h3><p>{t("historyImport.importingHelp")}</p><progress max={Math.max(1, progress.total)} value={progress.completed} /><strong>{t("historyImport.progressCount", { completed: progress.completed, total: progress.total })}</strong></> : result ? <><span className="history-import-success"><CheckCircle2 size={42} aria-hidden="true" /></span><h3>{t("historyImport.completeTitle")}</h3><p>{t("historyImport.completeHelp", { count: result.accepted, house: house.name })}</p><div className="history-import-result"><span><strong>{result.accepted.toLocaleString(locale)}</strong>{t("historyImport.added")}</span><span><strong>{result.ignoredDuplicates.toLocaleString(locale)}</strong>{t("historyImport.alreadyThere")}</span></div></> : <><span className="history-import-error"><TriangleAlert size={38} aria-hidden="true" /></span><h3>{t("historyImport.failedTitle")}</h3><p>{error}</p><p>{t("historyImport.retryHelp")}</p></>}
            </div>
          )}

          {error && step !== 4 && <p className="history-import-error-message" role="alert"><TriangleAlert size={16} aria-hidden="true" />{error}</p>}
        </div>

        <footer className="history-import-actions">
          {step === 1 && <><span /><button type="button" className="secondary-button" onClick={onClose}>{t("common.cancel")}</button></>}
          {step === 2 && <><button type="button" className="secondary-button" onClick={() => setStep(1)}><ArrowLeft size={15} aria-hidden="true" />{t("sensors.back")}</button><button type="button" className="primary-button" disabled={!readyToPreview} onClick={() => setStep(3)}>{t("historyImport.reviewData")}<ArrowRight size={15} aria-hidden="true" /></button></>}
          {step === 3 && <><button type="button" className="secondary-button" onClick={() => setStep(2)}><ArrowLeft size={15} aria-hidden="true" />{t("historyImport.fixMapping")}</button><button type="button" className="primary-button" disabled={!preview?.samples.length} onClick={() => void startImport()}><Upload size={15} aria-hidden="true" />{t("historyImport.importCount", { count: preview?.samples.length ?? 0 })}</button></>}
          {step === 4 && !importing && result && <><span /><button type="button" className="primary-button" onClick={onClose}>{t("historyImport.done")}</button></>}
          {step === 4 && !importing && !result && <><button type="button" className="secondary-button" onClick={() => setStep(3)}><ArrowLeft size={15} aria-hidden="true" />{t("sensors.back")}</button><button type="button" className="primary-button" onClick={() => void startImport()}>{t("historyImport.tryAgain")}</button></>}
        </footer>
      </section>
    </div>
  );
}
