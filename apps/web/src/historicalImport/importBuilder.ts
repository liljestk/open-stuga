import type { MeasurementDefinition, Sensor, MeasurementSample } from "@climate-twin/contracts";
import { type HistoricalImportMapping, type HistoricalImportPreview, type ImportCell, type ImportIssue, type ImportSheet, type InputUnit, MAX_RETAINED_ISSUES, isBlank, validateImportSheet } from "./importModel";
import { convertValue, createImportLookups, numberValue, resolveMetric, resolveSensor, unitFromCell } from "./importValues";
import { parseImportTimestamp } from "./importTimestamps";

export interface HistoricalImportBuilder {
  firstDataRow: number;
  lastDataRow: number;
  processRows: (start: number, end: number) => void;
  finish: () => HistoricalImportPreview;
}

export function createHistoricalImportBuilder(
  sheet: ImportSheet,
  mapping: HistoricalImportMapping,
  sensors: Sensor[],
  definitions: MeasurementDefinition[],
  timeZone: string,
): HistoricalImportBuilder {
  validateImportSheet(sheet);
  const samples: MeasurementSample[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  const sensorIds = new Set<string>();
  const metricIds = new Set<string>();
  let skippedEmpty = 0;
  let duplicatesInFile = 0;
  let usableRows = 0;
  let issueCount = 0;
  let issueRowCount = 0;
  let lastIssueRow: number | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  const firstDataRow = mapping.headerRow + 1;
  const sourceRows = Math.max(0, sheet.rows.length - firstDataRow);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const lookups = createImportLookups(sensors, definitions);
  const addIssue = (row: number, message: string) => {
    issueCount += 1;
    if (row !== lastIssueRow) {
      issueRowCount += 1;
      lastIssueRow = row;
    }
    if (issues.length < MAX_RETAINED_ISSUES) issues.push({ row, message });
  };

  const processRows = (start: number, end: number) => {
    for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
      const row = sheet.rows[rowIndex]!;
      const rowNumber = rowIndex + 1;
      if (row.every((cell) => isBlank(cell))) { skippedEmpty += 1; continue; }
      const timestamp = parseImportTimestamp(row[mapping.timestampColumn], timeZone, mapping.dateOrder);
      if (!timestamp) { addIssue(rowNumber, "The date or time could not be read."); continue; }
      const sensor = resolveSensor(mapping.sensorColumn === null ? undefined : row[mapping.sensorColumn], lookups, mapping.fallbackSensorId);
      if (!sensor) { addIssue(rowNumber, "The sensor does not match a sensor in this house."); continue; }
      const candidates: Array<{ definition: MeasurementDefinition; raw: ImportCell | undefined; unit: InputUnit }> = [];
      if (mapping.mode === "wide") {
        for (const item of mapping.wideColumns) {
          const definition = definitionsById.get(item.metric);
          if (definition && !isBlank(row[item.column])) candidates.push({ definition, raw: row[item.column], unit: item.inputUnit });
        }
      } else {
        const definition = resolveMetric(mapping.longMetricColumn === null ? undefined : row[mapping.longMetricColumn], definitionsById, lookups, mapping.longFixedMetric);
        if (!definition) { addIssue(rowNumber, "The measurement type is not recognized."); continue; }
        if (!isBlank(row[mapping.longValueColumn])) candidates.push({
          definition,
          raw: row[mapping.longValueColumn],
          unit: mapping.longUnitColumn === null ? "canonical" : unitFromCell(row[mapping.longUnitColumn]),
        });
      }
      if (!candidates.length) { skippedEmpty += 1; continue; }
      let rowAccepted = false;
      for (const candidate of candidates) {
        const parsed = numberValue(candidate.raw);
        if (parsed === null) { addIssue(rowNumber, `${candidate.definition.labels.en ?? candidate.definition.id} is not a number.`); continue; }
        const value = convertValue(parsed, candidate.unit);
        if (candidate.definition.validMin !== null && value < candidate.definition.validMin
          || candidate.definition.validMax !== null && value > candidate.definition.validMax) {
          addIssue(rowNumber, `${candidate.definition.labels.en ?? candidate.definition.id} is outside the allowed range.`);
          continue;
        }
        const sample: MeasurementSample = {
          sensorId: sensor.id,
          metric: candidate.definition.id,
          value: Number(value.toFixed(Math.max(candidate.definition.precision, 4))),
          canonicalUnit: candidate.definition.unit,
          timestamp,
          source: "import",
          quality: "good",
        };
        const key = `${sample.sensorId}\u0000${sample.metric}\u0000${sample.timestamp}`;
        if (seen.has(key)) { duplicatesInFile += 1; continue; }
        seen.add(key);
        samples.push(sample);
        sensorIds.add(sample.sensorId);
        metricIds.add(sample.metric);
        if (firstTimestamp === null || sample.timestamp < firstTimestamp) firstTimestamp = sample.timestamp;
        if (lastTimestamp === null || sample.timestamp > lastTimestamp) lastTimestamp = sample.timestamp;
        rowAccepted = true;
      }
      if (rowAccepted) usableRows += 1;
    }
  };
  return {
    firstDataRow,
    lastDataRow: sheet.rows.length,
    processRows,
    finish: () => ({
      samples,
      issues,
      issueCount,
      issueRowCount,
      sourceRows,
      usableRows,
      skippedEmpty,
      duplicatesInFile,
      firstTimestamp,
      lastTimestamp,
      sensorIds: [...sensorIds],
      metricIds: [...metricIds],
    }),
  };
}

export function buildHistoricalImport(
  sheet: ImportSheet,
  mapping: HistoricalImportMapping,
  sensors: Sensor[],
  definitions: MeasurementDefinition[],
  timeZone: string,
): HistoricalImportPreview {
  const builder = createHistoricalImportBuilder(sheet, mapping, sensors, definitions, timeZone);
  builder.processRows(builder.firstDataRow, builder.lastDataRow);
  return builder.finish();
}

export interface HistoricalImportBuildOptions {
  signal?: AbortSignal;
  onProgress?: (completedRows: number, totalRows: number) => void;
}

export const PREVIEW_ROWS_PER_CHUNK = 1_000;

export function previewAbortError(): Error {
  const error = new Error("Historical import preview was cancelled.");
  error.name = "AbortError";
  return error;
}

export function throwIfPreviewAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : previewAbortError();
}

export function yieldPreviewWork(signal: AbortSignal | undefined): Promise<void> {
  throwIfPreviewAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : previewAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 0);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function buildHistoricalImportAsync(
  sheet: ImportSheet,
  mapping: HistoricalImportMapping,
  sensors: Sensor[],
  definitions: MeasurementDefinition[],
  timeZone: string,
  options: HistoricalImportBuildOptions = {},
): Promise<HistoricalImportPreview> {
  const builder = createHistoricalImportBuilder(sheet, mapping, sensors, definitions, timeZone);
  const totalRows = builder.lastDataRow - builder.firstDataRow;
  let nextRow = builder.firstDataRow;
  options.onProgress?.(0, totalRows);
  while (nextRow < builder.lastDataRow) {
    throwIfPreviewAborted(options.signal);
    const end = Math.min(builder.lastDataRow, nextRow + PREVIEW_ROWS_PER_CHUNK);
    builder.processRows(nextRow, end);
    nextRow = end;
    options.onProgress?.(nextRow - builder.firstDataRow, totalRows);
    if (nextRow < builder.lastDataRow) await yieldPreviewWork(options.signal);
  }
  throwIfPreviewAborted(options.signal);
  return builder.finish();
}
