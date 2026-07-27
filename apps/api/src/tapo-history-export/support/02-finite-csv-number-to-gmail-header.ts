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
import { MAX_CSV_BYTES, MAX_TAPO_HISTORY_RAW_DATA_ROWS_PER_JOB, TapoHistoryCsvCoverageRequest, TapoHistoryCsvOptions, TapoHistoryCsvResult, TapoHistoryFormatError, detectDelimiter, findColumns, parseCsvRows, tapoCsvSchemaSignature } from "./01-max-csv-bytes-to-tapo-csv-schema-signature.js";

export function finiteCsvNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(/,(?=\d+$)/, ".");
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
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

export function zonedParts(timestamp: number, timeZone: string): number[] {
  const parts = zonedFormatter(timeZone).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return [part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second")];
}

export function sameParts(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Return both instants when a local wall time is repeated at a DST transition. */
export function localTimeCandidates(parts: number[], timeZone: string): number[] {
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

export function parsedDateParts(value: string): number[] | null {
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

export function parseTapoTimestamp(value: string, timeZone: string, previous: number | null): number | null {
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

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.length > 254 || /[\s<>]/.test(email)) return null;
  return email;
}

/** Generates a hidden capability address from an API-only random correlation nonce. */
export function tapoExportRecipient(baseEmail: string, correlationNonce: string, prefix = "stugu"): string {
  const email = normalizeEmail(baseEmail);
  if (!email) throw new Error("TAPO_HISTORY_EXPORT_EMAIL must be a valid email address");
  const [local, domain] = email.split("@");
  const untagged = local!.split("+")[0]!;
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "stugu";
  if (!correlationNonce) throw new Error("Tapo export correlation nonce is required");
  const digest = createHash("sha256").update(correlationNonce).digest("hex").slice(0, 32);
  const taggedLocal = `${untagged}+${safePrefix}-${digest}`;
  if (Buffer.byteLength(taggedLocal, "utf8") > 64) {
    throw new Error("TAPO_HISTORY_EXPORT_EMAIL local part is too long for a correlation tag");
  }
  return `${taggedLocal}@${domain}`;
}

export interface GmailHeader { name?: unknown; value?: unknown }

export interface GmailPart {
  filename?: unknown;
  mimeType?: unknown;
  headers?: unknown;
  body?: { data?: unknown; attachmentId?: unknown; size?: unknown };
  parts?: unknown;
}

export interface GmailMessage {
  id?: unknown;
  internalDate?: unknown;
  payload?: GmailPart;
}

export function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("Gmail returned invalid attachment encoding");
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function gmailParts(root: GmailPart | undefined): GmailPart[] {
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

export function gmailHeader(payload: GmailPart | undefined, name: string): string {
  if (!Array.isArray(payload?.headers)) return "";
  const header = (payload.headers as GmailHeader[]).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return typeof header?.value === "string" ? header.value : "";
}
