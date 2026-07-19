import type { ManualObservationInput, ObservationTimePrecision } from "@climate-twin/contracts";

function zonedDateTimeParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second")];
}

export function localObservationDateTime(date = new Date(), timeZone?: string): string {
  if (timeZone) {
    try {
      const [year, month, day, hour, minute] = zonedDateTimeParts(date, timeZone);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    } catch {
      // Fall through to the browser timezone if a stored timezone is unsupported.
    }
  }
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function localObservationDate(date = new Date(), timeZone?: string): string {
  return localObservationDateTime(date, timeZone).slice(0, 10);
}

function houseLocalDateTimeCandidates(value: string, timeZone: string): string[] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const nominal = Date.UTC(year, month - 1, day, hour, minute, 0);
  const nominalDate = new Date(nominal);
  if (nominalDate.getUTCFullYear() !== year || nominalDate.getUTCMonth() !== month - 1 || nominalDate.getUTCDate() !== day
    || nominalDate.getUTCHours() !== hour || nominalDate.getUTCMinutes() !== minute) return null;
  try {
    const offsets = new Set<number>();
    for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
      const probe = nominal + deltaHours * 3_600_000;
      const displayed = zonedDateTimeParts(new Date(probe), timeZone);
      offsets.add(Date.UTC(displayed[0]!, displayed[1]! - 1, displayed[2]!, displayed[3]!, displayed[4]!, displayed[5]!) - probe);
    }
    const target = [year, month, day, hour, minute];
    return [...new Set([...offsets].map((offset) => nominal - offset))]
      .filter((candidate) => zonedDateTimeParts(new Date(candidate), timeZone).slice(0, 5)
        .every((part, index) => part === target[index]))
      .sort((left, right) => left - right)
      .map((candidate) => new Date(candidate).toISOString());
  } catch {
    return null;
  }
}

export function observationTimeFields(
  precision: ObservationTimePrecision,
  dateTime: string,
  date: string,
  validFrom: string,
  validTo: string,
  timeZone: string,
): Pick<ManualObservationInput, "timePrecision"> & Partial<Pick<ManualObservationInput, "occurredAt" | "validFrom" | "validTo">> | null {
  if (precision === "unknown") return { timePrecision: precision };
  if (precision === "date-only") return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { timePrecision: precision, occurredAt: date } : null;
  if (precision === "date-range") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(validTo) || validFrom > validTo) return null;
    return { timePrecision: precision, validFrom, validTo };
  }
  const candidates = houseLocalDateTimeCandidates(dateTime, timeZone);
  const instant = candidates?.length === 1 || (precision === "approximate" && candidates && candidates.length > 1)
    ? candidates[0]
    : null;
  return instant ? { timePrecision: precision, occurredAt: instant } : null;
}
