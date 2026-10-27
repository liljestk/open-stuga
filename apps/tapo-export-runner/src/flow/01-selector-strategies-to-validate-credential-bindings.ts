import type { AttentionCode } from "../types.js";
import {
  type Selector,
  type SelectorStrategy,
} from "../webdriver.js";

export const SELECTOR_STRATEGIES = new Set<SelectorStrategy>([
  "accessibility id",
  "id",
  "xpath",
  "class name",
  "-android uiautomator",
]);

export const ATTENTION_CODES = new Set<AttentionCode>([
  "login_required",
  "two_factor_required",
  "ui_drift",
  "device_not_found",
  "configuration_error",
]);

export type FlowActionName =
  | "tap"
  | "type"
  | "clear"
  | "waitFor"
  | "waitForGone"
  | "back"
  | "pause"
  | "tapCoordinates"
  | "swipe"
  | "repeatTap";

export type RepeatCountVariable =
  | "FROM_MONTHS_BEFORE_CURRENT"
  | "TO_MONTHS_BEFORE_CURRENT"
  | "MONTHS_FROM_FROM_TO";

export const REPEAT_COUNT_VARIABLES = new Set<RepeatCountVariable>([
  "FROM_MONTHS_BEFORE_CURRENT",
  "TO_MONTHS_BEFORE_CURRENT",
  "MONTHS_FROM_FROM_TO",
]);

export const MAX_REPEAT_TAPS = 24;

export interface FlowAction {
  action: FlowActionName;
  selector?: Selector;
  value?: string;
  timeoutMs?: number;
  optional?: boolean;
  clearFirst?: boolean;
  requireUnique?: boolean;
  failureCode?: AttentionCode;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  countVariable?: RepeatCountVariable;
  settleMs?: number;
}

export interface TapoFlowConfig {
  version: 1;
  appPackage: string;
  /** Exact labels displayed by the pinned Tapo app locale. */
  intervalLabels: Record<string, string>;
  /** Immutable on-screen proof (serial/MAC/device id) keyed by API device id. */
  deviceProofs: Record<string, string>;
  restartAppBeforeJob: boolean;
  signalTimeoutMs: number;
  signals: {
    authenticated: Selector;
    login?: Selector;
    twoFactor?: Selector;
  };
  flows: {
    prepare?: FlowAction[];
    login?: FlowAction[];
    export: FlowAction[];
  };
}

export type UiState = "authenticated" | "login" | "two_factor" | "unknown";

export type AuthenticationPlan =
  | "proceed"
  | "auto_login"
  | "needs_login"
  | "needs_two_factor"
  | "needs_ui_review";

export interface UiSignals {
  authenticated: boolean;
  login: boolean;
  twoFactor: boolean;
}

export function classifyUiSignals(signals: UiSignals): UiState {
  if (signals.twoFactor) return "two_factor";
  if (signals.authenticated) return "authenticated";
  if (signals.login) return "login";
  return "unknown";
}

