import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../../bounded-response.js";
import { MAX_ACTIVE_APPIUM_SESSIONS, MAX_APPIUM_JSON_RESPONSE_BYTES, MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES, SessionRecord, WebDriverError, parseError } from "../support/01-max-appium-json-response-bytes-to-abortable-delay.js";
import { registerAppiumClientMethods, appiumClientState, type AppiumClientInternals } from "../core.js";

registerAppiumClientMethods({
  capabilitiesFingerprint(this: AppiumClientInternals, capabilities: Record<string, unknown>): string {
      return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
    },
  async raw(this: AppiumClientInternals, path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(`${this[appiumClientState].options.baseUrl.replace(/\/$/u, "")}${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...init.headers },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this[appiumClientState].options.requestTimeoutMs)])
            : AbortSignal.timeout(this[appiumClientState].options.requestTimeoutMs),
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
    },
  async command(this: AppiumClientInternals, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
      const body = await this.raw(path, init, signal);
      return body.value;
    },
  sessionPath(this: AppiumClientInternals, suffix = ""): string {
      if (!this[appiumClientState].sessionId) throw new WebDriverError("No active Appium session", "invalid session id", 404);
      return `/session/${encodeURIComponent(this[appiumClientState].sessionId)}${suffix}`;
    },
  async readStoredSession(this: AppiumClientInternals, capabilitiesFingerprint?: string): Promise<SessionRecord | null> {
      let contents: string;
      try {
        contents = await readFile(this[appiumClientState].options.sessionFile, "utf8");
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) return null;
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
    },
  async storeSession(this: AppiumClientInternals, capabilitiesFingerprint: string): Promise<void> {
      if (!this[appiumClientState].sessionId) return;
      const sessionDirectory = dirname(this[appiumClientState].options.sessionFile);
      const temporary = `${this[appiumClientState].options.sessionFile}.${process.pid}.${randomUUID()}.tmp`;
      const record: SessionRecord = {
        sessionId: this[appiumClientState].sessionId,
        appiumUrl: this[appiumClientState].options.baseUrl,
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
        await rename(temporary, this[appiumClientState].options.sessionFile);
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
    },
  async syncDirectoryWhereSupported(this: AppiumClientInternals, path: string): Promise<void> {
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
    },
  /**
     * Reconciles the only crash window: Appium accepted POST /session but the
     * durable record was not yet published. Only sessions that echo the exact
     * configured physical target and deployment pins are deleted. An
     * unidentified or same-UDID/mismatched session is refused, never guessed.
     */
  async reconcileOrphanSessions(this: AppiumClientInternals, signal?: AbortSignal, knownSessionId?: string): Promise<boolean> {
      const response = await this.raw("/sessions", { method: "GET" }, signal);
      if (!Array.isArray(response.value) || response.value.length > MAX_ACTIVE_APPIUM_SESSIONS) {
        throw new WebDriverError(
          "Appium did not return a bounded active-session list",
          "unsafe session state",
          502,
        );
      }
      const configuredUdid = this[appiumClientState].options.capabilities["appium:udid"];
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
    },
  /** Checks and reconciles Appium target ownership before the job API is touched. */
  async assertTargetSessionStateSafe(this: AppiumClientInternals, signal?: AbortSignal): Promise<void> {
      let knownSessionId = this[appiumClientState].sessionId;
      if (!knownSessionId) {
        const stored = await this.readStoredSession();
        if (stored) {
          if (stored.appiumUrl.replace(/\/$/u, "") !== this[appiumClientState].options.baseUrl.replace(/\/$/u, "")) {
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
        await rm(this[appiumClientState].options.sessionFile, { force: true });
        if (this[appiumClientState].sessionId === knownSessionId) {
          this[appiumClientState].sessionId = undefined;
          this[appiumClientState].activeCapabilitiesFingerprint = undefined;
        }
      }
    },
  async ensureSession(this: AppiumClientInternals, signal?: AbortSignal, expectedTimeZone?: string): Promise<string> {
      signal?.throwIfAborted();
      const capabilities = {
        ...this[appiumClientState].options.capabilities,
        ...(expectedTimeZone ? { "appium:timeZone": expectedTimeZone } : {}),
      };
      const fingerprint = this.capabilitiesFingerprint(capabilities);
      if (this[appiumClientState].sessionId && this[appiumClientState].activeCapabilitiesFingerprint !== fingerprint) {
        await this.discardCurrentSession(signal);
      }
      if (this[appiumClientState].sessionId) {
        try {
          await this.assertActiveSessionTarget(signal, expectedTimeZone);
          if (expectedTimeZone) await this.assertDeviceTimeZone(expectedTimeZone, signal);
          return this[appiumClientState].sessionId;
        } catch {
          signal?.throwIfAborted();
          await this.discardCurrentSession(signal);
        }
      }

      const stored = await this.readStoredSession();
      if (stored) {
        if (stored.appiumUrl.replace(/\/$/u, "") !== this[appiumClientState].options.baseUrl.replace(/\/$/u, "")) {
          throw new WebDriverError(
            "Persisted Appium session belongs to a different endpoint; refusing to create a concurrent target session",
            "unsafe session state",
            409,
          );
        }
        this[appiumClientState].sessionId = stored.sessionId;
        this[appiumClientState].activeCapabilitiesFingerprint = stored.capabilitiesFingerprint;
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
      this[appiumClientState].sessionId = sessionId;
      this[appiumClientState].activeCapabilitiesFingerprint = fingerprint;
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
    },
  /**
     * Fails closed while deleting a prior target session. A timed-out DELETE can
     * be queued behind an old command, so a replacement session must not start.
     */
  async resetSession(this: AppiumClientInternals, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (!this[appiumClientState].sessionId) {
        const stored = await this.readStoredSession();
        if (stored) {
          if (stored.appiumUrl.replace(/\/$/u, "") !== this[appiumClientState].options.baseUrl.replace(/\/$/u, "")) {
            throw new WebDriverError(
              "Persisted Appium session belongs to a different endpoint and cannot be safely reset",
              "unsafe session state",
              409,
            );
          }
          this[appiumClientState].sessionId = stored.sessionId;
          this[appiumClientState].activeCapabilitiesFingerprint = stored.capabilitiesFingerprint;
        }
      }
      await this.discardCurrentSession(signal);
    },
});
