import type { MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import type { Locale } from "../i18n";
import { DateOrder, HistoricalImportMapping, HistoricalImportPreview, ImportCell, ImportMode, ImportSheet, InputUnit, MAX_FILE_BYTES, MAX_IMPORT_CELLS, MAX_IMPORT_ROWS, MAX_XLSX_WORKSHEET_BYTES, MAX_XLSX_XML_BYTES, MAX_XLSX_XML_ENTRIES, METRIC_ALIASES, SENSOR_ALIASES, TIMESTAMP_ALIASES, UNIT_ALIASES, VALUE_ALIASES, importSizeError, invalidWorkbookError, isBlank, normalizeImportToken, parseCsv, parseZipEntries, readFileText, readZipEntry, validateImportSheet, worksheetAllocation } from "./01-import-cell-to-read-zip-entry";

export async function validateXlsxArchive(buffer: ArrayBuffer): Promise<void> {
  const archive = new Uint8Array(buffer);
  const entries = parseZipEntries(archive);
  const xmlEntries = entries.filter((entry) => entry.name.endsWith(".xml") || entry.name.endsWith(".xml.rels"));
  if (!xmlEntries.length || xmlEntries.length > MAX_XLSX_XML_ENTRIES) throw invalidWorkbookError();
  const duplicateNames = new Set<string>();
  let declaredXmlBytes = 0;
  for (const entry of xmlEntries) {
    if (duplicateNames.has(entry.name)) throw invalidWorkbookError();
    duplicateNames.add(entry.name);
    declaredXmlBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(declaredXmlBytes) || declaredXmlBytes > MAX_XLSX_XML_BYTES) throw importSizeError();
  }

  let actualXmlBytes = 0;
  let allocatedCells = 0;
  let allocatedRows = 0;
  let worksheetCount = 0;
  for (const entry of xmlEntries) {
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name);
    if (worksheet && entry.uncompressedSize > MAX_XLSX_WORKSHEET_BYTES) throw importSizeError();
    const result = await readZipEntry(
      archive,
      entry,
      worksheet ? Math.min(MAX_XLSX_WORKSHEET_BYTES, MAX_XLSX_XML_BYTES - actualXmlBytes) : MAX_XLSX_XML_BYTES - actualXmlBytes,
      worksheet,
    );
    actualXmlBytes += result.size;
    if (actualXmlBytes > MAX_XLSX_XML_BYTES) throw importSizeError();
    if (worksheet) {
      worksheetCount += 1;
      const allocation = worksheetAllocation(result.text ?? "");
      allocatedCells += allocation.cells;
      allocatedRows += allocation.rows;
      if (allocatedCells > MAX_IMPORT_CELLS || allocatedRows > MAX_IMPORT_ROWS) throw importSizeError();
    }
  }
  if (!worksheetCount) throw invalidWorkbookError();
}

export async function readHistoricalFile(file: File): Promise<ImportSheet[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose a file smaller than 25 MB.");
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return [parseCsv(await readFileText(file), file.name)];
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an Excel .xlsx, CSV, or TSV file.");
  const buffer = await file.arrayBuffer();
  await validateXlsxArchive(buffer);
  const { default: readExcelFile } = await import("read-excel-file/browser");
  const sheets = await readExcelFile(buffer);
  const usable = sheets
    .map((sheet) => ({ name: sheet.sheet, rows: sheet.data as ImportCell[][] }))
    .filter((sheet) => sheet.rows.some((row) => row.some((cell) => !isBlank(cell))));
  if (!usable.length) throw new Error("This workbook does not contain any data rows.");
  let workbookCells = 0;
  let workbookRows = 0;
  for (const sheet of usable) {
    validateImportSheet(sheet);
    workbookRows += sheet.rows.length;
    for (const row of sheet.rows) workbookCells += row.length;
    if (workbookRows > MAX_IMPORT_ROWS || workbookCells > MAX_IMPORT_CELLS) throw importSizeError();
  }
  return usable;
}

export function aliasScore(value: ImportCell | undefined, aliases: string[]): number {
  const normalized = normalizeImportToken(value);
  if (!normalized) return 0;
  if (aliases.includes(normalized)) return 5;
  return aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized)) ? 2 : 0;
}

export function detectHeaderRow(rows: ImportCell[][]): number {
  let best = { index: 0, score: -Infinity };
  rows.slice(0, 20).forEach((row, index) => {
    const populated = row.filter((cell) => !isBlank(cell));
    const strings = populated.filter((cell) => typeof cell === "string").length;
    const aliases = populated.reduce<number>((score, cell) => score
      + Math.max(aliasScore(cell, TIMESTAMP_ALIASES), aliasScore(cell, SENSOR_ALIASES), aliasScore(cell, METRIC_ALIASES), aliasScore(cell, VALUE_ALIASES)), 0);
    const score = populated.length + strings * 2 + aliases * 4 - index * 0.1;
    if (populated.length >= 2 && score > best.score) best = { index, score };
  });
  return best.index;
}

