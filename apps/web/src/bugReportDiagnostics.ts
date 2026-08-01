import {
  BUG_REPORT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  BUG_REPORT_MAX_RECENT_ERRORS,
  SYSTEM_VERSION,
  type BugReportDiagnostics,
  type BugReportRecentError,
} from "@climate-twin/contracts";
import type { AppPage } from "./domain";

const errors: BugReportRecentError[] = [];
let started = false;

export function redactDiagnosticText(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "Unknown error");
  return text
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/\b[^\s@<>]+@[^\s@<>]+\b/gu, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ip]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/giu, "[secret]")
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/giu, "$1[secret]")
    .slice(0, BUG_REPORT_DIAGNOSTIC_MESSAGE_MAX_LENGTH);
}

function remember(error: BugReportRecentError): void {
  errors.push({ ...error, message: redactDiagnosticText(error.message) });
  errors.splice(0, Math.max(0, errors.length - BUG_REPORT_MAX_RECENT_ERRORS));
}

export function recordApiError(status: number, code: string | null, message: string): void {
  remember({
    source: "api",
    occurredAt: new Date().toISOString(),
    message,
    status,
    ...(code ? { code: redactDiagnosticText(code).slice(0, 100) } : {}),
  });
}

export function startBugReportDiagnostics(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("error", (event) => {
    remember({ source: "browser", occurredAt: new Date().toISOString(), message: event.error ?? event.message });
  });
  window.addEventListener("unhandledrejection", (event) => {
    remember({ source: "promise", occurredAt: new Date().toISOString(), message: event.reason });
  });
}

const identitySegments: Record<string, string> = {
  properties: "propertyId",
  property: "propertyId",
  homes: "homeId",
  home: "homeId",
  houses: "houseId",
  house: "houseId",
  sensors: "sensorId",
  sensor: "sensorId",
  equipment: "equipmentId",
  areas: "areaId",
  area: "areaId",
  floors: "floorId",
  floor: "floorId",
  tasks: "taskId",
  alerts: "alertId",
};

export function routeTemplate(pathname = window.location.pathname): string {
  const segments = pathname.split("/").filter(Boolean);
  const templated = segments.map((segment, index) => {
    const field = identitySegments[segments[index - 1]?.toLowerCase() ?? ""];
    return field ? `:${field}` : segment.slice(0, 100);
  });
  return `/${templated.join("/")}`;
}

export function buildBugReportDiagnostics(page: AppPage, locale: string): BugReportDiagnostics {
  return {
    appVersion: SYSTEM_VERSION,
    page,
    route: routeTemplate(),
    occurredAt: new Date().toISOString(),
    locale: locale.slice(0, 35),
    userAgent: redactDiagnosticText(navigator.userAgent).slice(0, 500),
    recentErrors: errors.map((error) => ({ ...error })),
  };
}

export function clearBugReportDiagnosticsForTests(): void {
  errors.length = 0;
}
