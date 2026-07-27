import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../../bounded-response.js";
import { ELEMENT_KEY, ElementNotFoundError, Selector, WebDriverError, abortableDelay } from "../support/01-max-appium-json-response-bytes-to-abortable-delay.js";
import { registerAppiumClientMethods, appiumClientState, type AppiumClientInternals } from "../core.js";

registerAppiumClientMethods({
  /** Verifies the actual Android offset after applying appium:timeZone. */
  async assertDeviceTimeZone(this: AppiumClientInternals, timeZone: string, signal?: AbortSignal): Promise<void> {
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
    },
  async assertSensitiveInputSupported(this: AppiumClientInternals, signal?: AbortSignal): Promise<void> {
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
      if (this[appiumClientState].options.expectedAppiumVersion
        && (typeof version !== "string" || version.trim() !== this[appiumClientState].options.expectedAppiumVersion)) {
        throw new WebDriverError(
          "Appium /status version does not match the exact configured TAPO_APPIUM_VERSION",
          "unsafe appium version",
          412,
        );
      }
    },
  responseCapabilities(this: AppiumClientInternals, response: Record<string, unknown>): Record<string, unknown> {
      const value = response.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const candidate = value as Record<string, unknown>;
      const nested = candidate.capabilities;
      return nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : candidate;
    },
  assertTargetCapabilities(this: AppiumClientInternals, capabilities: Record<string, unknown>, expectedTimeZone?: string): void {
      const pins = [
        ["platformName", "platformName"],
        ["appium:automationName", "automationName"],
        ["appium:platformVersion", "platformVersion"],
        ["appium:language", "language"],
        ["appium:locale", "locale"],
        ["appium:udid", "udid"],
      ] as const;
      for (const [configuredKey, fallbackKey] of pins) {
        const configured = this[appiumClientState].options.capabilities[configuredKey];
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
    },
  async assertActiveSessionTarget(this: AppiumClientInternals, signal?: AbortSignal, expectedTimeZone?: string): Promise<void> {
      const response = await this.raw(this.sessionPath(), { method: "GET" }, signal);
      this.assertTargetCapabilities(this.responseCapabilities(response), expectedTimeZone);
    },
  async discardCurrentSession(this: AppiumClientInternals, signal?: AbortSignal): Promise<void> {
      if (this[appiumClientState].sessionId) {
        try {
          await this.command(this.sessionPath(), { method: "DELETE" }, signal);
        } catch (error) {
          if (!(error instanceof WebDriverError && error.webdriverCode === "invalid session id")) throw error;
        }
      }
      await rm(this[appiumClientState].options.sessionFile, { force: true });
      this[appiumClientState].sessionId = undefined;
      this[appiumClientState].activeCapabilitiesFingerprint = undefined;
    },
  async activateApp(this: AppiumClientInternals, appPackage: string, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath("/execute/sync"), {
        method: "POST",
        body: JSON.stringify({ script: "mobile: activateApp", args: [{ appId: appPackage }] }),
      }, signal);
    },
  async terminateApp(this: AppiumClientInternals, appPackage: string, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath("/execute/sync"), {
        method: "POST",
        body: JSON.stringify({ script: "mobile: terminateApp", args: [{ appId: appPackage }] }),
      }, signal);
    },
  async findOnce(this: AppiumClientInternals, selector: Selector, signal?: AbortSignal): Promise<string | null> {
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
    },
  async findAllOnce(this: AppiumClientInternals, selector: Selector, signal?: AbortSignal): Promise<string[]> {
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
    },
  async exists(this: AppiumClientInternals, selector: Selector, timeoutMs = 0, signal?: AbortSignal): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      do {
        signal?.throwIfAborted();
        if (await this.findOnce(selector, signal)) return true;
        if (Date.now() >= deadline) break;
        await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
      } while (Date.now() <= deadline);
      return false;
    },
  async waitForElement(this: AppiumClientInternals, selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      do {
        signal?.throwIfAborted();
        const element = await this.findOnce(selector, signal);
        if (element) return element;
        if (Date.now() >= deadline) break;
        await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
      } while (Date.now() <= deadline);
      throw new ElementNotFoundError(selector);
    },
  async waitForUniqueElement(this: AppiumClientInternals, selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string> {
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
    },
  async waitForGone(this: AppiumClientInternals, selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      do {
        signal?.throwIfAborted();
        if (!(await this.findOnce(selector, signal))) return;
        if (Date.now() >= deadline) break;
        await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
      } while (Date.now() <= deadline);
      throw new WebDriverError(`Element did not disappear (${selector.using}: ${selector.value})`, "timeout", 408);
    },
  async click(this: AppiumClientInternals, elementId: string, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath(`/element/${encodeURIComponent(elementId)}/click`), {
        method: "POST",
        body: "{}",
      }, signal);
    },
  async clear(this: AppiumClientInternals, elementId: string, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath(`/element/${encodeURIComponent(elementId)}/clear`), {
        method: "POST",
        body: "{}",
      }, signal);
    },
  async type(this: AppiumClientInternals, elementId: string, value: string, signal?: AbortSignal, sensitive = false): Promise<void> {
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
    },
  async back(this: AppiumClientInternals, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath("/back"), { method: "POST", body: "{}" }, signal);
    },
  async tapCoordinates(this: AppiumClientInternals, x: number, y: number, signal?: AbortSignal): Promise<void> {
      await this.pointerActions([
        { type: "pointerMove", duration: 0, x, y, origin: "viewport" },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerUp", button: 0 },
      ], signal);
    },
  async swipe(this: AppiumClientInternals,
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
    },
  async pointerActions(this: AppiumClientInternals, actions: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
      await this.command(this.sessionPath("/actions"), {
        method: "POST",
        body: JSON.stringify({
          actions: [{ type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions }],
        }),
      }, signal);
    },
  async saveScreenshot(this: AppiumClientInternals, label: string, signal?: AbortSignal): Promise<string> {
      const value = await this.command(this.sessionPath("/screenshot"), { method: "GET" }, signal);
      if (typeof value !== "string") throw new WebDriverError("Invalid screenshot response", "invalid response", 502);
      await mkdir(this[appiumClientState].options.artifactDirectory, { recursive: true });
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 80);
      const path = join(this[appiumClientState].options.artifactDirectory, `${Date.now()}-${safeLabel}.png`);
      await writeFile(path, Buffer.from(value, "base64"), { mode: 0o600 });
      return path;
    },
  /** Deletes only runner-created PNG diagnostics older than the configured retention. */
  async pruneArtifacts(this: AppiumClientInternals, retentionMs: number, now = Date.now()): Promise<number> {
      if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("Artifact retention must be positive");
      let entries;
      try { entries = await readdir(this[appiumClientState].options.artifactDirectory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !/^\d+-[A-Za-z0-9_-]+\.png$/u.test(entry.name)) continue;
        const path = join(this[appiumClientState].options.artifactDirectory, entry.name);
        const metadata = await stat(path);
        if (metadata.mtimeMs > now - retentionMs) continue;
        await rm(path, { force: true });
        removed += 1;
      }
      return removed;
    },
  async quit(this: AppiumClientInternals): Promise<void> {
      if (this[appiumClientState].sessionId) {
        try {
          await this.command(this.sessionPath(), { method: "DELETE" });
        } finally {
          this[appiumClientState].sessionId = undefined;
          await rm(this[appiumClientState].options.sessionFile, { force: true });
        }
      }
    },
});
