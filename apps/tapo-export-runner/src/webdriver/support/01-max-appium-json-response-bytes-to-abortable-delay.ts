import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../../bounded-response.js";

export const MAX_APPIUM_JSON_RESPONSE_BYTES = 1024 * 1024;

export const MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES = 16 * 1024 * 1024;

export const MAX_ACTIVE_APPIUM_SESSIONS = 64;

export type SelectorStrategy =
  | "accessibility id"
  | "id"
  | "xpath"
  | "class name"
  | "-android uiautomator";

export interface Selector {
  using: SelectorStrategy;
  value: string;
}

export interface SessionRecord {
  sessionId: string;
  appiumUrl: string;
  capabilitiesFingerprint: string;
  savedAt: string;
}

export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly webdriverCode: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebDriverError";
  }
}

export class ElementNotFoundError extends WebDriverError {
  constructor(selector: Selector) {
    super(`Element not found (${selector.using}: ${selector.value})`, "no such element", 404);
    this.name = "ElementNotFoundError";
  }
}

export interface AppiumClientOptions {
  baseUrl: string;
  /** Mandatory in enabled production config; optional for isolated clients/tests. */
  expectedAppiumVersion?: string;
  capabilities: Record<string, unknown>;
  sessionFile: string;
  artifactDirectory: string;
  requestTimeoutMs: number;
}

export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export function parseError(body: unknown, status: number): WebDriverError {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const details = value as Record<string, unknown>;
      const code = typeof details.error === "string" ? details.error : "webdriver error";
      const message = typeof details.message === "string" ? details.message : `WebDriver HTTP ${status}`;
      return new WebDriverError(message, code, status);
    }
  }
  return new WebDriverError(`WebDriver HTTP ${status}`, "webdriver error", status);
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
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
