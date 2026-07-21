import { readFile } from "node:fs/promises";
import type { AttentionCode } from "./types.js";
import {
  AppiumClient,
  ElementNotFoundError,
  WebDriverError,
  type Selector,
  type SelectorStrategy,
} from "./webdriver.js";

const SELECTOR_STRATEGIES = new Set<SelectorStrategy>([
  "accessibility id",
  "id",
  "xpath",
  "class name",
  "-android uiautomator",
]);

const ATTENTION_CODES = new Set<AttentionCode>([
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

const REPEAT_COUNT_VARIABLES = new Set<RepeatCountVariable>([
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, name: string, minimum = 0, maximum = 1_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function selector(value: unknown, name: string): Selector {
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

function action(value: unknown, name: string): FlowAction {
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

function actions(value: unknown, name: string): FlowAction[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => action(entry, `${name}[${index}]`));
}

function actionReferences(action: FlowAction, variable: string): boolean {
  const token = `{{${variable}}}`;
  return action.value?.includes(token) === true || action.selector?.value.includes(token) === true;
}

function actionReferencesDate(action: FlowAction, prefix: "FROM" | "TO"): boolean {
  return actionReferences(action, `${prefix}_DATE`) || ["YEAR", "MONTH", "DAY"]
    .every((part) => actionReferences(action, `${prefix}_${part}`));
}

function requiredAction(
  exportFlow: readonly FlowAction[],
  predicate: (entry: FlowAction, index: number) => boolean,
  message: string,
): number {
  const index = exportFlow.findIndex((entry, actionIndex) => predicate(entry, actionIndex));
  if (index < 0) throw new Error(message);
  if (exportFlow[index]?.optional === true) throw new Error(`${message}; the binding cannot be optional`);
  return index;
}

function validateExportBindings(exportFlow: readonly FlowAction[]): void {
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

function validateCredentialBindings(flows: TapoFlowConfig["flows"]): void {
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

export function parseFlowConfig(value: unknown): TapoFlowConfig {
  const root = record(value, "flow config");
  if (root.version !== 1) throw new Error("flow config version must be 1");
  const signalsValue = record(root.signals, "signals");
  const flowsValue = record(root.flows, "flows");
  const intervalLabelsValue = record(root.intervalLabels, "intervalLabels");
  const intervalLabels: Record<string, string> = {};
  for (const interval of ["1", "15", "30", "60", "360", "720", "1440"] as const) {
    intervalLabels[interval] = nonEmptyString(intervalLabelsValue[interval], `intervalLabels.${interval}`);
  }
  const deviceProofs: Record<string, string> = {};
  if (root.deviceProofs !== undefined) {
    const configuredProofs = record(root.deviceProofs, "deviceProofs");
    for (const [deviceId, proof] of Object.entries(configuredProofs)) {
      const normalizedId = nonEmptyString(deviceId, "deviceProofs key").trim();
      deviceProofs[normalizedId] = nonEmptyString(proof, `deviceProofs.${normalizedId}`).trim();
    }
  }
  const signals: TapoFlowConfig["signals"] = {
    authenticated: selector(signalsValue.authenticated, "signals.authenticated"),
  };
  if (signalsValue.login !== undefined) signals.login = selector(signalsValue.login, "signals.login");
  if (signalsValue.twoFactor !== undefined) signals.twoFactor = selector(signalsValue.twoFactor, "signals.twoFactor");

  const flows: TapoFlowConfig["flows"] = { export: actions(flowsValue.export, "flows.export") };
  if (flows.export.length === 0) throw new Error("flows.export must contain at least one action");
  validateExportBindings(flows.export);
  if (flowsValue.prepare !== undefined) flows.prepare = actions(flowsValue.prepare, "flows.prepare");
  if (flowsValue.login !== undefined) flows.login = actions(flowsValue.login, "flows.login");
  validateCredentialBindings(flows);

  if (root.restartAppBeforeJob !== undefined && typeof root.restartAppBeforeJob !== "boolean") {
    throw new Error("restartAppBeforeJob must be a boolean");
  }
  return {
    version: 1,
    appPackage: nonEmptyString(root.appPackage, "appPackage"),
    intervalLabels,
    deviceProofs,
    restartAppBeforeJob: root.restartAppBeforeJob !== false,
    signalTimeoutMs: root.signalTimeoutMs === undefined
      ? 750
      : finiteNumber(root.signalTimeoutMs, "signalTimeoutMs", 0, 10_000),
    signals,
    flows,
  };
}

export async function loadFlowConfig(path: string): Promise<TapoFlowConfig> {
  try {
    const text = await readFile(path, "utf8");
    return parseFlowConfigSource(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Cannot load Tapo flow config: ${message}`);
  }
}

/** Parses the exact source bytes that were included in deployment attestation. */
export function parseFlowConfigSource(text: string): TapoFlowConfig {
  if (text.includes("CHANGE_ME")) {
    throw new Error("flow still contains CHANGE_ME placeholders");
  }
  return parseFlowConfig(JSON.parse(text) as unknown);
}

function render(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key: string) => {
    const replacement = variables[key];
    if (replacement === undefined) throw new Error(`Flow references missing variable ${key}`);
    return replacement;
  });
}

function renderSelector(value: Selector, variables: Readonly<Record<string, string>>): Selector {
  return { using: value.using, value: render(value.value, variables) };
}

function abortablePause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FlowExecutionError extends Error {
  constructor(
    message: string,
    readonly failureCode: AttentionCode,
    readonly actionIndex: number,
    override readonly cause: unknown,
  ) {
    super(message, { cause });
    this.name = "FlowExecutionError";
  }
}

export class FlowEngine {
  constructor(
    private readonly appium: AppiumClient,
    private readonly config: TapoFlowConfig,
    private readonly defaultTimeoutMs: number,
  ) {}

  async detectUiState(signal?: AbortSignal): Promise<UiState> {
    const timeout = this.config.signalTimeoutMs;
    const twoFactor = this.config.signals.twoFactor
      ? await this.appium.exists(this.config.signals.twoFactor, timeout, signal)
      : false;
    if (twoFactor) return "two_factor";
    const authenticated = await this.appium.exists(this.config.signals.authenticated, timeout, signal);
    if (authenticated) return "authenticated";
    const login = this.config.signals.login
      ? await this.appium.exists(this.config.signals.login, timeout, signal)
      : false;
    return classifyUiSignals({ authenticated, login, twoFactor });
  }

  async execute(actionsToRun: readonly FlowAction[], variables: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
    for (const [index, configuredAction] of actionsToRun.entries()) {
      signal.throwIfAborted();
      const timeout = configuredAction.timeoutMs ?? this.defaultTimeoutMs;
      try {
        await this.executeOne(configuredAction, variables, timeout, signal);
      } catch (error) {
        const missing = error instanceof ElementNotFoundError ||
          (error instanceof WebDriverError && (error.webdriverCode === "no such element" || error.webdriverCode === "timeout"));
        if (configuredAction.optional && missing) continue;
        const code = configuredAction.failureCode ?? "ui_drift";
        const reason = error instanceof Error ? error.message : "unknown automation error";
        throw new FlowExecutionError(
          `Flow action ${index + 1} (${configuredAction.action}) failed: ${reason}`,
          code,
          index,
          error,
        );
      }
    }
  }

  private async executeOne(
    configuredAction: FlowAction,
    variables: Readonly<Record<string, string>>,
    timeout: number,
    signal: AbortSignal,
  ): Promise<void> {
    const selected = configuredAction.selector
      ? renderSelector(configuredAction.selector, variables)
      : undefined;
    switch (configuredAction.action) {
      case "tap": {
        const element = configuredAction.requireUnique
          ? await this.appium.waitForUniqueElement(selected as Selector, timeout, signal)
          : await this.appium.waitForElement(selected as Selector, timeout, signal);
        await this.appium.click(element, signal);
        return;
      }
      case "type": {
        const element = await this.appium.waitForElement(selected as Selector, timeout, signal);
        if (configuredAction.clearFirst !== false) await this.appium.clear(element, signal);
        // Appium can include value-command arguments in its own server/driver
        // logs. Mark every typed value sensitive; this includes the one-time
        // export correlation address as well as account credentials.
        await this.appium.type(element, render(configuredAction.value as string, variables), signal, true);
        return;
      }
      case "clear": {
        const element = await this.appium.waitForElement(selected as Selector, timeout, signal);
        await this.appium.clear(element, signal);
        return;
      }
      case "waitFor":
        await this.appium.waitForElement(selected as Selector, timeout, signal);
        return;
      case "waitForGone":
        await this.appium.waitForGone(selected as Selector, timeout, signal);
        return;
      case "back":
        await this.appium.back(signal);
        return;
      case "pause":
        await abortablePause(configuredAction.durationMs as number, signal);
        return;
      case "tapCoordinates":
        await this.appium.tapCoordinates(configuredAction.x as number, configuredAction.y as number, signal);
        return;
      case "swipe":
        await this.appium.swipe(
          configuredAction.fromX as number,
          configuredAction.fromY as number,
          configuredAction.toX as number,
          configuredAction.toY as number,
          configuredAction.durationMs as number,
          signal,
        );
        return;
      case "repeatTap": {
        const countText = variables[configuredAction.countVariable as RepeatCountVariable];
        if (countText === undefined || !/^(?:0|[1-9]\d*)$/u.test(countText)) {
          throw new Error("repeatTap count is not a server-derived non-negative integer");
        }
        const count = Number(countText);
        if (!Number.isSafeInteger(count) || count > MAX_REPEAT_TAPS) {
          throw new Error(`repeatTap count exceeds the hard ${MAX_REPEAT_TAPS}-tap limit`);
        }
        for (let iteration = 0; iteration < count; iteration += 1) {
          signal.throwIfAborted();
          // Picker controls commonly rerender after every month. Resolve one
          // exact unique element for each click rather than reusing a stale id.
          const element = await this.appium.waitForUniqueElement(selected as Selector, timeout, signal);
          await this.appium.click(element, signal);
          if (iteration + 1 < count) {
            await abortablePause(configuredAction.settleMs ?? 250, signal);
          }
        }
        return;
      }
    }
  }
}
