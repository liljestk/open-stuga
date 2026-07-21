import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "./db.js";
import type { SensorHistoryRecoveryResult } from "./sensor-gap-recovery.js";

const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_GMAIL_MESSAGE_BYTES = Math.ceil(MAX_CSV_BYTES * 4 / 3) + 2 * 1024 * 1024;
// Each app CSV row becomes both a temperature and a humidity staged sample.
// Keep one job below the database's 250,000-sample atomic completion ceiling.
export const MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB = 20_000;
// The app selects calendar dates rather than exact instants, so an export can
// include the partial start/end days (and a DST fallback hour) outside the
// requested interval. Those rows are filtered before samples are materialized.
const MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB = 23_000;
const MAX_GMAIL_PAGES = 5;
const MAX_GMAIL_MESSAGES_PER_PAGE = 25;
const MAX_GMAIL_CANDIDATE_ATTACHMENTS = 4;
const MAX_GMAIL_CANDIDATE_BYTES = 16 * 1024 * 1024;
const MAX_GMAIL_SEARCH_REQUESTS = 40;
const MAX_GMAIL_SEARCH_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_GMAIL_SEARCH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Longer than the runner's maximum accepted in-flight Appium request (120s). */
export const TAPO_TARGET_RECLAIM_GRACE_MS = 125_000;
const CONSUMED_STAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EXPORT_JOB_RETENTION_MS = 180 * 24 * 60 * 60_000;
const CANARY_JOB_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const TAPO_CANARY_APPROVAL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const TAPO_CANARY_RENEWAL_LEAD_MS = 7 * 24 * 60 * 60_000;
export const TAPO_HISTORY_CSV_PARSER_VERSION = "tapo-history-csv-v2";
/**
 * Umbrella acceptance-contract revision. Bump whenever CSV coverage, timezone,
 * Gmail correlation, canary provenance, or staging semantics change.
 */
export const TAPO_HISTORY_ACCEPTANCE_REVISION = "tapo-history-acceptance-2026-07-19-v1";

function apiImplementationSha256(directory = dirname(fileURLToPath(import.meta.url))): string {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) files.push(path);
    }
  };
  visit(directory);
  const hash = createHash("sha256");
  for (const path of files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)))) {
    hash.update(relative(directory, path).replaceAll("\\", "/"), "utf8")
      .update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

/** Exact API build/source digest included in the canary acceptance fence. */
export const TAPO_HISTORY_API_IMPLEMENTATION_SHA256 = apiImplementationSha256();

export interface TapoHistoryCsvOptions {
  sensorId: string;
  timeZone: string;
  from?: string;
  to?: string;
}

export interface TapoHistoryCsvResult {
  samples: MeasurementSample[];
  rowsRead: number;
  rowsSkipped: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Canonical structural signature fenced by the last accepted canary. */
  schemaSignature: string;
}

export interface TapoHistoryCsvCoverageRequest {
  metric: "temperature" | "humidity" | "power";
  from: string;
  to: string;
  intervalMinutes: number;
}

export class TapoHistoryFormatError extends Error {}

export class TapoHistoryCanaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TapoHistoryCanaryError";
  }
}

function normalizedHeader(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[\u00b0%()[\]{}]/g, " ").replace(/[_./\\-]+/g, " ").replace(/\s+/g, " ").trim();
}

function delimiterScore(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t"];
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8);
  let best = { delimiter: ",", score: 0 };
  for (const delimiter of candidates) {
    const counts = lines.map((line) => delimiterScore(line, delimiter)).filter((count) => count > 0);
    if (!counts.length) continue;
    const score = counts.reduce((sum, count) => sum + count, 0) - (Math.max(...counts) - Math.min(...counts));
    if (score > best.score) best = { delimiter, score };
  }
  if (best.score === 0) throw new TapoHistoryFormatError("Tapo export is not a delimited CSV file");
  return best.delimiter;
}

/** A bounded RFC 4180 parser. Tapo exports can contain quoted localized headers. */
function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      if (rows.length > MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB + 20) {
        throw new TapoHistoryFormatError("Tapo export contains too many rows for one bounded job");
      }
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new TapoHistoryFormatError("Tapo export contains an unterminated quoted field");
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length > MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB + 20) {
    throw new TapoHistoryFormatError("Tapo export contains too many rows for one bounded job");
  }
  return rows;
}

const DATE_TIME_ALIASES = ["timestamp", "date time", "datetime", "record time", "recorded at", "time stamp"];
const DATE_ALIASES = ["date", "paiva", "datum"];
const TIME_ALIASES = ["time", "aika", "tid", "uhrzeit"];
const TEMPERATURE_ALIASES = ["temperature", "temp", "lampotila", "temperatur", "teplota"];
const HUMIDITY_ALIASES = [
  "humidity", "relative humidity", "rh", "kosteus", "luftfuktighet", "luftfeuchtigkeit", "vlhkost vzduchu",
];

function headerMatches(header: string, aliases: string[]): boolean {
  return aliases.some((alias) => header === alias || header.startsWith(`${alias} `) || header.endsWith(` ${alias}`));
}

interface TapoColumns {
  headerRow: number;
  timestamp: number | null;
  date: number | null;
  time: number | null;
  temperature: number;
  humidity: number;
  temperatureUnit: "celsius" | "fahrenheit";
}

function hasExplicitDateTime(value: string): boolean {
  return /^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/u.test(value.trim())
    && parsedDateParts(value) !== null;
}

function rangeMetadataTimestampColumn(rows: string[][], headerRow: number): number | null {
  const header = rows[headerRow]?.[0]?.trim() ?? "";
  const range = header.split(/\s+-\s+/u);
  if (range.length !== 2 || !range.every(hasExplicitDateTime)) return null;
  const following = rows.slice(headerRow + 1)
    .filter((row) => row.some((value) => value.trim()))
    .slice(0, 3);
  // A metadata-looking header alone is insufficient: multiple following rows
  // must independently prove that column zero is a date-time series.
  return following.length >= 2 && following.every((row) => hasExplicitDateTime(row[0] ?? "")) ? 0 : null;
}

function uniqueHeaderColumn(raw: string[], pattern: RegExp): number {
  const matches = raw.flatMap((value, index) => pattern.test(value.normalize("NFKC")) ? [index] : []);
  return matches.length === 1 ? matches[0]! : -1;
}

function findColumns(rows: string[][]): TapoColumns {
  let unitlessTemperatureHeader = false;
  for (let rowIndex = 0; rowIndex < Math.min(20, rows.length); rowIndex += 1) {
    const raw = rows[rowIndex]!;
    const headers = raw.map(normalizedHeader);
    const find = (aliases: string[]) => {
      const exact = headers.findIndex((header) => aliases.includes(header));
      return exact >= 0 ? exact : headers.findIndex((header) => headerMatches(header, aliases));
    };
    const namedTemperature = find(TEMPERATURE_ALIASES);
    const namedHumidity = find(HUMIDITY_ALIASES);
    const temperature = namedTemperature >= 0
      ? namedTemperature
      : uniqueHeaderColumn(raw, /(?:°\s*[cf]\b|[℃℉])/iu);
    const humidity = namedHumidity >= 0 ? namedHumidity : uniqueHeaderColumn(raw, /%/u);
    const namedTimestamp = find(DATE_TIME_ALIASES);
    const date = find(DATE_ALIASES);
    const time = find(TIME_ALIASES);
    const inferredTimestamp = namedTimestamp < 0 && time < 0
      ? rangeMetadataTimestampColumn(rows, rowIndex)
      : null;
    const timestamp = namedTimestamp >= 0 ? namedTimestamp : inferredTimestamp ?? -1;
    if (temperature >= 0 && humidity >= 0 && (timestamp >= 0 || time >= 0)) {
      const temperatureHeader = raw[temperature]!.normalize("NFKC");
      const celsius = /(?:\u00b0\s*c\b|\u2103|\bcelsius\b)/iu.test(temperatureHeader);
      const fahrenheit = /(?:\u00b0\s*f\b|\u2109|\bfahrenheit\b)/iu.test(temperatureHeader);
      if (celsius === fahrenheit) {
        unitlessTemperatureHeader = true;
        continue;
      }
      const combinedDateAndTime = date >= 0 && time >= 0;
      return {
        headerRow: rowIndex,
        // Tapo commonly labels a full date-time column simply "Time". Only
        // treat it as a separate clock column when a Date column is present.
        timestamp: timestamp >= 0 ? timestamp : combinedDateAndTime ? null : time,
        date: date >= 0 ? date : null,
        time: time >= 0 ? time : null,
        temperature,
        humidity,
        temperatureUnit: fahrenheit ? "fahrenheit" : "celsius",
      };
    }
  }
  if (unitlessTemperatureHeader) {
    throw new TapoHistoryFormatError("Tapo export temperature header must explicitly declare °C or °F");
  }
  throw new TapoHistoryFormatError("Tapo export headers must contain time, temperature, and humidity columns");
}

