import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "./bounded-response.js";

export const MAX_APPIUM_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_APPIUM_SESSIONS = 64;

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

interface SessionRecord {
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

interface AppiumClientOptions {
  baseUrl: string;
  /** Mandatory in enabled production config; optional for isolated clients/tests. */
  expectedAppiumVersion?: string;
  capabilities: Record<string, unknown>;
  sessionFile: string;
  artifactDirectory: string;
  requestTimeoutMs: number;
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function parseError(body: unknown, status: number): WebDriverError {
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

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

export class AppiumClient {
  private sessionId: string | undefined;
  private activeCapabilitiesFingerprint: string | undefined;

  constructor(private readonly options: AppiumClientOptions) {}

  private capabilitiesFingerprint(capabilities: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
  }

  private async raw(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/u, "")}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
          : AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown network error";
      throw new WebDriverError(`Cannot reach Appium: ${message}`, "appium unavailable", 503);
    }

    const maximumBytes = path.endsWith("/screenshot")
      ? MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES
      : MAX_APPIUM_JSON_RESPONSE_BYTES;
    let text: string;
    try {
      text = await readBoundedResponseText(response, maximumBytes);
    } catch (error) {
      if (error instanceof ResponseLimitError) {
        throw new WebDriverError(
          `Appium response exceeded ${maximumBytes} bytes`,
          "response too large",
          502,
        );
      }
      throw new WebDriverError("Cannot read a bounded Appium response", "appium unavailable", 503);
    }
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new WebDriverError("Appium returned a non-JSON response", "invalid response", response.status);
      }
    }
    if (!response.ok) throw parseError(body, response.status);
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  }

  private async command(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const body = await this.raw(path, init, signal);
    return body.value;
  }

  private sessionPath(suffix = ""): string {
    if (!this.sessionId) throw new WebDriverError("No active Appium session", "invalid session id", 404);
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  private async readStoredSession(capabilitiesFingerprint?: string): Promise<SessionRecord | null> {
    let contents: string;
    try {
      contents = await readFile(this.options.sessionFile, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw new WebDriverError("Cannot read persisted Appium session state", "unsafe session state", 500);
    }
    try {
      const raw: unknown = JSON.parse(contents);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid record");
      const candidate = raw as Record<string, unknown>;
      if (
        typeof candidate.sessionId !== "string" ||
        typeof candidate.appiumUrl !== "string" ||
        typeof candidate.capabilitiesFingerprint !== "string" ||
        (capabilitiesFingerprint !== undefined && candidate.capabilitiesFingerprint !== capabilitiesFingerprint)
      ) throw new Error("invalid record");
      return {
        sessionId: candidate.sessionId,
        appiumUrl: candidate.appiumUrl,
        capabilitiesFingerprint: candidate.capabilitiesFingerprint,
        savedAt: typeof candidate.savedAt === "string" ? candidate.savedAt : "",
      };
    } catch {
      throw new WebDriverError(
        "Persisted Appium session state is invalid; refusing to create a potentially concurrent session",
        "unsafe session state",
        409,
      );
    }
  }

  private async storeSession(capabilitiesFingerprint: string): Promise<void> {
    if (!this.sessionId) return;
    const sessionDirectory = dirname(this.options.sessionFile);
    const temporary = `${this.options.sessionFile}.${process.pid}.${randomUUID()}.tmp`;
    const record: SessionRecord = {
      sessionId: this.sessionId,
      appiumUrl: this.options.baseUrl,
      capabilitiesFingerprint,
      savedAt: new Date().toISOString(),
    };
    try {
      await mkdir(sessionDirectory, { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      // rename is the atomic publication point. Never unlink the previous
      // record first: a crash must leave either the old or the new record.
      await rename(temporary, this.options.sessionFile);
      await this.syncDirectoryWhereSupported(sessionDirectory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const reason = error instanceof Error ? error.message : "unknown storage error";
      throw new WebDriverError(
        `Cannot durably record the Appium session: ${reason}`,
        "unsafe session state",
        500,
      );
    }
  }

  private async syncDirectoryWhereSupported(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(code ?? "")) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Reconciles the only crash window: Appium accepted POST /session but the
   * durable record was not yet published. Only sessions that echo the exact
   * configured physical target and deployment pins are deleted. An
   * unidentified or same-UDID/mismatched session is refused, never guessed.
   */
  private async reconcileOrphanSessions(signal?: AbortSignal, knownSessionId?: string): Promise<boolean> {
    const response = await this.raw("/sessions", { method: "GET" }, signal);
    if (!Array.isArray(response.value) || response.value.length > MAX_ACTIVE_APPIUM_SESSIONS) {
      throw new WebDriverError(
        "Appium did not return a bounded active-session list",
        "unsafe session state",
        502,
      );
    }
    const configuredUdid = this.options.capabilities["appium:udid"];
    if (typeof configuredUdid !== "string" || configuredUdid.length === 0) {
      throw new WebDriverError("Cannot reconcile sessions without appium:udid", "unsafe session state", 500);
    }

    let knownSessionFound = false;
    for (const entry of response.value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new WebDriverError("Appium returned an invalid active session", "unsafe session state", 502);
      }
      const record = entry as Record<string, unknown>;
      const sessionId = record.id ?? record.sessionId;
      const capabilities = record.capabilities;
      if (typeof sessionId !== "string" || !sessionId
        || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
        throw new WebDriverError("Appium returned an unidentified active session", "unsafe session state", 502);
      }
      const targetCapabilities = capabilities as Record<string, unknown>;
      const activeUdid = targetCapabilities["appium:udid"] ?? targetCapabilities.udid;
      if (typeof activeUdid !== "string" || !activeUdid) {
        throw new WebDriverError("Active Appium session has no verifiable UDID", "unsafe session state", 409);
      }
      if (sessionId === knownSessionId && activeUdid !== configuredUdid) {
        throw new WebDriverError("Recorded Appium session now identifies a different target", "unsafe session state", 409);
      }
      if (activeUdid !== configuredUdid) continue;

      // Throws before DELETE if any platform/driver/locale target pin differs.
      this.assertTargetCapabilities(targetCapabilities);
      if (sessionId === knownSessionId) {
        knownSessionFound = true;
        continue;
      }
      try {
        await this.raw(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, signal);
      } catch (error) {
        if (!(error instanceof WebDriverError && error.webdriverCode === "invalid session id")) throw error;
      }
    }
    return knownSessionFound;
  }

  /** Checks and reconciles Appium target ownership before the job API is touched. */
  async assertTargetSessionStateSafe(signal?: AbortSignal): Promise<void> {
    let knownSessionId = this.sessionId;
    if (!knownSessionId) {
      const stored = await this.readStoredSession();
      if (stored) {
        if (stored.appiumUrl.replace(/\/$/u, "") !== this.options.baseUrl.replace(/\/$/u, "")) {
          throw new WebDriverError(
            "Persisted Appium session belongs to a different endpoint",
            "unsafe session state",
            409,
          );
        }
        knownSessionId = stored.sessionId;
      }
    }
    const knownSessionFound = await this.reconcileOrphanSessions(signal, knownSessionId);
    if (knownSessionId && !knownSessionFound) {
      // Appium's authoritative list says the record is stale. Remove it before
      // a future create so it cannot be mistaken for active target ownership.
      await rm(this.options.sessionFile, { force: true });
      if (this.sessionId === knownSessionId) {
        this.sessionId = undefined;
        this.activeCapabilitiesFingerprint = undefined;
      }
    }
  }

  async ensureSession(signal?: AbortSignal, expectedTimeZone?: string): Promise<string> {
    signal?.throwIfAborted();
    const capabilities = {
      ...this.options.capabilities,
      ...(expectedTimeZone ? { "appium:timeZone": expectedTimeZone } : {}),
    };
    const fingerprint = this.capabilitiesFingerprint(capabilities);
    if (this.sessionId && this.activeCapabilitiesFingerprint !== fingerprint) {
      await this.discardCurrentSession(signal);
    }
    if (this.sessionId) {
      try {
        await this.assertActiveSessionTarget(signal, expectedTimeZone);
        if (expectedTimeZone) await this.assertDeviceTimeZone(expectedTimeZone, signal);
        return this.sessionId;
      } catch {
        signal?.throwIfAborted();
        await this.discardCurrentSession(signal);
      }
    }

    const stored = await this.readStoredSession();
    if (stored) {
      if (stored.appiumUrl.replace(/\/$/u, "") !== this.options.baseUrl.replace(/\/$/u, "")) {
        throw new WebDriverError(
          "Persisted Appium session belongs to a different endpoint; refusing to create a concurrent target session",
          "unsafe session state",
          409,
        );
      }
      this.sessionId = stored.sessionId;
      this.activeCapabilitiesFingerprint = stored.capabilitiesFingerprint;
      if (stored.capabilitiesFingerprint !== fingerprint) {
        await this.discardCurrentSession(signal);
      } else {
        try {
          await this.assertActiveSessionTarget(signal, expectedTimeZone);
          if (expectedTimeZone) await this.assertDeviceTimeZone(expectedTimeZone, signal);
          return stored.sessionId;
        } catch {
          signal?.throwIfAborted();
          await this.discardCurrentSession(signal);
        }
      }
    }

    await this.reconcileOrphanSessions(signal);
    signal?.throwIfAborted();
    const response = await this.raw("/session", {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }),
    }, signal);
    const value = response.value;
    const nestedId = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).sessionId
      : undefined;
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : nestedId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new WebDriverError("Appium did not return a session id", "invalid response", 502);
    }
    this.sessionId = sessionId;
    this.activeCapabilitiesFingerprint = fingerprint;
    try {
      this.assertTargetCapabilities(this.responseCapabilities(response), expectedTimeZone);
    } catch (error) {
      await this.discardCurrentSession(signal);
      throw error;
    }
    signal?.throwIfAborted();
    await this.storeSession(fingerprint);
    if (expectedTimeZone) await this.assertDeviceTimeZone(expectedTimeZone, signal);
    return sessionId;
  }

  /**
   * Fails closed while deleting a prior target session. A timed-out DELETE can
   * be queued behind an old command, so a replacement session must not start.
   */
  async resetSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.sessionId) {
      const stored = await this.readStoredSession();
      if (stored) {
        if (stored.appiumUrl.replace(/\/$/u, "") !== this.options.baseUrl.replace(/\/$/u, "")) {
          throw new WebDriverError(
            "Persisted Appium session belongs to a different endpoint and cannot be safely reset",
            "unsafe session state",
            409,
          );
        }
        this.sessionId = stored.sessionId;
        this.activeCapabilitiesFingerprint = stored.capabilitiesFingerprint;
      }
    }
    await this.discardCurrentSession(signal);
  }

  /** Verifies the actual Android offset after applying appium:timeZone. */
  async assertDeviceTimeZone(timeZone: string, signal?: AbortSignal): Promise<void> {
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en", {
        timeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    } catch {
      throw new WebDriverError("Export job contains an invalid IANA timezone", "invalid timezone", 422);
    }
    const value = await this.command(this.sessionPath("/execute/sync"), {
      method: "POST",
      body: JSON.stringify({ script: "mobile: getDeviceTime", args: [{ format: "YYYY-MM-DDTHH:mm:ssZ" }] }),
    }, signal);
    if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) {
      throw new WebDriverError("Appium did not return an offset-qualified Android device time", "timezone unverifiable", 412);
    }
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) {
      throw new WebDriverError("Appium returned an invalid Android device time", "timezone unverifiable", 412);
    }
    const match = /([+-])(\d{2}):?(\d{2})$/u.exec(value);
    const actualOffset = value.endsWith("Z") ? 0
      : (match?.[1] === "-" ? -1 : 1) * (Number(match?.[2]) * 60 + Number(match?.[3]));
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((candidate) => candidate.type === type)?.value);
    const expectedOffset = Math.round((Date.UTC(
      part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"),
    ) - instant) / 60_000);
    if (actualOffset !== expectedOffset) {
      throw new WebDriverError("Android device timezone does not match the export job timezone", "timezone mismatch", 409);
    }
  }

  async assertSensitiveInputSupported(signal?: AbortSignal): Promise<void> {
    const response = await this.raw("/status", { method: "GET" }, signal);
    const value = response.value;
    const build = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).build
      : undefined;
    const version = build && typeof build === "object" && !Array.isArray(build)
      ? (build as Record<string, unknown>).version
      : undefined;
    const match = typeof version === "string" ? /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version.trim()) : null;
    const major = match ? Number(match[1]) : -1;
    const minor = match ? Number(match[2]) : -1;
    if (major < 2 || (major === 2 && minor < 18)) {
      throw new WebDriverError(
        "Automatic credential entry requires Appium 2.18.0 or newer",
        "unsafe appium version",
        412,
      );
    }
    if (this.options.expectedAppiumVersion
      && (typeof version !== "string" || version.trim() !== this.options.expectedAppiumVersion)) {
      throw new WebDriverError(
        "Appium /status version does not match the exact configured TAPO_APPIUM_VERSION",
        "unsafe appium version",
        412,
      );
    }
  }

  private responseCapabilities(response: Record<string, unknown>): Record<string, unknown> {
    const value = response.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const candidate = value as Record<string, unknown>;
    const nested = candidate.capabilities;
    return nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : candidate;
  }

  private assertTargetCapabilities(capabilities: Record<string, unknown>, expectedTimeZone?: string): void {
    const pins = [
      ["platformName", "platformName"],
      ["appium:automationName", "automationName"],
      ["appium:platformVersion", "platformVersion"],
      ["appium:language", "language"],
      ["appium:locale", "locale"],
      ["appium:udid", "udid"],
    ] as const;
    for (const [configuredKey, fallbackKey] of pins) {
      const configured = this.options.capabilities[configuredKey];
      if (typeof configured !== "string" || configured.length === 0) continue;
      const actual = capabilities[configuredKey] ?? capabilities[fallbackKey];
      if (actual !== configured) {
        throw new WebDriverError(
          `Appium session did not confirm the exact configured ${configuredKey}`,
          "session capability mismatch",
          409,
        );
      }
    }
    if (expectedTimeZone) {
      const actualTimeZone = capabilities["appium:timeZone"] ?? capabilities.timeZone;
      if (actualTimeZone !== expectedTimeZone) {
        throw new WebDriverError(
          "Appium session did not confirm the exact requested IANA timezone",
          "session timezone mismatch",
          409,
        );
      }
    }
  }

  private async assertActiveSessionTarget(signal?: AbortSignal, expectedTimeZone?: string): Promise<void> {
    const response = await this.raw(this.sessionPath(), { method: "GET" }, signal);
    this.assertTargetCapabilities(this.responseCapabilities(response), expectedTimeZone);
  }

  private async discardCurrentSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId) {
      try {
        await this.command(this.sessionPath(), { method: "DELETE" }, signal);
      } catch (error) {
        if (!(error instanceof WebDriverError && error.webdriverCode === "invalid session id")) throw error;
      }
    }
    await rm(this.options.sessionFile, { force: true });
    this.sessionId = undefined;
    this.activeCapabilitiesFingerprint = undefined;
  }

  async activateApp(appPackage: string, signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath("/execute/sync"), {
      method: "POST",
      body: JSON.stringify({ script: "mobile: activateApp", args: [{ appId: appPackage }] }),
    }, signal);
  }

  async terminateApp(appPackage: string, signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath("/execute/sync"), {
      method: "POST",
      body: JSON.stringify({ script: "mobile: terminateApp", args: [{ appId: appPackage }] }),
    }, signal);
  }

  private async findOnce(selector: Selector, signal?: AbortSignal): Promise<string | null> {
    try {
      const value = await this.command(this.sessionPath("/element"), {
        method: "POST",
        body: JSON.stringify(selector),
      }, signal);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const element = value as Record<string, unknown>;
      const id = element[ELEMENT_KEY] ?? element.ELEMENT;
      return typeof id === "string" ? id : null;
    } catch (error) {
      if (error instanceof WebDriverError && error.webdriverCode === "no such element") return null;
      throw error;
    }
  }

  private async findAllOnce(selector: Selector, signal?: AbortSignal): Promise<string[]> {
    const value = await this.command(this.sessionPath("/elements"), {
      method: "POST",
      body: JSON.stringify(selector),
    }, signal);
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const record = candidate as Record<string, unknown>;
      const id = record[ELEMENT_KEY] ?? record.ELEMENT;
      return typeof id === "string" ? [id] : [];
    });
  }

  async exists(selector: Selector, timeoutMs = 0, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      if (await this.findOnce(selector, signal)) return true;
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    return false;
  }

  async waitForElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      const element = await this.findOnce(selector, signal);
      if (element) return element;
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    throw new ElementNotFoundError(selector);
  }

  async waitForUniqueElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      const elements = await this.findAllOnce(selector, signal);
      if (elements.length > 1) {
        throw new WebDriverError("Exact device selector matched more than one account device", "ambiguous element", 409);
      }
      if (elements.length === 1) return elements[0]!;
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    throw new ElementNotFoundError(selector);
  }

  async waitForGone(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      if (!(await this.findOnce(selector, signal))) return;
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    throw new WebDriverError(`Element did not disappear (${selector.using}: ${selector.value})`, "timeout", 408);
  }

  async click(elementId: string, signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath(`/element/${encodeURIComponent(elementId)}/click`), {
      method: "POST",
      body: "{}",
    }, signal);
  }

  async clear(elementId: string, signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath(`/element/${encodeURIComponent(elementId)}/clear`), {
      method: "POST",
      body: "{}",
    }, signal);
  }

  async type(elementId: string, value: string, signal?: AbortSignal, sensitive = false): Promise<void> {
    try {
      await this.command(this.sessionPath(`/element/${encodeURIComponent(elementId)}/value`), {
        method: "POST",
        ...(sensitive ? { headers: { "X-Appium-Is-Sensitive": "true" } } : {}),
        body: JSON.stringify({ text: value, value: Array.from(value) }),
      }, signal);
    } catch (error) {
      if (sensitive && error instanceof WebDriverError) {
        throw new WebDriverError("Sensitive Appium input command failed", error.webdriverCode, error.status);
      }
      throw error;
    }
  }

  async back(signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath("/back"), { method: "POST", body: "{}" }, signal);
  }

  async tapCoordinates(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.pointerActions([
      { type: "pointerMove", duration: 0, x, y, origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 80 },
      { type: "pointerUp", button: 0 },
    ], signal);
  }

  async swipe(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.pointerActions([
      { type: "pointerMove", duration: 0, x: fromX, y: fromY, origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: durationMs, x: toX, y: toY, origin: "viewport" },
      { type: "pointerUp", button: 0 },
    ], signal);
  }

  private async pointerActions(actions: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    await this.command(this.sessionPath("/actions"), {
      method: "POST",
      body: JSON.stringify({
        actions: [{ type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions }],
      }),
    }, signal);
  }

  async saveScreenshot(label: string, signal?: AbortSignal): Promise<string> {
    const value = await this.command(this.sessionPath("/screenshot"), { method: "GET" }, signal);
    if (typeof value !== "string") throw new WebDriverError("Invalid screenshot response", "invalid response", 502);
    await mkdir(this.options.artifactDirectory, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 80);
    const path = join(this.options.artifactDirectory, `${Date.now()}-${safeLabel}.png`);
    await writeFile(path, Buffer.from(value, "base64"), { mode: 0o600 });
    return path;
  }

  /** Deletes only runner-created PNG diagnostics older than the configured retention. */
  async pruneArtifacts(retentionMs: number, now = Date.now()): Promise<number> {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("Artifact retention must be positive");
    let entries;
    try { entries = await readdir(this.options.artifactDirectory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+-[A-Za-z0-9_-]+\.png$/u.test(entry.name)) continue;
      const path = join(this.options.artifactDirectory, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs > now - retentionMs) continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }

  async quit(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.command(this.sessionPath(), { method: "DELETE" });
      } finally {
        this.sessionId = undefined;
        await rm(this.options.sessionFile, { force: true });
      }
    }
  }
}
