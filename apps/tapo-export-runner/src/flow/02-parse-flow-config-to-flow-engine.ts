import { readFile } from "node:fs/promises";
import type { AttentionCode } from "../types.js";
import {
  AppiumClient,
  ElementNotFoundError,
  WebDriverError,
  type Selector,
} from "../webdriver.js";
import { FlowAction, MAX_REPEAT_TAPS, RepeatCountVariable, TapoFlowConfig, UiState, actions, classifyUiSignals, finiteNumber, nonEmptyString, record, selector, validateCredentialBindings, validateExportBindings } from "./01-selector-strategies-to-validate-credential-bindings.js";

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

export function render(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key: string) => {
    const replacement = variables[key];
    if (replacement === undefined) throw new Error(`Flow references missing variable ${key}`);
    return replacement;
  });
}

export function renderSelector(value: Selector, variables: Readonly<Record<string, string>>): Selector {
  return { using: value.using, value: render(value.value, variables) };
}

export function abortablePause(milliseconds: number, signal: AbortSignal): Promise<void> {
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