function timestampForm(value: string, splitDateAndTime: boolean): string {
  const text = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/u.test(text)) return splitDateAndTime ? "split-offset" : "combined-offset";
  const match = /^(\d{1,4})([.\-/])(\d{1,2})\2(\d{1,4})(?:([ T])(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?$/u.exec(text);
  if (!match) return splitDateAndTime ? "split-unknown" : "combined-unknown";
  const order = match[1]!.length === 4 ? "ymd" : match[4]!.length === 4 ? "dmy" : "ambiguous";
  const precision = match[8] === undefined ? "minute" : "second";
  return `${splitDateAndTime ? "split" : "combined"}-${order}-${match[2]}-${precision}`;
}

function tapoCsvSchemaSignature(
  rows: string[][],
  columns: TapoColumns,
  delimiter: string,
  hadBom: boolean,
): string {
  const firstData = rows.slice(columns.headerRow + 1).find((row) => row.some((value) => value.trim())) ?? [];
  const splitDateAndTime = columns.timestamp === null;
  const timestampText = columns.timestamp === null
    ? `${firstData[columns.date!] ?? ""} ${firstData[columns.time!] ?? ""}`
    : firstData[columns.timestamp] ?? "";
  const rangeColumn = rangeMetadataTimestampColumn(rows, columns.headerRow);
  const headers = rows[columns.headerRow]!.map((header, index) =>
    index === rangeColumn ? "range-metadata" : normalizedHeader(header));
  const signature = {
    schema: "tapo-csv-structure-v1",
    encoding: hadBom ? "utf8-bom" : "utf8",
    delimiter: delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : "comma",
    headers,
    mapping: {
      timestamp: columns.timestamp,
      date: columns.date,
      time: columns.time,
      temperature: columns.temperature,
      humidity: columns.humidity,
    },
    temperatureUnit: columns.temperatureUnit,
    timestampForm: timestampForm(timestampText, splitDateAndTime),
  };
  return createHash("sha256").update(JSON.stringify(signature), "utf8").digest("hex");
}

function finiteCsvNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(/,(?=\d+$)/, ".");
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) return existing;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch { throw new TapoHistoryFormatError(`Invalid house timezone ${timeZone}`); }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zonedParts(timestamp: number, timeZone: string): number[] {
  const parts = zonedFormatter(timeZone).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return [part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second")];
}

function sameParts(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Return both instants when a local wall time is repeated at a DST transition. */
function localTimeCandidates(parts: number[], timeZone: string): number[] {
  const [year, month, day, hour, minute, second] = parts;
  if ([year, month, day, hour, minute, second].some((value) => !Number.isInteger(value))) return [];
  const nominal = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const date = new Date(nominal);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return [];
  const offsets = new Set<number>();
  for (const probe of [nominal - 86_400_000, nominal, nominal + 86_400_000]) {
    const displayed = zonedParts(probe, timeZone);
    offsets.add(Date.UTC(displayed[0]!, displayed[1]! - 1, displayed[2]!, displayed[3]!, displayed[4]!, displayed[5]!) - probe);
  }
  return [...offsets].map((offset) => nominal - offset)
    .filter((candidate) => sameParts(zonedParts(candidate, timeZone), parts))
    .sort((left, right) => left - right);
}

function parsedDateParts(value: string): number[] | null {
  const text = value.trim();
  const match = text.match(/^(\d{1,4})[.\-/](\d{1,2})[.\-/](\d{1,4})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2})(?:[.,]\d+)?)?)?$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const [year, month, day] = first > 999 ? [first, second, third]
    : third > 999 ? [third, second, first] : [first, second, third];
  return [year, month, day, Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)];
}

function parseTapoTimestamp(value: string, timeZone: string, previous: number | null): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parts = parsedDateParts(text);
  if (!parts) return null;
  const candidates = localTimeCandidates(parts, timeZone);
  if (!candidates.length) return null;
  return candidates.find((candidate) => previous === null || candidate > previous) ?? candidates[0]!;
}

