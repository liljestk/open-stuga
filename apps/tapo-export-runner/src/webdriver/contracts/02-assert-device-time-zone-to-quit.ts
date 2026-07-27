import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../../bounded-response.js";
import { ELEMENT_KEY, ElementNotFoundError, Selector, WebDriverError, abortableDelay } from "../support/01-max-appium-json-response-bytes-to-abortable-delay.js";
import "../core.js";

declare module "../core.js" {
  interface AppiumClientInternals {
    assertDeviceTimeZone(timeZone: string, signal?: AbortSignal): Promise<void>;
    assertSensitiveInputSupported(signal?: AbortSignal): Promise<void>;
    responseCapabilities(response: Record<string, unknown>): Record<string, unknown>;
    assertTargetCapabilities(capabilities: Record<string, unknown>, expectedTimeZone?: string): void;
    assertActiveSessionTarget(signal?: AbortSignal, expectedTimeZone?: string): Promise<void>;
    discardCurrentSession(signal?: AbortSignal): Promise<void>;
    activateApp(appPackage: string, signal?: AbortSignal): Promise<void>;
    terminateApp(appPackage: string, signal?: AbortSignal): Promise<void>;
    findOnce(selector: Selector, signal?: AbortSignal): Promise<string | null>;
    findAllOnce(selector: Selector, signal?: AbortSignal): Promise<string[]>;
    exists(selector: Selector, timeoutMs?: number, signal?: AbortSignal): Promise<boolean>;
    waitForElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    waitForUniqueElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    waitForGone(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    click(elementId: string, signal?: AbortSignal): Promise<void>;
    clear(elementId: string, signal?: AbortSignal): Promise<void>;
    type(elementId: string, value: string, signal?: AbortSignal, sensitive?: boolean): Promise<void>;
    back(signal?: AbortSignal): Promise<void>;
    tapCoordinates(x: number, y: number, signal?: AbortSignal): Promise<void>;
    swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number, signal?: AbortSignal): Promise<void>;
    pointerActions(actions: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<void>;
    saveScreenshot(label: string, signal?: AbortSignal): Promise<string>;
    pruneArtifacts(retentionMs: number, now?: number): Promise<number>;
    quit(): Promise<void>;
  }

  interface AppiumClientCore {
    assertDeviceTimeZone(timeZone: string, signal?: AbortSignal): Promise<void>;
    assertSensitiveInputSupported(signal?: AbortSignal): Promise<void>;
    activateApp(appPackage: string, signal?: AbortSignal): Promise<void>;
    terminateApp(appPackage: string, signal?: AbortSignal): Promise<void>;
    exists(selector: Selector, timeoutMs?: number, signal?: AbortSignal): Promise<boolean>;
    waitForElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    waitForUniqueElement(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    waitForGone(selector: Selector, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    click(elementId: string, signal?: AbortSignal): Promise<void>;
    clear(elementId: string, signal?: AbortSignal): Promise<void>;
    type(elementId: string, value: string, signal?: AbortSignal, sensitive?: boolean): Promise<void>;
    back(signal?: AbortSignal): Promise<void>;
    tapCoordinates(x: number, y: number, signal?: AbortSignal): Promise<void>;
    swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number, signal?: AbortSignal): Promise<void>;
    saveScreenshot(label: string, signal?: AbortSignal): Promise<string>;
    pruneArtifacts(retentionMs: number, now?: number): Promise<number>;
    quit(): Promise<void>;
  }
}
