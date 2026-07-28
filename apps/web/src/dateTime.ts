const formatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTER_CACHE_SIZE = 64;

function formatterKey(locale: string, options: Intl.DateTimeFormatOptions): string {
  return JSON.stringify([locale, Object.entries(options).sort(([left], [right]) => left.localeCompare(right))]);
}

function cachedFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = formatterKey(locale, options);
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (formatterCache.size >= MAX_FORMATTER_CACHE_SIZE) {
    const oldest = formatterCache.keys().next().value as string | undefined;
    if (oldest !== undefined) formatterCache.delete(oldest);
  }
  formatterCache.set(key, formatter);
  return formatter;
}

function twentyFourHourOptions(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const normalized: Intl.DateTimeFormatOptions = { ...options, hourCycle: "h23" };
  delete normalized.hour12;
  return normalized;
}

export function getDateTimeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return cachedFormatter(locale, twentyFourHourOptions(options));
}

export function twentyFourHourInputLocale(locale: string): string {
  const language = locale.toLowerCase().split("-")[0];
  if (language === "fi") return "fi-FI";
  if (language === "sv") return "sv-SE";
  return "en-GB";
}

export function formatInTimeZone(
  value: string | number | Date,
  locale: string,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return getDateTimeFormatter(locale, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return getDateTimeFormatter(locale, options).format(date);
  }
}