/** Parse and identity-bind the otherwise anonymous CSV produced by the Tapo app. */
export function parseTapoHistoryCsv(csv: string | Uint8Array, options: TapoHistoryCsvOptions): TapoHistoryCsvResult {
  const bytes = typeof csv === "string" ? Buffer.byteLength(csv, "utf8") : csv.byteLength;
  if (bytes === 0 || bytes > MAX_CSV_BYTES) throw new TapoHistoryFormatError("Tapo export must be between 1 byte and 8 MiB");
  if (!options.sensorId.trim()) throw new TapoHistoryFormatError("A mapped sensor identity is required");
  const decoded = typeof csv === "string" ? csv : new TextDecoder("utf-8", { fatal: true }).decode(csv);
  const hadBom = decoded.startsWith("\uFEFF");
  const text = decoded.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows = parseCsvRows(text, delimiter);
  const columns = findColumns(rows);
  const schemaSignature = tapoCsvSchemaSignature(rows, columns, delimiter, hadBom);
  if (rows.length - columns.headerRow - 1 > MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB) {
    throw new TapoHistoryFormatError("Tapo export contains too many data rows for one bounded job");
  }
  const fromMs = options.from ? Date.parse(options.from) : -Infinity;
  const toMs = options.to ? Date.parse(options.to) : Infinity;
  if (!Number.isFinite(fromMs) && fromMs !== -Infinity || !Number.isFinite(toMs) && toMs !== Infinity || fromMs > toMs) {
    throw new TapoHistoryFormatError("Invalid Tapo export time range");
  }
  const samples: MeasurementSample[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;
  let rowsSkipped = 0;
  let previousTimestamp: number | null = null;
  for (const row of rows.slice(columns.headerRow + 1)) {
    rowsRead += 1;
    const timestampText = columns.timestamp === null
      ? `${row[columns.date!] ?? ""} ${row[columns.time!] ?? ""}`
      : row[columns.timestamp] ?? "";
    const timestampMs = parseTapoTimestamp(timestampText, options.timeZone, previousTimestamp);
    const rawTemperature = finiteCsvNumber(row[columns.temperature] ?? "");
    const humidity = finiteCsvNumber(row[columns.humidity] ?? "");
    if (timestampMs === null || rawTemperature === null || humidity === null) { rowsSkipped += 1; continue; }
    previousTimestamp = timestampMs;
    const temperature = columns.temperatureUnit === "fahrenheit" ? (rawTemperature - 32) * 5 / 9 : rawTemperature;
    if (temperature < -100 || temperature > 200 || humidity < 0 || humidity > 100) { rowsSkipped += 1; continue; }
    if (timestampMs < fromMs || timestampMs > toMs) continue;
    const timestamp = new Date(timestampMs).toISOString();
    for (const [metric, value, canonicalUnit] of [
      ["temperature", Number(temperature.toFixed(4)), "\u00b0C"],
      ["humidity", Number(humidity.toFixed(4)), "%"],
    ] as const) {
      const key = `${metric}\u0000${timestamp}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior !== value) throw new TapoHistoryFormatError("Tapo export contains conflicting duplicate timestamps");
        continue;
      }
      seen.set(key, value);
      // Tapo does not document whether interval rows are instantaneous or
      // aggregated, so imported app-export values must not claim exact quality.
      samples.push({ sensorId: options.sensorId, metric, value, canonicalUnit, timestamp, source: "tp-link", quality: "estimated" });
    }
  }
  if (rowsRead > 0 && samples.length === 0 && fromMs === -Infinity && toMs === Infinity) {
    throw new TapoHistoryFormatError("Tapo export did not contain any valid climate rows");
  }
  samples.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.metric.localeCompare(right.metric));
  return {
    samples,
    rowsRead,
    rowsSkipped,
    firstTimestamp: samples[0]?.timestamp ?? null,
    lastTimestamp: samples.at(-1)?.timestamp ?? null,
    schemaSignature,
  };
}

/** Fail closed when the app exported a default/overlapping range or cadence. */
export function assertTapoHistoryCsvCoverage(
  parsed: TapoHistoryCsvResult,
  request: TapoHistoryCsvCoverageRequest,
): void {
  const fromMs = Date.parse(request.from);
  const toMs = Date.parse(request.to);
  const intervalMs = request.intervalMinutes * 60_000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
    || !Number.isInteger(request.intervalMinutes) || request.intervalMinutes < 1) {
    throw new TapoHistoryFormatError("Tapo export job has an invalid coverage request");
  }
  if (parsed.rowsRead === 0) throw new TapoHistoryFormatError("Tapo export contains no data rows");
  const skippedLimit = Math.max(1, Math.floor(parsed.rowsRead * 0.05));
  if (parsed.rowsSkipped > skippedLimit) {
    throw new TapoHistoryFormatError("Tapo export skipped too many malformed or out-of-range rows");
  }
  const timestamps = [...new Set(parsed.samples
    .filter((sample) => sample.metric === request.metric)
    .map((sample) => Date.parse(sample.timestamp)))]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (timestamps.length < 2) {
    throw new TapoHistoryFormatError(`Tapo export contains fewer than two ${request.metric} samples in the requested range`);
  }
  const boundaryTolerance = Math.max(60_000, intervalMs * 0.2);
  if (timestamps[0]! > fromMs + intervalMs + boundaryTolerance
    || timestamps.at(-1)! < toMs - intervalMs - boundaryTolerance) {
    throw new TapoHistoryFormatError("Tapo export does not cover both requested range boundaries");
  }
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index]! - timestamps[index - 1]!;
    if (delta < intervalMs * 0.8) {
      throw new TapoHistoryFormatError("Tapo export cadence is finer than the requested interval");
    }
    if (delta > intervalMs * 1.5) {
      throw new TapoHistoryFormatError("Tapo export has an incomplete gap in its requested-range coverage");
    }
  }
}

/**
 * Canary-only temporal identity check against already trusted live telemetry.
 * It rejects both a better non-zero timezone lag and data too flat to prove
 * that zero lag is distinguishable.
 */
export function assertTapoCanaryMatchesLive(
  exportedSamples: readonly MeasurementSample[],
  liveSamples: readonly MeasurementSample[],
  metric: "temperature" | "humidity",
  intervalMinutes: number,
): void {
  const exported = exportedSamples.filter((sample) => sample.metric === metric)
    .map((sample) => ({ at: Date.parse(sample.timestamp), value: sample.value }))
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.value))
    .sort((left, right) => left.at - right.at);
  const live = liveSamples.filter((sample) => sample.metric === metric
      && sample.source === "tp-link" && sample.quality === "good")
    .map((sample) => ({ at: Date.parse(sample.timestamp), value: sample.value }))
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.value))
    .sort((left, right) => left.at - right.at);
  if (exported.length < 8 || live.length < 8) {
    throw new TapoHistoryFormatError("Canary needs at least eight overlapping trusted live samples");
  }
  const toleranceMs = Math.min(5 * 60_000, Math.max(90_000, intervalMinutes * 60_000 * 0.25));
  const nearest = (target: number): { at: number; value: number } | null => {
    let low = 0;
    let high = live.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (live[middle]!.at < target) low = middle + 1;
      else high = middle;
    }
    const candidates = [live[low - 1], live[low]].filter(Boolean) as Array<{ at: number; value: number }>;
    const match = candidates.sort((left, right) => Math.abs(left.at - target) - Math.abs(right.at - target))[0];
    return match && Math.abs(match.at - target) <= toleranceMs ? match : null;
  };
  const score = (lagMs: number): { lagMs: number; pairs: number; mae: number; values: number[] } => {
    let error = 0;
    let pairs = 0;
    const values: number[] = [];
    for (const sample of exported) {
      const match = nearest(sample.at + lagMs);
      if (!match) continue;
      error += Math.abs(sample.value - match.value);
      values.push(sample.value);
      pairs += 1;
    }
    return { lagMs, pairs, mae: pairs > 0 ? error / pairs : Number.POSITIVE_INFINITY, values };
  };
  const zero = score(0);
  if (zero.pairs < 8) throw new TapoHistoryFormatError("Canary does not overlap enough trusted live telemetry at zero lag");
  const valueRange = Math.max(...zero.values) - Math.min(...zero.values);
  const minimumRange = metric === "temperature" ? 0.4 : 2;
  if (valueRange < minimumRange) {
    throw new TapoHistoryFormatError("Canary live telemetry is too flat to prove export timezone alignment");
  }
  const candidateScores = [];
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    if (minutes === 0) continue;
    const candidate = score(minutes * 60_000);
    if (candidate.pairs >= 8) candidateScores.push(candidate);
  }
  const bestOther = candidateScores.sort((left, right) => left.mae - right.mae)[0];
  const allowedMae = metric === "temperature" ? 0.8 : 4;
  const discrimination = metric === "temperature" ? 0.1 : 0.5;
  if (zero.mae > allowedMae || (bestOther && zero.mae + discrimination > bestOther.mae)) {
    throw new TapoHistoryFormatError("Canary values do not prove zero-lag alignment with trusted live telemetry");
  }
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.length > 254 || /[\s<>]/.test(email)) return null;
  return email;
}

/** Generates a hidden capability address from an API-only random correlation nonce. */
export function tapoExportRecipient(baseEmail: string, correlationNonce: string, prefix = "stuga"): string {
  const email = normalizeEmail(baseEmail);
  if (!email) throw new Error("TAPO_HISTORY_EXPORT_EMAIL must be a valid email address");
  const [local, domain] = email.split("@");
  const untagged = local!.split("+")[0]!;
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "stuga";
  if (!correlationNonce) throw new Error("Tapo export correlation nonce is required");
  const digest = createHash("sha256").update(correlationNonce).digest("hex").slice(0, 32);
  const taggedLocal = `${untagged}+${safePrefix}-${digest}`;
  if (Buffer.byteLength(taggedLocal, "utf8") > 64) {
    throw new Error("TAPO_HISTORY_EXPORT_EMAIL local part is too long for a correlation tag");
  }
  return `${taggedLocal}@${domain}`;
}

interface GmailHeader { name?: unknown; value?: unknown }
interface GmailPart {
  filename?: unknown;
  mimeType?: unknown;
  headers?: unknown;
  body?: { data?: unknown; attachmentId?: unknown; size?: unknown };
  parts?: unknown;
}

interface GmailMessage {
  id?: unknown;
  internalDate?: unknown;
  payload?: GmailPart;
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("Gmail returned invalid attachment encoding");
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function gmailParts(root: GmailPart | undefined): GmailPart[] {
  if (!root) return [];
  const result: GmailPart[] = [];
  const pending: Array<{ part: GmailPart; depth: number }> = [{ part: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 12 || result.length >= 128) {
      throw new Error("Gmail MIME tree exceeds the allowed complexity");
    }
    result.push(current.part);
    if (Array.isArray(current.part.parts)) {
      for (let index = current.part.parts.length - 1; index >= 0; index -= 1) {
        const child = current.part.parts[index];
        if (child && typeof child === "object" && !Array.isArray(child)) {
          pending.push({ part: child as GmailPart, depth: current.depth + 1 });
        }
      }
    }
  }
  return result;
}

function gmailHeader(payload: GmailPart | undefined, name: string): string {
  if (!Array.isArray(payload?.headers)) return "";
  const header = (payload.headers as GmailHeader[]).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return typeof header?.value === "string" ? header.value : "";
}

async function boundedResponseBytes(
  response: Response,
  limit: number,
  controller?: AbortController,
  charge?: (bytes: number) => void,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    controller?.abort();
    throw new Error("Remote response exceeds the allowed size");
  }
  if (!response.body) throw new Error("Remote service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      charge?.(next.value.byteLength);
      total += next.value.byteLength;
      if (total > limit) {
        controller?.abort();
        await reader.cancel().catch(() => undefined);
        throw new Error("Remote response exceeds the allowed size");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    controller?.abort();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedResponseJson(
  response: Response,
  limit = 2 * 1024 * 1024,
  controller?: AbortController,
): Promise<unknown> {
  const bytes = await boundedResponseBytes(response, limit, controller);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("Remote service returned invalid JSON"); }
}

export interface GmailTapoMailboxOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Exact primary account identity expected from Gmail /users/me/profile. */
  expectedEmail: string;
  fetcher?: typeof fetch;
  tokenEndpoint?: string;
  apiBaseUrl?: string;
}

export interface GmailCsvSearchResult {
  attachments: Array<{ messageId: string; filename: string; bytes: Uint8Array }>;
  /** Matching messages/attachments rejected locally as malformed or oversized. */
  rejectedCandidates: number;
  /** Per-message Gmail fetch failures; these remain retryable and do not poison the scan. */
  transientFailures: number;
}

function mailboxContentRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("exceeds the allowed size")
    || message.includes("invalid attachment encoding")
    || message.includes("MIME tree exceeds the allowed complexity");
}

class GmailSearchBudgetExceeded extends Error {}
class GmailAuthenticationUnavailable extends Error {}
class GmailHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface GmailSearchBudget {
  deadlineAt: number;
  requests: number;
  responseBytes: number;
}

function gmailSearchBudget(deadlineAt = Date.now() + MAX_GMAIL_SEARCH_MS): GmailSearchBudget {
  return {
    deadlineAt: Math.min(deadlineAt, Date.now() + MAX_GMAIL_SEARCH_MS),
    requests: 0,
    responseBytes: 0,
  };
}

/** Minimal Gmail REST client: no mailbox password and no IMAP surface. */
export class GmailTapoMailbox {
  readonly #fetcher: typeof fetch;
  readonly #tokenEndpoint: string;
  readonly #apiBaseUrl: string;
  #accessToken: { value: string; expiresAt: number } | null = null;
  #identityVerifiedForToken: string | null = null;

  constructor(private readonly options: GmailTapoMailboxOptions) {
    if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(options.expectedEmail.trim())) {
      throw new Error("Expected Gmail account identity must be a valid email address");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#tokenEndpoint = options.tokenEndpoint ?? "https://oauth2.googleapis.com/token";
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
  }

  async findCsv(
    expectedRecipient: string,
    seenMessageIds: ReadonlySet<string>,
    notBefore?: string,
    budget = gmailSearchBudget(),
  ): Promise<GmailCsvSearchResult> {
    const token = await this.accessToken(budget);
    await this.verifyIdentity(token, budget);
    const results: Array<{ messageId: string; filename: string; bytes: Uint8Array }> = [];
    let candidateBytes = 0;
    let rejectedCandidates = 0;
    let transientFailures = 0;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_GMAIL_PAGES; page += 1) {
      const endpoint = new URL(`${this.#apiBaseUrl}/users/me/messages`);
      const minimumMs = notBefore ? Date.parse(notBefore) : Date.now() - 30 * 24 * 60 * 60_000;
      if (!Number.isFinite(minimumMs)) throw new Error("Tapo mailbox correlation time is invalid");
      endpoint.searchParams.set("q", `to:${expectedRecipient} has:attachment filename:csv after:${Math.floor((minimumMs - 300_000) / 1_000)}`);
      endpoint.searchParams.set("maxResults", String(MAX_GMAIL_MESSAGES_PER_PAGE));
      if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
      const listed = await this.requestJson(endpoint, token, 2 * 1024 * 1024, budget) as { messages?: unknown; nextPageToken?: unknown };
      const messages = Array.isArray(listed.messages) ? listed.messages : [];
      for (const item of messages) {
        const messageId = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id : null;
        if (!messageId || seenMessageIds.has(messageId)) continue;
        let message: GmailMessage;
        try {
          message = await this.requestJson(
            `${this.#apiBaseUrl}/users/me/messages/${encodeURIComponent(messageId)}?format=full`, token, MAX_GMAIL_MESSAGE_BYTES, budget,
          ) as GmailMessage;
        } catch (error) {
          if (error instanceof GmailSearchBudgetExceeded) throw error;
          if (mailboxContentRejected(error)) rejectedCandidates += 1;
          else transientFailures += 1;
          continue;
        }
        const recipientHeaders = ["to", "delivered-to", "x-original-to"]
          .map((name) => gmailHeader(message.payload, name)).join(",");
        const recipients: string[] = [...(recipientHeaders.toLowerCase()
          .match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [])];
        const internalDate = typeof message.internalDate === "string" ? Number(message.internalDate) : NaN;
        if (message.id !== messageId || !recipients.includes(expectedRecipient.toLowerCase())
          || !Number.isFinite(internalDate) || internalDate < minimumMs - 300_000 || internalDate > Date.now() + 300_000) continue;
        let parts: GmailPart[];
        try { parts = gmailParts(message.payload); }
        catch (error) {
          if (mailboxContentRejected(error)) rejectedCandidates += 1;
          else transientFailures += 1;
          continue;
        }
        for (const part of parts) {
          const filename = typeof part.filename === "string" ? part.filename.trim() : "";
          if (!filename.toLowerCase().endsWith(".csv")) continue;
          try {
            const size = Number(part.body?.size);
            if (Number.isFinite(size) && size > MAX_CSV_BYTES) throw new Error("oversized attachment");
            let bytes: Uint8Array;
            if (typeof part.body?.data === "string") bytes = base64UrlBytes(part.body.data);
            else if (typeof part.body?.attachmentId === "string") {
              let attachment: { data?: unknown; size?: unknown };
              try {
                attachment = await this.requestJson(
                  `${this.#apiBaseUrl}/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
                  token,
                  MAX_GMAIL_MESSAGE_BYTES,
                  budget,
                ) as { data?: unknown; size?: unknown };
              } catch (error) {
                if (error instanceof GmailSearchBudgetExceeded) throw error;
                if (mailboxContentRejected(error)) rejectedCandidates += 1;
                else transientFailures += 1;
                continue;
              }
              if (typeof attachment.data !== "string") throw new Error("missing attachment body");
              bytes = base64UrlBytes(attachment.data);
            } else {
              rejectedCandidates += 1;
              continue;
            }
            if (bytes.byteLength > MAX_CSV_BYTES) throw new Error("oversized attachment");
            if (results.length >= MAX_GMAIL_CANDIDATE_ATTACHMENTS
              || candidateBytes + bytes.byteLength > MAX_GMAIL_CANDIDATE_BYTES) {
              rejectedCandidates += 1;
              continue;
            }
            results.push({ messageId, filename, bytes });
            candidateBytes += bytes.byteLength;
            if (results.length >= MAX_GMAIL_CANDIDATE_ATTACHMENTS
              || candidateBytes >= MAX_GMAIL_CANDIDATE_BYTES) {
              return { attachments: results, rejectedCandidates, transientFailures };
            }
          } catch (error) {
            if (error instanceof GmailSearchBudgetExceeded) throw error;
            rejectedCandidates += 1;
          }
        }
      }
      pageToken = typeof listed.nextPageToken === "string" ? listed.nextPageToken : null;
      if (!pageToken) break;
    }
    return { attachments: results, rejectedCandidates, transientFailures };
  }

  async accessToken(budget?: GmailSearchBudget): Promise<string> {
    if (this.#accessToken && this.#accessToken.expiresAt > Date.now() + 60_000) return this.#accessToken.value;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: "refresh_token",
    });
    let value: { access_token?: unknown; expires_in?: unknown };
    try {
      value = await this.requestJsonWithInit(this.#tokenEndpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "error",
      }, 2 * 1024 * 1024, "Gmail OAuth refresh", budget) as { access_token?: unknown; expires_in?: unknown };
    } catch (error) {
      if (error instanceof GmailSearchBudgetExceeded) throw error;
      throw new GmailAuthenticationUnavailable("Gmail OAuth refresh is unavailable");
    }
    if (typeof value.access_token !== "string" || !value.access_token) {
      throw new GmailAuthenticationUnavailable("Gmail OAuth response omitted access_token");
    }
    const expiresIn = Number(value.expires_in);
    this.#accessToken = { value: value.access_token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3_600) * 1_000 };
    this.#identityVerifiedForToken = null;
    return value.access_token;
  }

  private async verifyIdentity(token: string, budget?: GmailSearchBudget): Promise<void> {
    if (this.#identityVerifiedForToken === token) return;
    let profile: { emailAddress?: unknown };
    try {
      profile = await this.requestJson(
        `${this.#apiBaseUrl}/users/me/profile`, token, 64 * 1024, budget,
      ) as { emailAddress?: unknown };
    } catch (error) {
      if (error instanceof GmailSearchBudgetExceeded || error instanceof GmailAuthenticationUnavailable) throw error;
      throw new GmailAuthenticationUnavailable("Gmail mailbox identity could not be verified");
    }
    const actual = typeof profile.emailAddress === "string" ? profile.emailAddress.trim().toLowerCase() : "";
    if (actual !== this.options.expectedEmail.trim().toLowerCase()) {
      this.#accessToken = null;
      this.#identityVerifiedForToken = null;
      throw new GmailAuthenticationUnavailable("Gmail OAuth token belongs to a different mailbox");
    }
    this.#identityVerifiedForToken = token;
  }

  private requestJson(
    endpoint: string | URL,
    token: string,
    limit = 2 * 1024 * 1024,
    budget?: GmailSearchBudget,
  ): Promise<unknown> {
    return this.requestJsonWithInit(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error",
    }, limit, "Gmail API", budget).catch((error: unknown) => {
      if (error instanceof GmailHttpError && error.status === 401) {
        this.#accessToken = null;
        this.#identityVerifiedForToken = null;
        throw new GmailAuthenticationUnavailable("Gmail rejected the cached OAuth access token");
      }
      throw error;
    });
  }

  private async requestJsonWithInit(
    endpoint: string | URL,
    init: RequestInit,
    limit: number,
    label: string,
    budget?: GmailSearchBudget,
  ): Promise<unknown> {
    if (budget && (budget.requests >= MAX_GMAIL_SEARCH_REQUESTS
      || budget.responseBytes >= MAX_GMAIL_SEARCH_RESPONSE_BYTES
      || Date.now() >= budget.deadlineAt)) {
      throw new GmailSearchBudgetExceeded("Gmail search exceeded its bounded request, byte, or time budget");
    }
    if (budget) budget.requests += 1;
    const controller = new AbortController();
    const remainingMs = budget ? Math.max(1, budget.deadlineAt - Date.now()) : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    timer.unref();
    try {
      const response = await this.#fetcher(endpoint, { ...init, signal: controller.signal });
      if (!response.ok) {
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
        throw new GmailHttpError(response.status, `${label} returned HTTP ${response.status}`);
      }
      if (!budget) return await boundedResponseJson(response, limit, controller);
      const remainingBytes = MAX_GMAIL_SEARCH_RESPONSE_BYTES - budget.responseBytes;
      if (remainingBytes <= 0) throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
      let bytes: Uint8Array;
      try {
        bytes = await boundedResponseBytes(response, Math.min(limit, remainingBytes), controller, (count) => {
          if (count > MAX_GMAIL_SEARCH_RESPONSE_BYTES - budget.responseBytes) {
            budget.responseBytes = MAX_GMAIL_SEARCH_RESPONSE_BYTES;
            throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
          }
          budget.responseBytes += count;
        });
      }
      catch (error) {
        if (error instanceof GmailSearchBudgetExceeded) throw error;
        if (remainingBytes < limit) throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
        throw error;
      }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new Error("Remote service returned invalid JSON"); }
    }
    catch (error) {
      if (budget && Date.now() >= budget.deadlineAt) {
        throw new GmailSearchBudgetExceeded("Gmail search exceeded its time budget");
      }
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`${label} request timed out`);
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export interface TapoPrivateHistoryClientOptions {
  endpoint: string;
  token: string;
  fetcher?: typeof fetch;
  resolver?: (hostname: string) => Promise<readonly string[]>;
}

interface PrivateHistoryPayload {
  deviceId?: unknown;
  state?: unknown;
  rangeStart?: unknown;
  rangeEnd?: unknown;
  samples?: unknown;
}

const PRIVATE_ENDPOINT_RESERVED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE_ENDPOINT_RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
  ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE_ENDPOINT_RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv6");

function normalizedEndpointHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPublicEndpointAddress(value: string): boolean {
  const address = normalizedEndpointHost(value);
  // Block IPv4-mapped IPv6 input outright. Node's BlockList maps IPv4 checks
  // into this range internally, so adding the /96 subnet would also block all
  // ordinary public IPv4 addresses.
  if (address.startsWith("::ffff:")) return false;
  const family = isIP(address);
  return family > 0 && !PRIVATE_ENDPOINT_RESERVED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function validatePrivateEndpoint(value: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must be a valid URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !endpoint.hostname) {
    throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must use HTTPS without embedded credentials");
  }
  const hostname = normalizedEndpointHost(endpoint.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || hostname === "home.arpa" || hostname.endsWith(".home.arpa")
    || isIP(hostname) > 0) {
    throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT may not target a private or reserved network");
  }
  return endpoint.toString();
}

async function withAbortDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Explicitly configured adapter for a reverse-engineered endpoint; disabled unless endpoint and token are supplied. */
export class TapoPrivateHistoryClient {
  readonly #endpoint: URL;
  readonly #fetcher: typeof fetch | null;
  readonly #resolver: (hostname: string) => Promise<readonly string[]>;
  constructor(private readonly options: TapoPrivateHistoryClientOptions) {
    this.#endpoint = new URL(validatePrivateEndpoint(options.endpoint));
    // An injected fetcher is retained for deterministic tests/embedders. The
    // production path below pins the vetted DNS answer through node:https.
    this.#fetcher = options.fetcher ?? null;
    this.#resolver = options.resolver ?? (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address));
  }

  async fetch(deviceId: string, sensorId: string, from: string, to: string): Promise<MeasurementSample[]> {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const hostname = normalizedEndpointHost(this.#endpoint.hostname);
      const addresses = isIP(hostname) > 0
        ? [hostname]
        : await withAbortDeadline(Promise.resolve(this.#resolver(hostname)), deadline);
      if (addresses.length === 0 || addresses.some((address) => !isPublicEndpointAddress(address))) {
        throw new Error("Experimental Tapo history endpoint resolved to a private or reserved network");
      }
      const body = JSON.stringify({ deviceId, from, to });
      const payload = (this.#fetcher
        ? await this.fetchInjected(body, deadline)
        : await this.fetchPinned(addresses[0]!, body, deadline)) as PrivateHistoryPayload;
      if (payload.deviceId !== deviceId || !Array.isArray(payload.samples)) {
        throw new Error("Experimental Tapo history response did not echo the requested device identity");
      }
      const coverageStart = typeof payload.rangeStart === "string" ? Date.parse(payload.rangeStart) : NaN;
      const coverageEnd = typeof payload.rangeEnd === "string" ? Date.parse(payload.rangeEnd) : NaN;
      if (payload.state !== "complete" || !Number.isFinite(coverageStart) || !Number.isFinite(coverageEnd)
        || coverageStart > Date.parse(from) || coverageEnd < Date.parse(to)) {
        throw new Error("Experimental Tapo history response did not prove complete requested-range coverage");
      }
      if (payload.samples.length > MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB) {
        throw new Error("Experimental Tapo history response contains too many rows for one bounded job");
      }
      const result: MeasurementSample[] = [];
      for (const candidate of payload.samples) {
        if (!candidate || typeof candidate !== "object") continue;
        const row = candidate as Record<string, unknown>;
        const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(timestampMs) || timestampMs < Date.parse(from) || timestampMs > Date.parse(to)) continue;
        for (const [metric, unit, min, max] of [["temperature", "\u00b0C", -100, 200], ["humidity", "%", 0, 100], ["power", "W", 0, 1_000_000]] as const) {
          const value = row[metric];
          if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) continue;
          // This compatibility endpoint is reverse-engineered history, not a
          // trusted direct/live observation. It must never satisfy a canary's
          // independent-reference requirement.
          result.push({ sensorId, metric, value, canonicalUnit: unit, timestamp: new Date(timestampMs).toISOString(), source: "tp-link", quality: "estimated" });
        }
      }
      return result;
    } catch (error) {
      if (deadline.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
        throw new Error("Experimental Tapo history request timed out");
      }
      throw error;
    }
  }

  private async fetchInjected(body: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetcher!(this.#endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", accept: "application/json" },
      body,
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`Experimental Tapo history endpoint returned HTTP ${response.status}`);
    return await withAbortDeadline(boundedResponseJson(response, 8 * 1024 * 1024), signal);
  }

  /** HTTPS transport with the validated DNS answer pinned while TLS verifies the configured hostname. */
  private fetchPinned(address: string, body: string, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      const request = httpsRequest({
        protocol: "https:",
        hostname: address,
        port: this.#endpoint.port || 443,
        servername: this.#endpoint.hostname,
        method: "POST",
        path: `${this.#endpoint.pathname}${this.#endpoint.search}`,
        headers: {
          host: this.#endpoint.host,
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
        },
        signal,
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          response.destroy();
          finish(() => reject(new Error(`Experimental Tapo history endpoint returned HTTP ${status}`)));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) {
          request.destroy();
          finish(() => reject(new Error("Remote response exceeds the allowed size")));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > 8 * 1024 * 1024) {
            const error = new Error("Remote response exceeds the allowed size");
            response.destroy(error);
            request.destroy(error);
            finish(() => reject(error));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          try { finish(() => resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown)); }
          catch { finish(() => reject(new Error("Remote service returned invalid JSON"))); }
        });
        response.once("error", (error) => finish(() => reject(error)));
      });
      request.once("error", (error) => finish(() => reject(error)));
      request.end(body);
    });
  }
}

export interface TapoHistoryServiceOptions {
  fetcher?: typeof fetch;
  onHistoryReady?: (job: TapoHistoryExportJob) => void;
  now?: () => Date;
  /** Returns the exact, unique alias visible in the Tapo app for this immutable device id. */
  deviceNameFor?: (sensorId: string, deviceId: string) => string | null;
  /** Deterministic DNS hook for the explicitly configured private adapter. */
  privateResolver?: (hostname: string) => Promise<readonly string[]>;
}

export interface TapoWorkerStatusUpdate {
  status: Extract<TapoHistoryExportJobStatus, "running" | "waiting-email" | "needs-attention" | "failed">;
  detail?: string | null;
}

export interface TapoHistoryMailboxHealth {
  lastSuccessfulPollAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  budgetExhaustions: number;
}

/**
 * Durable asynchronous fallback for ranges not retained on a local hub.
 * The gap coordinator remains the sole measurement writer: completed jobs are
 * exposed as recovery samples and consumed only after a successful ingest.
 */
export class TapoHistoryExportService {
  readonly #mailbox: GmailTapoMailbox | null;
  readonly #privateClient: TapoPrivateHistoryClient | null;
  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;
  readonly #pendingConsumption = new Map<string, { jobId: string; sampleIds: number[] }>();
  readonly #mailboxHealth: TapoHistoryMailboxHealth = {
    lastSuccessfulPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    budgetExhaustions: 0,
  };
  #timer: NodeJS.Timeout | null = null;
  #polling: Promise<void> | null = null;
  #lastMaintenanceAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly database: ClimateDatabase,
    private readonly options: TapoHistoryServiceOptions = {},
  ) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#mailbox = config.tapoHistoryGmailClientId && config.tapoHistoryGmailClientSecret && config.tapoHistoryGmailRefreshToken
      ? new GmailTapoMailbox({
          clientId: config.tapoHistoryGmailClientId,
          clientSecret: config.tapoHistoryGmailClientSecret,
          refreshToken: config.tapoHistoryGmailRefreshToken,
          expectedEmail: config.tapoHistoryGmailAccountEmail ?? config.tapoHistoryExportEmail!,
          fetcher: this.#fetcher,
        }) : null;
    this.#privateClient = config.tapoHistoryPrivateEndpoint && config.tapoHistoryPrivateToken
      ? new TapoPrivateHistoryClient({
          endpoint: config.tapoHistoryPrivateEndpoint,
          token: config.tapoHistoryPrivateToken,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.privateResolver ? { resolver: options.privateResolver } : {}),
        })
      : null;
    if (this.operational) {
      const appReady = Boolean(config.tapoHistoryExportEmail && config.tapoHistoryWorkerToken && this.#mailbox);
      const capabilityRevision = createHash("sha256").update(JSON.stringify({
        schema: 2,
        appReady,
        privateEndpoint: this.#privateClient ? config.tapoHistoryPrivateEndpoint : null,
        parser: TAPO_HISTORY_CSV_PARSER_VERSION,
      })).digest("hex");
      this.database.rearmNotSupportedSensorDataGaps(
        "tp-link",
        capabilityRevision,
        this.#now().toISOString(),
      );
    }
  }

  get enabled(): boolean { return this.config.tapoHistoryEnabled === true; }

  get operational(): boolean {
    const appReady = Boolean(this.config.tapoHistoryExportEmail
      && this.config.tapoHistoryWorkerToken && this.#mailbox);
    return this.enabled && (appReady || this.#privateClient !== null);
  }

  get mailboxHealth(): Readonly<TapoHistoryMailboxHealth> {
    return { ...this.#mailboxHealth };
  }

  start(): void {
    if (!this.enabled || this.#timer) return;
    this.wake();
    this.#timer = setInterval(() => this.wake(), Math.max(15_000, this.config.tapoHistoryMailboxPollIntervalMs ?? 60_000));
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#polling;
  }

  wake(): void {
    if (!this.enabled || this.#polling) return;
    this.#polling = this.pollMailbox()
      .catch((error: unknown) => {
        this.recordMailboxFailure(error);
        // Structured and deliberately detail-free: OAuth tokens, recipient
        // capabilities, and Gmail payloads must never enter API logs.
        console.warn(JSON.stringify({
          event: "tapo_history_mailbox_poll_failed",
          code: this.#mailboxHealth.lastErrorCode,
        }));
      })
      .finally(() => { this.#polling = null; });
  }

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    if (!this.enabled) return { state: "not-supported", samples: [], error: "Automated Tapo app history export is disabled" };
    const sensor = this.database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    if (!sensor || !deviceId) {
      return { state: "not-supported", samples: [], error: "Sensor has no TP-Link device binding" };
    }
    const definition = this.database.getMeasurementDefinition(metric);
    if (!sensor.enabled || !definition?.enabled) {
      return { state: "not-supported", samples: [], error: "Sensor or measurement metric is disabled" };
    }
    const house = this.database.getHouse(sensor.houseId);
    if (!house) return { state: "not-supported", samples: [], error: "Sensor house no longer exists" };
    const requestedFrom = Date.parse(from);
    const requestedTo = Date.parse(to);
    if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo) || requestedTo <= requestedFrom) {
      return { state: "not-supported", samples: [], error: "Tapo history recovery requires a valid increasing range" };
    }
    const providerCutoff = this.#now().getTime() - 730 * 24 * 60 * 60_000;
    if (requestedFrom < providerCutoff) {
      return { state: "not-supported", samples: [], error: "Tapo app history is limited to the most recent two years" };
    }
    const intervalMinutes = this.config.tapoHistoryExportIntervalMinutes ?? 15;
    const maximumJobSpanMs = maxTapoHistoryJobSpanMs(
      intervalMinutes,
      this.config.tapoHistoryMaxExportDays ?? 30,
    );
    let segmentStart = requestedFrom;
    const completedJobs = this.database.listTapoHistoryExportJobs({ sensorId, statuses: ["completed"], limit: 1_000 })
      .filter((job) => !job.dedupeKey.startsWith("canary:")
        && job.expectedDeviceId === deviceId
        && job.timeZone === house.timezone
        && job.intervalMinutes === intervalMinutes
        && (job.provider === "private-cloud"
          ? job.metric === metric
          : metric === "temperature" || metric === "humidity")
        && Date.parse(job.rangeEnd) > requestedFrom
        && Date.parse(job.rangeStart) < requestedTo)
      .sort((left, right) => Date.parse(left.rangeStart) - Date.parse(right.rangeStart)
        || Date.parse(right.rangeEnd) - Date.parse(left.rangeEnd));
    while (segmentStart < requestedTo) {
      const completed = completedJobs.find((job) => Date.parse(job.rangeStart) <= segmentStart
        && Date.parse(job.rangeEnd) > segmentStart);
      if (!completed) break;
      const staged = this.database.listTapoHistoryExportStagedSamples({
        jobId: completed.id,
        sensorId,
        metric,
        from: new Date(segmentStart).toISOString(),
        to: new Date(Math.min(requestedTo, Date.parse(completed.rangeEnd))).toISOString(),
        consumed: false,
        limit: 250_000,
      });
      if (staged.length > 0) {
        this.#pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
          jobId: completed.id, sampleIds: staged.map((sample) => sample.id),
        });
        const finalSegment = Date.parse(completed.rangeEnd) >= requestedTo;
        return {
          state: finalSegment ? "complete" : "partial",
          samples: staged.map(stagedMeasurement),
          error: finalSegment ? completed.detail : `Recovered bounded Tapo export segment ${completed.id}`,
        };
      }
      const anyRequestedMetric = this.database.listTapoHistoryExportStagedSamples({
        jobId: completed.id, sensorId, metric, limit: 1,
      }).length > 0;
      if (!anyRequestedMetric) {
        return {
          state: "partial",
          samples: [],
          error: `Tapo export job ${completed.id} proved its segment but contained no ${metric} samples`,
        };
      }
      segmentStart = Math.min(requestedTo, Date.parse(completed.rangeEnd));
    }

    if (segmentStart >= requestedTo) return { state: "complete", samples: [], error: null };
    const nextCompletedStart = completedJobs
      .map((job) => Date.parse(job.rangeStart))
      .filter((start) => start > segmentStart)
      .sort((left, right) => left - right)[0];
    const segmentEnd = Math.min(
      requestedTo,
      segmentStart + maximumJobSpanMs,
      nextCompletedStart ?? Number.POSITIVE_INFINITY,
    );
    const segmentFrom = new Date(segmentStart).toISOString();
    const segmentTo = new Date(segmentEnd).toISOString();

    const appReady = (metric === "temperature" || metric === "humidity")
      && Boolean(this.config.tapoHistoryExportEmail && this.config.tapoHistoryWorkerToken && this.#mailbox);
    let privateFailure: string | null = null;
    if (this.#privateClient) {
      try {
        const samples = await this.#privateClient.fetch(deviceId, sensorId, segmentFrom, segmentTo);
        const currentSensor = this.database.getSensor(sensorId);
        const currentHouse = currentSensor ? this.database.getHouse(currentSensor.houseId) : null;
        if (!currentSensor?.enabled || !this.database.getMeasurementDefinition(metric)?.enabled
          || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone) {
          throw new Error("Tapo sensor binding, enabled state, or house timezone changed during private history fetch");
        }
        const requestedSamples = samples.filter((sample) => sample.metric === metric);
        if (requestedSamples.length === 0) {
          throw new Error(`Experimental Tapo history response contained no ${metric} samples`);
        }
        assertTapoHistoryCsvCoverage({
          samples: requestedSamples,
          rowsRead: requestedSamples.length,
          rowsSkipped: 0,
          firstTimestamp: requestedSamples[0]?.timestamp ?? null,
          lastTimestamp: requestedSamples.at(-1)?.timestamp ?? null,
          schemaSignature: "private-cloud",
        }, {
          metric: metric as "temperature" | "humidity" | "power",
          from: segmentFrom,
          to: segmentTo,
          intervalMinutes,
        });
        const job = this.enqueue(sensorId, metric, segmentFrom, segmentTo, "private-cloud", sensor.name);
        const staged = this.database.completeTapoHistoryExportJobWithSamples(
          job.id,
          requestedSamples.map((sample) => stageMeasurement(sample, `private:${job.id}`)),
          { completedAt: this.#now().toISOString() },
        );
        this.#pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
          jobId: job.id,
          sampleIds: staged.staged.filter((sample) => sample.metric === metric).map((sample) => sample.id),
        });
        return {
          state: segmentEnd >= requestedTo ? "complete" : "partial",
          samples: requestedSamples,
          error: segmentEnd >= requestedTo ? null : `Recovered bounded private Tapo segment ${job.id}`,
        };
      } catch (error) {
        // The private endpoint is deliberately best-effort. A failed probe does
        // not block the documented app-export path or fabricate a worker lease.
        privateFailure = safeError(error);
      }
    }

    if (privateFailure && !appReady) {
      return {
        state: "partial",
        samples: [],
        error: `Experimental Tapo history endpoint is temporarily unavailable: ${privateFailure}`,
      };
    }

    const currentSensor = this.database.getSensor(sensorId);
    const currentHouse = currentSensor ? this.database.getHouse(currentSensor.houseId) : null;
    if (!currentSensor?.enabled || !this.database.getMeasurementDefinition(metric)?.enabled
      || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone) {
      return {
        state: "partial",
        samples: [],
        error: "Tapo sensor binding, enabled state, or house timezone changed while history recovery was in flight",
      };
    }

    if (metric !== "temperature" && metric !== "humidity") {
      return {
        state: "not-supported",
        samples: [],
        error: `Tapo app CSV automation does not provide the ${metric} metric`,
      };
    }

    if (!appReady) {
      return {
        state: "not-supported",
        samples: [],
        error: "Unattended Tapo app export requires export email, worker token, and Gmail OAuth configuration",
      };
    }
    const appDeviceName = this.options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
    if (!appDeviceName) {
      return {
        state: "partial",
        samples: [],
        error: "Tapo app export is waiting for a unique discovered device alias; sensor display names are never guessed",
      };
    }
    const job = this.enqueue(sensorId, metric, segmentFrom, segmentTo, "appium", appDeviceName);
    return { state: "partial", samples: [], error: `Tapo app export job ${job.id} is ${job.status}` };
  }

  consumeRecovered(sensorId: string, metric: string, from: string, to: string): void {
    const key = recoveryKey(sensorId, metric, from, to);
    const pending = this.#pendingConsumption.get(key);
    if (!pending) return;
    this.database.markTapoHistoryExportStagedSamplesConsumed(pending.jobId, pending.sampleIds, this.#now().toISOString());
    this.#pendingConsumption.delete(key);
  }

  listJobs(limit = 100): TapoHistoryExportJob[] {
    const now = this.#now();
    this.database.expireExhaustedTapoHistoryExportLeases(
      now.toISOString(),
      new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
    );
    return this.database.listTapoHistoryExportJobs({ limit });
  }

  claim(workerId: string, deploymentFingerprint: string): (TapoHistoryExportClaim & { serverNow: string }) | null {
    for (let skipped = 0; skipped < 100; skipped += 1) {
      const now = this.#now();
      const reclaimCutoff = new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString();
      this.database.expireExhaustedTapoHistoryExportLeases(now.toISOString(), reclaimCutoff);
      if (this.database.countWaitingTapoHistoryExportEmails()
        >= (this.config.tapoHistoryMaxPendingEmails ?? 1)) return null;
      const acceptanceRevision = this.acceptanceRevision();
      const renewalTarget = this.database.tapoHistoryCanaryRenewalTarget(
        deploymentFingerprint,
        acceptanceRevision,
        new Date(now.getTime() - TAPO_CANARY_APPROVAL_MAX_AGE_MS + TAPO_CANARY_RENEWAL_LEAD_MS).toISOString(),
      );
      if (renewalTarget) {
        const canaryEnd = now.getTime() - 5 * 60_000;
        // Renewal must observe enough real environmental movement for the
        // dual-metric anti-constant canary checks. A two-hour stable room often
        // cannot do that, so use the same bounded window as manual acceptance.
        const canarySpan = Math.max(7 * 24 * 60 * 60_000, 8 * renewalTarget.intervalMinutes * 60_000);
        try {
          this.createCanaryJob(
            renewalTarget.sensorId,
            renewalTarget.metric as "temperature" | "humidity",
            new Date(canaryEnd - canarySpan).toISOString(),
            new Date(canaryEnd).toISOString(),
            true,
          );
        } catch {
          // Keep a still-fresh prior approval usable if automatic renewal could
          // not be queued. Once it expires, ordinary selection below remains
          // closed and the authenticated status exposes the queued work.
        }
      }
      const claimArguments = [
        workerId,
        now.toISOString(),
        new Date(now.getTime() + Math.max(5 * 60_000, this.config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
        ["appium"],
        reclaimCutoff,
      ] as const;
      // Always lease a runnable canary first. Ordinary work is selected only
      // when this exact deployment has a fresh approval for the candidate's
      // sensor/device alias/timezone/export-interval scope.
      const claim = this.database.claimNextTapoHistoryExportJob(...claimArguments, {
        canaryOnly: true,
        deploymentFingerprint,
        acceptanceRevision,
        maxOutstandingAppium: this.config.tapoHistoryMaxPendingEmails ?? 1,
      }) ?? this.database.claimNextTapoHistoryExportJob(...claimArguments, {
        deploymentFingerprint,
        acceptanceRevision,
        requireApprovedTarget: true,
        approvalNotBefore: new Date(now.getTime() - TAPO_CANARY_APPROVAL_MAX_AGE_MS).toISOString(),
        requiredAcceptanceRevision: acceptanceRevision,
        maxOutstandingAppium: this.config.tapoHistoryMaxPendingEmails ?? 1,
      });
      if (!claim) return null;
      if (this.targetAliasMatches(claim.job) && this.config.tapoHistoryExportEmail) {
        const recipient = tapoExportRecipient(
          this.config.tapoHistoryExportEmail,
          randomBytes(32).toString("base64url"),
          this.config.tapoHistoryEmailTagPrefix,
        );
        const rotated = this.database.rotateTapoHistoryExportRecipient(
          claim.job.id,
          claim.leaseToken,
          recipient,
          now.toISOString(),
        );
        if (rotated) return { job: rotated, leaseToken: claim.leaseToken, serverNow: now.toISOString() };
        return null;
      }
      this.database.transitionTapoHistoryExportJob(claim.job.id, {
        status: "needs-attention",
        leaseToken: claim.leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed after this job was queued",
      });
    }
    return null;
  }

  heartbeat(jobId: string, leaseToken: string): { job: TapoHistoryExportJob; serverNow: string } | null {
    const now = this.#now();
    const current = this.database.getTapoHistoryExportJob(jobId);
    if (current && !this.targetAliasMatches(current)) {
      this.database.transitionTapoHistoryExportJob(jobId, {
        status: "needs-attention",
        leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
      });
      return null;
    }
    const job = this.database.heartbeatTapoHistoryExportJob(
      jobId, leaseToken, now.toISOString(),
      new Date(now.getTime() + Math.max(5 * 60_000, this.config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
    );
    return job ? { job, serverNow: now.toISOString() } : null;
  }

  updateFromWorker(jobId: string, leaseToken: string, update: TapoWorkerStatusUpdate): TapoHistoryExportJob | null {
    const now = this.#now();
    const current = this.database.getTapoHistoryExportJob(jobId);
    if (current && !this.targetAliasMatches(current)) {
      return this.database.transitionTapoHistoryExportJob(jobId, {
        status: "needs-attention",
        leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
      });
    }
    return this.database.transitionTapoHistoryExportJob(jobId, {
      status: update.status,
      leaseToken,
      at: now.toISOString(),
      ...(update.status === "failed" ? {
        error: update.detail ?? "Tapo mobile export failed",
        availableAt: new Date(now.getTime() + 60_000).toISOString(),
      } : {}),
      ...(update.status === "needs-attention" ? {
        attentionReason: update.detail ?? "Tapo mobile automation needs operator attention",
      } : {}),
    });
  }

  retry(jobId: string): TapoHistoryExportJob | null {
    const now = this.#now();
    const current = this.database.getTapoHistoryExportJob(jobId);
    const leaseFence = current?.leaseExpiresAt
      ? Date.parse(current.leaseExpiresAt) + TAPO_TARGET_RECLAIM_GRACE_MS
      : now.getTime();
    return this.database.requeueTapoHistoryExportJob(
      jobId,
      new Date(Math.max(now.getTime(), leaseFence)).toISOString(),
      true,
    );
  }

  cancel(jobId: string): TapoHistoryExportJob | null {
    return this.database.cancelTapoHistoryExportJob(jobId, this.#now().toISOString());
  }

  /** Records an explicit operator-requested historical interval for normal segmented recovery. */
  requestBackfill(
    sensorId: string,
    metric: "temperature" | "humidity",
    from: string,
    to: string,
  ): SensorDataGapRecord {
    if (!this.operational) {
      throw new TapoHistoryCanaryError(
        "TAPO_HISTORY_NOT_CONFIGURED",
        "Tapo history backfill requires a complete app/mailbox or private-adapter configuration",
      );
    }
    const sensor = this.database.getSensor(sensorId);
    if (!sensor?.enabled || !this.boundDeviceId(sensorId)) {
      throw new TapoHistoryCanaryError(
        "TAPO_BACKFILL_SENSOR_NOT_BOUND",
        "Backfill sensor must be enabled and have an immutable TP-Link device binding",
      );
    }
    const nowDate = this.#now();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const intervalMs = (this.config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
      || toMs - fromMs < 2 * intervalMs || toMs > nowDate.getTime() + 5 * 60_000
      || fromMs < nowDate.getTime() - 730 * 24 * 60 * 60_000
      || toMs - fromMs > 730 * 24 * 60 * 60_000) {
      throw new TapoHistoryCanaryError(
        "INVALID_TAPO_BACKFILL_RANGE",
        "Backfill must be within the most recent two years, span at least two export intervals, and not end in the future",
      );
    }
    const definition = this.database.getMeasurementDefinition(metric);
    if (!definition?.enabled) {
      throw new TapoHistoryCanaryError("TAPO_BACKFILL_TARGET_DISABLED", "Backfill metric must be enabled");
    }
    const now = nowDate.toISOString();
    const gap = this.database.noteHistoricalSensorDataGap(sensorId, metric, "tp-link", from, to, now);
    return this.database.rearmSensorDataGapRecovery(gap.id, now, true) ?? gap;
  }

  /** Queues an isolated end-to-end acceptance job; its staged rows are never offered to gap recovery. */
  createCanary(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): TapoHistoryExportJob {
    return this.createCanaryJob(sensorId, metric, from, to, false);
  }

  private createCanaryJob(
    sensorId: string,
    metric: "temperature" | "humidity",
    from: string,
    to: string,
    automaticRenewal: boolean,
  ): TapoHistoryExportJob {
    if (!this.enabled || !this.config.tapoHistoryExportEmail || !this.config.tapoHistoryWorkerToken || !this.#mailbox) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_NOT_CONFIGURED",
        "Canary requires enabled Tapo history, export email, worker token, and Gmail OAuth configuration",
      );
    }
    const sensor = this.database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    if (!sensor?.enabled || !deviceId) {
      throw new TapoHistoryCanaryError("TAPO_CANARY_SENSOR_NOT_BOUND", "Canary sensor needs an immutable TP-Link device binding");
    }
    if (!["temperature", "humidity"].every(
      (requiredMetric) => this.database.getMeasurementDefinition(requiredMetric)?.enabled === true,
    )) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_METRIC_DISABLED",
        "Canary requires enabled temperature and humidity measurement definitions",
      );
    }
    const deviceName = this.options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
    if (!deviceName) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_DEVICE_ALIAS_MISSING",
        "Canary is waiting for one unique live-discovered Tapo device alias",
      );
    }
    return this.enqueue(sensorId, metric, from, to, "appium", deviceName, true, automaticRenewal);
  }

  private enqueue(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    provider: TapoHistoryExportProvider,
    deviceName: string,
    canary = false,
    automaticRenewal = false,
  ): TapoHistoryExportJob {
    const sensor = this.database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    if (!sensor || !deviceId) throw new Error("TP-Link sensor binding disappeared");
    const house = this.database.getHouse(sensor.houseId);
    if (!house) throw new Error("TP-Link sensor house disappeared");
    const reusable = !canary ? this.findJob(sensorId, deviceId, house.timezone, from, to, [
      "queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled",
    ], provider, deviceName, this.config.tapoHistoryExportIntervalMinutes ?? 15, metric) : null;
    if (reusable) return reusable;
    const intervalMinutes = this.config.tapoHistoryExportIntervalMinutes ?? 15;
    const id = randomUUID();
    const requestIdentity = [
      provider, sensorId, deviceId, deviceName.normalize("NFKC"), house.timezone, metric, from, to, String(intervalMinutes),
      ...(canary ? [id] : []),
    ].join("\u0000");
    const dedupeKey = `${canary ? (automaticRenewal ? "canary:renewal" : "canary") : "automation"}:${createHash("sha256").update(requestIdentity).digest("hex")}`;
    const existing = this.database.getTapoHistoryExportJobByDedupeKey(dedupeKey);
    if (existing) return existing;
    const correlationNonce = randomBytes(32).toString("base64url");
    const recipient = this.config.tapoHistoryExportEmail
      ? tapoExportRecipient(this.config.tapoHistoryExportEmail, correlationNonce, this.config.tapoHistoryEmailTagPrefix)
      : null;
    const result = this.database.enqueueTapoHistoryExportJob({
      id,
      sensorId,
      expectedDeviceId: deviceId,
      deviceName,
      timeZone: house.timezone,
      metric,
      rangeStart: from,
      rangeEnd: to,
      intervalMinutes,
      provider,
      expectedRecipient: recipient,
      dedupeKey,
    }, this.#now().toISOString());
    return result.job;
  }

  private findJob(
    sensorId: string,
    expectedDeviceId: string,
    timeZone: string,
    from: string,
    to: string,
    statuses: TapoHistoryExportJobStatus[],
    provider?: TapoHistoryExportProvider,
    deviceName?: string,
    intervalMinutes?: number,
    metric?: string,
  ): TapoHistoryExportJob | null {
    const requestedFrom = Date.parse(from);
    const requestedTo = Date.parse(to);
    return this.database.listTapoHistoryExportJobs({ sensorId, statuses, ...(provider ? { provider } : {}), limit: 1_000 })
      .find((job) => !job.dedupeKey.startsWith("canary:")
        && Date.parse(job.rangeStart) <= requestedFrom && Date.parse(job.rangeEnd) >= requestedTo
        && job.expectedDeviceId === expectedDeviceId
        && job.timeZone === timeZone
        && (job.provider !== "private-cloud" || metric === undefined || job.metric === metric)
        && (deviceName === undefined || job.deviceName === deviceName)
        && (intervalMinutes === undefined || job.intervalMinutes === intervalMinutes)) ?? null;
  }

  private boundDeviceId(sensorId: string): string | null {
    const direct = this.database.getSensor(sensorId)?.tpLinkDeviceId?.trim();
    // Automated historical recovery requires a persisted direct binding.
    // Every job snapshots and revalidates this ID; legacy mutable map files are
    // intentionally excluded from the identity boundary.
    return direct || null;
  }

  private acceptanceRevision(): string {
    const mailboxCredentialProof = this.config.tapoHistoryGmailRefreshToken && this.config.tapoHistoryWorkerToken
      ? createHmac("sha256", this.config.tapoHistoryWorkerToken)
        .update(this.config.tapoHistoryGmailRefreshToken, "utf8").digest("hex")
      : null;
    return createHash("sha256").update(JSON.stringify({
      acceptanceContract: TAPO_HISTORY_ACCEPTANCE_REVISION,
      apiImplementationSha256: TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
      runtime: {
        node: process.version,
        icu: process.versions.icu ?? null,
        tz: process.versions.tz ?? null,
        cldr: process.versions.cldr ?? null,
        unicode: process.versions.unicode ?? null,
      },
      parser: TAPO_HISTORY_CSV_PARSER_VERSION,
      exportEmail: this.config.tapoHistoryExportEmail?.trim().toLowerCase() ?? null,
      gmailAccountEmail: this.config.tapoHistoryGmailAccountEmail?.trim().toLowerCase() ?? null,
      gmailClientId: this.config.tapoHistoryGmailClientId?.trim() ?? null,
      mailboxCredentialProof,
    })).digest("hex");
  }

  private targetAliasMatches(job: TapoHistoryExportJob): boolean {
    const sensor = this.database.getSensor(job.sensorId);
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    const definition = this.database.getMeasurementDefinition(job.metric);
    const canaryDefinitionsEnabled = !job.canary || ["temperature", "humidity"]
      .every((metric) => this.database.getMeasurementDefinition(metric)?.enabled === true);
    if (job.provider !== "appium" || !sensor || !sensor.enabled || !definition?.enabled
      || !canaryDefinitionsEnabled || !house
      || sensor.tpLinkDeviceId?.trim() !== job.expectedDeviceId
      || house.timezone !== job.timeZone
      || job.acceptanceRevision !== this.acceptanceRevision()) return false;
    try {
      return (this.options.deviceNameFor?.(job.sensorId, job.expectedDeviceId)?.trim() ?? "") === job.deviceName;
    } catch {
      return false;
    }
  }

  private recordMailboxSuccess(at = this.#now().toISOString()): void {
    this.#mailboxHealth.lastSuccessfulPollAt = at;
    this.#mailboxHealth.consecutiveFailures = 0;
    this.#mailboxHealth.lastErrorCode = null;
  }

  private recordMailboxFailure(error: unknown, at = this.#now().toISOString()): void {
    const code = error instanceof GmailSearchBudgetExceeded
      ? "budget_exhausted"
      : error instanceof GmailAuthenticationUnavailable
        ? "oauth_unavailable"
        : error instanceof Error && error.name
          ? error.name.replace(/[^a-z0-9_-]/giu, "_").toLowerCase().slice(0, 80)
          : "unknown_error";
    this.#mailboxHealth.lastErrorAt = at;
    this.#mailboxHealth.lastErrorCode = code;
    this.#mailboxHealth.consecutiveFailures += 1;
    if (error instanceof GmailSearchBudgetExceeded) this.#mailboxHealth.budgetExhaustions += 1;
  }

  private async pollMailbox(): Promise<void> {
    const maintenanceNow = this.#now();
    this.database.expireExhaustedTapoHistoryExportLeases(
      maintenanceNow.toISOString(),
      new Date(maintenanceNow.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
    );
    if (maintenanceNow.getTime() - this.#lastMaintenanceAt >= 24 * 60 * 60_000) {
      this.database.pruneTapoHistoryExportHistory({
        consumedBefore: new Date(maintenanceNow.getTime() - CONSUMED_STAGE_RETENTION_MS).toISOString(),
        completedBefore: new Date(maintenanceNow.getTime() - EXPORT_JOB_RETENTION_MS).toISOString(),
        canaryBefore: new Date(maintenanceNow.getTime() - CANARY_JOB_RETENTION_MS).toISOString(),
      });
      this.#lastMaintenanceAt = maintenanceNow.getTime();
    }
    if (!this.#mailbox) return;
    const jobs = this.database.listTapoHistoryExportJobs({ statuses: ["waiting-email"], oldestFirst: true, limit: 100 });
    const pollDeadlineAt = Date.now() + MAX_GMAIL_SEARCH_MS;
    const pollBudget = gmailSearchBudget(pollDeadlineAt);
    for (const job of jobs) {
      if (Date.now() >= pollDeadlineAt) break;
      if (!job.expectedRecipient) continue;
      const now = this.#now();
      const timeoutMs = Math.max(60_000, this.config.tapoHistoryEmailTimeoutMs ?? 6 * 60 * 60_000);
      if (!job.submittedAt) {
        this.database.transitionTapoHistoryExportJob(job.id, {
          status: "needs-attention",
          at: now.toISOString(),
          expectedRecipient: job.expectedRecipient,
          expectedSubmittedAt: null,
          attentionReason: "Tapo export is missing its server-recorded submission timestamp",
        });
        continue;
      }
      const emailDeadlineExpired = Date.parse(job.submittedAt) + timeoutMs <= now.getTime();
      try {
        const seen = new Set(this.database.listTapoHistoryExportJobs({ limit: 1_000 })
          .flatMap((candidate) => candidate.mailboxMessageId ? [candidate.mailboxMessageId] : []));
        const search = await this.#mailbox.findCsv(job.expectedRecipient, seen, job.submittedAt, pollBudget);
        if (search.transientFailures === 0) this.recordMailboxSuccess(now.toISOString());
        else {
          const transient = new Error("One or more Gmail message fetches failed transiently");
          transient.name = "GmailTransientFailure";
          this.recordMailboxFailure(transient, now.toISOString());
        }
        let attachmentError: string | null = null;
        let completed = false;
        for (const attachment of search.attachments) {
          try {
            const sensor = this.database.getSensor(job.sensorId);
            if (!sensor || !this.targetAliasMatches(job)) {
              throw new Error("Tapo export job device binding or unique live alias changed");
            }
            const parsed = parseTapoHistoryCsv(attachment.bytes, {
              sensorId: job.sensorId, timeZone: job.timeZone, from: job.from, to: job.to,
            });
            if (!job.canary && parsed.schemaSignature !== job.expectedSchemaSignature) {
              this.database.revokeTapoHistoryCanaryApprovalsForJobTarget(job.id);
              const canaryEnd = this.#now().getTime() - 5 * 60_000;
              const canarySpan = Math.max(7 * 24 * 60 * 60_000, 8 * job.intervalMinutes * 60_000);
              try {
                this.createCanaryJob(
                  job.sensorId,
                  job.metric as "temperature" | "humidity",
                  new Date(canaryEnd - canarySpan).toISOString(),
                  new Date(canaryEnd).toISOString(),
                  true,
                );
              } catch {
                // Approval remains revoked even if target state prevents an
                // automatic recertification job. Operator health exposes the
                // needs-attention job and ordinary claims remain closed.
              }
              throw new TapoHistoryFormatError(
                "Tapo CSV schema changed after acceptance; approval was revoked and a fresh canary is required",
              );
            }
            if (job.metric !== "temperature" && job.metric !== "humidity") {
              throw new Error(`Tapo app CSV cannot satisfy ${job.metric}`);
            }
            assertTapoHistoryCsvCoverage(parsed, {
              metric: job.metric,
              from: job.from,
              to: job.to,
              intervalMinutes: job.intervalMinutes,
            });
            if (job.canary) {
              // Approval is deployment-wide, so the canary must independently
              // prove both climate columns rather than only the gap that caused
              // the operator to enqueue it.
              for (const canaryMetric of ["temperature", "humidity"] as const) {
                assertTapoHistoryCsvCoverage(parsed, {
                  metric: canaryMetric,
                  from: job.from,
                  to: job.to,
                  intervalMinutes: job.intervalMinutes,
                });
                const live = this.database.measurementHistory(
                  job.sensorId,
                  canaryMetric,
                  job.from,
                  job.to,
                  20_000,
                );
                assertTapoCanaryMatchesLive(
                  parsed.samples,
                  live,
                  canaryMetric,
                  job.intervalMinutes,
                );
              }
            }
            const result = this.database.completeTapoHistoryExportJobWithSamples(
              job.id,
              parsed.samples.map((sample) => stageMeasurement(sample, `gmail:${attachment.messageId}`)),
              {
                mailboxMessageId: attachment.messageId,
                completedAt: this.#now().toISOString(),
                expectedRecipient: job.expectedRecipient,
                expectedSubmittedAt: job.submittedAt,
                sourceArtifactSha256: createHash("sha256").update(attachment.bytes).digest("hex"),
                sourceArtifactBytes: attachment.bytes.byteLength,
                parserVersion: TAPO_HISTORY_CSV_PARSER_VERSION,
                sourceSchemaSignature: parsed.schemaSignature,
              },
            );
            if (job.canary) {
              this.database.approveTapoHistoryDeploymentFromCanary(
                result.job.id,
                this.acceptanceRevision(),
                this.#now().toISOString(),
              );
            } else {
              this.database.expediteSensorDataGapRecovery(
                job.sensorId, "tp-link", job.rangeStart, job.rangeEnd, this.#now().toISOString(),
              );
              this.options.onHistoryReady?.(result.job);
            }
            completed = true;
            break;
          } catch (error) { attachmentError = safeError(error); }
        }
        if (!completed && attachmentError) {
          this.database.transitionTapoHistoryExportJob(job.id, {
            status: "needs-attention",
            at: this.#now().toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: job.submittedAt,
            attentionReason: attachmentError,
          });
        } else if (!completed && search.rejectedCandidates > 0) {
          this.database.transitionTapoHistoryExportJob(job.id, {
            status: "needs-attention",
            at: this.#now().toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: job.submittedAt,
            attentionReason: `Correlated Gmail messages contained ${search.rejectedCandidates} invalid or oversized CSV attachment(s)`,
          });
        } else if (!completed && emailDeadlineExpired && search.transientFailures === 0) {
          // A delivery deadline is meaningful only after a healthy Gmail list
          // and message scan. OAuth/network/individual-message failures pause
          // the deadline instead of burning another mobile export attempt.
          this.database.transitionTapoHistoryExportJob(job.id, {
            status: "failed",
            at: now.toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: job.submittedAt,
            availableAt: new Date(now.getTime() + 60_000).toISOString(),
            error: "No correlated Tapo export email arrived before the configured timeout",
          });
        }
      } catch (error) {
        this.recordMailboxFailure(error);
        if (error instanceof GmailSearchBudgetExceeded || error instanceof GmailAuthenticationUnavailable) break;
        // Mailbox network/OAuth failures are transient. The job remains in
        // waiting-email and the next bounded poll retries it.
      }
    }
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Tapo history operation failed").slice(0, 1_000);
}

/** Largest inclusive interval range whose two climate series fit one atomic staged job. */
export function maxTapoHistoryJobSpanMs(intervalMinutes: number, maximumExportDays = 30): number {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new TapoHistoryFormatError("Tapo history interval must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumExportDays) || maximumExportDays < 1 || maximumExportDays > 730) {
    throw new TapoHistoryFormatError("Tapo history maximum export days must be an integer from 1 through 730");
  }
  const rowBound = (MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB - 1) * intervalMinutes * 60_000;
  // Public reports have truncated multi-month requests to roughly 30 days in
  // practice. Keep that separately configurable while retaining row/2y caps.
  return Math.min(rowBound, maximumExportDays * 24 * 60 * 60_000, 730 * 24 * 60 * 60_000);
}

function recoveryKey(sensorId: string, metric: string, from: string, to: string): string {
  return `${sensorId}\u0000${metric}\u0000${new Date(from).toISOString()}\u0000${new Date(to).toISOString()}`;
}

function stageMeasurement(sample: MeasurementSample, identityPrefix: string): TapoHistoryExportStagedSampleInput {
  return {
    metric: sample.metric,
    timestamp: sample.timestamp,
    value: sample.value,
    canonicalUnit: sample.canonicalUnit,
    source: "tp-link",
    quality: sample.quality,
    sourceIdentity: createHash("sha256")
      .update(`${identityPrefix}\u0000${sample.metric}\u0000${sample.timestamp}`)
      .digest("hex"),
  };
}

function stagedMeasurement(sample: TapoHistoryExportStagedSample): MeasurementSample {
  return {
    sensorId: sample.sensorId,
    metric: sample.metric,
    timestamp: sample.timestamp,
    value: sample.value,
    canonicalUnit: sample.canonicalUnit,
    source: "tp-link",
    quality: sample.quality,
  };
}