export function columnLabels(sheet: ImportSheet, headerRow: number): string[] {
  const header = sheet.rows[headerRow] ?? [];
  const width = Math.max(header.length, ...sheet.rows.slice(headerRow + 1, headerRow + 21).map((row) => row.length), 0);
  const used = new Map<string, number>();
  return Array.from({ length: width }, (_, column) => {
    const base = String(header[column] ?? "").trim() || `Column ${column + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function findColumn(headers: string[], aliases: string[]): number {
  let best = { column: -1, score: 0 };
  headers.forEach((header, column) => {
    const score = aliasScore(header, aliases);
    if (score > best.score) best = { column, score };
  });
  return best.column;
}

export function metricAliases(definition: MeasurementDefinition): string[] {
  const aliases = [definition.id, ...Object.values(definition.labels)];
  if (definition.id === "temperature") aliases.push("temp", "air temperature", "lampotila");
  if (definition.id === "humidity") aliases.push("rh", "relative humidity", "kosteus", "ilmankosteus");
  if (definition.id === "co2") aliases.push("carbon dioxide", "carbon-dioxide", "hiilidioksidi");
  return aliases.map(normalizeImportToken).filter(Boolean);
}

export function guessMetric(header: string, definitions: MeasurementDefinition[]): MeasurementDefinition | null {
  const token = normalizeImportToken(header.replace(/\b(deg(?:rees?)?|celsius|fahrenheit|kelvin|ppm|percent|pct)\b/gi, ""));
  let best: { definition: MeasurementDefinition; score: number } | null = null;
  for (const definition of definitions) {
    for (const alias of metricAliases(definition)) {
      const score = token === alias ? 10 : token.startsWith(alias) || alias.startsWith(token) ? 6 : token.includes(alias) ? 4 : 0;
      if (score > (best?.score ?? 0)) best = { definition, score };
    }
  }
  return best?.definition ?? null;
}

export function unitFromHeader(header: string, metric: string): InputUnit {
  const normalized = header.toLocaleLowerCase();
  if (metric === "temperature" && (/°\s*f/.test(normalized) || /fahrenheit|deg(?:rees?)?\s*f/.test(normalized))) return "fahrenheit";
  if (metric === "temperature" && (/\bkelvin\b/.test(normalized) || /\(k\)/.test(normalized))) return "kelvin";
  return "canonical";
}

export function createInitialMapping(
  sheet: ImportSheet,
  definitions: MeasurementDefinition[],
  sensors: Sensor[],
  locale: Locale,
  headerRow = detectHeaderRow(sheet.rows),
): HistoricalImportMapping {
  const headers = columnLabels(sheet, headerRow);
  const timestampColumn = Math.max(0, findColumn(headers, TIMESTAMP_ALIASES));
  const sensor = findColumn(headers, SENSOR_ALIASES);
  const metric = findColumn(headers, METRIC_ALIASES);
  const value = findColumn(headers, VALUE_ALIASES);
  const unit = findColumn(headers, UNIT_ALIASES);
  const mode: ImportMode = metric >= 0 && value >= 0 ? "long" : "wide";
  const excluded = new Set([timestampColumn, sensor]);
  const wideColumns = headers.flatMap((header, column) => {
    if (excluded.has(column)) return [];
    const definition = guessMetric(header, definitions);
    return definition ? [{ column, metric: definition.id, inputUnit: unitFromHeader(header, definition.id) }] : [];
  });
  return {
    headerRow,
    mode,
    timestampColumn,
    sensorColumn: sensor >= 0 ? sensor : null,
    fallbackSensorId: sensors[0]?.id ?? "",
    dateOrder: locale === "en" ? "auto" : "dmy",
    wideColumns,
    longMetricColumn: metric >= 0 ? metric : null,
    longFixedMetric: definitions[0]?.id ?? "",
    longValueColumn: value >= 0 ? value : Math.min(1, Math.max(0, headers.length - 1)),
    longUnitColumn: unit >= 0 ? unit : null,
  };
}

export const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

export const MAX_ZONED_FORMATTERS = 32;

export function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  if (zonedFormatterCache.size >= MAX_ZONED_FORMATTERS) {
    const oldest = zonedFormatterCache.keys().next().value as string | undefined;
    if (oldest !== undefined) zonedFormatterCache.delete(oldest);
  }
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
}

export function zonedParts(timestamp: number, timeZone: string): number[] {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second")];
}

export function localPartsToIso(parts: number[], timeZone: string): string | null {
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts;
  if (!year || !month || !day || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(nominal).getUTCFullYear() !== year || new Date(nominal).getUTCMonth() !== month - 1 || new Date(nominal).getUTCDate() !== day) return null;
  try {
    const displayed = zonedParts(nominal, timeZone);
    const offset = Date.UTC(displayed[0]!, displayed[1]! - 1, displayed[2]!, displayed[3]!, displayed[4]!, displayed[5]!) - nominal;
    let candidate = nominal - offset;
    const adjusted = zonedParts(candidate, timeZone);
    const adjustedOffset = Date.UTC(adjusted[0]!, adjusted[1]! - 1, adjusted[2]!, adjusted[3]!, adjusted[4]!, adjusted[5]!) - candidate;
    candidate = nominal - adjustedOffset;
    const final = zonedParts(candidate, timeZone);
    return final.every((value, index) => value === [year, month, day, hour, minute, second][index])
      ? new Date(candidate).toISOString()
      : null;
  } catch {
    return null;
  }
}

/** "auto" is only offered in English, where an ambiguous date is month-first. */
function inferredDateOrder(first: number): Exclude<DateOrder, "auto"> {
  if (first > 999) return "ymd";
  return first > 12 ? "dmy" : "mdy";
}

export function parseImportTimestamp(value: ImportCell | undefined, timeZone: string, dateOrder: DateOrder): string | null {
  if (value instanceof Date) {
    return localPartsToIso([
      value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
      value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(),
    ], timeZone);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    if (value > 1_000_000_000) {
      const date = new Date(value * 1000);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    if (value > 0 && value < 3_000_000) {
      const serialDate = new Date((value - 25569) * 86_400_000);
      return localPartsToIso([
        serialDate.getUTCFullYear(), serialDate.getUTCMonth() + 1, serialDate.getUTCDate(),
        serialDate.getUTCHours(), serialDate.getUTCMinutes(), serialDate.getUTCSeconds(),
      ], timeZone);
    }
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  const match = text.match(/^(\d{1,4})[.\-/](\d{1,2})[.\-/](\d{1,4})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2})(?:[.,]\d+)?)?)?$/);
  if (!match) {
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const order = dateOrder === "auto" ? inferredDateOrder(first) : dateOrder;
  const [year, month, day] = order === "ymd" ? [first, second, third]
    : order === "dmy" ? [third, second, first] : [third, first, second];
  return localPartsToIso([year, month, day, Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)], timeZone);
}

export function numberValue(value: ImportCell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s/g, "");
  if (!text) return null;
  if (/^-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(text)) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    const decimal = Math.max(lastComma, lastDot);
    text = `${text.slice(0, decimal).replace(/[.,]/g, "")}.${text.slice(decimal + 1)}`;
  } else if (text.includes(",") && !text.includes(".")) {
    text = text.replace(",", ".");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function convertValue(value: number, unit: InputUnit): number {
  if (unit === "fahrenheit") return (value - 32) * 5 / 9;
  if (unit === "kelvin") return value - 273.15;
  return value;
}

export function unitFromCell(value: ImportCell | undefined): InputUnit {
  const unit = normalizeImportToken(value);
  if (["f", "degf", "fahrenheit"].includes(unit)) return "fahrenheit";
  if (["k", "kelvin"].includes(unit)) return "kelvin";
  return "canonical";
}

export interface ImportLookups {
  sensorsById: Map<string, Sensor>;
  sensorsByToken: Map<string, Sensor | null>;
  metricsByToken: Map<string, MeasurementDefinition>;
}

export function createImportLookups(sensors: Sensor[], definitions: MeasurementDefinition[]): ImportLookups {
  const sensorsById = new Map<string, Sensor>();
  const sensorsByToken = new Map<string, Sensor | null>();
  for (const sensor of sensors) {
    if (!sensorsById.has(sensor.id)) sensorsById.set(sensor.id, sensor);
    const tokens = new Set([normalizeImportToken(sensor.id), normalizeImportToken(sensor.name)]);
    for (const token of tokens) {
      if (!token) continue;
      const existing = sensorsByToken.get(token);
      if (existing === undefined) sensorsByToken.set(token, sensor);
      else if (existing !== sensor) sensorsByToken.set(token, null);
    }
  }
  const metricsByToken = new Map<string, MeasurementDefinition>();
  for (const definition of definitions) {
    for (const token of metricAliases(definition)) {
      if (!metricsByToken.has(token)) metricsByToken.set(token, definition);
    }
  }
  return { sensorsById, sensorsByToken, metricsByToken };
}

export function resolveSensor(value: ImportCell | undefined, lookups: ImportLookups, fallbackSensorId: string): Sensor | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return lookups.sensorsById.get(fallbackSensorId) ?? null;
  }
  return lookups.sensorsByToken.get(normalizeImportToken(value)) ?? null;
}

export function resolveMetric(
  value: ImportCell | undefined,
  definitionsById: Map<string, MeasurementDefinition>,
  lookups: ImportLookups,
  fallback: string,
): MeasurementDefinition | null {
  if (isBlank(value)) return definitionsById.get(fallback) ?? null;
  return lookups.metricsByToken.get(normalizeImportToken(value)) ?? null;
}

export interface HistoricalImportBuilder {
  firstDataRow: number;
  lastDataRow: number;
  processRows: (start: number, end: number) => void;
  finish: () => HistoricalImportPreview;
}
