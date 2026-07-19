import type { AlertDeliveryPolicy, AlertSeverity } from "@climate-twin/contracts";

export const DEFAULT_ALERT_DELIVERY_POLICY: AlertDeliveryPolicy = Object.freeze({
  timeZone: "UTC",
  activeDays: [1, 2, 3, 4, 5, 6, 7],
  activeFrom: null,
  activeUntil: null,
  quietHoursFrom: null,
  quietHoursUntil: null,
  quietHoursMode: "defer",
  criticalBypassQuietHours: true,
  escalationAfterSeconds: null,
  reminderIntervalSeconds: null,
  maxAttempts: 8,
});

const WEEKDAY_NUMBER: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

function timeValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label} must be null or a local time in HH:mm form`);
  }
  return value;
}

function optionalSeconds(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || Number(value) < 60 || Number(value) > 31 * 24 * 60 * 60) {
    throw new Error(`${label} must be null or an integer between 60 seconds and 31 days`);
  }
  return Number(value);
}

function validatedTimeZone(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
  } catch {
    throw new Error("deliveryPolicy.timeZone must be a valid IANA timezone");
  }
  return candidate;
}

export function normalizeAlertDeliveryPolicy(
  value: Partial<AlertDeliveryPolicy> | null | undefined,
  fallbackTimeZone = "UTC",
): AlertDeliveryPolicy {
  const activeDays = value?.activeDays ?? DEFAULT_ALERT_DELIVERY_POLICY.activeDays;
  if (!Array.isArray(activeDays) || activeDays.length === 0
    || activeDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("deliveryPolicy.activeDays must contain ISO weekdays 1 through 7");
  }
  const maxAttempts = value?.maxAttempts ?? DEFAULT_ALERT_DELIVERY_POLICY.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("deliveryPolicy.maxAttempts must be an integer between 1 and 100");
  }
  const quietHoursMode = value?.quietHoursMode ?? DEFAULT_ALERT_DELIVERY_POLICY.quietHoursMode;
  if (quietHoursMode !== "defer" && quietHoursMode !== "silent") {
    throw new Error("deliveryPolicy.quietHoursMode must be defer or silent");
  }
  const activeFrom = timeValue(value?.activeFrom, "deliveryPolicy.activeFrom");
  const activeUntil = timeValue(value?.activeUntil, "deliveryPolicy.activeUntil");
  if ((activeFrom === null) !== (activeUntil === null)) {
    throw new Error("deliveryPolicy.activeFrom and activeUntil must be configured together");
  }
  const quietHoursFrom = timeValue(value?.quietHoursFrom, "deliveryPolicy.quietHoursFrom");
  const quietHoursUntil = timeValue(value?.quietHoursUntil, "deliveryPolicy.quietHoursUntil");
  if ((quietHoursFrom === null) !== (quietHoursUntil === null)) {
    throw new Error("deliveryPolicy.quietHoursFrom and quietHoursUntil must be configured together");
  }
  return {
    timeZone: validatedTimeZone(value?.timeZone, fallbackTimeZone),
    activeDays: [...new Set(activeDays)].sort((left, right) => left - right),
    activeFrom,
    activeUntil,
    quietHoursFrom,
    quietHoursUntil,
    quietHoursMode,
    criticalBypassQuietHours: value?.criticalBypassQuietHours ?? DEFAULT_ALERT_DELIVERY_POLICY.criticalBypassQuietHours,
    escalationAfterSeconds: optionalSeconds(value?.escalationAfterSeconds, "deliveryPolicy.escalationAfterSeconds"),
    reminderIntervalSeconds: optionalSeconds(value?.reminderIntervalSeconds, "deliveryPolicy.reminderIntervalSeconds"),
    maxAttempts,
  };
}

interface LocalClock {
  weekday: number;
  minutes: number;
}

function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = WEEKDAY_NUMBER[part("weekday")];
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Could not resolve local clock in ${timeZone}`);
  }
  return { weekday, minutes: hour * 60 + minute };
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function withinWindow(minutes: number, from: string, until: string): boolean {
  const start = minuteOfDay(from);
  const end = minuteOfDay(until);
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function previousWeekday(day: number): number {
  return day === 1 ? 7 : day - 1;
}

function activeAt(policy: AlertDeliveryPolicy, at: Date): boolean {
  const clock = localClock(at, policy.timeZone);
  if (!policy.activeFrom || !policy.activeUntil) return policy.activeDays.includes(clock.weekday);
  const fromMinutes = minuteOfDay(policy.activeFrom);
  const untilMinutes = minuteOfDay(policy.activeUntil);
  const ownerDay = fromMinutes > untilMinutes && clock.minutes < untilMinutes
    ? previousWeekday(clock.weekday)
    : clock.weekday;
  return policy.activeDays.includes(ownerDay) && withinWindow(clock.minutes, policy.activeFrom, policy.activeUntil);
}

function quietAt(policy: AlertDeliveryPolicy, at: Date): boolean {
  if (!policy.quietHoursFrom || !policy.quietHoursUntil) return false;
  return withinWindow(localClock(at, policy.timeZone).minutes, policy.quietHoursFrom, policy.quietHoursUntil);
}

export interface NotificationScheduleDecision {
  deliverAt: Date;
  silent: boolean;
  deferred: boolean;
  quietHours: boolean;
}

function canDeliver(policy: AlertDeliveryPolicy, severity: AlertSeverity, at: Date): { allowed: boolean; silent: boolean; quiet: boolean } {
  if (!activeAt(policy, at)) return { allowed: false, silent: false, quiet: false };
  const quiet = quietAt(policy, at);
  if (!quiet || (severity === "critical" && policy.criticalBypassQuietHours)) {
    return { allowed: true, silent: severity === "info", quiet };
  }
  if (policy.quietHoursMode === "silent") return { allowed: true, silent: true, quiet: true };
  return { allowed: false, silent: false, quiet: true };
}

export function notificationScheduleDecision(
  policy: AlertDeliveryPolicy,
  severity: AlertSeverity,
  now = new Date(),
): NotificationScheduleDecision {
  const immediate = canDeliver(policy, severity, now);
  if (immediate.allowed) {
    return { deliverAt: now, silent: immediate.silent, deferred: false, quietHours: immediate.quiet };
  }
  // Minute stepping is intentionally bounded and runs only when an alert is
  // opened/followed up, not on every telemetry sample. It naturally respects
  // DST transitions through Intl and avoids maintaining timezone offset tables.
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let minute = 0; minute < 8 * 24 * 60; minute += 1) {
    const decision = canDeliver(policy, severity, candidate);
    if (decision.allowed) {
      return { deliverAt: new Date(candidate), silent: decision.silent, deferred: true, quietHours: immediate.quiet };
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error("The alert delivery policy does not contain a reachable delivery window");
}

export function policyJson(policy: AlertDeliveryPolicy): string {
  return JSON.stringify(normalizeAlertDeliveryPolicy(policy));
}

export function policyFromJson(value: string | null | undefined, fallbackTimeZone = "UTC"): AlertDeliveryPolicy {
  if (!value) return normalizeAlertDeliveryPolicy(undefined, fallbackTimeZone);
  const parsed = JSON.parse(value) as Partial<AlertDeliveryPolicy>;
  return normalizeAlertDeliveryPolicy(parsed, fallbackTimeZone);
}