export function authenticationPlan(state: UiState, automaticLoginConfigured: boolean): AuthenticationPlan {
  if (state === "authenticated") return "proceed";
  if (state === "two_factor") return "needs_two_factor";
  if (state === "login") return automaticLoginConfigured ? "auto_login" : "needs_login";
  return "needs_ui_review";
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function finiteNumber(value: unknown, name: string, minimum = 0, maximum = 1_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function selector(value: unknown, name: string): Selector {
  const parsed = record(value, name);
  const using = nonEmptyString(parsed.using, `${name}.using`) as SelectorStrategy;
  if (!SELECTOR_STRATEGIES.has(using)) throw new Error(`${name}.using is not a supported selector strategy`);
  const selectorValue = nonEmptyString(parsed.value, `${name}.value`);
  for (const variable of ["TAPO_USERNAME", "TAPO_PASSWORD", "EXPORT_EMAIL"] as const) {
    if (selectorValue.includes(`{{${variable}}}`)) {
      throw new Error(`${name}.value cannot contain sensitive variable {{${variable}}}`);
    }
  }
  return { using, value: selectorValue };
}

export function action(value: unknown, name: string): FlowAction {
  const parsed = record(value, name);
  const actionName = nonEmptyString(parsed.action, `${name}.action`) as FlowActionName;
  const allowed = new Set<FlowActionName>([
    "tap", "type", "clear", "waitFor", "waitForGone", "back", "pause", "tapCoordinates", "swipe", "repeatTap",
  ]);
  if (!allowed.has(actionName)) throw new Error(`${name}.action is not supported`);

  const result: FlowAction = { action: actionName };
  if (parsed.selector !== undefined) result.selector = selector(parsed.selector, `${name}.selector`);
  if (parsed.value !== undefined) result.value = nonEmptyString(parsed.value, `${name}.value`);
  if (parsed.timeoutMs !== undefined) result.timeoutMs = finiteNumber(parsed.timeoutMs, `${name}.timeoutMs`, 1, 120_000);
  if (parsed.durationMs !== undefined) result.durationMs = finiteNumber(parsed.durationMs, `${name}.durationMs`, 1, 60_000);
  if (parsed.settleMs !== undefined) result.settleMs = finiteNumber(parsed.settleMs, `${name}.settleMs`, 50, 2_000);
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"] as const) {
    if (parsed[key] !== undefined) result[key] = finiteNumber(parsed[key], `${name}.${key}`, 0, 20_000);
  }
  if (parsed.optional !== undefined) {
    if (typeof parsed.optional !== "boolean") throw new Error(`${name}.optional must be a boolean`);
    result.optional = parsed.optional;
  }
  if (parsed.clearFirst !== undefined) {
    if (typeof parsed.clearFirst !== "boolean") throw new Error(`${name}.clearFirst must be a boolean`);
    result.clearFirst = parsed.clearFirst;
  }
  if (parsed.requireUnique !== undefined) {
    if (typeof parsed.requireUnique !== "boolean") throw new Error(`${name}.requireUnique must be a boolean`);
    result.requireUnique = parsed.requireUnique;
  }
  if (parsed.failureCode !== undefined) {
    if (typeof parsed.failureCode !== "string" || !ATTENTION_CODES.has(parsed.failureCode as AttentionCode)) {
      throw new Error(`${name}.failureCode is not supported`);
    }
    result.failureCode = parsed.failureCode as AttentionCode;
  }
  if (parsed.countVariable !== undefined) {
    if (typeof parsed.countVariable !== "string"
      || !REPEAT_COUNT_VARIABLES.has(parsed.countVariable as RepeatCountVariable)) {
      throw new Error(`${name}.countVariable must be one of the three server-derived month variables`);
    }
    result.countVariable = parsed.countVariable as RepeatCountVariable;
  }

  if (["tap", "type", "clear", "waitFor", "waitForGone", "repeatTap"].includes(actionName) && !result.selector) {
    throw new Error(`${name}.selector is required for ${actionName}`);
  }
  if (actionName === "type" && result.value === undefined) throw new Error(`${name}.value is required for type`);
  if (actionName === "pause" && result.durationMs === undefined) throw new Error(`${name}.durationMs is required for pause`);
  if (actionName === "tapCoordinates" && (result.x === undefined || result.y === undefined)) {
    throw new Error(`${name}.x and ${name}.y are required for tapCoordinates`);
  }
  if (
    actionName === "swipe" &&
    [result.fromX, result.fromY, result.toX, result.toY, result.durationMs].some((part) => part === undefined)
  ) throw new Error(`${name} requires fromX, fromY, toX, toY, and durationMs`);
  if (actionName === "repeatTap") {
    if (!result.countVariable) throw new Error(`${name}.countVariable is required for repeatTap`);
    if (result.optional === true) throw new Error(`${name}.optional cannot be true for repeatTap`);
    if (result.value !== undefined || /\{\{[A-Z0-9_]+\}\}/u.test(result.selector?.value ?? "")) {
      throw new Error(`${name} repeatTap selector must be static and cannot accept a value template`);
    }
  } else if (result.countVariable !== undefined || result.settleMs !== undefined) {
    throw new Error(`${name}.countVariable and settleMs are only valid for repeatTap`);
  }
  return result;
}

export function actions(value: unknown, name: string): FlowAction[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => action(entry, `${name}[${index}]`));
}

export function actionReferences(action: FlowAction, variable: string): boolean {
  const token = `{{${variable}}}`;
  return action.value?.includes(token) === true || action.selector?.value.includes(token) === true;
}

export function actionReferencesDate(action: FlowAction, prefix: "FROM" | "TO"): boolean {
  return actionReferences(action, `${prefix}_DATE`) || ["YEAR", "MONTH", "DAY"]
    .every((part) => actionReferences(action, `${prefix}_${part}`));
}

export function requiredAction(
  exportFlow: readonly FlowAction[],
  predicate: (entry: FlowAction, index: number) => boolean,
  message: string,
): number {
  const index = exportFlow.findIndex((entry, actionIndex) => predicate(entry, actionIndex));
  if (index < 0) throw new Error(message);
  if (exportFlow[index]?.optional === true) throw new Error(`${message}; the binding cannot be optional`);
  return index;
}

