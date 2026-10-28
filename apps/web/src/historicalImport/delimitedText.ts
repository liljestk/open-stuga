import { type ImportCell, type ImportSheet, MAX_IMPORT_CELLS, MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS, importSizeError, isBlank } from "./importModel";

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
