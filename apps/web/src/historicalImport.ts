import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { Locale } from "./i18n";

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

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RETAINED_ISSUES = 25;
export const MAX_IMPORT_ROWS = 200_000;
export const MAX_IMPORT_COLUMNS = 256;
export const MAX_IMPORT_CELLS = 1_000_000;
const MAX_XLSX_XML_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_WORKSHEET_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_ARCHIVE_ENTRIES = 10_000;
const MAX_XLSX_XML_ENTRIES = 1_000;
const TIMESTAMP_ALIASES = ["timestamp", "datetime", "dateandtime", "recordedat", "recorded", "time", "date", "aika", "paivamaara", "ajankohta"];
const SENSOR_ALIASES = ["sensorid", "sensorname", "sensor", "deviceid", "devicename", "device", "anturiid", "anturinnimi", "anturi", "laite"];
const METRIC_ALIASES = ["metric", "measurementtype", "measurement", "type", "kind", "mittaustyyppi", "mittaus", "mittari", "suure"];
const VALUE_ALIASES = ["measurementvalue", "reading", "value", "arvo", "lukema", "mittausarvo"];
const UNIT_ALIASES = ["canonicalunit", "measurementunit", "unit", "units", "yksikko"];

export function normalizeImportToken(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isBlank(value: ImportCell | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function importSizeError(): Error {
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

function parseDelimited(text: string, delimiter: string): ImportCell[][] {
  const rows: ImportCell[][] = [];
  let row: ImportCell[] = [];
  let value = "";
  let quoted = false;
  let cells = 0;
  const pushValue = () => {
    row.push(value.trim());
    value = "";
    if (row.length > MAX_IMPORT_COLUMNS) throw importSizeError();
  };
  const pushRow = () => {
    pushValue();
    if (row.some((cell) => !isBlank(cell))) {
      if (rows.length >= MAX_IMPORT_ROWS) throw importSizeError();
      cells += row.length;
      if (cells > MAX_IMPORT_CELLS) throw importSizeError();
      rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      pushValue();
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      value += character;
    }
  }
  pushRow();
  return rows;
}

function delimiterScore(text: string, delimiter: string): number {
  const widths: number[] = [];
  const end = Math.min(text.length, 256 * 1024);
  let width = 1;
  let quoted = false;
  let hasContent = false;
  for (let index = 0; index < end && widths.length < 25; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      width += 1;
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      if (hasContent && width > 1) widths.push(width);
      width = 1;
      hasContent = false;
    } else if (!/\s/.test(character)) {
      hasContent = true;
    }
  }
  if (widths.length < 25 && hasContent && width > 1) widths.push(width);
  if (!widths.length) return 0;
  const counts = new Map<number, number>();
  for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
  const [commonWidth, frequency] = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]!;
  return commonWidth * frequency;
}

export function parseCsv(text: string, fileName = "CSV data"): ImportSheet {
  const clean = text.replace(/^\uFEFF/, "");
  const delimiters = /\.tsv$/i.test(fileName) ? ["\t", ",", ";"] : [",", ";", "\t"];
  const selected = delimiters
    .map((delimiter) => ({ delimiter, score: delimiterScore(clean, delimiter) }))
    .sort((left, right) => right.score - left.score)[0]!.delimiter;
  const rows = parseDelimited(clean, selected);
  let maximumWidth = 0;
  for (const row of rows) maximumWidth = Math.max(maximumWidth, row.length);
  if (!rows.length || maximumWidth < 2) {
    throw new Error("No table with two or more columns was found in this file.");
  }
  return { name: fileName.replace(/\.(csv|tsv|txt)$/i, "") || "CSV data", rows };
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function invalidWorkbookError(): Error {
  return new Error("This Excel workbook could not be safely read.");
}

function checkedRange(offset: number, length: number, total: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length >= 0 && offset <= total && length <= total - offset;
}

function parseZipEntries(archive: Uint8Array): ZipEntry[] {
  if (archive.byteLength < 22) throw invalidWorkbookError();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const firstPossibleEocd = Math.max(0, archive.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let offset = archive.byteLength - 22; offset >= firstPossibleEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === archive.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw invalidWorkbookError();

  const disk = view.getUint16(eocd + 4, true);
  const centralDirectoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectorySize = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff
    || entryCount > MAX_XLSX_ARCHIVE_ENTRIES
    || !checkedRange(centralDirectoryOffset, centralDirectorySize, archive.byteLength)
    || centralDirectoryOffset + centralDirectorySize > eocd) {
    throw invalidWorkbookError();
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (!checkedRange(offset, 46, archive.byteLength) || view.getUint32(offset, true) !== 0x02014b50) {
      throw invalidWorkbookError();
    }
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryLength = 46 + fileNameLength + extraLength + commentLength;
    if (!checkedRange(offset, entryLength, archive.byteLength)) throw invalidWorkbookError();
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + fileNameLength)).replaceAll("\\", "/");
    entries.push({
      name,
      flags: view.getUint16(offset + 8, true),
      compressionMethod: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += entryLength;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize) throw invalidWorkbookError();
  return entries;
}

function cellCoordinates(reference: string): { row: number; column: number } | null {
  const match = reference.trim().match(/^\$?([A-Z]{1,3})\$?(\d+)$/i);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]!.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return Number.isSafeInteger(row) && row > 0 ? { row, column } : null;
}

function worksheetAllocation(xml: string): { cells: number; rows: number } {
  const dimension = xml.match(/<(?:[\w.-]+:)?dimension\b[^>]*\bref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  let allocatedCells: number | null = null;
  let allocatedRows: number | null = null;
  if (dimension) {
    const references = (dimension[1] ?? dimension[2] ?? "").split(":");
    if (references.length < 1 || references.length > 2) throw invalidWorkbookError();
    const first = cellCoordinates(references[0]!);
    const last = cellCoordinates(references.at(-1)!);
    if (!first || !last || last.row < first.row || last.column < first.column) throw invalidWorkbookError();
    if (last.row > MAX_IMPORT_ROWS || last.column > MAX_IMPORT_COLUMNS) throw importSizeError();
    allocatedCells = last.row * last.column;
    allocatedRows = last.row;
    if (allocatedCells > MAX_IMPORT_CELLS) throw importSizeError();
  }

  const cellTag = /<(?:[\w.-]+:)?c\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  let cellCount = 0;
  let maximumRow = 0;
  let maximumColumn = 0;
  while ((match = cellTag.exec(xml))) {
    cellCount += 1;
    if (cellCount > MAX_IMPORT_CELLS) throw importSizeError();
    if (allocatedCells === null) {
      const reference = match[1]?.match(/\br\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
      const coordinates = reference ? cellCoordinates(reference[1] ?? reference[2] ?? "") : null;
      if (!coordinates) throw invalidWorkbookError();
      maximumRow = Math.max(maximumRow, coordinates.row);
      maximumColumn = Math.max(maximumColumn, coordinates.column);
      if (maximumRow > MAX_IMPORT_ROWS || maximumColumn > MAX_IMPORT_COLUMNS
        || maximumRow * maximumColumn > MAX_IMPORT_CELLS) throw importSizeError();
    }
  }
  return {
    cells: Math.max(allocatedCells ?? maximumRow * maximumColumn, cellCount),
    rows: allocatedRows ?? maximumRow,
  };
}

async function readZipEntry(
  archive: Uint8Array,
  entry: ZipEntry,
  maximumOutputBytes: number,
  retainText: boolean,
): Promise<{ size: number; text: string | null }> {
  if ((entry.flags & 0x1) !== 0 || ![0, 8].includes(entry.compressionMethod)) throw invalidWorkbookError();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const offset = entry.localHeaderOffset;
  if (!checkedRange(offset, 30, archive.byteLength) || view.getUint32(offset, true) !== 0x04034b50) {
    throw invalidWorkbookError();
  }
  const localFlags = view.getUint16(offset + 6, true);
  const localCompressionMethod = view.getUint16(offset + 8, true);
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  if ((localFlags & 0x1) !== 0 || localCompressionMethod !== entry.compressionMethod
    || !checkedRange(dataOffset, entry.compressedSize, archive.byteLength)) throw invalidWorkbookError();
  const localName = new TextDecoder().decode(archive.subarray(offset + 30, offset + 30 + fileNameLength)).replaceAll("\\", "/");
  if (localName !== entry.name) throw invalidWorkbookError();

  const decoder = retainText ? new TextDecoder() : null;
  const textChunks: string[] = [];
  let size = 0;
  const consume = (chunk: Uint8Array) => {
    size += chunk.byteLength;
    if (size > maximumOutputBytes || size > entry.uncompressedSize) throw importSizeError();
    if (decoder) textChunks.push(decoder.decode(chunk, { stream: true }));
  };

  const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    for (let start = 0; start < compressed.byteLength; start += 64 * 1024) {
      consume(compressed.subarray(start, Math.min(compressed.byteLength, start + 64 * 1024)));
    }
  } else {
    if (typeof DecompressionStream === "undefined") throw invalidWorkbookError();
    try {
      const stream = new Blob([compressed.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          consume(result.value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("This file contains too much data.")) throw error;
      throw invalidWorkbookError();
    }
  }
  if (size !== entry.uncompressedSize) throw invalidWorkbookError();
  if (decoder) textChunks.push(decoder.decode());
  return { size, text: decoder ? textChunks.join("") : null };
}

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

function aliasScore(value: ImportCell | undefined, aliases: string[]): number {
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

function findColumn(headers: string[], aliases: string[]): number {
  let best = { column: -1, score: 0 };
  headers.forEach((header, column) => {
    const score = aliasScore(header, aliases);
    if (score > best.score) best = { column, score };
  });
  return best.column;
}

function metricAliases(definition: MeasurementDefinition): string[] {
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

function unitFromHeader(header: string, metric: string): InputUnit {
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

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_ZONED_FORMATTERS = 32;

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
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

function zonedParts(timestamp: number, timeZone: string): number[] {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second")];
}

function localPartsToIso(parts: number[], timeZone: string): string | null {
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
  const order = dateOrder === "auto"
    ? first > 999 ? "ymd" : first > 12 ? "dmy" : second > 12 ? "mdy" : "mdy"
    : dateOrder;
  const [year, month, day] = order === "ymd" ? [first, second, third]
    : order === "dmy" ? [third, second, first] : [third, first, second];
  return localPartsToIso([year, month, day, Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)], timeZone);
}

function numberValue(value: ImportCell | undefined): number | null {
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

function convertValue(value: number, unit: InputUnit): number {
  if (unit === "fahrenheit") return (value - 32) * 5 / 9;
  if (unit === "kelvin") return value - 273.15;
  return value;
}

function unitFromCell(value: ImportCell | undefined): InputUnit {
  const unit = normalizeImportToken(value);
  if (["f", "degf", "fahrenheit"].includes(unit)) return "fahrenheit";
  if (["k", "kelvin"].includes(unit)) return "kelvin";
  return "canonical";
}

interface ImportLookups {
  sensorsById: Map<string, Sensor>;
  sensorsByToken: Map<string, Sensor | null>;
  metricsByToken: Map<string, MeasurementDefinition>;
}

function createImportLookups(sensors: Sensor[], definitions: MeasurementDefinition[]): ImportLookups {
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

function resolveSensor(value: ImportCell | undefined, lookups: ImportLookups, fallbackSensorId: string): Sensor | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return lookups.sensorsById.get(fallbackSensorId) ?? null;
  }
  return lookups.sensorsByToken.get(normalizeImportToken(value)) ?? null;
}

function resolveMetric(
  value: ImportCell | undefined,
  definitionsById: Map<string, MeasurementDefinition>,
  lookups: ImportLookups,
  fallback: string,
): MeasurementDefinition | null {
  if (isBlank(value)) return definitionsById.get(fallback) ?? null;
  return lookups.metricsByToken.get(normalizeImportToken(value)) ?? null;
}

interface HistoricalImportBuilder {
  firstDataRow: number;
  lastDataRow: number;
  processRows: (start: number, end: number) => void;
  finish: () => HistoricalImportPreview;
}

function createHistoricalImportBuilder(
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

const PREVIEW_ROWS_PER_CHUNK = 1_000;

function previewAbortError(): Error {
  const error = new Error("Historical import preview was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfPreviewAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : previewAbortError();
}

function yieldPreviewWork(signal: AbortSignal | undefined): Promise<void> {
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
