import { SessionRecord } from "../support/01-max-appium-json-response-bytes-to-abortable-delay.js";
import "../core.js";

declare module "../core.js" {
  interface AppiumClientInternals {
    capabilitiesFingerprint(capabilities: Record<string, unknown>): string;
    raw(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>>;
    command(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown>;
    sessionPath(suffix?: string ): string;
    readStoredSession(capabilitiesFingerprint?: string): Promise<SessionRecord | null>;
    storeSession(capabilitiesFingerprint: string): Promise<void>;
    syncDirectoryWhereSupported(path: string): Promise<void>;
    reconcileOrphanSessions(signal?: AbortSignal, knownSessionId?: string): Promise<boolean>;
    assertTargetSessionStateSafe(signal?: AbortSignal): Promise<void>;
    ensureSession(signal?: AbortSignal, expectedTimeZone?: string): Promise<string>;
    resetSession(signal?: AbortSignal): Promise<void>;
  }

  interface AppiumClientCore {
    assertTargetSessionStateSafe(signal?: AbortSignal): Promise<void>;
    ensureSession(signal?: AbortSignal, expectedTimeZone?: string): Promise<string>;
    resetSession(signal?: AbortSignal): Promise<void>;
  }
}
