import type { DateOrder, ImportCell } from "./importModel";

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
