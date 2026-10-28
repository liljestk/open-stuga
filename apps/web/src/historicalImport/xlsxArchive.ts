import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync, type UnzipFile } from "fflate";
import { MAX_IMPORT_CELLS, MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS, importSizeError } from "./importModel";

export const MAX_XLSX_XML_BYTES = 64 * 1024 * 1024;

export const MAX_XLSX_WORKSHEET_BYTES = 32 * 1024 * 1024;

export const MAX_XLSX_ARCHIVE_ENTRIES = 10_000;

export const MAX_XLSX_XML_ENTRIES = 1_000;

export function invalidWorkbookError(): Error {
  return new Error("This Excel workbook could not be safely read.");
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

/** Archive bytes handed to the streaming inflater at a time; deflate expands a slice at most about 1000-fold. */
const ZIP_PUSH_BYTES = 16 * 1024;

const isXmlEntry = (name: string) => name.endsWith(".xml") || name.endsWith(".xml.rels");
const isWorksheetEntry = (name: string) => /^xl\/worksheets\/[^/]+\.xml$/.test(name);
const entryName = (name: string) => name.replaceAll("\\", "/");

function isImportSizeError(error: unknown): boolean {
  return error instanceof Error && error.message === importSizeError().message;
}

/**
 * The central-directory size of each XML entry, listed by fflate without inflating anything. These are
 * the sizes read-excel-file allocates, so they are bounded here and later checked against the real output.
 */
function declaredXmlSizes(archive: Uint8Array): Map<string, number> {
  const sizes = new Map<string, number>();
  let entries = 0;
  let declaredBytes = 0;
  unzipSync(archive, {
    filter: (entry) => {
      entries += 1;
      if (entries > MAX_XLSX_ARCHIVE_ENTRIES) throw invalidWorkbookError();
      const name = entryName(entry.name);
      if (!isXmlEntry(name)) return false;
      if (sizes.has(name) || sizes.size >= MAX_XLSX_XML_ENTRIES) throw invalidWorkbookError();
      declaredBytes += entry.originalSize;
      if (declaredBytes > MAX_XLSX_XML_BYTES || (isWorksheetEntry(name) && entry.originalSize > MAX_XLSX_WORKSHEET_BYTES)) {
        throw importSizeError();
      }
      sizes.set(name, entry.originalSize);
      return false;
    },
  });
  if (!sizes.size) throw invalidWorkbookError();
  return sizes;
}

interface InflationTotals {
  xmlBytes: number;
  worksheets: number;
  cells: number;
  rows: number;
}

/** Counts a worksheet's declared or populated cells and rows into the workbook-wide bounds. */
function addWorksheet(totals: InflationTotals, xml: string): void {
  const allocation = worksheetAllocation(xml);
  totals.worksheets += 1;
  totals.cells += allocation.cells;
  totals.rows += allocation.rows;
  if (totals.cells > MAX_IMPORT_CELLS || totals.rows > MAX_IMPORT_ROWS) throw importSizeError();
}

/**
 * Inflates one XML entry, stopping as soon as it outgrows its declared size or the archive outgrows
 * the XML budget; a worksheet's text is kept to count what it would allocate.
 */
function inflateXmlEntry(file: UnzipFile, declaredSize: number, totals: InflationTotals): void {
  const decoder = isWorksheetEntry(entryName(file.name)) ? new TextDecoder() : null;
  const chunks: string[] = [];
  let size = 0;
  file.ondata = (error, chunk, final) => {
    if (error) throw error;
    size += chunk.byteLength;
    totals.xmlBytes += chunk.byteLength;
    if (size > declaredSize || totals.xmlBytes > MAX_XLSX_XML_BYTES) throw importSizeError();
    if (decoder) chunks.push(decoder.decode(chunk, { stream: !final }));
    if (!final) return;
    if (size !== declaredSize) throw invalidWorkbookError();
    if (decoder) addWorksheet(totals, chunks.join(""));
  };
  file.start();
}

/** Streams the archive through fflate in small slices, inflating every XML entry once under the caps. */
function inflateXmlEntries(archive: Uint8Array, declared: Map<string, number>): InflationTotals {
  const totals: InflationTotals = { xmlBytes: 0, worksheets: 0, cells: 0, rows: 0 };
  const inflated = new Set<string>();
  const unzip = new Unzip((file) => {
    const name = entryName(file.name);
    const declaredSize = declared.get(name);
    if (declaredSize === undefined) return;
    if (inflated.has(name)) throw invalidWorkbookError();
    inflated.add(name);
    inflateXmlEntry(file, declaredSize, totals);
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for (let offset = 0; offset < archive.byteLength; offset += ZIP_PUSH_BYTES) {
    unzip.push(archive.subarray(offset, offset + ZIP_PUSH_BYTES), offset + ZIP_PUSH_BYTES >= archive.byteLength);
  }
  if (inflated.size !== declared.size) throw invalidWorkbookError();
  return totals;
}

/**
 * Checks an .xlsx archive before read-excel-file unzips it: entry counts, declared and actual XML
 * sizes, and the cells its worksheets would allocate. Anything fflate cannot read is an unsafe workbook.
 */
export async function validateXlsxArchive(buffer: ArrayBuffer): Promise<void> {
  const archive = new Uint8Array(buffer);
  try {
    if (!inflateXmlEntries(archive, declaredXmlSizes(archive)).worksheets) throw invalidWorkbookError();
  } catch (error) {
    throw isImportSizeError(error) ? error : invalidWorkbookError();
  }
}
