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

export function formatInTimeZone(
  value: string | number | Date,
  locale: string,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return cachedFormatter(locale, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return cachedFormatter(locale, options).format(date);
  }
}
