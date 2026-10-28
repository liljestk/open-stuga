import type { MeasurementSample } from "@climate-twin/contracts";

export type ImportCell = string | number | boolean | Date | null;

export type ImportMode = "wide" | "long";

export type DateOrder = "auto" | "ymd" | "dmy" | "mdy";

export type InputUnit = "canonical" | "fahrenheit" | "kelvin";

export interface ImportSheet {
  name: string;
  rows: ImportCell[][];
}

export interface WideColumnMapping {
  column: number;
  metric: string;
  inputUnit: InputUnit;
}

export interface HistoricalImportMapping {
  headerRow: number;
  mode: ImportMode;
  timestampColumn: number;
  sensorColumn: number | null;
  fallbackSensorId: string;
  dateOrder: DateOrder;
  wideColumns: WideColumnMapping[];
  longMetricColumn: number | null;
  longFixedMetric: string;
  longValueColumn: number;
  longUnitColumn: number | null;
}

export interface ImportIssue {
  row: number;
  message: string;
}

export interface HistoricalImportPreview {
  samples: MeasurementSample[];
  issues: ImportIssue[];
  issueCount: number;
  issueRowCount: number;
  sourceRows: number;
  usableRows: number;
  skippedEmpty: number;
  duplicatesInFile: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  sensorIds: string[];
  metricIds: string[];
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const MAX_RETAINED_ISSUES = 25;

export const MAX_IMPORT_ROWS = 200_000;

export const MAX_IMPORT_COLUMNS = 256;

export const MAX_IMPORT_CELLS = 1_000_000;

export const TIMESTAMP_ALIASES = ["timestamp", "datetime", "dateandtime", "recordedat", "recorded", "time", "date", "aika", "paivamaara", "ajankohta"];

export const SENSOR_ALIASES = ["sensorid", "sensorname", "sensor", "deviceid", "devicename", "device", "anturiid", "anturinnimi", "anturi", "laite"];

export const METRIC_ALIASES = ["metric", "measurementtype", "measurement", "type", "kind", "mittaustyyppi", "mittaus", "mittari", "suure"];

export const VALUE_ALIASES = ["measurementvalue", "reading", "value", "arvo", "lukema", "mittausarvo"];

export const UNIT_ALIASES = ["canonicalunit", "measurementunit", "unit", "units", "yksikko"];

export function normalizeImportToken(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isBlank(value: ImportCell | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export function importSizeError(): Error {
  return new Error(`This file contains too much data. Use at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows, ${MAX_IMPORT_COLUMNS} columns, and ${MAX_IMPORT_CELLS.toLocaleString("en-US")} cells.`);
}

export function validateImportSheet(sheet: ImportSheet): void {
  if (sheet.rows.length > MAX_IMPORT_ROWS) throw importSizeError();
  let cells = 0;
  for (const row of sheet.rows) {
    if (row.length > MAX_IMPORT_COLUMNS) throw importSizeError();
    cells += row.length;
    if (cells > MAX_IMPORT_CELLS) throw importSizeError();
  }
}
