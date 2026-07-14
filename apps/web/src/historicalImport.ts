import readExcelFile from "read-excel-file/browser";
import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";

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

function parseDelimited(text: string, delimiter: string): ImportCell[][] {
  const rows: ImportCell[][] = [];
  let row: ImportCell[] = [];
  let value = "";
  let quoted = false;
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
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some((cell) => !isBlank(cell))) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value.trim());
  if (row.some((cell) => !isBlank(cell))) rows.push(row);
  return rows;
}

function delimiterScore(rows: ImportCell[][]): number {
  const widths = rows.slice(0, 25).map((row) => row.length).filter((width) => width > 1);
  if (!widths.length) return 0;
  const counts = new Map<number, number>();
  for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
  const [width, frequency] = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]!;
  return width * frequency;
}

export function parseCsv(text: string, fileName = "CSV data"): ImportSheet {
  const clean = text.replace(/^\uFEFF/, "");
  const candidates = [",", ";", "\t"].map((delimiter) => ({ delimiter, rows: parseDelimited(clean, delimiter) }));
  const selected = candidates.sort((left, right) => delimiterScore(right.rows) - delimiterScore(left.rows))[0]!;
  if (!selected.rows.length || Math.max(...selected.rows.map((row) => row.length)) < 2) {
    throw new Error("No table with two or more columns was found in this file.");
  }
  return { name: fileName.replace(/\.(csv|tsv|txt)$/i, "") || "CSV data", rows: selected.rows };
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

export async function readHistoricalFile(file: File): Promise<ImportSheet[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose a file smaller than 25 MB.");
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return [parseCsv(await readFileText(file), file.name)];
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an Excel .xlsx, CSV, or TSV file.");
  const sheets = await readExcelFile(file);
  const usable = sheets
    .map((sheet) => ({ name: sheet.sheet, rows: sheet.data as ImportCell[][] }))
    .filter((sheet) => sheet.rows.some((row) => row.some((cell) => !isBlank(cell))));
  if (!usable.length) throw new Error("This workbook does not contain any data rows.");
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
  locale: "en" | "fi",
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
    dateOrder: locale === "fi" ? "dmy" : "auto",
    wideColumns,
    longMetricColumn: metric >= 0 ? metric : null,
    longFixedMetric: definitions[0]?.id ?? "",
    longValueColumn: value >= 0 ? value : Math.min(1, Math.max(0, headers.length - 1)),
    longUnitColumn: unit >= 0 ? unit : null,
  };
}

function zonedParts(timestamp: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
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
    if (value > 1_000_000_000_000) return new Date(value).toISOString();
    if (value > 1_000_000_000) return new Date(value * 1000).toISOString();
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

function resolveSensor(value: ImportCell | undefined, sensors: Sensor[], fallbackSensorId: string): Sensor | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return sensors.find((sensor) => sensor.id === fallbackSensorId) ?? null;
  }
  const token = normalizeImportToken(value);
  const matches = sensors.filter((sensor) => normalizeImportToken(sensor.id) === token || normalizeImportToken(sensor.name) === token);
  return matches.length === 1 ? matches[0]! : null;
}

function resolveMetric(value: ImportCell | undefined, definitions: MeasurementDefinition[], fallback: string): MeasurementDefinition | null {
  if (isBlank(value)) return definitions.find((definition) => definition.id === fallback) ?? null;
  const token = normalizeImportToken(value);
  return definitions.find((definition) => metricAliases(definition).includes(token)) ?? null;
}

export function buildHistoricalImport(
  sheet: ImportSheet,
  mapping: HistoricalImportMapping,
  sensors: Sensor[],
  definitions: MeasurementDefinition[],
  timeZone: string,
): HistoricalImportPreview {
  const samples: MeasurementSample[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  let skippedEmpty = 0;
  let duplicatesInFile = 0;
  let usableRows = 0;
  const dataRows = sheet.rows.slice(mapping.headerRow + 1);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));

  dataRows.forEach((row, dataIndex) => {
    const rowNumber = mapping.headerRow + dataIndex + 2;
    if (row.every((cell) => isBlank(cell))) { skippedEmpty += 1; return; }
    const timestamp = parseImportTimestamp(row[mapping.timestampColumn], timeZone, mapping.dateOrder);
    if (!timestamp) { issues.push({ row: rowNumber, message: "The date or time could not be read." }); return; }
    const sensor = resolveSensor(mapping.sensorColumn === null ? undefined : row[mapping.sensorColumn], sensors, mapping.fallbackSensorId);
    if (!sensor) { issues.push({ row: rowNumber, message: "The sensor does not match a sensor in this house." }); return; }
    const candidates: Array<{ definition: MeasurementDefinition; raw: ImportCell | undefined; unit: InputUnit }> = [];
    if (mapping.mode === "wide") {
      for (const item of mapping.wideColumns) {
        const definition = definitionsById.get(item.metric);
        if (definition && !isBlank(row[item.column])) candidates.push({ definition, raw: row[item.column], unit: item.inputUnit });
      }
    } else {
      const definition = resolveMetric(mapping.longMetricColumn === null ? undefined : row[mapping.longMetricColumn], definitions, mapping.longFixedMetric);
      if (!definition) { issues.push({ row: rowNumber, message: "The measurement type is not recognized." }); return; }
      if (!isBlank(row[mapping.longValueColumn])) candidates.push({
        definition,
        raw: row[mapping.longValueColumn],
        unit: mapping.longUnitColumn === null ? "canonical" : unitFromCell(row[mapping.longUnitColumn]),
      });
    }
    if (!candidates.length) { skippedEmpty += 1; return; }
    let rowAccepted = false;
    for (const candidate of candidates) {
      const parsed = numberValue(candidate.raw);
      if (parsed === null) { issues.push({ row: rowNumber, message: `${candidate.definition.labels.en ?? candidate.definition.id} is not a number.` }); continue; }
      const value = convertValue(parsed, candidate.unit);
      if (candidate.definition.validMin !== null && value < candidate.definition.validMin
        || candidate.definition.validMax !== null && value > candidate.definition.validMax) {
        issues.push({ row: rowNumber, message: `${candidate.definition.labels.en ?? candidate.definition.id} is outside the allowed range.` });
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
      rowAccepted = true;
    }
    if (rowAccepted) usableRows += 1;
  });
  const timestamps = samples.map((sample) => sample.timestamp).sort();
  return {
    samples,
    issues,
    sourceRows: dataRows.length,
    usableRows,
    skippedEmpty,
    duplicatesInFile,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    sensorIds: [...new Set(samples.map((sample) => sample.sensorId))],
    metricIds: [...new Set(samples.map((sample) => sample.metric))],
  };
}
