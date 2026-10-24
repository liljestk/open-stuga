/** A civil date in some time zone, without a time of day. */
export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  if (formatterCache.size >= 32) formatterCache.delete(formatterCache.keys().next().value!);
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Local `[year, month, day, hour, minute, second]` of an instant in `timeZone`. */
export function zonedParts(timestamp: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((item) => item.type === type)?.value);
  return [part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second")];
}

export function localDate(timestamp: number, timeZone: string): LocalDateParts {
  const [year, month, day] = zonedParts(timestamp, timeZone);
  return { year, month, day };
}

export function validLocalDate(parts: LocalDateParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year
    && date.getUTCMonth() === parts.month - 1
    && date.getUTCDate() === parts.day;
}

export function addLocalDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * First real instant of a local calendar date. Zones that skip midnight on a
 * daylight-saving change start that day at the first existing local time.
 */
export function localDateStart(parts: LocalDateParts, timeZone: string): number | null {
  if (!validLocalDate(parts)) return null;
  for (let minute = 0; minute <= 180; minute += 30) {
    const hour = Math.floor(minute / 60);
    const localMinute = minute % 60;
    const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, hour, localMinute, 0);
    const offsets = new Set<number>();
    for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
      const probe = nominal + deltaHours * 3_600_000;
      const displayed = zonedParts(probe, timeZone);
      offsets.add(Date.UTC(displayed[0], displayed[1] - 1, displayed[2], displayed[3], displayed[4], displayed[5]) - probe);
    }
    const target = [parts.year, parts.month, parts.day, hour, localMinute, 0];
    const candidate = [...offsets].map((offset) => nominal - offset)
      .filter((instant) => zonedParts(instant, timeZone).every((value, index) => value === target[index]))
      .sort((left, right) => left - right)[0];
    if (candidate !== undefined) return candidate;
  }
  return null;
}
