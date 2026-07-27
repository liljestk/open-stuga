import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "../../db.js";
import type { SensorHistoryRecoveryResult } from "../../sensor-gap-recovery.js";
import { parsedDateParts } from "./02-finite-csv-number-to-gmail-header.js";

export const MAX_CSV_BYTES = 8 * 1024 * 1024;

export const MAX_GMAIL_MESSAGE_BYTES = Math.ceil(MAX_CSV_BYTES * 4 / 3) + 2 * 1024 * 1024;

// Each app CSV row becomes both a temperature and a humidity staged sample.
// Keep one job below the database's 250,000-sample atomic completion ceiling.
export const MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB = 20_000;

// The app selects calendar dates rather than exact instants, so an export can
// include the partial start/end days (and a DST fallback hour) outside the
// requested interval. Those rows are filtered before samples are materialized.
export const MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB = 23_000;

export const MAX_GMAIL_PAGES = 5;

export const MAX_GMAIL_MESSAGES_PER_PAGE = 25;

export const MAX_GMAIL_CANDIDATE_ATTACHMENTS = 4;

export const MAX_GMAIL_CANDIDATE_BYTES = 16 * 1024 * 1024;

export const MAX_GMAIL_SEARCH_REQUESTS = 40;

export const MAX_GMAIL_SEARCH_RESPONSE_BYTES = 64 * 1024 * 1024;

export const MAX_GMAIL_SEARCH_MS = 30_000;

export const REQUEST_TIMEOUT_MS = 20_000;

/** Longer than the runner's maximum accepted in-flight Appium request (120s). */
export const TAPO_TARGET_RECLAIM_GRACE_MS = 125_000;

export const CONSUMED_STAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const EXPORT_JOB_RETENTION_MS = 180 * 24 * 60 * 60_000;

export const CANARY_JOB_RETENTION_MS = 365 * 24 * 60 * 60_000;

export const TAPO_CANARY_APPROVAL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export const TAPO_CANARY_RENEWAL_LEAD_MS = 7 * 24 * 60 * 60_000;

export const TAPO_HISTORY_CSV_PARSER_VERSION = "tapo-history-csv-v2";

/**
 * Umbrella acceptance-contract revision. Bump whenever CSV coverage, timezone,
 * Gmail correlation, canary provenance, or staging semantics change.
 */
export const TAPO_HISTORY_ACCEPTANCE_REVISION = "tapo-history-acceptance-2026-07-19-v1";

export function apiImplementationSha256(directory = dirname(fileURLToPath(import.meta.url))): string {
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

export function normalizedHeader(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[\u00b0%()[\]{}]/g, " ").replace(/[_./\\-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function delimiterScore(line: string, delimiter: string): number {
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

export function detectDelimiter(text: string): string {
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
export function parseCsvRows(text: string, delimiter: string): string[][] {
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

export const DATE_TIME_ALIASES = ["timestamp", "date time", "datetime", "record time", "recorded at", "time stamp"];

export const DATE_ALIASES = ["date", "paiva", "datum"];

export const TIME_ALIASES = ["time", "aika", "tid", "uhrzeit"];

export const TEMPERATURE_ALIASES = ["temperature", "temp", "lampotila", "temperatur", "teplota"];

export const HUMIDITY_ALIASES = [
  "humidity", "relative humidity", "rh", "kosteus", "luftfuktighet", "luftfeuchtigkeit", "vlhkost vzduchu",
];

export function headerMatches(header: string, aliases: string[]): boolean {
  return aliases.some((alias) => header === alias || header.startsWith(`${alias} `) || header.endsWith(` ${alias}`));
}

export interface TapoColumns {
  headerRow: number;
  timestamp: number | null;
  date: number | null;
  time: number | null;
  temperature: number;
  humidity: number;
  temperatureUnit: "celsius" | "fahrenheit";
}

export function hasExplicitDateTime(value: string): boolean {
  return /^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/u.test(value.trim())
    && parsedDateParts(value) !== null;
}

export function rangeMetadataTimestampColumn(rows: string[][], headerRow: number): number | null {
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

export function uniqueHeaderColumn(raw: string[], pattern: RegExp): number {
  const matches = raw.flatMap((value, index) => pattern.test(value.normalize("NFKC")) ? [index] : []);
  return matches.length === 1 ? matches[0]! : -1;
}

export function findColumns(rows: string[][]): TapoColumns {
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

export function timestampForm(value: string, splitDateAndTime: boolean): string {
  const text = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/u.test(text)) return splitDateAndTime ? "split-offset" : "combined-offset";
  const match = /^(\d{1,4})([.\-/])(\d{1,2})\2(\d{1,4})(?:([ T])(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?$/u.exec(text);
  if (!match) return splitDateAndTime ? "split-unknown" : "combined-unknown";
  const order = match[1]!.length === 4 ? "ymd" : match[4]!.length === 4 ? "dmy" : "ambiguous";
  const precision = match[8] === undefined ? "minute" : "second";
  return `${splitDateAndTime ? "split" : "combined"}-${order}-${match[2]}-${precision}`;
}

export function tapoCsvSchemaSignature(
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