export function validateExportBindings(exportFlow: readonly FlowAction[]): void {
  const deviceTap = requiredAction(
    exportFlow,
    (entry) => entry.action === "tap"
      && entry.failureCode === "device_not_found"
      && entry.selector?.value === "{{DEVICE_NAME}}"
      && entry.requireUnique === true,
    "flows.export must uniquely tap the exact {{DEVICE_NAME}} with failureCode device_not_found",
  );
  const deviceVerification = requiredAction(
    exportFlow,
    (entry, index) => index > deviceTap
      && entry.action === "waitFor"
      && entry.failureCode === "device_not_found"
      && actionReferences(entry, "DEVICE_NAME"),
    "flows.export must verify the exact {{DEVICE_NAME}} after selecting it",
  );
  const immutableDeviceProof = requiredAction(
    exportFlow,
    (entry, index) => index > deviceVerification
      && entry.action === "waitFor"
      && entry.failureCode === "device_not_found"
      && actionReferences(entry, "DEVICE_PROOF"),
    "flows.export must verify the exact immutable {{DEVICE_PROOF}} after selecting the device",
  );
  const fromDateSelection = requiredAction(
    exportFlow,
    (entry, index) => index > immutableDeviceProof
      && (entry.action === "type" || entry.action === "tap")
      && actionReferencesDate(entry, "FROM"),
    "flows.export must explicitly select the requested FROM date after device verification",
  );
  if (exportFlow[fromDateSelection]?.action === "tap") {
    requiredAction(
      exportFlow,
      (entry, index) => index > immutableDeviceProof && index === fromDateSelection - 1
        && entry.action === "repeatTap"
        && entry.countVariable === "FROM_MONTHS_BEFORE_CURRENT",
      "tap-based FROM selection must navigate from the current month with FROM_MONTHS_BEFORE_CURRENT",
    );
  }
  const fromDateVerification = requiredAction(
    exportFlow,
    (entry, index) => index > fromDateSelection
      && entry.action === "waitFor" && actionReferencesDate(entry, "FROM"),
    "flows.export must verify the selected FROM date",
  );
  const toDateSelection = requiredAction(
    exportFlow,
    (entry, index) => index > immutableDeviceProof
      && (entry.action === "type" || entry.action === "tap")
      && actionReferencesDate(entry, "TO"),
    "flows.export must explicitly select the requested TO date after device verification",
  );
  if (exportFlow[toDateSelection]?.action === "tap") {
    requiredAction(
      exportFlow,
      (entry, index) => index > fromDateVerification && index === toDateSelection - 1
        && entry.action === "repeatTap"
        && (entry.countVariable === "TO_MONTHS_BEFORE_CURRENT"
          || entry.countVariable === "MONTHS_FROM_FROM_TO"),
      "tap-based TO selection must navigate from current or FROM month with a server-derived month count",
    );
  }
  const toDateVerification = requiredAction(
    exportFlow,
    (entry, index) => index > toDateSelection
      && entry.action === "waitFor" && actionReferencesDate(entry, "TO"),
    "flows.export must verify the selected TO date",
  );
  const intervalSelection = requiredAction(
    exportFlow,
    (entry, index) => index > immutableDeviceProof
      && entry.action === "tap" && actionReferences(entry, "INTERVAL_LABEL"),
    "flows.export must select {{INTERVAL_LABEL}} after device verification",
  );
  const intervalVerification = requiredAction(
    exportFlow,
    (entry, index) => index > intervalSelection
      && entry.action === "waitFor" && actionReferences(entry, "INTERVAL_LABEL"),
    "flows.export must verify {{INTERVAL_LABEL}} after selecting it",
  );
  const rangeAndCadence = Math.max(fromDateVerification, toDateVerification, intervalVerification);
  const email = requiredAction(
    exportFlow,
    (entry, index) => index > rangeAndCadence
      && entry.action === "type" && entry.value === "{{EXPORT_EMAIL}}",
    "flows.export must type {{EXPORT_EMAIL}} after applying the range and interval",
  );
  const submitCandidates = exportFlow.flatMap((entry, index) =>
    index > email && index < exportFlow.length - 1 && entry.action === "tap" ? [index] : []);
  if (submitCandidates.length !== 1 || exportFlow[submitCandidates[0]!]?.optional === true) {
    throw new Error("flows.export must contain exactly one non-optional submit tap after typing {{EXPORT_EMAIL}}");
  }
  const submit = submitCandidates[0]!;
  const confirmation = exportFlow.at(-1);
  if (confirmation?.action !== "waitFor" || confirmation.optional === true || exportFlow.length - 1 <= submit) {
    throw new Error("flows.export must end with a non-optional wait for an explicit submission confirmation");
  }
  requiredAction(
    exportFlow,
    (entry, index) => index > email && index === submit - 1
      && entry.action === "waitForGone"
      && entry.selector?.using === confirmation.selector?.using
      && entry.selector?.value === confirmation.selector?.value,
    "flows.export must prove the final confirmation selector is absent immediately before submit",
  );
}

export function validateCredentialBindings(flows: TapoFlowConfig["flows"]): void {
  for (const [flowName, configuredActions] of Object.entries(flows)) {
    for (const [index, configuredAction] of (configuredActions ?? []).entries()) {
      for (const variable of ["TAPO_USERNAME", "TAPO_PASSWORD"] as const) {
        if (configuredAction.value?.includes(`{{${variable}}}`) !== true) continue;
        if (flowName !== "login" || configuredAction.action !== "type"
          || configuredAction.value !== `{{${variable}}}`) {
          throw new Error(`flows.${flowName}[${index}] may use {{${variable}}} only as the exact value of a login type action`);
        }
      }
    }
  }
  if (flows.login !== undefined) {
    for (const variable of ["TAPO_USERNAME", "TAPO_PASSWORD"] as const) {
      const bindings = flows.login.filter((entry) => entry.action === "type" && entry.value === `{{${variable}}}`);
      if (bindings.length !== 1 || bindings[0]?.optional === true || bindings[0]?.clearFirst === false) {
        throw new Error(`flows.login must contain exactly one non-optional clearing type action for {{${variable}}}`);
      }
    }
  }
}
