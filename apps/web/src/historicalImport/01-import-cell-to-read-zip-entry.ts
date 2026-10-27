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

export const MAX_XLSX_XML_BYTES = 64 * 1024 * 1024;

export const MAX_XLSX_WORKSHEET_BYTES = 32 * 1024 * 1024;

export const MAX_XLSX_ARCHIVE_ENTRIES = 10_000;

export const MAX_XLSX_XML_ENTRIES = 1_000;

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

export function parseDelimited(text: string, delimiter: string): ImportCell[][] {
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

export function delimiterScore(text: string, delimiter: string): number {
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

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

export interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function invalidWorkbookError(): Error {
  return new Error("This Excel workbook could not be safely read.");
}

export function checkedRange(offset: number, length: number, total: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length >= 0 && offset <= total && length <= total - offset;
}

export function parseZipEntries(archive: Uint8Array): ZipEntry[] {
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

export function cellCoordinates(reference: string): { row: number; column: number } | null {
  const match = reference.trim().match(/^\$?([A-Z]{1,3})\$?(\d+)$/i);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]!.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return Number.isSafeInteger(row) && row > 0 ? { row, column } : null;
}

export function worksheetAllocation(xml: string): { cells: number; rows: number } {
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

export async function readZipEntry(
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
