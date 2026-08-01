export const BUG_REPORT_DESCRIPTION_MAX_LENGTH = 4_000;
export const BUG_REPORT_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 500;
export const BUG_REPORT_MAX_RECENT_ERRORS = 5;

export type BugReportErrorSource = "browser" | "promise" | "api";

export interface BugReportRecentError {
  source: BugReportErrorSource;
  occurredAt: string;
  message: string;
  status?: number;
  code?: string;
}

export interface BugReportDiagnostics {
  appVersion: string;
  page: string;
  route: string;
  occurredAt: string;
  locale: string;
  userAgent: string;
  recentErrors: BugReportRecentError[];
}

export interface BugReportInput {
  description: string;
  diagnostics?: BugReportDiagnostics;
  contactEmail?: string;
}

export interface BugReportReceipt {
  reportId: string;
  submittedAt: string;
}

export interface BugReportRelayPayload extends BugReportInput, BugReportReceipt {
  serverVersion: string;
}

export class BugReportValidationError extends Error {}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BugReportValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new BugReportValidationError(`${field} contains unknown fields`);
}

function textValue(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string") throw new BugReportValidationError(`${field} must be a string`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new BugReportValidationError(`${field} must contain ${minimum}-${maximum} characters`);
  }
  return text;
}

function dateTimeValue(value: unknown, field: string): string {
  const text = textValue(value, field, 100);
  if (!Number.isFinite(Date.parse(text))) throw new BugReportValidationError(`${field} must be an ISO date-time`);
  return new Date(text).toISOString();
}

function recentErrorValue(value: unknown, index: number): BugReportRecentError {
  const field = `diagnostics.recentErrors[${index}]`;
  const item = objectValue(value, field);
  rejectUnknown(item, ["source", "occurredAt", "message", "status", "code"], field);
  const source = item.source;
  if (source !== "browser" && source !== "promise" && source !== "api") {
    throw new BugReportValidationError(`${field}.source is invalid`);
  }
  const status = item.status;
  if (status !== undefined && (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599)) {
    throw new BugReportValidationError(`${field}.status is invalid`);
  }
  const code = item.code === undefined ? undefined : textValue(item.code, `${field}.code`, 100);
  return {
    source,
    occurredAt: dateTimeValue(item.occurredAt, `${field}.occurredAt`),
    message: textValue(item.message, `${field}.message`, BUG_REPORT_DIAGNOSTIC_MESSAGE_MAX_LENGTH),
    ...(status === undefined ? {} : { status: status as number }),
    ...(code === undefined ? {} : { code }),
  };
}

function diagnosticsValue(value: unknown): BugReportDiagnostics {
  const diagnostics = objectValue(value, "diagnostics");
  rejectUnknown(diagnostics, ["appVersion", "page", "route", "occurredAt", "locale", "userAgent", "recentErrors"], "diagnostics");
  if (!Array.isArray(diagnostics.recentErrors) || diagnostics.recentErrors.length > BUG_REPORT_MAX_RECENT_ERRORS) {
    throw new BugReportValidationError(`diagnostics.recentErrors must contain at most ${BUG_REPORT_MAX_RECENT_ERRORS} items`);
  }
  return {
    appVersion: textValue(diagnostics.appVersion, "diagnostics.appVersion", 100),
    page: textValue(diagnostics.page, "diagnostics.page", 200),
    route: textValue(diagnostics.route, "diagnostics.route", 500),
    occurredAt: dateTimeValue(diagnostics.occurredAt, "diagnostics.occurredAt"),
    locale: textValue(diagnostics.locale, "diagnostics.locale", 35),
    userAgent: textValue(diagnostics.userAgent, "diagnostics.userAgent", 500),
    recentErrors: diagnostics.recentErrors.map(recentErrorValue),
  };
}

export function normalizeBugReportInput(value: unknown): BugReportInput {
  const input = objectValue(value, "bug report");
  rejectUnknown(input, ["description", "diagnostics", "contactEmail"], "bug report");
  const contactEmail = input.contactEmail === undefined
    ? undefined
    : textValue(input.contactEmail, "contactEmail", 254).toLowerCase();
  if (contactEmail && !/^[^\s@<>]+@[^\s@<>]+$/u.test(contactEmail)) {
    throw new BugReportValidationError("contactEmail must be a valid email address");
  }
  return {
    description: textValue(input.description, "description", BUG_REPORT_DESCRIPTION_MAX_LENGTH, 3),
    ...(input.diagnostics === undefined ? {} : { diagnostics: diagnosticsValue(input.diagnostics) }),
    ...(contactEmail === undefined ? {} : { contactEmail }),
  };
}
