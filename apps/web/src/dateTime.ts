export function formatInTimeZone(
  value: string | number | Date,
  locale: string,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}
