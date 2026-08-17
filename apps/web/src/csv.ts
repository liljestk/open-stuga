export type CsvValue = string | number | null | undefined;

/** Spreadsheet importers expect CRLF row terminators and a trailing newline. */
const ROW_SEPARATOR = "\r\n";

/** Excel only detects UTF-8 in a CSV when the document opens with a byte-order mark. */
export const CSV_BYTE_ORDER_MARK = "\uFEFF";

export const CSV_MEDIA_TYPE = "text/csv;charset=utf-8";

/**
 * Escapes one CSV field and neutralizes spreadsheet formula injection.
 *
 * Every export carries operator-controlled text — sensor names, opening labels,
 * recovery errors — into a file that Excel, Numbers, and Sheets will happily
 * evaluate. A leading `=`, `+`, `-`, or `@` is therefore prefixed with an
 * apostrophe so the cell stays inert text. Exporters must route all fields
 * through this function rather than quoting values themselves.
 */
export function csvCell(value: CsvValue): string {
  const text = value === null || value === undefined ? "" : String(value);
  const formulaSafe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

/** Serializes a header row plus data rows into a complete CSV document. */
export function csvDocument(rows: ReadonlyArray<readonly CsvValue[]>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join(ROW_SEPARATOR)}${ROW_SEPARATOR}`;
}
