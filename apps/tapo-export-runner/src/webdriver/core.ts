import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../bounded-response.js";
import { AppiumClientOptions } from "./support/01-max-appium-json-response-bytes-to-abortable-delay.js";

export const appiumClientState = Symbol("AppiumClient.state");

export interface AppiumClientState {
  sessionId: string | undefined;
  activeCapabilitiesFingerprint: string | undefined;
  options: AppiumClientOptions;
}

export function createAppiumClientState(options: AppiumClientOptions): AppiumClientState {
  return {
    sessionId: undefined,
    activeCapabilitiesFingerprint: undefined,
    options,
  };
}

export interface AppiumClientInternals {
  readonly [appiumClientState]: AppiumClientState;
}

export type AppiumClientMethodSet = Record<string, unknown> & ThisType<AppiumClientInternals>;

export class AppiumClientCore {
  readonly [appiumClientState]: AppiumClientState;

  constructor(options: AppiumClientOptions) {
    this[appiumClientState] = createAppiumClientState(options);
  }
}

export function registerAppiumClientMethods(methods: AppiumClientMethodSet): void {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(AppiumClientCore.prototype, name, {
      value: method, configurable: true, writable: true, enumerable: false,
    });
  }
}
